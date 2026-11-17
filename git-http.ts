import {
  ForgeStore,
  HTTP_KA_SUFFIX,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  buildHttpBuffer,
  buildPackfile,
  collectReachableObjects,
  invalidateRepoRefs,
  isFastForward,
  parseCommit,
  parsePktLines,
  peelOid,
  pktLine,
  unpackPackfile,
  type Repository,
} from './store.ts';
import type { HttpRequest, HttpResponse } from './rest.ts';

const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta atomic agent=git/makefun';
const RECEIVE_CAPS_BUF = Buffer.from(RECEIVE_CAPS, 'ascii');
const RECEIVE_PKT_PREAMBLE = Buffer.concat([pktLine('# service=git-receive-pack\n'), PKT_FLUSH]);

const V2_UPLOAD_PACK_AD = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=git/makefun\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

const HTTP_200_UP_AD_PRE = Buffer.from(
  'HTTP/1.1 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\nCache-Control: no-cache\r\nContent-Length: ',
  'ascii',
);
const HTTP_200_RP_AD_PRE = Buffer.from(
  'HTTP/1.1 200 OK\r\nContent-Type: application/x-git-receive-pack-advertisement\r\nCache-Control: no-cache\r\nContent-Length: ',
  'ascii',
);
const HTTP_200_UP_RESULT_PRE = Buffer.from(
  'HTTP/1.1 200 OK\r\nContent-Type: application/x-git-upload-pack-result\r\nCache-Control: no-cache\r\nContent-Length: ',
  'ascii',
);
const HTTP_200_RP_RESULT_PRE = Buffer.from(
  'HTTP/1.1 200 OK\r\nContent-Type: application/x-git-receive-pack-result\r\nCache-Control: no-cache\r\nContent-Length: ',
  'ascii',
);

export const HTTP_200_V2_UPLOAD_PACK_AD = buildHttpBuffer(HTTP_200_UP_AD_PRE, HTTP_KA_SUFFIX, V2_UPLOAD_PACK_AD);

const PUSH_OK_MAIN_INNER = Buffer.concat([
  pktLine('unpack ok\n'),
  pktLine('ok refs/heads/main\n'),
  PKT_FLUSH,
]);
const PUSH_OK_MAIN_SB_BODY = (() => {
  const framed = Buffer.allocUnsafe(PUSH_OK_MAIN_INNER.length + 1);
  framed[0] = 1;
  PUSH_OK_MAIN_INNER.copy(framed, 1);
  return Buffer.concat([pktLine(framed), PKT_FLUSH]);
})();

export const HTTP_PUSH_OK_MAIN_SB = buildHttpBuffer(HTTP_200_RP_RESULT_PRE, HTTP_KA_SUFFIX, PUSH_OK_MAIN_SB_BODY);
export const HTTP_PUSH_OK_MAIN_NOSB = buildHttpBuffer(HTTP_200_RP_RESULT_PRE, HTTP_KA_SUFFIX, PUSH_OK_MAIN_INNER);

const REF_HEADS_MAIN_BUF = Buffer.from('refs/heads/main', 'ascii');
const SIDE_BAND_BUF = Buffer.from('side-band', 'ascii');

function sendSidebandPack(pack: Buffer): Buffer {
  const maxChunk = 65500;
  const numChunks = Math.ceil(pack.length / maxChunk);
  if (numChunks <= 1) {
    const framed = Buffer.allocUnsafe(pack.length + 5);
    framed.write((pack.length + 5).toString(16).padStart(4, '0'), 0, 4, 'ascii');
    framed[4] = 1;
    pack.copy(framed, 5);
    return framed;
  }
  const chunks: Buffer[] = [];
  for (let off = 0; off < pack.length; off += maxChunk) {
    const end = Math.min(off + maxChunk, pack.length);
    const sliceLen = end - off;
    const framed = Buffer.allocUnsafe(sliceLen + 5);
    framed.write((sliceLen + 5).toString(16).padStart(4, '0'), 0, 4, 'ascii');
    framed[4] = 1;
    pack.copy(framed, 5, off, end);
    chunks.push(framed);
  }
  return Buffer.concat(chunks);
}

function isProtoV2(req: HttpRequest): boolean {
  const gp = req.headers['git-protocol'];
  if (!gp) return false;
  const val = Array.isArray(gp) ? gp.join(' ') : gp;
  return val.includes('version=2');
}

