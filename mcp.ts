import { formatIssue, formatPull, formatRepo, mergePullRequest, sendRawBuf, type HttpRequest, type HttpResponse } from './rest.ts';
import { ForgeStore, invalidateIssueCache, resolveRefOrSha, type Issue, type PullRequest } from './store.ts';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        auto_init: { type: 'boolean', description: 'Initialize with a README' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository by owner and repo name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        merge_method: { type: 'string', description: 'Merge method' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_RESULT_JSON = JSON.stringify({ tools: TOOLS });
const SERVER_DISCOVER_RESULT_JSON = JSON.stringify({
  supportedVersions: ['2026-07-28', '2025-11-25'],
  capabilities: { tools: {} },
  serverInfo: { name: 'makefun-forge', version: '1.0.0' },
});
const INIT_TAIL_JSON = ',"capabilities":{"tools":{}},"serverInfo":{"name":"makefun-forge","version":"1.0.0"}}}';
const ERR_AUTH_BUF = Buffer.from('{"message":"Requires authentication"}', 'ascii');
const ERR_METHOD_BUF = Buffer.from('{"message":"Method Not Allowed"}', 'ascii');
const ERR_PARSE_BUF = Buffer.from('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}', 'ascii');

function sendRpcText(res: HttpResponse, status: number, text: string, reqId: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId,
  });
  res.end(text);
}

function sendRpc(res: HttpResponse, status: number, payload: unknown, reqId: string): void {
  sendRpcText(res, status, JSON.stringify(payload), reqId);
}

function toolOk(data: unknown): { content: Array<{ type: 'text'; text: string }>; isError: false } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false };
}

function toolErr(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner || parts[0]!;
      repo = repo || parts[1]!;
    }
  }
  if (!owner || !repo) return null;
  return { owner, repo };
}

function executeTool(store: ForgeStore, name: string, args: Record<string, unknown>): { kind: 'ok'; result: unknown } | { kind: 'rpc_error'; code: number; message: string } {
  const canonical = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2).toLowerCase() : name.toLowerCase();

  if (canonical === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name.trim() : '';
    if (!repoName) return { kind: 'ok', result: toolErr('Missing required argument: name') };
    const created = store.createRepo(repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: Boolean(args.private),
      auto_init: Boolean(args.auto_init),
    });
    if (!created) return { kind: 'ok', result: toolErr(`Repository ${repoName} already exists`) };
    return { kind: 'ok', result: toolOk(formatRepo(store, created)) };
  }

  if (canonical === 'get_repo') {
    const target = resolveOwnerRepo(args);
    if (!target) return { kind: 'ok', result: toolErr('Missing required arguments: owner, repo') };
    const repo = store.resolveRepo(target.owner, target.repo);
    if (!repo) return { kind: 'ok', result: toolErr('Repository not found') };
    return { kind: 'ok', result: toolOk(formatRepo(store, repo)) };
  }

  if (canonical === 'create_issue') {
    const target = resolveOwnerRepo(args);
    const title = typeof args.title === 'string' ? args.title : '';
    if (!target || !title) return { kind: 'ok', result: toolErr('Missing required arguments: owner, repo, title') };
    const repo = store.resolveRepo(target.owner, target.repo);
    if (!repo) return { kind: 'ok', result: toolErr('Repository not found') };
    const body = typeof args.body === 'string' ? args.body : '';
    const ts = store.nextTimestamp();
    const issue: Issue = {
      id: store.nextId(),
      number: repo.nextIssueNumber++,
      title,
      body,
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
    repo.issueByNumber.set(issue.number, issue);
    invalidateIssueCache(store, issue);
    return { kind: 'ok', result: toolOk(formatIssue(issue)) };
  }

  if (canonical === 'list_issues') {
    const target = resolveOwnerRepo(args);
    if (!target) return { kind: 'ok', result: toolErr('Missing required arguments: owner, repo') };
    const repo = store.resolveRepo(target.owner, target.repo);
    if (!repo) return { kind: 'ok', result: toolErr('Repository not found') };
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((i) => state === 'all' || i.state === state).map(formatIssue);
    return { kind: 'ok', result: toolOk(list) };
  }

  if (canonical === 'create_pull_request') {
    const target = resolveOwnerRepo(args);
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    if (!target || !title || !head || !base) {
      return { kind: 'ok', result: toolErr('Missing required arguments: owner, repo, title, head, base') };
    }
    const repo = store.resolveRepo(target.owner, target.repo);
    if (!repo) return { kind: 'ok', result: toolErr('Repository not found') };
    const headSha = resolveRefOrSha(repo, head);
    const baseSha = resolveRefOrSha(repo, base);
    if (!headSha || !baseSha) return { kind: 'ok', result: toolErr('Head or base branch not found') };
    const ts = store.nextTimestamp();
    const pr: PullRequest = {
      id: store.nextId(),
      number: repo.nextPullNumber++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      user: { login: store.getViewerLogin() },
      created_at: ts.iso,
      updated_at: ts.iso,
    };
    repo.pulls.push(pr);
    store.mutationEpoch += 1;
    return { kind: 'ok', result: toolOk(formatPull(pr)) };
  }

  if (canonical === 'merge_pull_request') {
    const target = resolveOwnerRepo(args);
    const pullNum = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    if (!target || !Number.isInteger(pullNum)) {
      return { kind: 'ok', result: toolErr('Missing required arguments: owner, repo, pull_number') };
    }
    const repo = store.resolveRepo(target.owner, target.repo);
    if (!repo) return { kind: 'ok', result: toolErr('Repository not found') };
    const pr = repo.pulls.find((p) => p.number === pullNum);
    if (!pr) return { kind: 'ok', result: toolErr(`Pull request #${pullNum} not found`) };
    const merged = mergePullRequest(store, repo, pr);
    if (!merged.ok) return { kind: 'ok', result: toolErr(merged.message) };
    return { kind: 'ok', result: toolOk({ sha: merged.sha, merged: true, message: 'Pull Request successfully merged' }) };
  }

  return { kind: 'rpc_error', code: -32601, message: `Unknown tool: ${name}` };
}

