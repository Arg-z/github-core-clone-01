import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeStore,
  buildTreeFromFiles,
  createCommit,
  findMergeBase,
  getCommitFiles,
  parseCommit,
  parseTree,
  resolveRefOrSha,
  threeWayMergeFiles,
  walkCommitHistory,
  writeObject,
  type Issue,
  type PullRequest,
  type Repository,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function formatRepo(store: ForgeStore, repo: Repository): Record<string, unknown> {
  const owner = store.getViewerLogin();
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    owner: { login: owner, id: 1, type: 'User' },
    permissions: { admin: true, push: true, pull: true },
    has_issues: true,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

export function formatIssue(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    user: issue.user,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
  };
}

export function getIssueJsonBuf(issue: Issue): Buffer {
  if (issue.cachedJsonBuf === undefined) {
    issue.cachedJsonBuf = Buffer.from(JSON.stringify(formatIssue(issue)), 'utf8');
  }
  return issue.cachedJsonBuf;
}

export function formatPull(pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    mergeable: pr.state === 'open' ? true : null,
    user: pr.user,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  };
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return Math.max(1, lines.length);
}

export function computePullFiles(
  repo: Repository,
  baseSha: string,
  headSha: string,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const mergeBase = findMergeBase(repo, baseSha, headSha) ?? baseSha;
  const baseFiles = getCommitFiles(repo, mergeBase);
  const headFiles = getCommitFiles(repo, headSha);
  const allPaths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];

  for (const p of allPaths) {
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    if (!b && h) {
      const obj = repo.objects.get(h.sha);
      const adds = obj ? countLines(obj.data) : 1;
      out.push({ filename: p, status: 'added', additions: adds, deletions: 0, changes: adds });
    } else if (b && !h) {
      const obj = repo.objects.get(b.sha);
      const dels = obj ? countLines(obj.data) : 1;
      out.push({ filename: p, status: 'removed', additions: 0, deletions: dels, changes: dels });
    } else if (b && h && b.sha !== h.sha) {
      const bObj = repo.objects.get(b.sha);
      const hObj = repo.objects.get(h.sha);
      const bLines = bObj ? countLines(bObj.data) : 1;
      const hLines = hObj ? countLines(hObj.data) : 1;
      const adds = Math.max(1, hLines);
      const dels = Math.max(1, bLines);
      out.push({ filename: p, status: 'modified', additions: adds, deletions: dels, changes: adds + dels });
    }
  }
  return out;
}

