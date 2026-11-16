import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitHttp } from './git-http.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { getIssueJsonBuf, handleRest, sendJson } from './rest.ts';
import { ForgeStore } from './store.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  const clHeader = req.headers['content-length'];
  const cl = clHeader !== undefined ? parseInt(Array.isArray(clHeader) ? clHeader[0]! : clHeader, 10) : -1;
  if (Number.isFinite(cl) && cl === 0) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    if (Number.isFinite(cl) && cl > 0 && cl <= 16 * 1024 * 1024) {
      const buf = Buffer.allocUnsafe(cl);
      let off = 0;
      let extra: Buffer[] | null = null;
      req.on('data', (chunk: Buffer) => {
        if (extra === null && off + chunk.length <= cl) {
          chunk.copy(buf, off);
          off += chunk.length;
        } else {
          if (extra === null) extra = off > 0 ? [buf.subarray(0, off), chunk] : [chunk];
          else extra.push(chunk);
        }
      });
      req.on('end', () => {
        if (extra !== null) resolve(Buffer.concat(extra));
        else resolve(off === cl ? buf : buf.subarray(0, off));
      });
      req.on('error', reject);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  } catch {
    return new URL('/', 'http://127.0.0.1');
  }
}

function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  url: URL,
  body: Buffer,
  reqId: string,
): void {
  try {
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

const FAST_ISSUE_GET = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;

export function createApp(): Server {
  const store = new ForgeStore();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqId = store.nextRequestId();
    const rawUrl = req.url ?? '/';

    if (req.method === 'GET') {
      if (rawUrl === '/healthz') {
        sendJson(res, 200, { ok: true }, { 'x-github-request-id': reqId });
        return;
      }
      const m = FAST_ISSUE_GET.exec(rawUrl);
      if (m && store.isAuthorized(req.headers.authorization)) {
        const repo = store.resolveRepo(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
        const issue = repo?.issueByNumber.get(parseInt(m[3]!, 10));
        if (issue) {
          const buf = getIssueJsonBuf(issue);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': buf.length,
            'x-github-request-id': reqId,
          });
          res.end(buf);
          return;
        }
      }
    }

    const url = parseUrl(req);
    const hasBody =
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      (req.method !== 'DELETE' || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0'));

    if (!hasBody) {
      dispatch(req, res, store, url, Buffer.alloc(0), reqId);
      return;
    }

    readBody(req).then(
      (body) => dispatch(req, res, store, url, body, reqId),
      (err) => {
        sendJson(
          res,
          500,
          { message: err instanceof Error ? err.message : 'Internal Server Error' },
          { 'x-github-request-id': reqId },
        );
      },
    );
  });

  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
