// The REST v3 pull-request surface, on the same shared store rest.ts and issues.ts serve.
// Shapes and statuses follow GitHub's API as the kit's conformance suite
// (program/env/src/checks-rest.ts, the `pulls` group) exercises it:
//
//   POST   /repos/{o}/{r}/pulls                      201 the pull; 422 on a bad head/base
//   GET    /repos/{o}/{r}/pulls?state=&head=&base=   200 list (default state=open)
//   GET    /repos/{o}/{r}/pulls/{n}                  200 one pull; 404 when unknown
//   PATCH  /repos/{o}/{r}/pulls/{n}                  200 the updated pull
//   GET    /repos/{o}/{r}/pulls/{n}/files            200 [{filename, status, additions, ...}]
//   GET    /repos/{o}/{r}/pulls/{n}/commits          200 the head's commits past the merge base
//   PUT    /repos/{o}/{r}/pulls/{n}/merge            200 {sha, merged:true, message};
//                                                    404 unknown, 405 conflict/not mergeable
//
// A pull request IS an issue record with pull data hung on it (IssueRecord.pull), drawing its
// number from the repository's one shared sequence, exactly as on GitHub. The files view and
// the merge both work on real git trees from the object store: files diff the merge base
// against the head, and a merge is a three-way tree merge (ancestor / base tip / head tip)
// that refuses with 405 when both sides changed the same path differently.

import { parseCommit } from './gitobj.ts';
import {
  commitView,
  isReply,
  jsonBody,
  notFound,
  paginate,
  repoOr404,
  repoView,
  type Handler,
  type Reply,
  type Route,
} from './rest.ts';
import {
  branchTip,
  commitTree,
  flattenCommit,
  getObject,
  listCommitShas,
  storeFlatTree,
  type FlatTree,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
  type Store,
} from './store.ts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Views

/** The GitHub user object for a login (same shape issues.ts renders). */
function userView(login: string): Json {
  return {
    login,
    id: 1,
    node_id: 'user-1',
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `/${login}`,
    type: 'User',
    site_admin: false,
  };
}

/** One side (head or base) of a pull: the branch's live tip while it exists, else the tip captured at creation. */
function refView(store: Store, repo: RepoRecord, issue: IssueRecord, side: 'head' | 'base'): Json {
  const pull = issue.pull as PullRecord;
  const ref = side === 'head' ? pull.headRef : pull.baseRef;
  const captured = side === 'head' ? pull.headSha : pull.baseSha;
  return {
    label: `${store.login()}:${ref}`,
    ref,
    sha: branchTip(repo, ref) ?? captured,
    user: userView(store.login()),
    repo: repoView(store, repo),
  };
}

/** The GitHub pull-request object. */
function pullView(store: Store, repo: RepoRecord, issue: IssueRecord): Json {
  const pull = issue.pull as PullRecord;
  const login = store.login();
  return {
    id: issue.id,
    node_id: `pull-${issue.id}`,
    url: `/api/v3/repos/${login}/${repo.name}/pulls/${issue.number}`,
    html_url: `/${login}/${repo.name}/pull/${issue.number}`,
    diff_url: `/${login}/${repo.name}/pull/${issue.number}.diff`,
    patch_url: `/${login}/${repo.name}/pull/${issue.number}.patch`,
    number: issue.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    body: issue.body,
    user: userView(issue.authorLogin),
    draft: pull.draft,
    head: refView(store, repo, issue, 'head'),
    base: refView(store, repo, issue, 'base'),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: issue.closedAt,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared resolution helpers

/** GitHub's 422 body: a message plus a per-field errors list (same shape issues.ts renders). */
function validationFailed(errors: readonly { resource: string; field: string; code: string }[]): Reply {
  const summary = errors.map((error) => `${error.field} ${error.code === 'missing_field' ? 'is required' : error.code}`).join(', ');
  return {
    status: 422,
    body: { message: `Validation Failed: ${summary}`, errors: errors.map((error) => ({ ...error })) },
  };
}

/** rest.ts's isReply is typed for the RepoRecord union; this serves the unions here. */
function failed<T>(value: T | Reply): value is Reply {
  return typeof value === 'object' && value !== null && typeof (value as Reply).status === 'number';
}

/** Resolve the pull a route names (a record of the shared sequence with pull data), or 404. */
function pullOr404(repo: RepoRecord, params: Readonly<Record<string, string>>): IssueRecord | Reply {
  const raw = params.number ?? '';
  const number = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const issue = Number.isNaN(number)
    ? undefined
    : repo.issues.find((candidate) => candidate.number === number && candidate.pull !== null);
  return issue ?? notFound();
}

/** A branch name from a create/update field: 'refs/heads/x' and 'owner:x' both mean 'x'. */
function branchNameOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  let name = value.trim();
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.indexOf(':');
  if (colon !== -1) name = name.slice(colon + 1);
  return name;
}

// ---------------------------------------------------------------------------------------------
// Git graph helpers (ancestors, merge base, three-way tree merge)

/** Every commit reachable from `sha`, as a set (listCommitShas already walks ancestors). */
function ancestorSet(repo: RepoRecord, sha: string): Set<string> {
  return new Set(listCommitShas(repo, sha));
}

/**
 * The merge base of two commits: breadth-first from `a` recording generations, then
 * breadth-first from `b` — the first commit already recorded is a best common ancestor.
 */
export function mergeBase(repo: RepoRecord, a: string, b: string): string | undefined {
  if (a === b) return a;
  const generation = new Map<string, number>();
  const queueA: string[] = [a];
  generation.set(a, 0);
  for (let at = 0; at < queueA.length; at += 1) {
    const sha = queueA[at] as string;
    const object = getObject(repo, sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.body).parents) {
      if (!generation.has(parent)) {
        generation.set(parent, (generation.get(sha) ?? 0) + 1);
        queueA.push(parent);
      }
    }
  }
  const seen = new Set<string>([b]);
  const queueB: string[] = [b];
  for (let at = 0; at < queueB.length; at += 1) {
    const sha = queueB[at] as string;
    if (generation.has(sha)) return sha;
    const object = getObject(repo, sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.body).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queueB.push(parent);
      }
    }
  }
  return undefined;
}

