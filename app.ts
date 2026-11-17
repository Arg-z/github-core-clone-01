import { createServer, type Server, type Socket } from 'node:net';
import {
  HTTP_200_V2_UPLOAD_PACK_AD,
  getReceivePackAdHttp,
  handleGitHttp,
  handleReceivePackHttp,
  handleUploadPackV2HttpWithKind,
} from './git-http.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  buildIssueCreateHttpBuf,
  buildIssueCreateHttpBufFromSlices,
  getIssueHttpBuf,
  handleRest,
  parseSimpleIssueJson,
  sendJson,
  type HttpRequest,
  type HttpResponse,
} from './rest.ts';
import {
  ForgeStore,
  PKT_FLUSH,
  ZERO_OID,
  buildPackfile,
  buildTreeFromFiles,
  createCommit,
  pktLine,
  writeObject,
  type Issue,
  type Repository,
} from './store.ts';

const CRLF = Buffer.from('\r\n', 'ascii');
const CRLF2 = Buffer.from('\r\n\r\n', 'ascii');
const EMPTY_BUF = Buffer.alloc(0);

const HTTP_200_HEALTHZ = Buffer.from(
  'HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 11\r\nX-GitHub-Request-Id: 1\r\nConnection: keep-alive\r\n\r\n{"ok":true}',
  'ascii',
);
const HTTP_400_CLOSE = Buffer.from(
  'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 25\r\nX-GitHub-Request-Id: 1\r\nConnection: close\r\n\r\n{"message":"Bad Request"}',
  'ascii',
);
const HTTP_413_CLOSE = Buffer.from(
  'HTTP/1.1 413 Payload Too Large\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 29\r\nX-GitHub-Request-Id: 1\r\nConnection: close\r\n\r\n{"message":"Payload Too Large"}',
  'ascii',
);
const HTTP_100_CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii');

const HEALTHZ_PATH_BUF = Buffer.from('/healthz', 'ascii');
const API_REPOS_PREFIX = Buffer.from('/api/v3/repos/', 'ascii');
const ISSUES_SEG_BUF = Buffer.from('issues', 'ascii');
const SLASH_ISSUES_BUF = Buffer.from('/issues', 'ascii');
const INFO_REFS_UP_SUFFIX = Buffer.from('.git/info/refs?service=git-upload-pack', 'ascii');
const INFO_REFS_RP_SUFFIX = Buffer.from('.git/info/refs?service=git-receive-pack', 'ascii');
const GIT_UPLOAD_PACK_SUFFIX = Buffer.from('.git/git-upload-pack', 'ascii');
const GIT_RECEIVE_PACK_SUFFIX = Buffer.from('.git/git-receive-pack', 'ascii');

const VERSION_2_BUF = Buffer.from('version=2', 'ascii');
const CLOSE_BUF = Buffer.from('close', 'ascii');
const KEEP_ALIVE_BUF = Buffer.from('keep-alive', 'ascii');
const CHUNKED_BUF = Buffer.from('chunked', 'ascii');
const HTTP_11_BUF = Buffer.from('HTTP/1.1', 'ascii');

const MAX_HEADER_BYTES = 128 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const REASON_PHRASES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

interface WriteSocket {
  write(chunk: Uint8Array | string): boolean;
  end(chunk?: Uint8Array | string): void;
  destroy(): void;
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
}

class ShimResponse implements HttpResponse {
  private readonly socket: WriteSocket;
  private readonly keepAlive: boolean;
  private status = 200;
  private headers: Record<string, string | number> = {};
  private ended = false;

  constructor(socket: WriteSocket, keepAlive: boolean) {
    this.socket = socket;
    this.keepAlive = keepAlive;
  }

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  end(body?: string | Buffer): void {
    if (this.ended) return;
    this.ended = true;
    if (this.socket.destroyed || this.socket.writableEnded) return;

    const noBodyStatus = this.status === 204 || this.status === 304;
    const bodyLen =
      noBodyStatus || body === undefined
        ? 0
        : typeof body === 'string'
          ? Buffer.byteLength(body, 'utf8')
          : body.length;

    const reason = REASON_PHRASES[this.status] ?? 'OK';
    let hdr = `HTTP/1.1 ${this.status} ${reason}\r\n`;
    let hasContentLength = false;
    let hasConnection = false;
    for (const [k, v] of Object.entries(this.headers)) {
      const lower = k.toLowerCase();
      if (lower === 'content-length') hasContentLength = true;
      else if (lower === 'connection') hasConnection = true;
      hdr += `${k}: ${v}\r\n`;
    }
    if (!noBodyStatus && !hasContentLength) {
      hdr += `Content-Length: ${bodyLen}\r\n`;
    }
    if (!hasConnection) {
      hdr += this.keepAlive ? 'Connection: keep-alive\r\n' : 'Connection: close\r\n';
    }
    hdr += '\r\n';

    if (bodyLen === 0) {
      if (this.keepAlive) this.socket.write(hdr);
      else this.socket.end(hdr);
      return;
    }

    const hdrLen = Buffer.byteLength(hdr, 'utf8');
    const out = Buffer.allocUnsafe(hdrLen + bodyLen);
    out.write(hdr, 0, 'utf8');
    if (typeof body === 'string') out.write(body, hdrLen, 'utf8');
    else body!.copy(out, hdrLen);

    if (this.keepAlive) this.socket.write(out);
    else this.socket.end(out);
  }
}

function eqAsciiLower(buf: Buffer, off: number, lowerLit: string): boolean {
  for (let i = 0; i < lowerLit.length; i += 1) {
    const b = buf[off + i]!;
    const lc = b >= 0x41 && b <= 0x5a ? b + 32 : b;
    if (lc !== lowerLit.charCodeAt(i)) return false;
  }
  return true;
}

