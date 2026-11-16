import type { IncomingMessage, ServerResponse } from 'node:http';
import { computePullFiles, mergePullRequest, sendJson } from './rest.ts';
import {
  ForgeStore,
  resolveRefOrSha,
  type Issue,
  type PullRequest,
  type Repository,
} from './store.ts';

// ---------------------------------------------------------------------------
// Minimal GraphQL AST & Parser

interface SelectionField {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[];
}

interface SelectionInlineFrag {
  kind: 'inline';
  typeCondition?: string;
  selections: Selection[];
}

interface SelectionFragSpread {
  kind: 'spread';
  name: string;
}

type Selection = SelectionField | SelectionInlineFrag | SelectionFragSpread;

interface OperationDef {
  opType: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct';
  val: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'punct', val: '...' });
      i += 3;
      continue;
    }
    if ('{}():=[]!@$&'.includes(ch)) {
      tokens.push({ kind: 'punct', val: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let s = '';
      i += 1;
      if (src.startsWith('""', i)) {
        i += 2;
        const end = src.indexOf('"""', i);
        s = end === -1 ? src.slice(i) : src.slice(i, end);
        i = end === -1 ? src.length : end + 3;
      } else {
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\' && i + 1 < src.length) {
            i += 1;
            const esc = src[i]!;
            s += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          } else {
            s += src[i];
          }
          i += 1;
        }
        i += 1;
      }
      tokens.push({ kind: 'string', val: s });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i += 1;
      tokens.push({ kind: 'name', val: src.slice(start, i) });
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < src.length && /[0-9.eE+-]/.test(src[i]!)) i += 1;
      const val = src.slice(start, i);
      tokens.push({ kind: val.includes('.') ? 'float' : 'int', val });
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly vars: Record<string, unknown>;

  constructor(tokens: Token[], vars: Record<string, unknown>) {
    this.tokens = tokens;
    this.vars = vars;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private eat(val: string): boolean {
    if (this.peek()?.val === val) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { ops: OperationDef[]; frags: Map<string, FragmentDef> } {
    const ops: OperationDef[] = [];
    const frags = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.val === '{') {
        ops.push({ opType: 'query', selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && (t.val === 'query' || t.val === 'mutation')) {
        const opType = this.next()!.val as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek()?.kind === 'name') name = this.next()!.val;
        if (this.eat('(')) {
          let depth = 1;
          while (this.pos < this.tokens.length && depth > 0) {
            const p = this.next()!;
            if (p.val === '(') depth += 1;
            else if (p.val === ')') depth -= 1;
          }
        }
        // skip directives
        while (this.eat('@')) {
          this.next();
          if (this.eat('(')) {
            let d = 1;
            while (this.pos < this.tokens.length && d > 0) {
              const p = this.next()!;
              if (p.val === '(') d += 1;
              else if (p.val === ')') d -= 1;
            }
          }
        }
        ops.push({ opType, name, selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.val === 'fragment') {
        this.next();
        const name = this.next()?.val ?? '';
        this.next(); // 'on'
        const typeCondition = this.next()?.val ?? '';
        frags.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { ops, frags };
  }

  private parseSelectionSet(): Selection[] {
    const out: Selection[] = [];
    if (!this.eat('{')) return out;
    while (this.pos < this.tokens.length && this.peek()?.val !== '}') {
      if (this.eat('...')) {
        if (this.peek()?.val === 'on') {
          this.next();
          const typeCondition = this.next()?.val;
          out.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek()?.val === '{') {
          out.push({ kind: 'inline', selections: this.parseSelectionSet() });
        } else {
          const name = this.next()?.val ?? '';
          out.push({ kind: 'spread', name });
        }
      } else {
        const first = this.next();
        if (!first) break;
        let alias: string | undefined;
        let name = first.val;
        if (this.eat(':')) {
          alias = first.val;
          name = this.next()?.val ?? '';
        }
        const args: Record<string, unknown> = {};
        if (this.eat('(')) {
          while (this.pos < this.tokens.length && this.peek()?.val !== ')') {
            const argName = this.next()?.val ?? '';
            this.eat(':');
            args[argName] = this.parseValue();
          }
          this.eat(')');
        }
        while (this.eat('@')) {
          this.next();
          if (this.eat('(')) {
            let d = 1;
            while (this.pos < this.tokens.length && d > 0) {
              const p = this.next()!;
              if (p.val === '(') d += 1;
              else if (p.val === ')') d -= 1;
            }
          }
        }
        const selections = this.peek()?.val === '{' ? this.parseSelectionSet() : [];
        out.push({ kind: 'field', alias, name, args, selections });
      }
    }
    this.eat('}');
    return out;
  }

  private parseValue(): unknown {
    const t = this.peek();
    if (!t) return null;
    if (this.eat('$')) {
      const varName = this.next()?.val ?? '';
      return this.vars[varName];
    }
    if (this.eat('[')) {
      const arr: unknown[] = [];
      while (this.pos < this.tokens.length && this.peek()?.val !== ']') {
        arr.push(this.parseValue());
      }
      this.eat(']');
      return arr;
    }
    if (this.eat('{')) {
      const obj: Record<string, unknown> = {};
      while (this.pos < this.tokens.length && this.peek()?.val !== '}') {
        const k = this.next()?.val ?? '';
        this.eat(':');
        obj[k] = this.parseValue();
      }
      this.eat('}');
      return obj;
    }
    this.next();
    if (t.kind === 'int') return parseInt(t.val, 10);
    if (t.kind === 'float') return parseFloat(t.val);
    if (t.kind === 'string') return t.val;
    if (t.val === 'true') return true;
    if (t.val === 'false') return false;
    if (t.val === 'null') return null;
    return t.val; // enum literal
  }
}

// ---------------------------------------------------------------------------
// Schema Introspection Data

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'url', 'createdAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
  User: ['id', 'login'],
  Ref: ['name', 'target'],
  GitObject: ['oid'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function expandSelections(selections: Selection[], frags: Map<string, FragmentDef>): SelectionField[] {
  const out: SelectionField[] = [];
  for (const s of selections) {
    if (s.kind === 'field') out.push(s);
    else if (s.kind === 'inline') out.push(...expandSelections(s.selections, frags));
    else if (s.kind === 'spread') {
      const f = frags.get(s.name);
      if (f) out.push(...expandSelections(f.selections, frags));
    }
  }
  return out;
}

function repoGlobalId(repo: Repository): string {
  return `R_${repo.id}`;
}

function issueGlobalId(repo: Repository, issue: Issue): string {
  return `I_${repo.name}_${issue.number}`;
}

function pullGlobalId(repo: Repository, pr: PullRequest): string {
  return `PR_${repo.name}_${pr.number}`;
}

function resolveObj(
  obj: Record<string, unknown> | null,
  selections: Selection[],
  frags: Map<string, FragmentDef>,
  errors: Array<{ message: string }>,
  typeName?: string,
): Record<string, unknown> | null {
  if (obj === null) return null;
  const fields = expandSelections(selections, frags);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === '__typename') {
      out[key] = typeName ?? obj.__typename ?? 'Object';
      continue;
    }
    if (!(f.name in obj)) {
      errors.push({ message: `Field '${f.name}' doesn't exist on type '${typeName ?? 'Object'}'` });
      return null;
    }
    const val = obj[f.name];
    if (typeof val === 'function') {
      const res = (val as (args: Record<string, unknown>) => unknown)(f.args);
      if (f.selections.length > 0 && res !== null && typeof res === 'object') {
        if (Array.isArray(res)) {
          out[key] = res.map((item) =>
            item !== null && typeof item === 'object'
              ? resolveObj(item as Record<string, unknown>, f.selections, frags, errors)
              : item,
          );
        } else {
          out[key] = resolveObj(res as Record<string, unknown>, f.selections, frags, errors);
        }
      } else {
        out[key] = res;
      }
    } else if (f.selections.length > 0 && val !== null && typeof val === 'object') {
      if (Array.isArray(val)) {
        out[key] = val.map((item) =>
          item !== null && typeof item === 'object'
            ? resolveObj(item as Record<string, unknown>, f.selections, frags, errors)
            : item,
        );
      } else {
        out[key] = resolveObj(val as Record<string, unknown>, f.selections, frags, errors);
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}

function makeIssueNode(store: ForgeStore, repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    url: `https://make.fun/${store.getViewerLogin()}/${repo.name}/issues/${issue.number}`,
    author: { __typename: 'User', login: issue.user.login },
    labels: { nodes: issue.labels.map((l) => ({ name: l.name, color: l.color })) },
    comments: {
      totalCount: issue.comments.length,
      nodes: issue.comments.map((c) => ({ id: `C_${c.id}`, body: c.body, createdAt: c.created_at })),
    },
  };
}

function makePullNode(store: ForgeStore, repo: Repository, pr: PullRequest): Record<string, unknown> {
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const files = computePullFiles(repo, baseSha, headSha).map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changeType: f.status.toUpperCase(),
  }));

  return {
    __typename: 'PullRequest',
    id: pullGlobalId(repo, pr),
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    headRefOid: headSha,
    baseRefOid: baseSha,
    mergeable: pr.state === 'open' ? 'MERGEABLE' : 'UNKNOWN',
    merged: pr.merged,
    mergedAt: pr.merged_at,
    mergeCommit: pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null,
    url: `https://make.fun/${store.getViewerLogin()}/${repo.name}/pull/${pr.number}`,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    author: { __typename: 'User', login: pr.user.login },
    files: (args: Record<string, unknown>) => {
      const first = typeof args.first === 'number' ? args.first : files.length;
      const sliced = files.slice(0, first);
      return {
        totalCount: files.length,
        nodes: sliced,
        edges: sliced.map((n, idx) => ({ cursor: String(idx + 1), node: n })),
        pageInfo: { hasNextPage: files.length > sliced.length, endCursor: sliced.length ? String(sliced.length) : null },
      };
    },
  };
}

function makeRepoNode(store: ForgeStore, repo: Repository): Record<string, unknown> {
  const owner = store.getViewerLogin();
  const defaultTip = repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    owner: { __typename: 'User', id: 'U_1', login: owner },
    defaultBranchRef: {
      __typename: 'Ref',
      name: repo.default_branch,
      target: defaultTip ? { __typename: 'Commit', oid: defaultTip } : null,
    },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.private,
    description: repo.description,
    issue: (args: Record<string, unknown>) => {
      const num = typeof args.number === 'number' ? args.number : Number(args.number);
      const found = repo.issues.find((i) => i.number === num);
      return found ? makeIssueNode(store, repo, found) : null;
    },
    issues: (args: Record<string, unknown>) => {
      let list = [...repo.issues];
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = args.orderBy as { direction?: string } | undefined;
      const dir = orderBy?.direction === 'ASC' ? 1 : -1;
      list.sort((a, b) => (a.number - b.number) * dir);

      let startIdx = 0;
      if (typeof args.after === 'string' && args.after !== '') {
        const idx = parseInt(args.after, 10);
        if (Number.isFinite(idx)) startIdx = idx;
      }
      const first = typeof args.first === 'number' ? args.first : 100;
      const sliced = list.slice(startIdx, startIdx + first);
      const nodes = sliced.map((i) => makeIssueNode(store, repo, i));
      const hasNextPage = startIdx + sliced.length < list.length;
      const endCursor = sliced.length > 0 ? String(startIdx + sliced.length) : null;
      return {
        totalCount: list.length,
        nodes,
        edges: nodes.map((n, idx) => ({ cursor: String(startIdx + idx + 1), node: n })),
        pageInfo: { hasNextPage, endCursor },
      };
    },
    pullRequest: (args: Record<string, unknown>) => {
      const num = typeof args.number === 'number' ? args.number : Number(args.number);
      const found = repo.pulls.find((p) => p.number === num);
      return found ? makePullNode(store, repo, found) : null;
    },
    pullRequests: (args: Record<string, unknown>) => {
      let list = [...repo.pulls];
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
        list = list.filter((p) => {
          const st = p.merged ? 'MERGED' : p.state.toUpperCase();
          return wanted.has(st);
        });
      }
      const first = typeof args.first === 'number' ? args.first : 100;
      const sliced = list.slice(0, first);
      const nodes = sliced.map((p) => makePullNode(store, repo, p));
      return {
        totalCount: list.length,
        nodes,
        edges: nodes.map((n, idx) => ({ cursor: String(idx + 1), node: n })),
        pageInfo: { hasNextPage: list.length > sliced.length, endCursor: sliced.length ? String(sliced.length) : null },
      };
    },
  };
}