function buildInfoRefsBody(repo: Repository, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/${repo.default_branch} agent=git/makefun`
      : RECEIVE_CAPS;

  const refEntries = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const headTarget = repo.refs.get(`refs/heads/${repo.default_branch}`);
  const list: Array<[string, string]> = [];
  if (service === 'git-upload-pack' && headTarget) {
    list.push(['HEAD', headTarget]);
  }
  for (const entry of refEntries) list.push(entry);

  if (list.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    for (let i = 0; i < list.length; i += 1) {
      const [refName, sha] = list[i]!;
      if (i === 0) {
        parts.push(pktLine(`${sha} ${refName}\0${caps}\n`));
      } else {
        parts.push(pktLine(`${sha} ${refName}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

const MAIN_AD_PKT_LEN = 4 + 40 + 1 + 15 + 1 + RECEIVE_CAPS_BUF.length + 1;
const MAIN_AD_BODY_PREFIX = Buffer.concat([
  RECEIVE_PKT_PREAMBLE,
  Buffer.from(MAIN_AD_PKT_LEN.toString(16).padStart(4, '0'), 'ascii'),
]);
const MAIN_AD_BODY_SUFFIX = Buffer.from(` refs/heads/main\0${RECEIVE_CAPS}\n0000`, 'ascii');
const MAIN_AD_TOTAL_BODY_LEN = MAIN_AD_BODY_PREFIX.length + 40 + MAIN_AD_BODY_SUFFIX.length;
const MAIN_AD_HTTP_PREFIX = Buffer.concat([
  HTTP_200_RP_AD_PRE,
  Buffer.from(String(MAIN_AD_TOTAL_BODY_LEN), 'ascii'),
  HTTP_KA_SUFFIX,
  MAIN_AD_BODY_PREFIX,
]);

export function getReceivePackAdHttp(repo: Repository): Buffer {
  if (repo.cachedReceivePackAdHttp !== null) return repo.cachedReceivePackAdHttp;

  if (repo.refs.size === 1) {
    const first = repo.refs.entries().next().value as [string, string];
    const refName = first[0];
    const sha = first[1];
    if (refName === 'refs/heads/main') {
      const out = Buffer.allocUnsafe(MAIN_AD_HTTP_PREFIX.length + 40 + MAIN_AD_BODY_SUFFIX.length);
      MAIN_AD_HTTP_PREFIX.copy(out, 0);
      out.write(sha, MAIN_AD_HTTP_PREFIX.length, 40, 'ascii');
      MAIN_AD_BODY_SUFFIX.copy(out, MAIN_AD_HTTP_PREFIX.length + 40);
      repo.cachedReceivePackAdHttp = out;
      return out;
    }
    const refBytesLen = Buffer.byteLength(refName, 'utf8');
    // pkt-line: 4 (hex len) + 40 (sha) + 1 (' ') + refBytesLen + 1 ('\0') + RECEIVE_CAPS_BUF.length + 1 ('\n')
    const pktLen = 4 + 40 + 1 + refBytesLen + 1 + RECEIVE_CAPS_BUF.length + 1;
    const bodyLen = RECEIVE_PKT_PREAMBLE.length + pktLen + 4;
    const clStr = String(bodyLen);
    const out = Buffer.allocUnsafe(HTTP_200_RP_AD_PRE.length + clStr.length + HTTP_KA_SUFFIX.length + bodyLen);
    let off = 0;
    HTTP_200_RP_AD_PRE.copy(out, off);
    off += HTTP_200_RP_AD_PRE.length;
    off += out.write(clStr, off, 'ascii');
    HTTP_KA_SUFFIX.copy(out, off);
    off += HTTP_KA_SUFFIX.length;

    RECEIVE_PKT_PREAMBLE.copy(out, off);
    off += RECEIVE_PKT_PREAMBLE.length;
    out.write(pktLen.toString(16).padStart(4, '0'), off, 4, 'ascii');
    off += 4;
    out.write(sha, off, 40, 'ascii');
    off += 40;
    out[off++] = 0x20;
    off += out.write(refName, off, 'utf8');
    out[off++] = 0x00;
    RECEIVE_CAPS_BUF.copy(out, off);
    off += RECEIVE_CAPS_BUF.length;
    out[off++] = 0x0a;
    PKT_FLUSH.copy(out, off);
    repo.cachedReceivePackAdHttp = out;
    return out;
  }

  const body = buildInfoRefsBody(repo, 'git-receive-pack');
  const out = buildHttpBuffer(HTTP_200_RP_AD_PRE, HTTP_KA_SUFFIX, body);
  repo.cachedReceivePackAdHttp = out;
  return out;
}

function handleInfoRefs(
  req: HttpRequest,
  res: HttpResponse,
  repo: Repository,
  service: string,
  reqId: string,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': reqId });
    res.end(JSON.stringify({ message: 'Forbidden' }));
    return;
  }

  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && isProtoV2(req)) {
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-cache',
      'content-length': V2_UPLOAD_PACK_AD.length,
      'x-github-request-id': reqId,
    });
    res.end(V2_UPLOAD_PACK_AD);
    return;
  }

  const body = buildInfoRefsBody(repo, service);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'content-length': body.length,
    'x-github-request-id': reqId,
  });
  res.end(body);
}