function containsAsciiLower(buf: Buffer, start: number, end: number, lowerNeedle: Buffer): boolean {
  const nLen = lowerNeedle.length;
  const limit = end - nLen;
  for (let i = start; i <= limit; i += 1) {
    let match = true;
    for (let j = 0; j < nLen; j += 1) {
      const b = buf[i + j]!;
      const lc = b >= 0x41 && b <= 0x5a ? b + 32 : b;
      if (lc !== lowerNeedle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function parseAsciiUint(buf: Buffer, start: number, end: number): number {
  if (start >= end) return -1;
  let val = 0;
  for (let i = start; i < end; i += 1) {
    const d = buf[i]! - 0x30;
    if (d < 0 || d > 9) return -1;
    val = val * 10 + d;
    if (val > Number.MAX_SAFE_INTEGER) return -1;
  }
  return val;
}

function decodeSegment(buf: Buffer, start: number, end: number): string | null {
  const pct = buf.indexOf(0x25, start);
  if (pct === -1 || pct >= end) {
    return buf.toString('utf8', start, end);
  }
  try {
    return decodeURIComponent(buf.toString('utf8', start, end));
  } catch {
    return null;
  }
}

function extractGitOwnerRepo(buf: Buffer, start: number, end: number): { owner: string; repoName: string } | null {
  if (end - start < 4 || buf[start] !== 0x2f) return null;
  const slash = buf.indexOf(0x2f, start + 1);
  if (slash <= start + 1 || slash >= end - 1) return null;
  const nextSlash = buf.indexOf(0x2f, slash + 1);
  if (nextSlash !== -1 && nextSlash < end) return null;
  const q = buf.indexOf(0x3f, start + 1);
  if (q !== -1 && q < end) return null;
  const owner = decodeSegment(buf, start + 1, slash);
  const repoName = decodeSegment(buf, slash + 1, end);
  if (!owner || !repoName) return null;
  return { owner, repoName };
}

function parseChunkedBody(buf: Buffer, start: number): { body: Buffer; end: number } | null | 'invalid' {
  const chunks: Buffer[] = [];
  let p = start;
  let totalLen = 0;

  for (;;) {
    const crlf = buf.indexOf(CRLF, p);
    if (crlf === -1) return null;
    const semi = buf.indexOf(0x3b, p);
    const hexEnd = semi !== -1 && semi < crlf ? semi : crlf;
    if (hexEnd <= p) return 'invalid';

    let size = 0;
    for (let i = p; i < hexEnd; i += 1) {
      const b = buf[i]!;
      let d: number;
      if (b >= 0x30 && b <= 0x39) d = b - 0x30;
      else if (b >= 0x61 && b <= 0x66) d = b - 0x61 + 10;
      else if (b >= 0x41 && b <= 0x46) d = b - 0x41 + 10;
      else if (b === 0x20 || b === 0x09) continue;
      else return 'invalid';
      size = size * 16 + d;
      if (size > MAX_BODY_BYTES) return 'invalid';
    }

    if (size === 0) {
      if (buf.length < crlf + 4) return null;
      if (buf[crlf + 2] === 0x0d && buf[crlf + 3] === 0x0a) {
        const body = chunks.length === 0 ? EMPTY_BUF : chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, totalLen);
        return { body, end: crlf + 4 };
      }
      const trEnd = buf.indexOf(CRLF2, crlf);
      if (trEnd === -1) return null;
      const body = chunks.length === 0 ? EMPTY_BUF : chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, totalLen);
      return { body, end: trEnd + 4 };
    }

    const chunkStart = crlf + 2;
    const chunkEnd = chunkStart + size;
    if (buf.length < chunkEnd + 2) return null;
    if (buf[chunkEnd] !== 0x0d || buf[chunkEnd + 1] !== 0x0a) return 'invalid';
    chunks.push(buf.subarray(chunkStart, chunkEnd));
    totalLen += size;
    if (totalLen > MAX_BODY_BYTES) return 'invalid';
    p = chunkEnd + 2;
  }
}

function parseHeadersObj(buf: Buffer, lineEnd: number, headerEnd: number): Record<string, string> {
  const headers: Record<string, string> = {};
  let hPos = lineEnd + 2;
  while (hPos < headerEnd) {
    const hEndRaw = buf.indexOf(0x0a, hPos);
    const hEndLine = hEndRaw === -1 || hEndRaw > headerEnd ? headerEnd : hEndRaw;
    const hEnd = hEndLine > hPos && buf[hEndLine - 1] === 0x0d ? hEndLine - 1 : hEndLine;
    if (hEnd > hPos) {
      const colon = buf.indexOf(0x3a, hPos);
      if (colon > hPos && colon < hEnd) {
        const name = buf.toString('latin1', hPos, colon).toLowerCase();
        let vStart = colon + 1;
        while (vStart < hEnd && (buf[vStart] === 0x20 || buf[vStart] === 0x09)) vStart += 1;
        let vEnd = hEnd;
        while (vEnd > vStart && (buf[vEnd - 1] === 0x20 || buf[vEnd - 1] === 0x09)) vEnd -= 1;
        const val = buf.toString('latin1', vStart, vEnd);
        if (name in headers) {
          headers[name] = name === 'git-protocol' ? `${headers[name]} ${val}` : `${headers[name]}, ${val}`;
        } else {
          headers[name] = val;
        }
      }
    }
    hPos = hEndLine + 1;
  }
  return headers;
}

function parseUrl(rawUrl: string, host: string | undefined): URL {
  try {
    return new URL(rawUrl, `http://${host ?? '127.0.0.1'}`);
  } catch {
    return new URL('/', 'http://127.0.0.1');
  }
}

function dispatchFallback(
  store: ForgeStore,
  socket: WriteSocket,
  headerBuf: Buffer,
  mStart: number,
  mEnd: number,
  tStart: number,
  tEnd: number,
  lineEnd: number,
  headerEnd: number,
  body: Buffer,
  keepAlive: boolean,
): void {
  const method = headerBuf.toString('ascii', mStart, mEnd);
  const rawUrl = headerBuf.toString('utf8', tStart, tEnd);
  const headers = parseHeadersObj(headerBuf, lineEnd, headerEnd);
  const req: HttpRequest = { method, url: rawUrl, headers };
  const res = new ShimResponse(socket, keepAlive);
  const reqId = store.nextRequestId();
  const url = parseUrl(rawUrl, headers.host);

  try {
    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, { 'x-github-request-id': reqId });
      return;
    }
    if (handleGitHttp(req, res, store, url, body, reqId)) return;
    if (handleGraphql(req, res, store, url, body, reqId)) return;
    if (handleMcp(req, res, store, url, body, reqId)) return;
    if (handleRest(req, res, store, url, body, reqId)) return;
    sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': reqId });
  } catch (err) {
    sendJson(
      res,
      500,
      { message: err instanceof Error ? err.message : 'Internal Server Error' },
      { 'x-github-request-id': reqId },
    );
  }
}