type FlatEntry = { readonly mode: string; readonly sha: string };

function sameEntry(a: FlatEntry | undefined, b: FlatEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.sha === b.sha && a.mode === b.mode;
}

/**
 * Three-way merge of flattened trees: a path changed on only one side takes that side, a
 * path changed identically on both takes it once, a path changed differently on both (or
 * changed against a delete) is a conflict. Returns the merged tree, or null on conflict.
 */
export function mergeTrees(ancestor: FlatTree, ours: FlatTree, theirs: FlatTree): FlatTree | null {
  const merged: FlatTree = new Map();
  const paths = new Set<string>([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (sameEntry(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (sameEntry(a, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (sameEntry(a, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return null;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Create / list / get / update

const createPull: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const body = jsonBody(info);
  const headRef = branchNameOf(body.head);
  const baseRef = branchNameOf(body.base) || repo.defaultBranch;
  if (headRef === '') return validationFailed([{ resource: 'PullRequest', field: 'head', code: 'missing_field' }]);

  // GitHub lets a pull be opened from an existing issue (`issue: <number>` supplies the text).
  let title = typeof body.title === 'string' ? body.title : '';
  let text = typeof body.body === 'string' ? body.body : '';
  if (title === '' && typeof body.issue === 'number') {
    const source = repo.issues.find((candidate) => candidate.number === body.issue && candidate.pull === null);
    if (source !== undefined) {
      title = source.title;
      text = source.body;
    }
  }
  if (title === '') return validationFailed([{ resource: 'PullRequest', field: 'title', code: 'missing_field' }]);

  const headSha = branchTip(repo, headRef);
  if (headSha === undefined) {
    return {
      status: 422,
      body: { message: `Validation Failed: head ref "${headRef}" is not a branch`, errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] },
    };
  }
  const baseSha = branchTip(repo, baseRef);
  if (baseSha === undefined) {
    return {
      status: 422,
      body: { message: `Validation Failed: base ref "${baseRef}" is not a branch`, errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] },
    };
  }
  const baseAncestors = ancestorSet(repo, baseSha);
  const hasNewCommits = listCommitShas(repo, headSha).some((sha) => !baseAncestors.has(sha));
  if (!hasNewCommits) {
    return {
      status: 422,
      body: { message: `Validation Failed: No commits between ${baseRef} and ${headRef}`, errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] },
    };
  }
  const duplicate = repo.issues.find(
    (candidate) =>
      candidate.pull !== null &&
      candidate.state === 'open' &&
      candidate.pull.headRef === headRef &&
      candidate.pull.baseRef === baseRef,
  );
  if (duplicate !== undefined) {
    return {
      status: 422,
      body: {
        message: `Validation Failed: A pull request already exists for ${headRef} into ${baseRef}`,
        errors: [{ resource: 'PullRequest', field: 'head', code: 'already_exists' }],
      },
    };
  }

  const stamp = store.nowIso();
  const issue: IssueRecord = {
    id: store.recordId(),
    number: repo.nextNumber,
    title,
    body: text,
    state: 'open',
    stateReason: null,
    labelIds: [],
    assigneeLogins: [],
    authorLogin: store.login(),
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    comments: [],
    pull: { headRef, baseRef, headSha, baseSha, draft: body.draft === true, merged: false, mergedAt: null, mergeCommitSha: null },
  };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return { status: 201, body: pullView(store, repo, issue) };
};

const listPulls: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const state = info.query.get('state') ?? 'open';
  let pulls = repo.issues.filter((issue) => issue.pull !== null);
  if (state === 'open' || state === 'closed') pulls = pulls.filter((issue) => issue.state === state);
  const headFilter = info.query.get('head');
  if (headFilter !== null && headFilter !== '') {
    const wanted = branchNameOf(headFilter);
    pulls = pulls.filter((issue) => (issue.pull as PullRecord).headRef === wanted);
  }
  const baseFilter = info.query.get('base');
  if (baseFilter !== null && baseFilter !== '') {
    pulls = pulls.filter((issue) => (issue.pull as PullRecord).baseRef === baseFilter);
  }
  const sort = info.query.get('sort') ?? 'created';
  const direction = info.query.get('direction') ?? 'desc';
  const key = (issue: IssueRecord): string => (sort === 'updated' ? issue.updatedAt : issue.createdAt);
  const sorted = [...pulls].sort((a, b) => {
    const order = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.number - b.number;
    return direction === 'asc' ? order : -order;
  });
  const views = sorted.map((issue) => pullView(store, repo, issue));
  const { page, headers } = paginate(views, info, `/api/v3/repos/${params.owner}/${params.repo}/pulls`);
  return { status: 200, body: page, headers };
};

const getPull: Handler = (store, _info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const issue = pullOr404(repo, params);
  if (failed(issue)) return issue;
  return { status: 200, body: pullView(store, repo, issue) };
};

const patchPull: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const issue = pullOr404(repo, params);
  if (failed(issue)) return issue;
  const pull = issue.pull as PullRecord;
  const body = jsonBody(info);
  if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.base !== undefined) {
    const baseRef = branchNameOf(body.base);
    if (baseRef === '' || branchTip(repo, baseRef) === undefined) {
      return {
        status: 422,
        body: { message: `Validation Failed: base ref "${String(body.base)}" is not a branch`, errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] },
      };
    }
    (pull as { baseRef: string }).baseRef = baseRef;
    pull.baseSha = branchTip(repo, baseRef) as string;
  }
  if (body.state !== undefined) {
    if (body.state !== 'open' && body.state !== 'closed') {
      return validationFailed([{ resource: 'PullRequest', field: 'state', code: 'invalid' }]);
    }
    if (body.state === 'open' && pull.merged) {
      return validationFailed([{ resource: 'PullRequest', field: 'state', code: 'invalid' }]);
    }
    if (body.state !== issue.state) {
      issue.state = body.state;
      issue.closedAt = body.state === 'closed' ? store.nowIso() : null;
    }
  }
  issue.updatedAt = store.nowIso();
  return { status: 200, body: pullView(store, repo, issue) };
};

// ---------------------------------------------------------------------------------------------
// Files and commits (diff of the merge base against the head)

/** The text lines of a blob: a trailing newline ends the last line, it does not add one. */
function linesOf(bytes: Buffer): string[] {
  const text = bytes.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function blobBytes(repo: RepoRecord, sha: string | undefined): Buffer {
  if (sha === undefined) return Buffer.alloc(0);
  const object = getObject(repo, sha);
  return object !== undefined && object.type === 'blob' ? object.body : Buffer.alloc(0);
}

/** Line-diff counts between two blobs: an LCS over lines, with a coarse fallback for huge files. */
export function diffCounts(repo: RepoRecord, beforeSha: string | undefined, afterSha: string | undefined): { additions: number; deletions: number } {
  const before = linesOf(blobBytes(repo, beforeSha));
  const after = linesOf(blobBytes(repo, afterSha));
  if (before.length === 0) return { additions: after.length, deletions: 0 };
  if (after.length === 0) return { additions: 0, deletions: before.length };
  if (before.length * after.length > 4_000_000) return { additions: after.length, deletions: before.length };
  const width = after.length + 1;
  const dp = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = before[i] === after[j]
        ? (dp[(i + 1) * width + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: after.length - common, deletions: before.length - common };
}

/** The diff endpoints of a pull: the merge base of the live tips, and the head tip. */
function diffEndpoints(repo: RepoRecord, pull: PullRecord): { baseSha: string | undefined; headSha: string } {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const ancestor = mergeBase(repo, headSha, baseSha);
  return { baseSha: ancestor, headSha };
}

const listPullFiles: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const issue = pullOr404(repo, params);
  if (failed(issue)) return issue;
  const { baseSha, headSha } = diffEndpoints(repo, issue.pull as PullRecord);
  const before: FlatTree = baseSha === undefined ? new Map() : flattenCommit(repo, baseSha);
  const after = flattenCommit(repo, headSha);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files: Json[] = [];
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (sameEntry(oldEntry, newEntry)) continue;
    const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
    const counts = diffCounts(repo, oldEntry?.sha, newEntry?.sha);
    files.push({
      sha: newEntry?.sha ?? oldEntry?.sha ?? '',
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  const { page, headers } = paginate(files, info, `/api/v3/repos/${params.owner}/${params.repo}/pulls/${params.number}/files`);
  return { status: 200, body: page, headers };
};

const listPullCommits: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const issue = pullOr404(repo, params);
  if (failed(issue)) return issue;
  const { baseSha, headSha } = diffEndpoints(repo, issue.pull as PullRecord);
  const baseAncestors = baseSha === undefined ? new Set<string>() : ancestorSet(repo, baseSha);
  const views = listCommitShas(repo, headSha)
    .filter((sha) => !baseAncestors.has(sha))
    .map((sha) => commitView(repo, sha));
  const { page, headers } = paginate(views, info, `/api/v3/repos/${params.owner}/${params.repo}/pulls/${params.number}/commits`);
  return { status: 200, body: page, headers };
};

// ---------------------------------------------------------------------------------------------
// Merge

const mergePull: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const issue = pullOr404(repo, params);
  if (failed(issue)) return issue;
  const pull = issue.pull as PullRecord;
  if (pull.merged || issue.state !== 'open') {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const body = jsonBody(info);
  const method = typeof body.merge_method === 'string' && body.merge_method !== '' ? body.merge_method : 'merge';
  if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
    return { status: 405, body: { message: 'Merge is not allowed on this repository' } };
  }

  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const ancestor = mergeBase(repo, headSha, baseSha);
  if (ancestor === headSha) {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const ancestorTree: FlatTree = ancestor === undefined ? new Map() : flattenCommit(repo, ancestor);
  const mergedTree = mergeTrees(ancestorTree, flattenCommit(repo, baseSha), flattenCommit(repo, headSha));
  if (mergedTree === null) {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const mergedTreeSha = storeFlatTree(repo, mergedTree);
  const title = typeof body.commit_title === 'string' && body.commit_title !== '' ? body.commit_title : issue.title;
  const message = typeof body.commit_message === 'string' ? body.commit_message : issue.body;

  let mergeSha: string;
  if (method === 'merge') {
    mergeSha = commitTree(store, repo, pull.baseRef, mergedTreeSha, [baseSha, headSha], `Merge pull request #${issue.number} from ${pull.headRef}`);
  } else if (method === 'rebase') {
    // Replay the head's own commits (oldest first) onto the base tip. Each replayed commit
    // keeps its source tree, so the branch lands on the head's tree; when the base moved
    // under the head this is the linear approximation GitHub's rebase makes unnecessary
    // here — the three-way result above already proved the trees compatible.
    const baseAncestors = ancestor === undefined ? new Set<string>() : ancestorSet(repo, ancestor);
    const own = listCommitShas(repo, headSha).filter((sha) => !baseAncestors.has(sha)).reverse();
    let parent = baseSha;
    mergeSha = baseSha;
    for (const sha of own) {
      const object = getObject(repo, sha);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.body);
      mergeSha = commitTree(store, repo, pull.baseRef, commit.tree, [parent], commit.message);
      parent = mergeSha;
    }
    if (own.length === 0) mergeSha = commitTree(store, repo, pull.baseRef, mergedTreeSha, [baseSha], `${title} (#${issue.number})`);
  } else {
    const text = message === '' ? `${title} (#${issue.number})` : `${title} (#${issue.number})\n\n${message}`;
    mergeSha = commitTree(store, repo, pull.baseRef, mergedTreeSha, [baseSha], text);
  }

  const stamp = store.nowIso();
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.mergeCommitSha = mergeSha;
  issue.state = 'closed';
  issue.closedAt = stamp;
  issue.updatedAt = stamp;
  return { status: 200, body: { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' } };
};

// ---------------------------------------------------------------------------------------------
// The route table for this block; app.ts serves it beside rest.ts's and issues.ts's tables.

const REPO: readonly string[] = ['api', 'v3', 'repos', ':owner', ':repo'];

export const PULL_ROUTES: readonly Route[] = [
  { method: 'POST', segments: [...REPO, 'pulls'], handler: createPull },
  { method: 'GET', segments: [...REPO, 'pulls'], handler: listPulls },
  { method: 'GET', segments: [...REPO, 'pulls', ':number'], handler: getPull },
  { method: 'PATCH', segments: [...REPO, 'pulls', ':number'], handler: patchPull },
  { method: 'GET', segments: [...REPO, 'pulls', ':number', 'files'], handler: listPullFiles },
  { method: 'GET', segments: [...REPO, 'pulls', ':number', 'commits'], handler: listPullCommits },
  { method: 'PUT', segments: [...REPO, 'pulls', ':number', 'merge'], handler: mergePull },
];