function handleUploadPackV2Internal(
  repo: Repository,
  body: Buffer,
): { reply: Buffer; cacheKind: 'ls-refs' | 'fetch' | 'none' } {
  const { items } = parsePktLines(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const item of items) {
    if (item.type === 'delim') {
      inArgs = true;
      continue;
    }
    if (item.type === 'flush') break;
    if (item.type === 'data' && item.data) {
      const line = item.data.toString('utf8').replace(/\n$/, '');
      if (!inArgs && line.startsWith('command=')) {
        command = line.slice(8);
      } else if (inArgs) {
        args.push(line);
      }
    }
  }

  if (command === 'ls-refs') {
    let symrefs = false;
    let peel = false;
    const prefixes: string[] = [];
    for (const a of args) {
      if (a === 'symrefs') symrefs = true;
      else if (a === 'peel') peel = true;
      else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice(11));
    }
    const matchesPrefix = (name: string): boolean =>
      prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

    const out: Buffer[] = [];
    const defaultRef = `refs/heads/${repo.default_branch}`;
    const headSha = repo.refs.get(defaultRef);
    if (headSha && matchesPrefix('HEAD')) {
      const suffix = symrefs ? ` symref-target:${defaultRef}` : '';
      out.push(pktLine(`${headSha} HEAD${suffix}\n`));
    }
    const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [refName, sha] of sorted) {
      if (matchesPrefix(refName)) {
        let line = `${sha} ${refName}`;
        if (peel && repo.objects.get(sha)?.type === 'tag') {
          const peeled = peelOid(repo, sha);
          if (peeled !== sha) line += ` peeled:${peeled}`;
        }
        out.push(pktLine(`${line}\n`));
      }
    }
    out.push(PKT_FLUSH);
    return { reply: Buffer.concat(out), cacheKind: 'ls-refs' };
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let deepen: number | undefined;
    let done = false;
    let hasFilterOrExtra = false;
    for (const a of args) {
      if (a.startsWith('want ')) wants.push(a.slice(5).trim());
      else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
      else if (a.startsWith('shallow ')) clientShallow.push(a.slice(8).trim());
      else if (a.startsWith('deepen ')) {
        const n = parseInt(a.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) deepen = n;
      } else if (a === 'done') done = true;
      else if (a.startsWith('filter ') || a.startsWith('deepen-since ') || a.startsWith('deepen-not ')) {
        hasFilterOrExtra = true;
      }
    }

    if (!done && haves.length > 0 && wants.length > 0) {
      return {
        reply: Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]),
        cacheKind: 'none',
      };
    }

    const validWants = wants.filter((w) => repo.objects.has(w));
    const isDepth1Cacheable =
      done &&
      haves.length === 0 &&
      clientShallow.length === 0 &&
      !hasFilterOrExtra &&
      validWants.length === 1 &&
      deepen === 1;
    const cacheKey =
      haves.length === 0 && clientShallow.length === 0 && !hasFilterOrExtra && validWants.length === 1 && deepen !== undefined
        ? `${validWants[0]}:${deepen}`
        : null;
    if (cacheKey !== null) {
      const cached = repo.fetchCache.get(cacheKey);
      if (cached) {
        return { reply: cached, cacheKind: isDepth1Cacheable ? 'fetch' : 'none' };
      }
    }

    const oids = collectReachableObjects(repo, validWants, haves, deepen, clientShallow);
    const pack = buildPackfile(repo, oids);
    const out: Buffer[] = [];

    if (deepen !== undefined) {
      out.push(pktLine('shallow-info\n'));
      const boundary = new Set<string>();
      const queue: Array<{ sha: string; d: number }> = validWants.map((sha) => ({ sha, d: 1 }));
      const seen = new Set<string>();
      let qHead = 0;
      while (qHead < queue.length) {
        const { sha, d } = queue[qHead++]!;
        if (seen.has(sha)) continue;
        seen.add(sha);
        const obj = repo.objects.get(sha);
        if (!obj || obj.type !== 'commit') continue;
        const parsed = parseCommit(obj.data);
        if (d >= deepen) {
          if (parsed.parents.length > 0) boundary.add(sha);
        } else {
          for (const p of parsed.parents) queue.push({ sha: p, d: d + 1 });
        }
      }
      for (const b of boundary) {
        out.push(pktLine(`shallow ${b}\n`));
      }
      for (const s of clientShallow) {
        if (!boundary.has(s) && seen.has(s)) {
          out.push(pktLine(`unshallow ${s}\n`));
        }
      }
      out.push(PKT_DELIM);
    }

    out.push(pktLine('packfile\n'));
    out.push(sendSidebandPack(pack));
    out.push(PKT_FLUSH);
    const result = Buffer.concat(out);
    if (cacheKey !== null) repo.fetchCache.set(cacheKey, result);
    return { reply: result, cacheKind: isDepth1Cacheable ? 'fetch' : 'none' };
  }

  return { reply: PKT_FLUSH, cacheKind: 'none' };
}