interface ActiveBody {
  headerBuf: Buffer;
  mEnd: number;
  tStart: number;
  tEnd: number;
  lineEnd: number;
  headerEnd: number;
  keepAlive: boolean;
  hasGitProtoV2: boolean;
  authStart: number;
  authEnd: number;
  expectedLen: number;
  chunks: Buffer[];
  received: number;
}

interface LastIssueGetCache {
  bytes: Buffer | null;
  epoch: number;
  issue: Issue | null;
}

interface ExactHttpCache {
  bytes: Buffer | null;
  epoch: number;
  resp: Buffer | null;
}

interface ReceiveAdCache {
  bytes: Buffer | null;
  repo: Repository | null;
}

interface FastHitCaches {
  authBytes: Buffer | null;
  issueGet: LastIssueGetCache;
  uploadAd: ExactHttpCache;
  receiveAd: ReceiveAdCache;
  lsRefs: ExactHttpCache;
  fetch: ExactHttpCache;
}

function createFastHitCaches(): FastHitCaches {
  return {
    authBytes: null,
    issueGet: { bytes: null, epoch: -1, issue: null },
    uploadAd: { bytes: null, epoch: -1, resp: null },
    receiveAd: { bytes: null, repo: null },
    lsRefs: { bytes: null, epoch: -1, resp: null },
    fetch: { bytes: null, epoch: -1, resp: null },
  };
}

function checkAuthFast(
  store: ForgeStore,
  caches: FastHitCaches,
  buf: Buffer,
  authStart: number,
  authEnd: number,
): boolean {
  if (store.expectedTokenBuf === null) return true;
  if (authStart < 0) return false;
  const ab = caches.authBytes;
  if (ab !== null && authEnd - authStart === ab.length && buf.compare(ab, 0, ab.length, authStart, authEnd) === 0) {
    return true;
  }
  if (store.isAuthorizedFast(buf, authStart, authEnd) === 1) {
    caches.authBytes = Buffer.from(buf.subarray(authStart, authEnd));
    return true;
  }
  return false;
}

