import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjType;
  data: Buffer;
  deflated?: Buffer;
  parent0?: string | null;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: { login: string };
  comments: IssueComment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  cachedJsonBuf?: Buffer | null;
  cachedHttpBuf?: Buffer | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface CachedUploadHttpEntry {
  reqBody: Buffer;
  respHttp: Buffer;
}

export interface Repository {
  id: number;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  nextIssueNumber: number;
  pulls: PullRequest[];
  nextPullNumber: number;
  // Cached commit tree files for fast reads
  treeCache: Map<string, Map<string, { mode: string; sha: string }>>;
  // Cached upload-pack v2 shallow fetch payloads keyed by "want:deepen"
  fetchCache: Map<string, Buffer>;
  // Versioning and pre-built HTTP response caches
  deleted: boolean;
  refsVersion: number;
  cachedReceivePackAdHttp: Buffer | null;
  cachedRepoJson?: Buffer | null;
  uploadHttpCacheVersion: number;
  lsRefsHttpCache: CachedUploadHttpEntry[];
  fetchHttpCache: CachedUploadHttpEntry[];
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export const HTTP_KA_SUFFIX = Buffer.from('\r\nX-GitHub-Request-Id: 1\r\nConnection: keep-alive\r\n\r\n', 'ascii');

export function buildHttpBuffer(prefix: Buffer, suffix: Buffer, body: Buffer): Buffer {
  const clStr = String(body.length);
  const out = Buffer.allocUnsafe(prefix.length + clStr.length + suffix.length + body.length);
  let off = 0;
  prefix.copy(out, off);
  off += prefix.length;
  off += out.write(clStr, off, 'ascii');
  suffix.copy(out, off);
  off += suffix.length;
  body.copy(out, off);
  return out;
}

const TWO_DIGITS: readonly string[] = Array.from({ length: 60 }, (_, i) => (i < 10 ? `0${i}` : String(i)));

let isoCachedDay = Number.NaN;
let isoCachedDayPrefix = '';

function formatIsoUtcSeconds(epoch: number): string {
  const day = Math.floor(epoch / 86400);
  if (day !== isoCachedDay) {
    isoCachedDayPrefix = new Date(day * 86400 * 1000).toISOString().slice(0, 11);
    isoCachedDay = day;
  }
  const rem = epoch - day * 86400;
  const hh = (rem / 3600) | 0;
  const mrem = rem - hh * 3600;
  const mm = (mrem / 60) | 0;
  const ss = mrem - mm * 60;
  return `${isoCachedDayPrefix}${TWO_DIGITS[hh]}:${TWO_DIGITS[mm]}:${TWO_DIGITS[ss]}.000Z`;
}

export class ForgeStore {
  readonly expectedToken: string;
  readonly expectedTokenBuf: Buffer | null;
  readonly expectedBearerLen: number;
  readonly baseEpoch: number;
  mutationEpoch = 0;
  private seq = 0;
  private reqSeq = 0;
  private nextObjId = 1000;
  private viewerLogin: string | null = null;
  private cachedUserJsonLogin: string | null = null;
  private cachedUserJson = '{"login":"viewer"}';
  readonly repos = new Map<string, Repository>();
  readonly repoOrder: Repository[] = [];

  constructor() {
    this.expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    this.expectedTokenBuf = this.expectedToken ? Buffer.from(this.expectedToken, 'utf8') : null;
    this.expectedBearerLen = this.expectedTokenBuf ? 7 + this.expectedTokenBuf.length : 0;
    const nowEnv = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = nowEnv ? Date.parse(nowEnv) : NaN;
    this.baseEpoch = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1793491200; // 2026-11-01T00:00:00Z
  }

