// The forge's in-memory state: one store per process, shared by every surface (REST today;
// git smart HTTP, GraphQL and MCP in later blocks read and write the same records).
//
// Ownership model: this forge has exactly one user — the bearer token's holder. The token is
// opaque, so the server never learns the login out of band; instead it adopts the first owner
// segment it serves under /api/v3/repos/{owner}/... (or a git path) as the viewer's login, and
// answers GET /api/v3/user with it. A repository name under any other owner is a 404, which is
// the behaviour the conformance suite checks (the stranger's name is only ever probed after
// the owner's own reads).

import { buildCommit, buildTree, hashObject, parseCommit, parseTree, type GitObjectType, type TreeEntry } from './gitobj.ts';

/** One stored git object. */
export interface StoredObject {
  readonly type: GitObjectType;
  readonly body: Buffer;
}

/** One repository label: the name issues reference it by id, so a rename keeps attachments. */
export interface LabelRecord {
  readonly id: number;
  name: string;
  color: string;
  description: string | null;
}

/**
 * The pull-request half of an issue record: head/base branch names, the branch tips captured
 * at creation (views refresh them from the live refs while the branches exist), and the merge
 * outcome once the pull is merged.
 */
export interface PullRecord {
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

/** One issue (or pull-request, from block 4) comment. */
export interface CommentRecord {
  readonly id: number;
  body: string;
  readonly authorLogin: string;
  readonly createdAt: string;
  updatedAt: string;
}

/**
 * One issue. Pull requests join this same list in block 4 (GitHub numbers them from one
 * sequence, kept on the repo as nextNumber); `pull` stays null for plain issues.
 */
export interface IssueRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  /** Label ids (LabelRecord.id), resolved to label objects when a view is rendered. */
  labelIds: number[];
  assigneeLogins: string[];
  readonly authorLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly comments: CommentRecord[];
  pull: PullRecord | null;
}

/** One repository: metadata plus its own object store and refs. */
export interface RepoRecord {
  readonly id: number;
  readonly name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  readonly createdAt: string;
  readonly objects: Map<string, StoredObject>;
  /** Full ref name ('refs/heads/main') to the commit sha it points at. */
  readonly refs: Map<string, string>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  /** The repository's labels, in creation order. */
  readonly labels: LabelRecord[];
  /** The repository's issues (and, from block 4, pull requests), in creation order. */
  readonly issues: IssueRecord[];
}

/** A flattened tree: repository path -> blob mode and sha. */
export type FlatTree = Map<string, { readonly mode: string; readonly sha: string }>;

/** The whole forge. */
export class Store {
  /** The adopted viewer login; null until the first owner-carrying path is served. */
  viewerLogin: string | null = null;
  /** Repositories by name (single tenant: names are unique). */
  readonly repos: RepoRecord[] = [];
  private nextRepoId = 1;
  /** Global id sequence for labels, issues and comments (GitHub ids are instance-wide). */
  private nextRecordId = 1;
  /** Monotonic seconds for commit timestamps, so commit ids stay stable within a run. */
  private clockSec = 1_735_689_600; // 2025-01-01T00:00:00Z

  /** Adopt `owner` as the viewer login if none is adopted yet. */
  adoptOwner(owner: string): void {
    if (this.viewerLogin === null && owner !== '') this.viewerLogin = owner;
  }

  /** The login to report: the adopted one, or a placeholder before adoption. */
  login(): string {
    return this.viewerLogin ?? 'user';
  }

  /** The next commit timestamp, one second later than the last. */
  tick(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  /** The next global record id (labels, issues, comments). */
  recordId(): number {
    const id = this.nextRecordId;
    this.nextRecordId += 1;
    return id;
  }

  /** An ISO timestamp one tick later than the last, so record times never go backwards. */
  nowIso(): string {
    return new Date(this.tick() * 1000).toISOString();
  }

  findRepo(name: string): RepoRecord | undefined {
    return this.repos.find((repo) => repo.name === name);
  }

  createRepo(name: string, isPrivate: boolean, description: string): RepoRecord {
    const repo: RepoRecord = {
      id: this.nextRepoId,
      name,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdAt: new Date().toISOString(),
      objects: new Map(),
      refs: new Map(),
      nextNumber: 1,
      labels: [],
      issues: [],
    };
    this.nextRepoId += 1;
    this.repos.push(repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    const index = this.repos.findIndex((repo) => repo.name === name);
    if (index === -1) return false;
    this.repos.splice(index, 1);
    return true;
  }
}

/** Store an object in a repository and return its sha (idempotent: same bytes, same sha). */
export function putObject(repo: RepoRecord, type: GitObjectType, body: Buffer): string {
  const sha = hashObject(type, body);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, body });
  return sha;
}