export function handleUploadPackV2HttpWithKind(
  repo: Repository,
  body: Buffer,
): { respHttp: Buffer; cacheKind: 'ls-refs' | 'fetch' | 'none' } {
  if (repo.uploadHttpCacheVersion !== repo.refsVersion) {
    repo.lsRefsHttpCache.length = 0;
    repo.fetchHttpCache.length = 0;
    repo.uploadHttpCacheVersion = repo.refsVersion;
  }

  for (let i = 0; i < repo.lsRefsHttpCache.length; i += 1) {
    const entry = repo.lsRefsHttpCache[i]!;
    if (entry.reqBody.equals(body)) return { respHttp: entry.respHttp, cacheKind: 'ls-refs' };
  }
  for (let i = 0; i < repo.fetchHttpCache.length; i += 1) {
    const entry = repo.fetchHttpCache[i]!;
    if (entry.reqBody.equals(body)) return { respHttp: entry.respHttp, cacheKind: 'fetch' };
  }

  const { reply, cacheKind } = handleUploadPackV2Internal(repo, body);
  const respHttp = buildHttpBuffer(HTTP_200_UP_RESULT_PRE, HTTP_KA_SUFFIX, reply);
  if (cacheKind === 'ls-refs' && repo.lsRefsHttpCache.length < 16) {
    repo.lsRefsHttpCache.push({ reqBody: Buffer.from(body), respHttp });
  } else if (cacheKind === 'fetch' && repo.fetchHttpCache.length < 16) {
    repo.fetchHttpCache.push({ reqBody: Buffer.from(body), respHttp });
  }
  return { respHttp, cacheKind };
}

export function handleUploadPackV2Http(repo: Repository, body: Buffer): Buffer {
  return handleUploadPackV2HttpWithKind(repo, body).respHttp;
}

function handleUploadPackV0(repo: Repository, body: Buffer): Buffer {
  const { items } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | undefined;
  let useSideband = false;

  for (const item of items) {
    if (item.type !== 'data' || !item.data) continue;
    const line = item.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const parts = line.slice(5).split(' ');
      if (parts[0]) wants.push(parts[0]);
      if (parts.slice(1).some((c) => c === 'side-band' || c === 'side-band-64k')) useSideband = true;
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }

  const out: Buffer[] = [pktLine('NAK\n')];

  const validWants = wants.filter((w) => repo.objects.has(w));
  const oids = collectReachableObjects(repo, validWants, haves, deepen);
  const pack = buildPackfile(repo, oids);
  if (useSideband) {
    out.push(sendSidebandPack(pack));
    out.push(PKT_FLUSH);
  } else {
    out.push(pack);
  }
  return Buffer.concat(out);
}

