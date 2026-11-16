import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeStore,
  PKT_DELIM,
  PKT_FLUSH,
  buildPackfile,
  collectReachableObjects,
  isAncestor,
  parseCommit,
  parsePktLines,
  peelOid,
  pktLine,
  unpackPackfile,
  type Repository,
} from './store.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';

const V2_UPLOAD_PACK_AD = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=git/makefun\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

function sendSidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const maxChunk = 65500;
  for (let off = 0; off < pack.length; off += maxChunk) {
    const slice = pack.subarray(off, Math.min(off + maxChunk, pack.length));
    const framed = Buffer.allocUnsafe(slice.length + 1);
    framed[0] = 1;
    slice.copy(framed, 1);
    chunks.push(pktLine(framed));
  }
  return Buffer.concat(chunks);
}

function isProtoV2(req: IncomingMessage): boolean {
  const gp = req.headers['git-protocol'];
  if (!gp) return false;
  const val = Array.isArray(gp) ? gp.join(' ') : gp;
  return val.includes('version=2');
}

function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
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

  const parts: Buffer[] = [];
  {
    parts.push(pktLine(`# service=${service}\n`));
    parts.push(PKT_FLUSH);

    const caps =
      service === 'git-upload-pack'
        ? `multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/${repo.default_branch} agent=git/makefun`
        : 'report-status delete-refs side-band-64k ofs-delta atomic agent=git/makefun';

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
  }

  const body = Buffer.concat(parts);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'content-length': body.length,
    'x-github-request-id': reqId,
  });
  res.end(body);
}

function handleUploadPackV2(repo: Repository, body: Buffer): Buffer {
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
    return Buffer.concat(out);
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let deepen: number | undefined;
    let done = false;
    for (const a of args) {
      if (a.startsWith('want ')) wants.push(a.slice(5).trim());
      else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
      else if (a.startsWith('shallow ')) clientShallow.push(a.slice(8).trim());
      else if (a.startsWith('deepen ')) {
        const n = parseInt(a.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) deepen = n;
      } else if (a === 'done') done = true;
    }

    if (!done && haves.length > 0 && wants.length > 0) {
      return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]);
    }

    const validWants = wants.filter((w) => repo.objects.has(w));
    const cacheKey =
      haves.length === 0 && clientShallow.length === 0 && validWants.length === 1 && deepen !== undefined
        ? `${validWants[0]}:${deepen}`
        : null;
    if (cacheKey !== null) {
      const cached = repo.fetchCache.get(cacheKey);
      if (cached) return cached;
    }

    const oids = collectReachableObjects(repo, validWants, haves, deepen, clientShallow);
    const pack = buildPackfile(repo, oids);
    const out: Buffer[] = [];

    if (deepen !== undefined) {
      out.push(pktLine('shallow-info\n'));
      const boundary = new Set<string>();
      const queue: Array<{ sha: string; d: number }> = validWants.map((sha) => ({ sha, d: 1 }));
      const seen = new Set<string>();
      while (queue.length > 0) {
        const { sha, d } = queue.shift()!;
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
    return result;
  }

  return PKT_FLUSH;
}

function handleUploadPackV0(repo: Repository, body: Buffer): Buffer {
  const { items } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | undefined;
  let useSideband = false;
  let done = false;

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
    } else if (line === 'done') {
      done = true;
    }
  }

  const out: Buffer[] = [];
  if (deepen !== undefined && !done) {
    // Wait for done
  }
  out.push(pktLine('NAK\n'));

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

function handleReceivePack(repo: Repository, body: Buffer): Buffer {
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
  if (rest.length > 0 && rest.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      unpackPackfile(repo, rest);
    } catch (err) {
      unpackStatus = `unpack ${err instanceof Error ? err.message : 'failed'}\n`;
    }
  }

  const reportLines: Buffer[] = [pktLine(unpackStatus)];
  const unpackOk = unpackStatus === 'unpack ok\n';

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
        reportLines.push(pktLine(`ok ${cmd.refName}\n`));
      }
      continue;
    }

    if (cur !== cmd.oldOid) {
      reportLines.push(pktLine(`ng ${cmd.refName} non-fast-forward\n`));
      continue;
    }
    if (cur !== ZERO_OID && !isAncestor(repo, cur, cmd.newOid)) {
      reportLines.push(pktLine(`ng ${cmd.refName} non-fast-forward\n`));
      continue;
    }
    repo.refs.set(cmd.refName, cmd.newOid);
    reportLines.push(pktLine(`ok ${cmd.refName}\n`));
  }
  reportLines.push(PKT_FLUSH);

  const reportPayload = Buffer.concat(reportLines);
  if (!useSideband) return reportPayload;

  const framed = Buffer.allocUnsafe(reportPayload.length + 1);
  framed[0] = 1;
  reportPayload.copy(framed, 1);
  return Buffer.concat([pktLine(framed), PKT_FLUSH]);
}

export function handleGitHttp(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  url: URL,
  body: Buffer,
  reqId: string,
): boolean {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) return false;

  if (!store.isAuthorized(req.headers.authorization)) {
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
    const reply = isProtoV2(req) ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
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
    const reply = handleReceivePack(repo, body);
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