function executeOperation(
  store: ForgeStore,
  op: OperationDef,
  frags: Map<string, FragmentDef>,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];

  const rootQuery: Record<string, unknown> = {
    viewer: { __typename: 'User', id: 'U_1', login: store.getViewerLogin() },
    __type: (args: Record<string, unknown>) => {
      const typeName = String(args.name ?? '');
      if (!(typeName in TYPE_FIELDS)) return null;
      const fields = (TYPE_FIELDS[typeName] ?? []).map((n) => ({ name: n }));
      const enumVals = (ENUM_VALUES[typeName] ?? []).map((n) => ({ name: n }));
      return { name: typeName, fields, enumValues: enumVals };
    },
    repository: (args: Record<string, unknown>) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = store.resolveRepo(owner, name);
      return repo ? makeRepoNode(store, repo) : null;
    },
    node: (args: Record<string, unknown>) => {
      const id = String(args.id ?? '');
      if (id.startsWith('R_')) {
        const numId = parseInt(id.slice(2), 10);
        const repo = store.repoOrder.find((r) => r.id === numId);
        return repo ? makeRepoNode(store, repo) : null;
      }
      if (id.startsWith('I_')) {
        const last = id.lastIndexOf('_');
        const repoName = id.slice(2, last);
        const num = parseInt(id.slice(last + 1), 10);
        const repo = store.repos.get(repoName);
        const issue = repo?.issues.find((i) => i.number === num);
        return repo && issue ? makeIssueNode(store, repo, issue) : null;
      }
      if (id.startsWith('PR_')) {
        const last = id.lastIndexOf('_');
        const repoName = id.slice(3, last);
        const num = parseInt(id.slice(last + 1), 10);
        const repo = store.repos.get(repoName);
        const pr = repo?.pulls.find((p) => p.number === num);
        return repo && pr ? makePullNode(store, repo, pr) : null;
      }
      return null;
    },
    search: (args: Record<string, unknown>) => {
      const first = typeof args.first === 'number' ? args.first : 20;
      const nodes: Array<Record<string, unknown>> = [];
      for (const r of store.repoOrder) {
        for (const i of r.issues) nodes.push(makeIssueNode(store, r, i));
      }
      return { issueCount: nodes.length, nodes: nodes.slice(0, first) };
    },
  };

  const rootMutation: Record<string, unknown> = {
    createIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = String(input.repositoryId ?? '');
      const numId = repoId.startsWith('R_') ? parseInt(repoId.slice(2), 10) : NaN;
      const repo = store.repoOrder.find((r) => r.id === numId);
      if (!repo) {
        errors.push({ message: 'Repository not found' });
        return null;
      }
      const ts = store.nextTimestamp();
      const issue: Issue = {
        id: store.nextId(),
        number: repo.nextIssueNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        user: { login: store.getViewerLogin() },
        comments: [],
        created_at: ts.iso,
        updated_at: ts.iso,
        closed_at: null,
      };
      repo.issues.push(issue);
      repo.issueByNumber.set(issue.number, issue);
      return { issue: makeIssueNode(store, repo, issue) };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const id = String(input.issueId ?? '');
      const last = id.lastIndexOf('_');
      const repoName = id.startsWith('I_') ? id.slice(2, last) : '';
      const num = parseInt(id.slice(last + 1), 10);
      const repo = store.repos.get(repoName);
      const issue = repo?.issueByNumber.get(num);
      if (!repo || !issue) {
        errors.push({ message: 'Issue not found' });
        return null;
      }
      issue.state = 'closed';
      issue.closed_at = store.nextTimestamp().iso;
      issue.updated_at = issue.closed_at;
      issue.cachedJsonBuf = undefined;
      return { issue: makeIssueNode(store, repo, issue) };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = String(input.repositoryId ?? '');
      const numId = repoId.startsWith('R_') ? parseInt(repoId.slice(2), 10) : NaN;
      const repo = store.repoOrder.find((r) => r.id === numId);
      if (!repo) {
        errors.push({ message: 'Repository not found' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.default_branch);
      const headSha = resolveRefOrSha(repo, head);
      const baseSha = resolveRefOrSha(repo, base);
      if (!headSha || !baseSha) {
        errors.push({ message: 'Head or base branch not found' });
        return null;
      }
      const ts = store.nextTimestamp();
      const pr: PullRequest = {
        id: store.nextId(),
        number: repo.nextPullNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      return { pullRequest: makePullNode(store, repo, pr) };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const id = String(input.pullRequestId ?? '');
      const last = id.lastIndexOf('_');
      const repoName = id.startsWith('PR_') ? id.slice(3, last) : '';
      const num = parseInt(id.slice(last + 1), 10);
      const repo = store.repos.get(repoName);
      const pr = repo?.pulls.find((p) => p.number === num);
      if (!repo || !pr) {
        errors.push({ message: 'PullRequest not found' });
        return null;
      }
      const res = mergePullRequest(store, repo, pr);
      if (!res.ok) {
        errors.push({ message: res.message });
        return null;
      }
      return { pullRequest: makePullNode(store, repo, pr) };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const id = String(input.subjectId ?? '');
      const last = id.lastIndexOf('_');
      const repoName = id.startsWith('I_') ? id.slice(2, last) : '';
      const num = parseInt(id.slice(last + 1), 10);
      const repo = store.repos.get(repoName);
      const issue = repo?.issueByNumber.get(num);
      if (!repo || !issue) {
        errors.push({ message: 'Subject not found' });
        return null;
      }
      const ts = store.nextTimestamp();
      const comment = {
        id: store.nextId(),
        body: String(input.body ?? ''),
        user: { login: store.getViewerLogin() },
        created_at: ts.iso,
        updated_at: ts.iso,
      };
      issue.comments.push(comment);
      issue.cachedJsonBuf = undefined;
      return { commentEdge: { node: { id: `C_${comment.id}`, body: comment.body } } };
    },
  };

  const root = op.opType === 'mutation' ? rootMutation : rootQuery;
  const data = resolveObj(root, op.selections, frags, errors, op.opType === 'mutation' ? 'Mutation' : 'Query');
  return errors.length > 0 ? { data: null, errors } : { data };
}

function runOneDoc(store: ForgeStore, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const { ops, frags } = new Parser(tokenize(query), variables).parseDocument();
  if (ops.length === 0) {
    return { data: null, errors: [{ message: 'No operation found' }] };
  }
  return executeOperation(store, ops[0]!, frags);
}

export function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  url: URL,
  rawBody: Buffer,
  reqId: string,
): boolean {
  if (url.pathname !== '/api/graphql') return false;

  const baseHeaders = { 'x-github-request-id': reqId };
  if (!store.isAuthorized(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' }, baseHeaders);
    return true;
  }

  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => {
      const obj = (item ?? {}) as Record<string, unknown>;
      const q = typeof obj.query === 'string' ? obj.query : '';
      const v = typeof obj.variables === 'object' && obj.variables !== null ? (obj.variables as Record<string, unknown>) : {};
      return runOneDoc(store, q, v);
    });
    sendJson(res, 200, results, baseHeaders);
    return true;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { message: 'Invalid GraphQL request' }, baseHeaders);
    return true;
  }

  const obj = parsed as Record<string, unknown>;
  const q = typeof obj.query === 'string' ? obj.query : '';
  const v = typeof obj.variables === 'object' && obj.variables !== null ? (obj.variables as Record<string, unknown>) : {};
  sendJson(res, 200, runOneDoc(store, q, v), baseHeaders);
  return true;
}