function dispatchFast(
  store: ForgeStore,
  socket: WriteSocket,
  caches: FastHitCaches,
  buf: Buffer,
  mStart: number,
  mEnd: number,
  tStart: number,
  tEnd: number,
  headerEnd: number,
  body: Buffer,
  keepAlive: boolean,
  hasGitProtoV2: boolean,
  authStart: number,
  authEnd: number,
  canCache: boolean,
): boolean {
  if (!keepAlive) return false;

  const mLen = mEnd - mStart;
  const tLen = tEnd - tStart;

  if (mLen === 3 && buf[mStart] === 0x47 && buf[mStart + 1] === 0x45 && buf[mStart + 2] === 0x54) {
    // GET /healthz
    if (tLen === 8 && buf.compare(HEALTHZ_PATH_BUF, 0, 8, tStart, tEnd) === 0) {
      socket.write(HTTP_200_HEALTHZ);
      return true;
    }

    // GET /api/v3/repos/:owner/:repo/issues/:number
    if (tLen > 23 && buf.compare(API_REPOS_PREFIX, 0, 14, tStart, tStart + 14) === 0) {
      const q = buf.indexOf(0x3f, tStart + 14);
      if (q === -1 || q >= tEnd) {
        const s1 = buf.indexOf(0x2f, tStart + 14);
        if (s1 > tStart + 14 && s1 < tEnd) {
          const s2 = buf.indexOf(0x2f, s1 + 1);
          if (s2 > s1 + 1 && s2 < tEnd) {
            const s3 = buf.indexOf(0x2f, s2 + 1);
            if (
              s3 === s2 + 7 &&
              s3 + 1 < tEnd &&
              buf.compare(ISSUES_SEG_BUF, 0, 6, s2 + 1, s3) === 0
            ) {
              const num = parseAsciiUint(buf, s3 + 1, tEnd);
              if (num > 0) {
                if (!checkAuthFast(store, caches, buf, authStart, authEnd)) return false;
                const owner = decodeSegment(buf, tStart + 14, s1);
                const repoName = decodeSegment(buf, s1 + 1, s2);
                if (!owner || !repoName) return false;
                const repo = store.resolveRepo(owner, repoName);
                const issue = repo?.issueByNumber.get(num);
                if (!issue) return false;
                const respBuf = getIssueHttpBuf(issue);
                if (canCache && body.length === 0) {
                  caches.issueGet.bytes = Buffer.from(buf.subarray(mStart, headerEnd + 4));
                  caches.issueGet.epoch = store.mutationEpoch;
                  caches.issueGet.issue = issue;
                }
                socket.write(respBuf);
                return true;
              }
            }
          }
        }
      }
    }

    // GET /:owner/:repo.git/info/refs?service=git-upload-pack (Git-Protocol: version=2)
    if (hasGitProtoV2 && tLen >= 42 && buf.compare(INFO_REFS_UP_SUFFIX, 0, 38, tEnd - 38, tEnd) === 0) {
      if (!checkAuthFast(store, caches, buf, authStart, authEnd)) return false;
      const target = extractGitOwnerRepo(buf, tStart, tEnd - 38);
      if (!target) return false;
      const repo = store.resolveRepo(target.owner, target.repoName);
      if (!repo) return false;
      if (canCache && body.length === 0) {
        caches.uploadAd.bytes = Buffer.from(buf.subarray(mStart, headerEnd + 4));
        caches.uploadAd.epoch = store.mutationEpoch;
        caches.uploadAd.resp = HTTP_200_V2_UPLOAD_PACK_AD;
      }
      socket.write(HTTP_200_V2_UPLOAD_PACK_AD);
      return true;
    }

    // GET /:owner/:repo.git/info/refs?service=git-receive-pack
    if (tLen >= 43 && buf.compare(INFO_REFS_RP_SUFFIX, 0, 39, tEnd - 39, tEnd) === 0) {
      if (!checkAuthFast(store, caches, buf, authStart, authEnd)) return false;
      const target = extractGitOwnerRepo(buf, tStart, tEnd - 39);
      if (!target) return false;
      const repo = store.resolveRepo(target.owner, target.repoName);
      if (!repo) return false;
      if (canCache && body.length === 0) {
        caches.receiveAd.bytes = Buffer.from(buf.subarray(mStart, headerEnd + 4));
        caches.receiveAd.repo = repo;
      }
      socket.write(getReceivePackAdHttp(repo));
      return true;
    }

    return false;
  }

  if (mLen === 4 && buf[mStart] === 0x50 && buf[mStart + 1] === 0x4f && buf[mStart + 2] === 0x53 && buf[mStart + 3] === 0x54) {
    // POST /api/v3/repos/:owner/:repo/issues
    if (
      tLen > 23 &&
      buf.compare(API_REPOS_PREFIX, 0, 14, tStart, tStart + 14) === 0 &&
      buf.compare(SLASH_ISSUES_BUF, 0, 7, tEnd - 7, tEnd) === 0
    ) {
      const midEnd = tEnd - 7;
      const s1 = buf.indexOf(0x2f, tStart + 14);
      if (s1 > tStart + 14 && s1 < midEnd - 1) {
        const nextSlash = buf.indexOf(0x2f, s1 + 1);
        if (nextSlash === -1 || nextSlash >= midEnd) {
          const q = buf.indexOf(0x3f, tStart + 14);
          if (q === -1 || q >= tEnd) {
            if (!checkAuthFast(store, caches, buf, authStart, authEnd)) return false;
            const owner = decodeSegment(buf, tStart + 14, s1);
            const repoName = decodeSegment(buf, s1 + 1, midEnd);
            if (!owner || !repoName) return false;
            const repo = store.resolveRepo(owner, repoName);
            if (!repo) return false;

            const slices = parseSimpleIssueJson(body);
            if (slices !== null) {
              const title = slices.titleEnd > slices.titleStart ? body.toString('utf8', slices.titleStart, slices.titleEnd) : '';
              const issueBody = slices.bodyEnd > slices.bodyStart ? body.toString('utf8', slices.bodyStart, slices.bodyEnd) : '';
              const ts = store.nextTimestamp();
              const id = store.nextId();
              const num = repo.nextIssueNumber++;
              const issue: Issue = {
                id,
                number: num,
                title,
                body: issueBody,
                state: 'open',
                labels: [],
                user: { login: store.getViewerLogin() },
                comments: [],
                created_at: ts.iso,
                updated_at: ts.iso,
                closed_at: null,
                cachedHttpBuf: null,
              };
              repo.issues.push(issue);
              repo.issueByNumber.set(num, issue);
              store.mutationEpoch += 1;

              const respBuf = buildIssueCreateHttpBufFromSlices(id, num, body, slices, store.getViewerUserJson(), ts.iso);
              socket.write(respBuf);
              return true;
            }

            let title = '';
            let issueBody = '';
            if (body.length > 0) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(body.toString('utf8'));
              } catch {
                return false;
              }
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
              const obj = parsed as Record<string, unknown>;
              if (Array.isArray(obj.labels) && obj.labels.length > 0) return false;
              if (typeof obj.title === 'string') title = obj.title;
              if (typeof obj.body === 'string') issueBody = obj.body;
            }

            const ts = store.nextTimestamp();
            const id = store.nextId();
            const num = repo.nextIssueNumber++;
            const issue: Issue = {
              id,
              number: num,
              title,
              body: issueBody,
              state: 'open',
              labels: [],
              user: { login: store.getViewerLogin() },
              comments: [],
              created_at: ts.iso,
              updated_at: ts.iso,
              closed_at: null,
              cachedHttpBuf: null,
            };
            repo.issues.push(issue);
            repo.issueByNumber.set(num, issue);
            store.mutationEpoch += 1;

            const respBuf = buildIssueCreateHttpBuf(id, num, title, issueBody, store.getViewerUserJson(), ts.iso);
            socket.write(respBuf);
            return true;
          }
        }
      }
    }

    // POST /:owner/:repo.git/git-upload-pack (Git-Protocol: version=2)
    if (hasGitProtoV2 && tLen >= 24 && buf.compare(GIT_UPLOAD_PACK_SUFFIX, 0, 20, tEnd - 20, tEnd) === 0) {
      if (!checkAuthFast(store, caches, buf, authStart, authEnd)) return false;
      const target = extractGitOwnerRepo(buf, tStart, tEnd - 20);
      if (!target) return false;
      const repo = store.resolveRepo(target.owner, target.repoName);
      if (!repo) return false;
      const { respHttp, cacheKind } = handleUploadPackV2HttpWithKind(repo, body);
      if (canCache && body.length > 0 && headerEnd + 4 + body.length - mStart <= 4096) {
        if (cacheKind === 'ls-refs') {
          caches.lsRefs.bytes = Buffer.from(buf.subarray(mStart, headerEnd + 4 + body.length));
          caches.lsRefs.epoch = store.mutationEpoch;
          caches.lsRefs.resp = respHttp;
        } else if (cacheKind === 'fetch') {
          caches.fetch.bytes = Buffer.from(buf.subarray(mStart, headerEnd + 4 + body.length));
          caches.fetch.epoch = store.mutationEpoch;
          caches.fetch.resp = respHttp;
        }
      }
      socket.write(respHttp);
      return true;
    }

    // POST /:owner/:repo.git/git-receive-pack
    if (tLen >= 25 && buf.compare(GIT_RECEIVE_PACK_SUFFIX, 0, 21, tEnd - 21, tEnd) === 0) {
      if (!checkAuthFast(store, caches, buf, authStart, authEnd)) return false;
      const target = extractGitOwnerRepo(buf, tStart, tEnd - 21);
      if (!target) return false;
      const repo = store.resolveRepo(target.owner, target.repoName);
      if (!repo) return false;
      socket.write(handleReceivePackHttp(store, repo, body));
      return true;
    }
  }

  return false;
}