function parseHex4(buf: Buffer, off: number): number {
  let val = 0;
  for (let i = 0; i < 4; i += 1) {
    const b = buf[off + i]!;
    let d: number;
    if (b >= 0x30 && b <= 0x39) d = b - 0x30;
    else if (b >= 0x61 && b <= 0x66) d = b - 0x61 + 10;
    else if (b >= 0x41 && b <= 0x46) d = b - 0x41 + 10;
    else return -1;
    val = (val << 4) | d;
  }
  return val;
}

function wrapSidebandReport(reportPayload: Buffer): Buffer {
  const totalLen = reportPayload.length + 5;
  const out = Buffer.allocUnsafe(totalLen + 4);
  out.write(totalLen.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  out[4] = 1;
  reportPayload.copy(out, 5);
  PKT_FLUSH.copy(out, totalLen);
  return out;
}

function handleReceivePackGeneral(store: ForgeStore, repo: Repository, body: Buffer): Buffer {
  const { items, rest } = parsePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; refName: string }> = [];
  let useSideband = false;

  for (const item of items) {
    if (item.type === 'flush') break;
    if (item.type !== 'data' || !item.data) continue;
    let line = item.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      const caps = line.slice(nul + 1).split(' ');
      if (caps.includes('side-band-64k') || caps.includes('side-band')) useSideband = true;
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, refName: parts.slice(2).join(' ') });
    }
  }

  let unpackStatus = 'unpack ok\n';
  if (rest.length >= 4 && rest.readUInt32BE(0) === 0x5041434b) {
    try {
      unpackPackfile(repo, rest);
    } catch (err) {
      unpackStatus = `unpack ${err instanceof Error ? err.message : 'failed'}\n`;
    }
  }

  const reportLines: Buffer[] = [pktLine(unpackStatus)];
  const unpackOk = unpackStatus === 'unpack ok\n';
  let refsMutated = false;

  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(pktLine(`ng ${cmd.refName} unpack failed\n`));
      continue;
    }
    const cur = repo.refs.get(cmd.refName) ?? ZERO_OID;
    if (cmd.newOid === ZERO_OID) {
      if (cur !== cmd.oldOid && cmd.oldOid !== ZERO_OID) {
        reportLines.push(pktLine(`ng ${cmd.refName} non-fast-forward\n`));
      } else {
        repo.refs.delete(cmd.refName);
        refsMutated = true;
        reportLines.push(pktLine(`ok ${cmd.refName}\n`));
      }
      continue;
    }

    if (cur !== cmd.oldOid || !isFastForward(repo, cur, cmd.newOid)) {
      reportLines.push(pktLine(`ng ${cmd.refName} non-fast-forward\n`));
      continue;
    }
    repo.refs.set(cmd.refName, cmd.newOid);
    refsMutated = true;
    reportLines.push(pktLine(`ok ${cmd.refName}\n`));
  }
  reportLines.push(PKT_FLUSH);

  if (refsMutated) {
    invalidateRepoRefs(store, repo);
  } else {
    store.mutationEpoch += 1;
  }

  const reportPayload = Buffer.concat(reportLines);
  return useSideband ? wrapSidebandReport(reportPayload) : reportPayload;
}