  nextId(): number {
    this.nextObjId += 1;
    return this.nextObjId;
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq}`;
  }

  nextTimestamp(): { iso: string; epoch: number } {
    this.seq += 1;
    const epoch = this.baseEpoch + this.seq;
    return { iso: formatIsoUtcSeconds(epoch), epoch };
  }

  getViewerLogin(): string {
    return this.viewerLogin ?? 'viewer';
  }

  getViewerUserJson(): string {
    const login = this.viewerLogin ?? 'viewer';
    if (this.cachedUserJsonLogin !== login) {
      this.cachedUserJsonLogin = login;
      this.cachedUserJson = JSON.stringify({ login });
    }
    return this.cachedUserJson;
  }

  isAuthorized(authHeader: string | undefined): boolean {
    if (!this.expectedToken) return true;
    if (!authHeader) return false;
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    return m !== null && m[1] === this.expectedToken;
  }

  /** Fast raw-Buffer authorization check; returns 1 (ok), 0 (unauthorized), -1 (fallback). */
  isAuthorizedFast(buf: Buffer, start: number, end: number): number {
    if (this.expectedTokenBuf === null) return 1;
    if (start < 0) return 0;
    const len = end - start;
    if (len !== this.expectedBearerLen) {
      // Handle unusual whitespace like `Bearer  token` via fallback
      if (len > 7) return -1;
      return 0;
    }
    // Check "bearer " case-insensitively
    if (
      (buf[start]! | 0x20) !== 0x62 ||
      (buf[start + 1]! | 0x20) !== 0x65 ||
      (buf[start + 2]! | 0x20) !== 0x61 ||
      (buf[start + 3]! | 0x20) !== 0x72 ||
      (buf[start + 4]! | 0x20) !== 0x65 ||
      (buf[start + 5]! | 0x20) !== 0x72 ||
      buf[start + 6]! !== 0x20
    ) {
      return -1;
    }
    return buf.compare(this.expectedTokenBuf, 0, this.expectedTokenBuf.length, start + 7, end) === 0 ? 1 : 0;
  }

  /** Learn viewerLogin on first authenticated access to a created repo, or verify owner matches. */
  resolveRepo(owner: string, name: string): Repository | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
    }
    if (owner !== this.viewerLogin) return null;
    return repo;
  }

  createRepo(name: string, opts: { description?: string; private?: boolean; default_branch?: string; auto_init?: boolean }): Repository | null {
    if (this.repos.has(name)) return null;
    const ts = this.nextTimestamp();
    const repo: Repository = {
      id: this.nextId(),
      name,
      description: opts.description ?? '',
      private: Boolean(opts.private),
      default_branch: opts.default_branch || 'main',
      created_at: ts.iso,
      updated_at: ts.iso,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueByNumber: new Map(),
      nextIssueNumber: 1,
      pulls: [],
      nextPullNumber: 1,
      treeCache: new Map(),
      fetchCache: new Map(),
      deleted: false,
      refsVersion: 1,
      cachedReceivePackAdHttp: null,
      cachedRepoJson: null,
      uploadHttpCacheVersion: 0,
      lsRefsHttpCache: [],
      fetchHttpCache: [],
    };
    if (opts.auto_init) {
      const blobSha = writeObject(repo, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
      const treeSha = buildTreeFromFiles(repo, new Map([['README.md', { mode: '100644', sha: blobSha }]]));
      const commitSha = createCommit(repo, treeSha, [], 'Initial commit', this.getViewerLogin(), ts.epoch);
      repo.refs.set(`refs/heads/${repo.default_branch}`, commitSha);
    }
    this.repos.set(name, repo);
    this.repoOrder.push(repo);
    this.mutationEpoch += 1;
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.resolveRepo(owner, name);
    if (!repo) return false;
    repo.deleted = true;
    this.repos.delete(name);
    const idx = this.repoOrder.indexOf(repo);
    if (idx !== -1) this.repoOrder.splice(idx, 1);
    repo.refsVersion += 1;
    repo.cachedReceivePackAdHttp = null;
    repo.cachedRepoJson = null;
    this.mutationEpoch += 1;
    return true;
  }
}

export function invalidateIssueCache(store: ForgeStore, issue: Issue): void {
  issue.cachedJsonBuf = null;
  issue.cachedHttpBuf = null;
  store.mutationEpoch += 1;
}

export function invalidateRepoRefs(store: ForgeStore, repo: Repository): void {
  repo.refsVersion += 1;
  repo.cachedReceivePackAdHttp = null;
  store.mutationEpoch += 1;
}

export function invalidateRepoMeta(store: ForgeStore, repo: Repository): void {
  repo.cachedRepoJson = null;
  store.mutationEpoch += 1;
}

// ---------------------------------------------------------------------------
// Git object & packfile primitives

const HASH_HDR_BUF = Buffer.allocUnsafe(32);

export function hashObject(type: GitObjType, data: Buffer): string {
  let off = HASH_HDR_BUF.write(type, 0, 'ascii');
  HASH_HDR_BUF[off++] = 0x20;
  let len = data.length;
  if (len === 0) {
    HASH_HDR_BUF[off++] = 0x30;
  } else {
    const start = off;
    while (len > 0) {
      const q = Math.floor(len / 10);
      HASH_HDR_BUF[off++] = 0x30 + (len - q * 10);
      len = q;
    }
    for (let l = start, r = off - 1; l < r; l += 1, r -= 1) {
      const tmp = HASH_HDR_BUF[l]!;
      HASH_HDR_BUF[l] = HASH_HDR_BUF[r]!;
      HASH_HDR_BUF[r] = tmp;
    }
  }
  HASH_HDR_BUF[off++] = 0x00;
  return createHash('sha1').update(HASH_HDR_BUF.subarray(0, off)).update(data).digest('hex');
}

export function writeObject(repo: Repository, type: GitObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) {
    repo.objects.set(sha, { type, data });
  }
  return sha;
}

export function getCommitParent0(obj: GitObject): string | null {
  if (obj.parent0 !== undefined) return obj.parent0;
  const data = obj.data;
  const len = data.length;
  // Fast O(1) path for standard `tree <40-hex>\nparent <40-hex>\n...` commits
  if (
    len >= 93 &&
    data[45] === 0x0a &&
    data[46] === 0x70 &&
    data[47] === 0x61 &&
    data[48] === 0x72 &&
    data[49] === 0x65 &&
    data[50] === 0x6e &&
    data[51] === 0x74 &&
    data[52] === 0x20
  ) {
    const p0 = data.toString('ascii', 53, 93);
    obj.parent0 = p0;
    return p0;
  }
  let pos = 0;
  while (pos < len) {
    const nl = data.indexOf(0x0a, pos);
    const lineEnd = nl === -1 ? len : nl;
    if (lineEnd === pos) break;
    if (
      lineEnd - pos >= 47 &&
      data[pos] === 0x70 &&
      data[pos + 1] === 0x61 &&
      data[pos + 2] === 0x72 &&
      data[pos + 3] === 0x65 &&
      data[pos + 4] === 0x6e &&
      data[pos + 5] === 0x74 &&
      data[pos + 6] === 0x20
    ) {
      const p0 = data.toString('ascii', pos + 7, pos + 47);
      obj.parent0 = p0;
      return p0;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  obj.parent0 = null;
  return null;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function createCommit(
  repo: Repository,
  treeSha: string,
  parents: string[],
  message: string,
  authorName: string,
  epoch: number,
): string {
  const ident = `${authorName} <${authorName}@users.noreply.make.fun> ${epoch} +0000`;
  const lines = [`tree ${treeSha}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  const payload = `${lines.join('\n')}\n\n${message}`;
  return writeObject(repo, 'commit', Buffer.from(payload, 'utf8'));
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ak = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
    const bk = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    const normMode = e.mode === '040000' ? '40000' : e.mode;
    parts.push(Buffer.from(`${normMode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function readTreeFiles(repo: Repository, treeSha: string): Map<string, { mode: string; sha: string }> {
  const cached = repo.treeCache.get(treeSha);
  if (cached) return new Map(cached);

  const files = new Map<string, { mode: string; sha: string }>();
  const walk = (sha: string, prefix: string): void => {
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000' || entry.mode === '040000') {
        walk(entry.sha, fullPath);
      } else {
        files.set(fullPath, { mode: entry.mode, sha: entry.sha });
      }
    }
  };
  walk(treeSha, '');
  repo.treeCache.set(treeSha, files);
  return new Map(files);
}

export function getCommitFiles(repo: Repository, commitSha: string): Map<string, { mode: string; sha: string }> {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return new Map();
  const parsed = parseCommit(obj.data);
  return readTreeFiles(repo, parsed.tree);
}

export function buildTreeFromFiles(repo: Repository, files: Map<string, { mode: string; sha: string }>): string {
  interface DirNode {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [filePath, info] of files) {
    const parts = filePath.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let sub = cur.dirs.get(parts[i]!);
      if (!sub) {
        sub = { files: new Map(), dirs: new Map() };
        cur.dirs.set(parts[i]!, sub);
      }
      cur = sub;
    }
    cur.files.set(parts[parts.length - 1]!, info);
  }
  const writeDir = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, info] of node.files) {
      entries.push({ mode: info.mode, name, sha: info.sha });
    }
    for (const [name, sub] of node.dirs) {
      const subSha = writeDir(sub);
      entries.push({ mode: '40000', name, sha: subSha });
    }
    return writeObject(repo, 'tree', serializeTree(entries));
  };
  return writeDir(root);
}

export function walkCommitHistory(repo: Repository, tipSha: string, limit = 10000): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const queue = [tipSha];
  let head = 0;
  while (head < queue.length && result.length < limit) {
    const sha = queue[head++]!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    result.push(sha);
    const parsed = parseCommit(obj.data);
    for (const p of parsed.parents) {
      if (!seen.has(p)) queue.push(p);
    }
  }
  return result;
}

export function isAncestor(repo: Repository, ancestorSha: string, descendantSha: string): boolean {
  if (ancestorSha === descendantSha) return true;
  const seen = new Set<string>();
  const stack = [descendantSha];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestorSha) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    for (const p of parsed.parents) stack.push(p);
  }
  return false;
}

export function isFastForward(repo: Repository, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID || oldOid === newOid) return true;
  const newObj = repo.objects.get(newOid);
  if (newObj && newObj.type === 'commit' && getCommitParent0(newObj) === oldOid) {
    return true;
  }
  return isAncestor(repo, oldOid, newOid);
}

export function findMergeBase(repo: Repository, shaA: string, shaB: string): string | null {
  const ancestorsA = new Set<string>(walkCommitHistory(repo, shaA));
  const queue = [shaB];
  const seen = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const sha = queue[head++]!;
    if (ancestorsA.has(sha)) return sha;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    for (const p of parsed.parents) queue.push(p);
  }
  return null;
}

export function threeWayMergeFiles(
  repo: Repository,
  baseCommitSha: string | null,
  oursCommitSha: string,
  theirsCommitSha: string,
): { ok: true; files: Map<string, { mode: string; sha: string }> } | { ok: false; conflict: string } {
  const baseFiles = baseCommitSha ? getCommitFiles(repo, baseCommitSha) : new Map<string, { mode: string; sha: string }>();
  const oursFiles = getCommitFiles(repo, oursCommitSha);
  const theirsFiles = getCommitFiles(repo, theirsCommitSha);

  const allPaths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  const merged = new Map<string, { mode: string; sha: string }>();

  for (const p of allPaths) {
    const b = baseFiles.get(p);
    const o = oursFiles.get(p);
    const t = theirsFiles.get(p);

    const bSha = b?.sha;
    const oSha = o?.sha;
    const tSha = t?.sha;

    if (oSha === tSha) {
      if (o) merged.set(p, o);
    } else if (oSha === bSha) {
      if (t) merged.set(p, t);
    } else if (tSha === bSha) {
      if (o) merged.set(p, o);
    } else {
      return { ok: false, conflict: p };
    }
  }
  return { ok: true, files: merged };
}

export function resolveRefOrSha(repo: Repository, refOrSha: string | undefined): string | null {
  if (!refOrSha) {
    return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
  }
  if (/^[0-9a-f]{40}$/i.test(refOrSha)) {
    const lower = refOrSha.toLowerCase();
    return repo.objects.has(lower) ? lower : null;
  }
  if (repo.refs.has(refOrSha)) return repo.refs.get(refOrSha)!;
  if (repo.refs.has(`refs/heads/${refOrSha}`)) return repo.refs.get(`refs/heads/${refOrSha}`)!;
  if (repo.refs.has(`refs/tags/${refOrSha}`)) return repo.refs.get(`refs/tags/${refOrSha}`)!;
  return null;
}

// ---------------------------------------------------------------------------
// Pkt-line & Packfile v2

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const totalLen = payload.length + 4;
  const out = Buffer.allocUnsafe(totalLen);
  out.write(totalLen.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  payload.copy(out, 4);
  return out;
}

export interface PktItem {
  type: 'flush' | 'delim' | 'data';
  data?: Buffer;
}

export function parsePktLines(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.toString('ascii', off, off + 4);
    if (hex === '0000') {
      items.push({ type: 'flush' });
      off += 4;
      continue;
    }
    if (hex === '0001') {
      items.push({ type: 'delim' });
      off += 4;
      continue;
    }
    if (hex === '0002') {
      off += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    items.push({ type: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { items, rest: buf.subarray(off) };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarInt = (): number => {
    let val = 0;
    let shift = 0;
    while (pos < delta.length) {
      const b = delta[pos++]!;
      val |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return val;
  };
  const baseLen = readVarInt();
  if (baseLen !== base.length) {
    throw new Error(`delta base size mismatch: expected ${baseLen}, got ${base.length}`);
  }
  const targetLen = readVarInt();
  const out = Buffer.allocUnsafe(targetLen);
  let outPos = 0;

  while (pos < delta.length) {
    const cmd = delta[pos++]!;
    if ((cmd & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      if (cmd & 0x01) cpOff |= delta[pos++]!;
      if (cmd & 0x02) cpOff |= delta[pos++]! << 8;
      if (cmd & 0x04) cpOff |= delta[pos++]! << 16;
      if (cmd & 0x08) cpOff |= delta[pos++]! << 24;
      if (cmd & 0x10) cpSize |= delta[pos++]!;
      if (cmd & 0x20) cpSize |= delta[pos++]! << 8;
      if (cmd & 0x40) cpSize |= delta[pos++]! << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (cmd > 0) {
      delta.copy(out, outPos, pos, pos + cmd);
      pos += cmd;
      outPos += cmd;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (outPos !== targetLen) {
    throw new Error(`delta target size mismatch: expected ${targetLen}, got ${outPos}`);
  }
  return out;
}

const PACK_MAGIC = 0x5041434b; // 'PACK'
const PACK_OBJ_TYPES: readonly (GitObjType | undefined)[] = [undefined, 'commit', 'tree', 'blob', 'tag'];
const UNPACK_OFFSETS: number[] = [];
const UNPACK_TYPES: GitObjType[] = [];
const UNPACK_DATAS: Buffer[] = [];

export function unpackPackfile(repo: Repository, pack: Buffer): void {
  if (pack.length < 32) throw new Error('packfile too short');
  if (pack.readUInt32BE(0) !== PACK_MAGIC) throw new Error('bad PACK magic');
  const count = pack.readUInt32BE(8);
  let off = 12;

  let byOffset: Map<number, { type: GitObjType; data: Buffer }> | null = null;
  let entryCount = 0;
  let pendingRefDeltas: Array<{ baseSha: string; delta: Buffer }> | null = null;

  try {
    for (let i = 0; i < count; i += 1) {
      const entryStart = off;
      let c = pack[off++]!;
      const objType = (c >> 4) & 7;
      while (c & 0x80) {
        c = pack[off++]!;
      }

      if (objType >= 1 && objType <= 4) {
        const res = inflateSync(pack.subarray(off), { info: true }) as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        off += res.engine.bytesWritten;
        const type = PACK_OBJ_TYPES[objType]!;
        const data = res.buffer;
        writeObject(repo, type, data);
        if (byOffset !== null) {
          byOffset.set(entryStart, { type, data });
        } else {
          UNPACK_OFFSETS[entryCount] = entryStart;
          UNPACK_TYPES[entryCount] = type;
          UNPACK_DATAS[entryCount] = data;
          entryCount += 1;
        }
      } else if (objType === 6) {
        // OBJ_OFS_DELTA
        let b = pack[off++]!;
        let backOff = b & 0x7f;
        while (b & 0x80) {
          b = pack[off++]!;
          backOff = ((backOff + 1) << 7) | (b & 0x7f);
        }
        const res = inflateSync(pack.subarray(off), { info: true }) as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        off += res.engine.bytesWritten;
        if (byOffset === null) {
          byOffset = new Map();
          for (let j = 0; j < entryCount; j += 1) {
            byOffset.set(UNPACK_OFFSETS[j]!, { type: UNPACK_TYPES[j]!, data: UNPACK_DATAS[j]! });
          }
        }
        const baseEntry = byOffset.get(entryStart - backOff);
        if (!baseEntry) throw new Error(`missing OFS_DELTA base at ${entryStart - backOff}`);
        const target = applyDelta(baseEntry.data, res.buffer);
        writeObject(repo, baseEntry.type, target);
        byOffset.set(entryStart, { type: baseEntry.type, data: target });
      } else if (objType === 7) {
        // OBJ_REF_DELTA
        const baseSha = pack.subarray(off, off + 20).toString('hex');
        off += 20;
        const res = inflateSync(pack.subarray(off), { info: true }) as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        off += res.engine.bytesWritten;
        const baseObj = repo.objects.get(baseSha);
        if (baseObj) {
          const target = applyDelta(baseObj.data, res.buffer);
          writeObject(repo, baseObj.type, target);
          if (byOffset !== null) {
            byOffset.set(entryStart, { type: baseObj.type, data: target });
          } else {
            UNPACK_OFFSETS[entryCount] = entryStart;
            UNPACK_TYPES[entryCount] = baseObj.type;
            UNPACK_DATAS[entryCount] = target;
            entryCount += 1;
          }
        } else {
          if (pendingRefDeltas === null) pendingRefDeltas = [];
          pendingRefDeltas.push({ baseSha, delta: res.buffer });
        }
      } else {
        throw new Error(`unsupported pack object type ${objType}`);
      }
    }

    if (pendingRefDeltas !== null) {
      for (let pass = 0; pass < pendingRefDeltas.length && pendingRefDeltas.length > 0; pass += 1) {
        for (let i = pendingRefDeltas.length - 1; i >= 0; i -= 1) {
          const item = pendingRefDeltas[i]!;
          const baseObj = repo.objects.get(item.baseSha);
          if (baseObj) {
            const target = applyDelta(baseObj.data, item.delta);
            writeObject(repo, baseObj.type, target);
            pendingRefDeltas.splice(i, 1);
          }
        }
      }
      if (pendingRefDeltas.length > 0) {
        throw new Error(`unresolved REF_DELTA base ${pendingRefDeltas[0]!.baseSha}`);
      }
    }
  } finally {
    for (let j = 0; j < entryCount; j += 1) {
      UNPACK_DATAS[j] = undefined!;
    }
  }
}

export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return null;
}

export function peelOid(repo: Repository, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') break;
    const target = parseTagTarget(obj.data);
    if (!target) break;
    cur = target;
  }
  return cur;
}

export function collectReachableObjects(
  repo: Repository,
  wants: string[],
  haves: string[] = [],
  depth?: number,
  clientShallow: string[] = [],
): string[] {
  const shallowSet = new Set<string>(clientShallow);
  const haveSet = new Set<string>();
  const addTreeToSet = (treeSha: string, target: Set<string>): void => {
    const stack = [treeSha];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (target.has(cur)) continue;
      target.add(cur);
      const obj = repo.objects.get(cur);
      if (obj && obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.sha);
      }
    }
  };

  const markHave = (sha: string): void => {
    const stack = [sha];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (haveSet.has(cur)) continue;
      haveSet.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const parsed = parseCommit(obj.data);
        addTreeToSet(parsed.tree, haveSet);
        if (!shallowSet.has(cur)) {
          for (const p of parsed.parents) stack.push(p);
        }
      } else if (obj.type === 'tree') {
        addTreeToSet(cur, haveSet);
      } else if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) stack.push(target);
      }
    }
  };
  for (const h of haves) markHave(h);

  const visited = new Set<string>();
  const seenCommits = new Set<string>();
  const out: string[] = [];

  const addTree = (treeSha: string): void => {
    const stack = [treeSha];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur) || haveSet.has(cur)) continue;
      const obj = repo.objects.get(cur);
      if (!obj) continue;
      visited.add(cur);
      out.push(cur);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.sha);
      }
    }
  };

  const queue: Array<{ sha: string; d: number }> = wants.map((sha) => ({ sha, d: 1 }));
  let qHead = 0;
  while (qHead < queue.length) {
    const { sha, d } = queue[qHead++]!;
    if (seenCommits.has(sha)) continue;
    seenCommits.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!visited.has(sha) && !haveSet.has(sha)) {
        visited.add(sha);
        out.push(sha);
      }
      const target = parseTagTarget(obj.data);
      if (target) queue.push({ sha: target, d });
      continue;
    }
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      if (!visited.has(sha) && !haveSet.has(sha)) {
        visited.add(sha);
        out.push(sha);
        addTree(parsed.tree);
      }
      if (depth === undefined || d < depth) {
        for (const p of parsed.parents) {
          queue.push({ sha: p, d: d + 1 });
        }
      }
    } else if (obj.type === 'tree') {
      addTree(sha);
    } else if (!visited.has(sha) && !haveSet.has(sha)) {
      visited.add(sha);
      out.push(sha);
    }
  }
  return out;
}

const TYPE_NUM: Record<GitObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function buildPackfile(repo: Repository, oids: string[]): Buffer {
  const objs: GitObject[] = [];
  let bodyLen = 12;
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (!obj.deflated) obj.deflated = deflateSync(obj.data);
    objs.push(obj);
    let hdrLen = 1;
    let size = obj.data.length >> 4;
    while (size > 0) {
      hdrLen += 1;
      size >>= 7;
    }
    bodyLen += hdrLen + obj.deflated.length;
  }

  const out = Buffer.allocUnsafe(bodyLen + 20);
  out.write('PACK', 0, 'ascii');
  out.writeUInt32BE(2, 4);
  out.writeUInt32BE(objs.length, 8);
  let off = 12;

  for (const obj of objs) {
    let size = obj.data.length;
    const t = TYPE_NUM[obj.type];
    let first = (t << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    out[off++] = first;
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      out[off++] = b;
    }
    const def = obj.deflated!;
    def.copy(out, off);
    off += def.length;
  }

  const checksum = createHash('sha1').update(out.subarray(0, bodyLen)).digest();
  checksum.copy(out, bodyLen);
  return out;
}