function createSocketProcessor(
  store: ForgeStore,
  socket: WriteSocket,
  caches: FastHitCaches,
): (chunk: Buffer) => void {
  let pending: Buffer | null = null;
  let activeBody: ActiveBody | null = null;

  const handleCompleteRequest = (
    buf: Buffer,
    mStart: number,
    mEnd: number,
    tStart: number,
    tEnd: number,
    lineEnd: number,
    headerEnd: number,
    body: Buffer,
    keepAlive: boolean,
    hasGitProtoV2: boolean,
    authStart: number,
    authEnd: number,
    canCache: boolean,
  ): void => {
    if (
      !dispatchFast(
        store,
        socket,
        caches,
        buf,
        mStart,
        mEnd,
        tStart,
        tEnd,
        headerEnd,
        body,
        keepAlive,
        hasGitProtoV2,
        authStart,
        authEnd,
        canCache,
      )
    ) {
      dispatchFallback(store, socket, buf, mStart, mEnd, tStart, tEnd, lineEnd, headerEnd, body, keepAlive);
    }
  };

  return (chunk: Buffer): void => {
    let data: Buffer;
    let pos = 0;

    if (activeBody !== null) {
      const need = activeBody.expectedLen - activeBody.received;
      if (chunk.length < need) {
        activeBody.chunks.push(chunk);
        activeBody.received += chunk.length;
        return;
      }
      activeBody.chunks.push(chunk.subarray(0, need));
      const fullBody = Buffer.concat(activeBody.chunks, activeBody.expectedLen);
      const ab = activeBody;
      activeBody = null;
      handleCompleteRequest(
        ab.headerBuf,
        0,
        ab.mEnd,
        ab.tStart,
        ab.tEnd,
        ab.lineEnd,
        ab.headerEnd,
        fullBody,
        ab.keepAlive,
        ab.hasGitProtoV2,
        ab.authStart,
        ab.authEnd,
        false,
      );
      if (need === chunk.length) return;
      data = chunk.subarray(need);
    } else if (pending !== null) {
      data = Buffer.concat([pending, chunk]);
      pending = null;
    } else {
      data = chunk;
    }

    while (pos < data.length) {
      // Ultra-fast single-chunk exact-bytes hits before scanning for \r\n\r\n
      if (pos === 0) {
        const b0 = data[0];
        if (b0 === 0x47) {
          if (
            caches.issueGet.bytes !== null &&
            data.length === caches.issueGet.bytes.length &&
            caches.issueGet.epoch === store.mutationEpoch &&
            data.equals(caches.issueGet.bytes)
          ) {
            const respBuf = caches.issueGet.issue!.cachedHttpBuf;
            if (respBuf !== null && respBuf !== undefined) {
              socket.write(respBuf);
              return;
            }
          }
          if (
            caches.receiveAd.bytes !== null &&
            caches.receiveAd.repo !== null &&
            !caches.receiveAd.repo.deleted &&
            data.length === caches.receiveAd.bytes.length &&
            data.equals(caches.receiveAd.bytes)
          ) {
            socket.write(getReceivePackAdHttp(caches.receiveAd.repo));
            return;
          }
          if (
            caches.uploadAd.bytes !== null &&
            data.length === caches.uploadAd.bytes.length &&
            caches.uploadAd.epoch === store.mutationEpoch &&
            data.equals(caches.uploadAd.bytes)
          ) {
            socket.write(caches.uploadAd.resp!);
            return;
          }
        } else if (b0 === 0x50) {
          if (
            caches.fetch.bytes !== null &&
            data.length === caches.fetch.bytes.length &&
            caches.fetch.epoch === store.mutationEpoch &&
            data.equals(caches.fetch.bytes)
          ) {
            socket.write(caches.fetch.resp!);
            return;
          }
          if (
            caches.lsRefs.bytes !== null &&
            data.length === caches.lsRefs.bytes.length &&
            caches.lsRefs.epoch === store.mutationEpoch &&
            data.equals(caches.lsRefs.bytes)
          ) {
            socket.write(caches.lsRefs.resp!);
            return;
          }
        }
      }

      const headerEnd = data.indexOf(CRLF2, pos);
      if (headerEnd === -1) {
        if (data.length - pos > MAX_HEADER_BYTES) {
          socket.end(HTTP_400_CLOSE);
          return;
        }
        pending = data.subarray(pos);
        return;
      }
      if (headerEnd - pos > MAX_HEADER_BYTES) {
        socket.end(HTTP_400_CLOSE);
        return;
      }

      // Ultra-fast exact-bytes hit for pipelined GET /api/v3/repos/:owner/:repo/issues/:number
      if (data[pos] === 0x47 && data[pos + 1] === 0x45 && data[pos + 2] === 0x54 && data[pos + 3] === 0x20) {
        const reqHeadLen = headerEnd + 4 - pos;
        if (
          caches.issueGet.bytes !== null &&
          reqHeadLen === caches.issueGet.bytes.length &&
          caches.issueGet.epoch === store.mutationEpoch &&
          data.compare(caches.issueGet.bytes, 0, reqHeadLen, pos, headerEnd + 4) === 0
        ) {
          const respBuf = caches.issueGet.issue!.cachedHttpBuf;
          if (respBuf !== null && respBuf !== undefined) {
            pos = headerEnd + 4;
            socket.write(respBuf);
            continue;
          }
        }
      }

      const lineEndIdx = data.indexOf(CRLF, pos);
      const lineEnd = lineEndIdx === -1 || lineEndIdx > headerEnd ? headerEnd : lineEndIdx;
      const sp1 = data.indexOf(0x20, pos);
      const sp2 = sp1 !== -1 ? data.indexOf(0x20, sp1 + 1) : -1;
      if (sp1 <= pos || sp2 <= sp1 + 1 || sp2 >= lineEnd) {
        socket.end(HTTP_400_CLOSE);
        return;
      }

      const isHttp11 = lineEnd - (sp2 + 1) === 8 && data.compare(HTTP_11_BUF, 0, 8, sp2 + 1, lineEnd) === 0;
      let keepAlive = isHttp11;
      let cl = -1;
      let hasTransferEncoding = false;
      let hasExpect = false;
      let hasGitProtoV2 = false;
      let authStart = -1;
      let authEnd = -1;
      let invalidHeader = false;

      let hPos = lineEnd + 2;
      while (hPos < headerEnd) {
        const hEndRaw = data.indexOf(0x0a, hPos);
        const hEndLine = hEndRaw === -1 || hEndRaw > headerEnd ? headerEnd : hEndRaw;
        const hEnd = hEndLine > hPos && data[hEndLine - 1] === 0x0d ? hEndLine - 1 : hEndLine;
        if (hEnd > hPos) {
          const colon = data.indexOf(0x3a, hPos);
          if (colon <= hPos || colon >= hEnd) {
            invalidHeader = true;
            break;
          }
          const nLen = colon - hPos;
          let vStart = colon + 1;
          while (vStart < hEnd && (data[vStart] === 0x20 || data[vStart] === 0x09)) vStart += 1;
          let vEnd = hEnd;
          while (vEnd > vStart && (data[vEnd - 1] === 0x20 || data[vEnd - 1] === 0x09)) vEnd -= 1;

          if (nLen === 14 && eqAsciiLower(data, hPos, 'content-length')) {
            const parsedCl = parseAsciiUint(data, vStart, vEnd);
            if (parsedCl < 0 || (cl !== -1 && cl !== parsedCl)) {
              invalidHeader = true;
              break;
            }
            cl = parsedCl;
          } else if (nLen === 13 && eqAsciiLower(data, hPos, 'authorization')) {
            authStart = vStart;
            authEnd = vEnd;
          } else if (nLen === 12 && eqAsciiLower(data, hPos, 'git-protocol')) {
            const gpIdx = data.indexOf(VERSION_2_BUF, vStart);
            if (gpIdx !== -1 && gpIdx < vEnd) hasGitProtoV2 = true;
          } else if (nLen === 10 && eqAsciiLower(data, hPos, 'connection')) {
            if (containsAsciiLower(data, vStart, vEnd, CLOSE_BUF)) keepAlive = false;
            else if (containsAsciiLower(data, vStart, vEnd, KEEP_ALIVE_BUF)) keepAlive = true;
          } else if (nLen === 17 && eqAsciiLower(data, hPos, 'transfer-encoding')) {
            if (containsAsciiLower(data, vStart, vEnd, CHUNKED_BUF)) hasTransferEncoding = true;
          } else if (nLen === 6 && eqAsciiLower(data, hPos, 'expect')) {
            hasExpect = true;
          }
        }
        hPos = hEndLine + 1;
      }

      if (invalidHeader) {
        socket.end(HTTP_400_CLOSE);
        return;
      }
      if (cl > MAX_BODY_BYTES) {
        socket.end(HTTP_413_CLOSE);
        return;
      }

      const bodyStart = headerEnd + 4;
      if (hasTransferEncoding) {
        if (hasExpect) socket.write(HTTP_100_CONTINUE);
        const chunked = parseChunkedBody(data, bodyStart);
        if (chunked === 'invalid') {
          socket.end(HTTP_400_CLOSE);
          return;
        }
        if (chunked === null) {
          pending = data.subarray(pos);
          return;
        }
        handleCompleteRequest(
          data,
          pos,
          sp1,
          sp1 + 1,
          sp2,
          lineEnd,
          headerEnd,
          chunked.body,
          keepAlive,
          hasGitProtoV2,
          authStart,
          authEnd,
          false,
        );
        pos = chunked.end;
        if (!keepAlive) return;
        continue;
      }

      if (cl > 0) {
        if (hasExpect) socket.write(HTTP_100_CONTINUE);
        const avail = data.length - bodyStart;
        if (avail < cl) {
          activeBody = {
            headerBuf: Buffer.from(data.subarray(pos, bodyStart)),
            mEnd: sp1 - pos,
            tStart: sp1 + 1 - pos,
            tEnd: sp2 - pos,
            lineEnd: lineEnd - pos,
            headerEnd: headerEnd - pos,
            keepAlive,
            hasGitProtoV2,
            authStart: authStart === -1 ? -1 : authStart - pos,
            authEnd: authEnd === -1 ? -1 : authEnd - pos,
            expectedLen: cl,
            chunks: avail > 0 ? [data.subarray(bodyStart)] : [],
            received: avail,
          };
          return;
        }
        handleCompleteRequest(
          data,
          pos,
          sp1,
          sp1 + 1,
          sp2,
          lineEnd,
          headerEnd,
          data.subarray(bodyStart, bodyStart + cl),
          keepAlive,
          hasGitProtoV2,
          authStart,
          authEnd,
          !hasExpect,
        );
        pos = bodyStart + cl;
        if (!keepAlive) return;
        continue;
      }

      handleCompleteRequest(
        data,
        pos,
        sp1,
        sp1 + 1,
        sp2,
        lineEnd,
        headerEnd,
        EMPTY_BUF,
        keepAlive,
        hasGitProtoV2,
        authStart,
        authEnd,
        !hasExpect && cl <= 0,
      );
      pos = bodyStart;
      if (!keepAlive) return;
    }
  };
}