export function handleReceivePackHttp(store: ForgeStore, repo: Repository, body: Buffer): Buffer {
  if (body.length >= 90) {
    const pktLen = parseHex4(body, 0);
    if (
      pktLen >= 89 &&
      pktLen + 4 <= body.length &&
      body[pktLen] === 0x30 &&
      body[pktLen + 1] === 0x30 &&
      body[pktLen + 2] === 0x30 &&
      body[pktLen + 3] === 0x30 &&
      body[44] === 0x20 &&
      body[85] === 0x20
    ) {
      const lineEnd = body[pktLen - 1] === 0x0a ? pktLen - 1 : pktLen;
      const nul = body.indexOf(0x00, 86);
      if (nul !== -1 && nul < lineEnd) {
        const refNameLen = nul - 86;
        const isMain = refNameLen === 15 && body.compare(REF_HEADS_MAIN_BUF, 0, 15, 86, nul) === 0;
        const sbIdx = body.indexOf(SIDE_BAND_BUF, nul + 1);
        const useSideband = sbIdx !== -1 && sbIdx < lineEnd;
        const pack = body.subarray(pktLen + 4);

        let unpackErr: string | null = null;
        if (pack.length >= 4 && pack.readUInt32BE(0) === 0x5041434b) {
          try {
            unpackPackfile(repo, pack);
          } catch (err) {
            unpackErr = err instanceof Error ? err.message : 'failed';
          }
        }

        const refName = isMain ? 'refs/heads/main' : body.toString('utf8', 86, nul);
        if (unpackErr !== null) {
          store.mutationEpoch += 1;
          const payload = Buffer.concat([
            pktLine(`unpack ${unpackErr}\n`),
            pktLine(`ng ${refName} unpack failed\n`),
            PKT_FLUSH,
          ]);
          return buildHttpBuffer(HTTP_200_RP_RESULT_PRE, HTTP_KA_SUFFIX, useSideband ? wrapSidebandReport(payload) : payload);
        }

        const oldOid = body.toString('ascii', 4, 44).toLowerCase();
        const newOid = body.toString('ascii', 45, 85).toLowerCase();
        const cur = repo.refs.get(refName) ?? ZERO_OID;

        if (newOid === ZERO_OID) {
          if (cur !== oldOid && oldOid !== ZERO_OID) {
            store.mutationEpoch += 1;
            const payload = Buffer.concat([pktLine('unpack ok\n'), pktLine(`ng ${refName} non-fast-forward\n`), PKT_FLUSH]);
            return buildHttpBuffer(HTTP_200_RP_RESULT_PRE, HTTP_KA_SUFFIX, useSideband ? wrapSidebandReport(payload) : payload);
          }
          repo.refs.delete(refName);
          invalidateRepoRefs(store, repo);
          const payload = Buffer.concat([pktLine('unpack ok\n'), pktLine(`ok ${refName}\n`), PKT_FLUSH]);
          return buildHttpBuffer(HTTP_200_RP_RESULT_PRE, HTTP_KA_SUFFIX, useSideband ? wrapSidebandReport(payload) : payload);
        }

        if (cur === oldOid && isFastForward(repo, cur, newOid)) {
          repo.refs.set(refName, newOid);
          invalidateRepoRefs(store, repo);
          if (isMain) {
            return useSideband ? HTTP_PUSH_OK_MAIN_SB : HTTP_PUSH_OK_MAIN_NOSB;
          }
          const payload = Buffer.concat([pktLine('unpack ok\n'), pktLine(`ok ${refName}\n`), PKT_FLUSH]);
          return buildHttpBuffer(HTTP_200_RP_RESULT_PRE, HTTP_KA_SUFFIX, useSideband ? wrapSidebandReport(payload) : payload);
        }

        store.mutationEpoch += 1;
        const payload = Buffer.concat([pktLine('unpack ok\n'), pktLine(`ng ${refName} non-fast-forward\n`), PKT_FLUSH]);
        return buildHttpBuffer(HTTP_200_RP_RESULT_PRE, HTTP_KA_SUFFIX, useSideband ? wrapSidebandReport(payload) : payload);
      }
    }
  }

  const reply = handleReceivePackGeneral(store, repo, body);
  return buildHttpBuffer(HTTP_200_RP_RESULT_PRE, HTTP_KA_SUFFIX, reply);
}

export function handleGitHttp(
  req: HttpRequest,
  res: HttpResponse,
  store: ForgeStore,
  url: URL,
  body: Buffer,
  reqId: string,
): boolean {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) return false;

  const authHeader = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  if (!store.isAuthorized(authHeader)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': reqId });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }

  const owner = decodeURIComponent(m[1]!);
  const repoName = decodeURIComponent(m[2]!);
  const endpoint = m[3]!;

  const repo = store.resolveRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': reqId });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return true;
  }

  if (req.method === 'GET' && endpoint === 'info/refs') {
    const service = url.searchParams.get('service') ?? '';
    handleInfoRefs(req, res, repo, service, reqId);
    return true;
  }

  if (req.method === 'POST' && endpoint === 'git-upload-pack') {
    const reply = isProtoV2(req) ? handleUploadPackV2Internal(repo, body).reply : handleUploadPackV0(repo, body);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'cache-control': 'no-cache',
      'content-length': reply.length,
      'x-github-request-id': reqId,
    });
    res.end(reply);
    return true;
  }

  if (req.method === 'POST' && endpoint === 'git-receive-pack') {
    const reply = handleReceivePackGeneral(store, repo, body);
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'cache-control': 'no-cache',
      'content-length': reply.length,
      'x-github-request-id': reqId,
    });
    res.end(reply);
    return true;
  }

  return false;
}