/** Read an object by sha, or undefined when the repository does not hold it. */
export function getObject(repo: RepoRecord, sha: string): StoredObject | undefined {
  return repo.objects.get(sha);
}

/** The commit sha a branch points at, or undefined for an unborn or unknown branch. */
export function branchTip(repo: RepoRecord, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Flatten a tree (recursively) into path -> blob entries. An unknown tree flattens to empty. */
export function flattenTree(repo: RepoRecord, treeSha: string): FlatTree {
  const flat: FlatTree = new Map();
  const walk = (sha: string, prefix: string): void => {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'tree') return;
    for ( const entry of parseTree(object.body)) {
      if (entry.mode === '40000') walk(entry.sha, `${prefix}${entry.name}/`);
      else flat.set(`${prefix}${entry.name}`, { mode: entry.mode, sha: entry.sha });
    }
  };
  walk(treeSha, '');
  return flat;
}

/** The flattened tree at a commit, or an empty map for an unknown commit. */
export function flattenCommit(repo: RepoRecord, commitSha: string): FlatTree {
  const object = repo.objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.body).tree);
}

/** Persist a flattened tree back into nested tree objects; returns the root tree sha. */
export function storeFlatTree(repo: RepoRecord, flat: FlatTree): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, value] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: value.mode, name: rest, sha: value.sha });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const dir of subdirs) {
      entries.push({ mode: '40000', name: dir, sha: build(`${prefix}${dir}/`) });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build('');
}

/** The forge's commit identity line for REST-made commits. */
function identityLine(store: Store): string {
  const login = store.login();
  return `${login} <${login}@example.invalid> ${store.tick()} +0000`;
}

/**
 * Commit a set of file changes on a branch: `changes` maps a path to its new bytes, or null to
 * delete it. `parent` is the commit the new commit builds on (null for a root commit, e.g. an
 * unborn repository's first); the branch ref is moved to the new commit. Returns the new
 * commit's sha and the blob sha of each written path.
 */
export function commitChanges(
  store: Store,
  repo: RepoRecord,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
  parent: string | null,
): { commitSha: string; blobShas: Map<string, string> } {
  const flat: FlatTree = parent === null ? new Map() : flattenCommit(repo, parent);
  const blobShas = new Map<string, string>();
  for (const [path, bytes] of changes) {
    if (bytes === null) {
      flat.delete(path);
    } else {
      const sha = putObject(repo, 'blob', bytes);
      flat.set(path, { mode: '100644', sha });
      blobShas.set(path, sha);
    }
  }
  const treeSha = storeFlatTree(repo, flat);
  const identity = identityLine(store);
  const commitSha = putObject(repo, 'commit', buildCommit({
    tree: treeSha,
    parents: parent === null ? [] : [parent],
    author: identity,
    committer: identity,
    message,
  }));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobShas };
}

/**
 * Commit an already-built tree on a branch with explicit parents — the merge/squash/rebase
 * shapes commitChanges cannot express — and move the branch ref to the new commit. Returns
 * the new commit's sha. The tree must already be stored (storeFlatTree).
 */
export function commitTree(
  store: Store,
  repo: RepoRecord,
  branch: string,
  treeSha: string,
  parents: readonly string[],
  message: string,
): string {
  const identity = identityLine(store);
  const commitSha = putObject(repo, 'commit', buildCommit({
    tree: treeSha,
    parents,
    author: identity,
    committer: identity,
    message,
  }));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return commitSha;
}

/** Create a branch pointing at an existing commit sha. */
export function createBranchRef(repo: RepoRecord, branch: string, sha: string): void {
  repo.refs.set(`refs/heads/${branch}`, sha);
}

/** Branch names in a repository, alphabetical (GitHub's list order). */
export function branchNames(repo: RepoRecord): string[] {
  const names: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
  }
  return names.sort();
}

/**
 * The commits reachable from `startSha`, newest first: a depth-first walk in parent order with
 * duplicates removed, which is the exact history order for the linear histories this forge's
 * REST surface creates.
 */
export function listCommitShas(repo: RepoRecord, startSha: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (sha: string): void => {
    if (seen.has(sha)) return;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return;
    seen.add(sha);
    order.push(sha);
    for (const parent of parseCommit(object.body).parents) visit(parent);
  };
  visit(startSha);
  return order;
}