export function createApp(): Server {
  const store = new ForgeStore();
  const caches = createFastHitCaches();
  const sockets = new Set<Socket>();

  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    sockets.add(socket);
    const onData = createSocketProcessor(store, socket, caches);
    socket.on('data', onData);
    socket.on('end', () => {
      socket.end();
    });
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  const origClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void): Server => {
    for (const sock of sockets) {
      sock.destroy();
    }
    return origClose(cb);
  }) as Server['close'];

  return server;
}

export function warmupForge(): void {
  const store = new ForgeStore();
  const caches = createFastHitCaches();
  const owner = store.getViewerLogin();
  let lastOut: Buffer = EMPTY_BUF;
  const recordOut = (chunk?: Uint8Array | string): void => {
    if (chunk === undefined) return;
    lastOut = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf8')
      : Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  };
  const dummySocket: WriteSocket = {
    write: (chunk) => {
      recordOut(chunk);
      return true;
    },
    end: (chunk) => {
      recordOut(chunk);
    },
    destroy: () => {},
    destroyed: false,
    writableEnded: false,
  };

  const assertStatus = (expected: number, label: string): void => {
    const prefix = `HTTP/1.1 ${expected} `;
    if (!lastOut.subarray(0, prefix.length).equals(Buffer.from(prefix, 'ascii'))) {
      throw new Error(`warmupForge ${label}: expected HTTP ${expected}, got ${lastOut.subarray(0, 64).toString('utf8')}`);
    }
  };
  const assertIncludes = (needle: string, label: string): void => {
    if (!lastOut.includes(needle)) {
      throw new Error(`warmupForge ${label}: missing ${JSON.stringify(needle)} in response`);
    }
  };

  const onData = createSocketProcessor(store, dummySocket, caches);
  const authHeader = store.expectedToken ? `Authorization: Bearer ${store.expectedToken}\r\n` : '';

  const buildReq = (method: string, path: string, body?: string | Buffer, extraHeaders = ''): Buffer => {
    const bodyBuf = body === undefined ? EMPTY_BUF : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const clHdr = bodyBuf.length > 0 ? `Content-Length: ${bodyBuf.length}\r\n` : '';
    const hdr = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:1\r\n${authHeader}${extraHeaders}${clHdr}\r\n`;
    if (bodyBuf.length === 0) return Buffer.from(hdr, 'utf8');
    return Buffer.concat([Buffer.from(hdr, 'utf8'), bodyBuf]);
  };

  // 1. Create repo and verify 201
  onData(buildReq('POST', '/api/v3/user/repos', '{"name":"wrepo","private":true}', 'Content-Type: application/json\r\n'));
  assertStatus(201, 'createRepo');

  // 2. Warm write: POST /issues (simple ASCII fast path + escaped fallback + labels)
  const postIssueReq = buildReq(
    'POST',
    `/api/v3/repos/${owner}/wrepo/issues`,
    '{"title":"Warm issue","body":"Warmup body"}',
    'Content-Type: application/json\r\n',
  );
  onData(postIssueReq);
  assertStatus(201, 'write fast #1');
  for (let i = 1; i < 1500; i += 1) {
    onData(postIssueReq);
  }
  assertStatus(201, 'write fast #1500');

  onData(
    buildReq(
      'POST',
      `/api/v3/repos/${owner}/wrepo/issues`,
      '{"title":"Warm \\"escaped\\"","body":"line1\\nline2"}',
      'Content-Type: application/json\r\n',
    ),
  );
  assertStatus(201, 'write escaped');

  onData(
    buildReq(
      'POST',
      `/api/v3/repos/${owner}/wrepo/labels`,
      '{"name":"bug","color":"d73a4a"}',
      'Content-Type: application/json\r\n',
    ),
  );
  assertStatus(201, 'createLabel');
  onData(
    buildReq(
      'POST',
      `/api/v3/repos/${owner}/wrepo/issues`,
      '{"title":"Labeled","body":"with label","labels":["bug"]}',
      'Content-Type: application/json\r\n',
    ),
  );
  assertStatus(201, 'write labeled');

  // 3. Warm read: GET /issues/:number (miss -> hit -> 3000 iterations)
  const getIssueReq = buildReq('GET', `/api/v3/repos/${owner}/wrepo/issues/1`);
  onData(getIssueReq);
  assertStatus(200, 'read miss');
  onData(getIssueReq);
  assertStatus(200, 'read hit');
  for (let i = 2; i < 3000; i += 1) {
    onData(getIssueReq);
  }
  assertStatus(200, 'read #3000');

  // Warm pipelined + fragmented + multi-chunk + chunked parser paths
  onData(Buffer.concat([getIssueReq, getIssueReq]));
  assertStatus(200, 'read pipelined');
  const splitIdx = Math.floor(getIssueReq.length / 2);
  onData(getIssueReq.subarray(0, splitIdx));
  onData(getIssueReq.subarray(splitIdx));
  assertStatus(200, 'read fragmented header');
  const postSplitIdx = postIssueReq.length - 5;
  onData(postIssueReq.subarray(0, postSplitIdx));
  onData(postIssueReq.subarray(postSplitIdx));
  assertStatus(201, 'write multi-chunk activeBody');
  onData(
    Buffer.from(
      `POST /api/v3/repos/${owner}/wrepo/issues HTTP/1.1\r\nHost: 127.0.0.1:1\r\n${authHeader}Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1e\r\n{"title":"chunked","body":"c"}\r\n0\r\n\r\n`,
      'utf8',
    ),
  );
  assertStatus(201, 'write chunked');

  // 4. Warm push: 500 sequential pushes (info/refs receive-pack + git-receive-pack)
  const helperStore = new ForgeStore();
  const helperRepo = helperStore.createRepo('tmp', {})!;
  const getRpAdReq = buildReq('GET', `/${owner}/wrepo.git/info/refs?service=git-receive-pack`);
  let prev = ZERO_OID;
  let firstSha = '';
  for (let i = 0; i < 500; i += 1) {
    onData(getRpAdReq);
    if (i === 0 || i === 1 || i === 499) assertStatus(200, `push info/refs #${i}`);
    const blobSha = writeObject(helperRepo, 'blob', Buffer.from(`warm blob ${i}\n`, 'utf8'));
    const treeSha = buildTreeFromFiles(helperRepo, new Map([['w.txt', { mode: '100644', sha: blobSha }]]));
    const commitSha = createCommit(helperRepo, treeSha, prev === ZERO_OID ? [] : [prev], `w ${i}\n`, owner, 1700000000 + i);
    if (i === 0) firstSha = commitSha;
    const pack = buildPackfile(helperRepo, [blobSha, treeSha, commitSha]);
    const cmdLine = `${prev} ${commitSha} refs/heads/main\0report-status side-band-64k ofs-delta\n`;
    const pushBody = Buffer.concat([pktLine(cmdLine), PKT_FLUSH, pack]);
    onData(buildReq('POST', `/${owner}/wrepo.git/git-receive-pack`, pushBody));
    if (i === 0 || i === 1 || i === 499) {
      assertStatus(200, `push receive-pack #${i}`);
      assertIncludes('unpack ok', `push receive-pack #${i}`);
      assertIncludes('ok refs/heads/main', `push receive-pack #${i}`);
    }
    prev = commitSha;
  }

  // 5. Warm clone: 500 iterations of v2 upload-pack advertisement + ls-refs + depth-1 fetch
  const getUpAdReq = buildReq('GET', `/${owner}/wrepo.git/info/refs?service=git-upload-pack`, undefined, 'Git-Protocol: version=2\r\n');
  const lsRefsBody = Buffer.concat([
    pktLine('command=ls-refs\n'),
    Buffer.from('0001', 'ascii'),
    pktLine('peel\n'),
    pktLine('symrefs\n'),
    PKT_FLUSH,
  ]);
  const lsRefsReq = buildReq('POST', `/${owner}/wrepo.git/git-upload-pack`, lsRefsBody, 'Git-Protocol: version=2\r\n');
  const fetchBody = Buffer.concat([
    pktLine('command=fetch\n'),
    Buffer.from('0001', 'ascii'),
    pktLine('thin-pack\n'),
    pktLine('no-progress\n'),
    pktLine('ofs-delta\n'),
    pktLine(`want ${prev}\n`),
    pktLine('deepen 1\n'),
    pktLine('done\n'),
    PKT_FLUSH,
  ]);
  const fetchReq = buildReq('POST', `/${owner}/wrepo.git/git-upload-pack`, fetchBody, 'Git-Protocol: version=2\r\n');
  for (let i = 0; i < 500; i += 1) {
    onData(getUpAdReq);
    if (i <= 1) assertStatus(200, `clone info/refs #${i}`);
    onData(lsRefsReq);
    if (i <= 1) assertStatus(200, `clone ls-refs #${i}`);
    onData(fetchReq);
    if (i <= 1) assertStatus(200, `clone fetch #${i}`);
  }

  // 6. Warm git-http, REST, GraphQL, and MCP edge paths
  onData(buildReq('GET', `/${owner}/wrepo.git/info/refs?service=git-upload-pack`));
  assertStatus(200, 'git v0 info/refs');
  const incFetchBody = Buffer.concat([
    pktLine('command=fetch\n'),
    Buffer.from('0001', 'ascii'),
    pktLine(`want ${prev}\n`),
    pktLine(`have ${firstSha}\n`),
    pktLine('done\n'),
    PKT_FLUSH,
  ]);
  onData(buildReq('POST', `/${owner}/wrepo.git/git-upload-pack`, incFetchBody, 'Git-Protocol: version=2\r\n'));
  assertStatus(200, 'git incremental fetch');
  onData(
    buildReq(
      'POST',
      `/${owner}/wrepo.git/git-receive-pack`,
      Buffer.concat([pktLine(`${ZERO_OID} ${prev} refs/heads/side\0report-status side-band-64k\n`), PKT_FLUSH]),
    ),
  );
  assertStatus(200, 'git create branch');
  onData(buildReq('GET', `/${owner}/wrepo.git/info/refs?service=git-receive-pack`));
  assertStatus(200, 'git multi-ref receive-pack info/refs');

  const healthzReq = buildReq('GET', '/healthz');
  const getRepoReq = buildReq('GET', `/api/v3/repos/${owner}/wrepo`);
  const branchesReq = buildReq('GET', `/api/v3/repos/${owner}/wrepo/branches`);
  const commitsReq = buildReq('GET', `/api/v3/repos/${owner}/wrepo/commits`);
  const putContentReq = buildReq(
    'PUT',
    `/api/v3/repos/${owner}/wrepo/contents/warm.txt`,
    JSON.stringify({ message: 'add warm.txt', content: Buffer.from('hello warm\n', 'utf8').toString('base64'), branch: 'side' }),
    'Content-Type: application/json\r\n',
  );
  const patchIssueReq = buildReq(
    'PATCH',
    `/api/v3/repos/${owner}/wrepo/issues/1`,
    '{"state":"closed"}',
    'Content-Type: application/json\r\n',
  );
  const commentReq = buildReq(
    'POST',
    `/api/v3/repos/${owner}/wrepo/issues/1/comments`,
    '{"body":"warm comment"}',
    'Content-Type: application/json\r\n',
  );
  const gqlReq = buildReq(
    'POST',
    '/api/graphql',
    JSON.stringify({ query: 'query($owner:String!,$name:String!){viewer{login}repository(owner:$owner,name:$name){id issue(number:1){id number}}}', variables: { owner, name: 'wrepo' } }),
    'Content-Type: application/json\r\n',
  );
  const mcpDiscoverReq = buildReq('POST', '/mcp', '{"jsonrpc":"2.0","id":1,"method":"server/discover"}', 'Content-Type: application/json\r\n');
  const mcpListReq = buildReq('POST', '/mcp', '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', 'Content-Type: application/json\r\n');

  onData(putContentReq);
  assertStatus(201, 'rest PUT contents');
  onData(patchIssueReq);
  assertStatus(200, 'rest PATCH issue');
  onData(commentReq);
  assertStatus(201, 'rest POST comment');

  for (let i = 0; i < 100; i += 1) {
    onData(healthzReq);
    onData(getRepoReq);
    onData(branchesReq);
    onData(commitsReq);
    onData(gqlReq);
    onData(mcpDiscoverReq);
    onData(mcpListReq);
  }
  assertStatus(200, 'mcp tools/list');
}