export function mergePullRequest(
  store: ForgeStore,
  repo: Repository,
  pr: PullRequest,
): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pr.merged || pr.state !== 'open') {
    return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  }
  const baseRefName = `refs/heads/${pr.baseRef}`;
  const headRefName = `refs/heads/${pr.headRef}`;
  const currentBaseSha = repo.refs.get(baseRefName) ?? pr.baseSha;
  const currentHeadSha = repo.refs.get(headRefName) ?? pr.headSha;

  const mergeBase = findMergeBase(repo, currentBaseSha, currentHeadSha);
  const merged = threeWayMergeFiles(repo, mergeBase, currentBaseSha, currentHeadSha);
  if (!merged.ok) {
    return { ok: false, status: 405, message: `Merge conflict in ${merged.conflict}` };
  }

  const ts = store.nextTimestamp();
  const treeSha = buildTreeFromFiles(repo, merged.files);
  const commitSha = createCommit(
    repo,
    treeSha,
    [currentBaseSha],
    `${pr.title} (#${pr.number})`,
    store.getViewerLogin(),
    ts.epoch,
  );
  repo.refs.set(baseRefName, commitSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = ts.iso;
  pr.merge_commit_sha = commitSha;
  pr.updated_at = ts.iso;
  return { ok: true, sha: commitSha };
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  url: URL,
  rawBody: Buffer,
  reqId: string,
): boolean {
  const path = url.pathname;
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;

  const baseHeaders = { 'x-github-request-id': reqId };
  const method = req.method ?? 'GET';

  if (!store.isAuthorized(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
    return true;
  }

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { ...baseHeaders, 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '3.14.0' }, baseHeaders);
    return true;
  }

  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, { login: store.getViewerLogin(), id: 1, type: 'User' }, baseHeaders);
    return true;
  }

  let bodyObj: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || (method === 'DELETE' && rawBody.length > 0)) {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' }, baseHeaders);
      return true;
    }
    bodyObj = parsed.value;
  }

  // GET /api/v3/user/repos
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
    const total = store.repoOrder.length;
    const start = (page - 1) * perPage;
    const slice = store.repoOrder.slice(start, start + perPage).map((r) => formatRepo(store, r));
    const headers: Record<string, string> = { ...baseHeaders };
    if (start + perPage < total) {
      const host = req.headers.host ?? '127.0.0.1';
      const nextUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      headers.link = `<${nextUrl}>; rel="next"`;
    }
    sendJson(res, 200, slice, headers);
    return true;
  }

  // POST /api/v3/user/repos
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const name = typeof bodyObj.name === 'string' ? bodyObj.name.trim() : '';
    if (!name) {
      sendJson(res, 422, { message: 'Repository name is required' }, baseHeaders);
      return true;
    }
    const repo = store.createRepo(name, {
      description: typeof bodyObj.description === 'string' ? bodyObj.description : '',
      private: Boolean(bodyObj.private),
      default_branch: typeof bodyObj.default_branch === 'string' ? bodyObj.default_branch : 'main',
      auto_init: Boolean(bodyObj.auto_init),
    });
    if (!repo) {
      sendJson(res, 422, { message: 'Repository creation failed: name already exists' }, baseHeaders);
      return true;
    }
    sendJson(res, 201, formatRepo(store, repo), baseHeaders);
    return true;
  }

  // Routes under /api/v3/repos/:owner/:repo...
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!repoMatch) {
    sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
    return true;
  }

  const owner = decodeURIComponent(repoMatch[1]!);
  const repoName = decodeURIComponent(repoMatch[2]!);
  const sub = repoMatch[3] ?? '';

  const repo = store.resolveRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
    return true;
  }

  // /api/v3/repos/:owner/:repo
  if (sub === '') {
    if (method === 'GET') {
      sendJson(res, 200, formatRepo(store, repo), baseHeaders);
      return true;
    }
    if (method === 'PATCH') {
      if (typeof bodyObj.description === 'string') repo.description = bodyObj.description;
      if (typeof bodyObj.private === 'boolean') repo.private = bodyObj.private;
      if (typeof bodyObj.default_branch === 'string') repo.default_branch = bodyObj.default_branch;
      repo.updated_at = store.nextTimestamp().iso;
      sendJson(res, 200, formatRepo(store, repo), baseHeaders);
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { ...baseHeaders, 'content-type': JSON_TYPE });
      res.end();
      return true;
    }
  }

  // /branches
  if (method === 'GET' && sub === 'branches') {
    const branches: Array<{ name: string; commit: { sha: string } }> = [];
    for (const [refName, sha] of repo.refs) {
      if (refName.startsWith('refs/heads/')) {
        branches.push({ name: refName.slice('refs/heads/'.length), commit: { sha } });
      }
    }
    sendJson(res, 200, branches, baseHeaders);
    return true;
  }

  // /commits
  if (method === 'GET' && sub === 'commits') {
    const shaParam = url.searchParams.get('sha') ?? undefined;
    const tipSha = resolveRefOrSha(repo, shaParam);
    if (!tipSha) {
      sendJson(res, 200, [], baseHeaders);
      return true;
    }
    const shas = walkCommitHistory(repo, tipSha);
    const commits = shas.map((s) => {
      const obj = repo.objects.get(s);
      const parsed = obj ? parseCommit(obj.data) : { message: '', author: '' };
      return {
        sha: s,
        commit: {
          message: parsed.message,
          author: { name: store.getViewerLogin(), email: `${store.getViewerLogin()}@users.noreply.make.fun`, date: repo.created_at },
        },
      };
    });
    sendJson(res, 200, commits, baseHeaders);
    return true;
  }

  // /git/refs
  if (method === 'POST' && sub === 'git/refs') {
    const ref = typeof bodyObj.ref === 'string' ? bodyObj.ref : '';
    const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha.toLowerCase() : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
      sendJson(res, 422, { message: 'Invalid ref or sha' }, baseHeaders);
      return true;
    }
    if (repo.refs.has(ref)) {
      sendJson(res, 422, { message: 'Reference already exists' }, baseHeaders);
      return true;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: 'commit' } }, baseHeaders);
    return true;
  }

  // /contents/...
  if (sub === 'contents' || sub.startsWith('contents/')) {
    const rawFilePath = sub === 'contents' ? '' : sub.slice('contents/'.length);
    const filePath = rawFilePath.split('/').map((s) => decodeURIComponent(s)).filter(Boolean).join('/');

    if (method === 'GET') {
      const refParam = url.searchParams.get('ref') ?? undefined;
      const tipSha = resolveRefOrSha(repo, refParam);
      if (!tipSha) {
        sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
        return true;
      }
      const files = getCommitFiles(repo, tipSha);
      const exact = filePath ? files.get(filePath) : undefined;
      if (exact) {
        const blob = repo.objects.get(exact.sha);
        const data = blob ? blob.data : Buffer.alloc(0);
        const name = filePath.split('/').pop() ?? filePath;
        sendJson(
          res,
          200,
          {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name,
            path: filePath,
            content: data.toString('base64'),
            sha: exact.sha,
          },
          baseHeaders,
        );
        return true;
      }

      // Check directory
      const prefix = filePath ? `${filePath}/` : '';
      const dirEntries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
      for (const [p, info] of files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          const blob = repo.objects.get(info.sha);
          dirEntries.set(rest, {
            type: 'file',
            name: rest,
            path: p,
            sha: info.sha,
            size: blob ? blob.data.length : 0,
          });
        } else {
          const dirName = rest.slice(0, slash);
          if (!dirEntries.has(dirName)) {
            // Compute tree sha deterministically from commit tree
            dirEntries.set(dirName, {
              type: 'dir',
              name: dirName,
              path: prefix ? `${prefix}${dirName}` : dirName,
              sha: tipSha,
              size: 0,
            });
          }
        }
      }
      if (dirEntries.size > 0 || filePath === '') {
        sendJson(res, 200, [...dirEntries.values()], baseHeaders);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      return true;
    }

    if (method === 'PUT') {
      const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Update file';
      const contentB64 = typeof bodyObj.content === 'string' ? bodyObj.content : '';
      const branch = typeof bodyObj.branch === 'string' ? bodyObj.branch : repo.default_branch;
      const providedSha = typeof bodyObj.sha === 'string' ? bodyObj.sha.toLowerCase() : undefined;
      const refName = `refs/heads/${branch}`;
      const parentSha = repo.refs.get(refName) ?? null;
      const files = parentSha ? getCommitFiles(repo, parentSha) : new Map<string, { mode: string; sha: string }>();
      const existing = files.get(filePath);

      if (existing) {
        if (!providedSha || providedSha !== existing.sha) {
          sendJson(res, 409, { message: `${filePath} does not match ${providedSha ?? 'missing sha'}` }, baseHeaders);
          return true;
        }
      } else if (providedSha) {
        sendJson(res, 409, { message: `${filePath} does not exist` }, baseHeaders);
        return true;
      }

      const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const blobSha = writeObject(repo, 'blob', data);
      files.set(filePath, { mode: '100644', sha: blobSha });
      const treeSha = buildTreeFromFiles(repo, files);
      const ts = store.nextTimestamp();
      const commitSha = createCommit(
        repo,
        treeSha,
        parentSha ? [parentSha] : [],
        message,
        store.getViewerLogin(),
        ts.epoch,
      );
      repo.refs.set(refName, commitSha);
      const name = filePath.split('/').pop() ?? filePath;
      sendJson(
        res,
        existing ? 200 : 201,
        {
          content: { name, path: filePath, sha: blobSha, size: data.length, type: 'file', encoding: 'base64', content: data.toString('base64') },
          commit: { sha: commitSha, message },
        },
        baseHeaders,
      );
      return true;
    }

    if (method === 'DELETE') {
      const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Delete file';
      const branch = typeof bodyObj.branch === 'string' ? bodyObj.branch : repo.default_branch;
      const providedSha = typeof bodyObj.sha === 'string' ? bodyObj.sha.toLowerCase() : undefined;
      const refName = `refs/heads/${branch}`;
      const parentSha = repo.refs.get(refName) ?? null;
      const files = parentSha ? getCommitFiles(repo, parentSha) : new Map<string, { mode: string; sha: string }>();
      const existing = files.get(filePath);
      if (!existing) {
        sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
        return true;
      }
      if (!providedSha || providedSha !== existing.sha) {
        sendJson(res, 409, { message: `${filePath} does not match ${providedSha ?? 'missing sha'}` }, baseHeaders);
        return true;
      }
      files.delete(filePath);
      const treeSha = buildTreeFromFiles(repo, files);
      const ts = store.nextTimestamp();
      const commitSha = createCommit(
        repo,
        treeSha,
        parentSha ? [parentSha] : [],
        message,
        store.getViewerLogin(),
        ts.epoch,
      );
      repo.refs.set(refName, commitSha);
      sendJson(res, 200, { content: null, commit: { sha: commitSha, message } }, baseHeaders);
      return true;
    }
  }

  // /labels
  if (sub === 'labels') {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()], baseHeaders);
      return true;
    }
    if (method === 'POST') {
      const name = typeof bodyObj.name === 'string' ? bodyObj.name.trim() : '';
      if (!name) {
        sendJson(res, 422, { message: 'Label name is required' }, baseHeaders);
        return true;
      }
      const label = {
        name,
        color: typeof bodyObj.color === 'string' ? bodyObj.color : 'ededed',
        description: typeof bodyObj.description === 'string' ? bodyObj.description : '',
      };
      repo.labels.set(name, label);
      sendJson(res, 201, label, baseHeaders);
      return true;
    }
  }

  // /issues
  if (sub === 'issues') {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      list = [...list].sort((a, b) => {
        const cmp = sort === 'created' ? a.number - b.number : a.number - b.number;
        return direction === 'asc' ? cmp : -cmp;
      });
      const start = (page - 1) * perPage;
      sendJson(res, 200, list.slice(start, start + perPage).map(formatIssue), baseHeaders);
      return true;
    }
    if (method === 'POST') {
      const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
      const body = typeof bodyObj.body === 'string' ? bodyObj.body : '';
      const rawLabels = Array.isArray(bodyObj.labels) ? bodyObj.labels : [];
      const resolvedLabels = [];
      for (const l of rawLabels) {
        const name = typeof l === 'string' ? l : '';
        const found = repo.labels.get(name);
        if (!found) {
          sendJson(res, 422, { message: `Unknown label: ${name}` }, baseHeaders);
          return true;
        }
        resolvedLabels.push(found);
      }
      const ts = store.nextTimestamp();
      const issue: Issue = {
        id: store.nextId(),
        number: repo.nextIssueNumber++,
        title,
        body,
        state: 'open',
        labels: resolvedLabels,
        user: { login: store.getViewerLogin() },
        comments: [],
        created_at: ts.iso,
        updated_at: ts.iso,
        closed_at: null,
      };
      repo.issues.push(issue);
      repo.issueByNumber.set(issue.number, issue);
      const jsonBuf = getIssueJsonBuf(issue);
      res.writeHead(201, {
        'content-type': JSON_TYPE,
        'content-length': jsonBuf.length,
        ...baseHeaders,
      });
      res.end(jsonBuf);
      return true;
    }
  }

  // /issues/:number
  const issueMatch = /^issues\/(\d+)$/.exec(sub);
  if (issueMatch) {
    const num = parseInt(issueMatch[1]!, 10);
    const issue = repo.issueByNumber.get(num);
    if (!issue) {
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      return true;
    }
    if (method === 'GET') {
      const jsonBuf = getIssueJsonBuf(issue);
      res.writeHead(200, {
        'content-type': JSON_TYPE,
        'content-length': jsonBuf.length,
        ...baseHeaders,
      });
      res.end(jsonBuf);
      return true;
    }
    if (method === 'PATCH') {
      if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
      if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
      if (bodyObj.state === 'open' || bodyObj.state === 'closed') {
        issue.state = bodyObj.state;
        issue.closed_at = bodyObj.state === 'closed' ? store.nextTimestamp().iso : null;
      }
      issue.updated_at = store.nextTimestamp().iso;
      issue.cachedJsonBuf = undefined;
      sendJson(res, 200, formatIssue(issue), baseHeaders);
      return true;
    }
  }

  // /issues/:number/comments
  const commentMatch = /^issues\/(\d+)\/comments$/.exec(sub);
  if (commentMatch) {
    const num = parseInt(commentMatch[1]!, 10);
    const issue = repo.issueByNumber.get(num);
    if (!issue) {
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments, baseHeaders);
      return true;
    }
    if (method === 'POST') {
      const body = typeof bodyObj.body === 'string' ? bodyObj.body : '';
      const ts = store.nextTimestamp();
      const comment = {
        id: store.nextId(),
        body,
        user: { login: store.getViewerLogin() },
        created_at: ts.iso,
        updated_at: ts.iso,
      };
      issue.comments.push(comment);
      issue.cachedJsonBuf = undefined;
      sendJson(res, 201, comment, baseHeaders);
      return true;
    }
  }

  // /pulls
  if (sub === 'pulls') {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      const start = (page - 1) * perPage;
      sendJson(res, 200, list.slice(start, start + perPage).map(formatPull), baseHeaders);
      return true;
    }
    if (method === 'POST') {
      const head = typeof bodyObj.head === 'string' ? bodyObj.head : '';
      const base = typeof bodyObj.base === 'string' ? bodyObj.base : repo.default_branch;
      const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
      const body = typeof bodyObj.body === 'string' ? bodyObj.body : '';
      const headSha = resolveRefOrSha(repo, head);
      const baseSha = resolveRefOrSha(repo, base);
      if (!headSha || !baseSha) {
        sendJson(res, 422, { message: 'Head or base branch not found' }, baseHeaders);
        return true;
      }
      const ts = store.nextTimestamp();
      const pr: PullRequest = {
        id: store.nextId(),
        number: repo.nextPullNumber++,
        title,
        body,
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
      sendJson(res, 201, formatPull(pr), baseHeaders);
      return true;
    }
  }

  // /pulls/:number
  const pullMatch = /^pulls\/(\d+)$/.exec(sub);
  if (pullMatch) {
    const num = parseInt(pullMatch[1]!, 10);
    const pr = repo.pulls.find((p) => p.number === num);
    if (!pr) {
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, formatPull(pr), baseHeaders);
      return true;
    }
  }

  // /pulls/:number/files
  const pullFilesMatch = /^pulls\/(\d+)\/files$/.exec(sub);
  if (pullFilesMatch && method === 'GET') {
    const num = parseInt(pullFilesMatch[1]!, 10);
    const pr = repo.pulls.find((p) => p.number === num);
    if (!pr) {
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      return true;
    }
    const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    sendJson(res, 200, computePullFiles(repo, baseSha, headSha), baseHeaders);
    return true;
  }

  // /pulls/:number/merge
  const pullMergeMatch = /^pulls\/(\d+)\/merge$/.exec(sub);
  if (pullMergeMatch && method === 'PUT') {
    const num = parseInt(pullMergeMatch[1]!, 10);
    const pr = repo.pulls.find((p) => p.number === num);
    if (!pr) {
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      return true;
    }
    const result = mergePullRequest(store, repo, pr);
    if (!result.ok) {
      sendJson(res, result.status, { message: result.message }, baseHeaders);
      return true;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' }, baseHeaders);
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
  return true;
}