export function handleMcp(
  req: HttpRequest,
  res: HttpResponse,
  store: ForgeStore,
  url: URL,
  rawBody: Buffer,
  reqId: string,
): boolean {
  if (url.pathname !== '/mcp') return false;

  const baseHeaders = { 'x-github-request-id': reqId };
  const authHeader = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  if (!store.isAuthorized(authHeader)) {
    sendRawBuf(res, 401, ERR_AUTH_BUF, baseHeaders);
    return true;
  }

  if (req.method !== 'POST') {
    sendRawBuf(res, 405, ERR_METHOD_BUF, baseHeaders);
    return true;
  }

  let msg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendRawBuf(res, 400, ERR_PARSE_BUF, baseHeaders);
      return true;
    }
    msg = parsed as Record<string, unknown>;
  } catch {
    sendRawBuf(res, 400, ERR_PARSE_BUF, baseHeaders);
    return true;
  }

  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = typeof msg.params === 'object' && msg.params !== null ? (msg.params as Record<string, unknown>) : {};

  if (method === 'notifications/initialized') {
    res.writeHead(202, baseHeaders);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    sendRpcText(res, 200, `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${SERVER_DISCOVER_RESULT_JSON}}`, reqId);
    return true;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    sendRpcText(
      res,
      200,
      `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"protocolVersion":${JSON.stringify(requested)}${INIT_TAIL_JSON}`,
      reqId,
    );
    return true;
  }

  if (method === 'tools/list') {
    sendRpcText(res, 200, `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${TOOLS_RESULT_JSON}}`, reqId);
    return true;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
    const out = executeTool(store, toolName, args);
    if (out.kind === 'rpc_error') {
      sendRpc(res, 200, { jsonrpc: '2.0', id, error: { code: out.code, message: out.message } }, reqId);
    } else {
      sendRpc(res, 200, { jsonrpc: '2.0', id, result: out.result }, reqId);
    }
    return true;
  }

  sendRpc(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }, reqId);
  return true;
}
