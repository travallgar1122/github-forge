// The REST v3 surface for this block: the viewer's profile, repositories, branches, refs,
// commits and the contents API. Handlers are pure functions of the shared store: each returns
// a Reply (status, JSON body, extra headers) and app.ts serializes it. Shapes and statuses
// follow GitHub's API as the conformance suite in the kit (program/env/src/checks-rest.ts)
// exercises it: 201 on create, 200 on update, 204 on repository delete, 409 on a stale
// contents sha, 422 on validation failures, and {"message": ...} error bodies throughout.

import { parseCommit, parseIdentity, parseTree, type TreeEntry } from './gitobj.ts';
import {
  branchNames,
  branchTip,
  commitChanges,
  flattenCommit,
  getObject,
  listCommitShas,
  type RepoRecord,
  type Store,
} from './store.ts';

/** One handler's answer: an HTTP status, an optional JSON body, optional extra headers. */
export interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** What a handler needs from the request beyond the store and its route parameters. */
export interface RequestInfo {
  readonly method: string;
  readonly query: URLSearchParams;
  /** The parsed JSON body, or undefined when there was none (or it was not JSON). */
  readonly body: unknown;
  /** The request's Host header, used to build absolute pagination links. */
  readonly host: string;
}

/** A route handler: route parameters come from the pattern (':name', '*' for the rest). */
export type Handler = (store: Store, info: RequestInfo, params: Readonly<Record<string, string>>) => Reply;

/** One route: a method and a segment pattern. */
export interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: Handler;
}

type Json = Record<string, unknown>;

export function jsonBody(info: RequestInfo): Json {
  return typeof info.body === 'object' && info.body !== null && !Array.isArray(info.body) ? (info.body as Json) : {};
}

export function notFound(message = 'Not Found'): Reply {
  return { status: 404, body: { message } };
}

export function unprocessable(message: string): Reply {
  return { status: 422, body: { message } };
}

/**
 * GitHub-style pagination over an in-memory list: `page`/`per_page` query parameters and a
 * Link header whose absolute URLs keep the original query (the suite follows rel="next"
 * until it is absent, and requires it to stay on this origin — hence the Host header).
 */
export function paginate<T>(items: readonly T[], info: RequestInfo, path: string): { page: T[]; headers: Record<string, string> } {
  const rawPerPage = Number(info.query.get('per_page'));
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(100, Math.floor(rawPerPage)) : 30;
  const rawPage = Number(info.query.get('page'));
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const urlFor = (target: number): string => {
    const query = new URLSearchParams(info.query);
    query.set('page', String(target));
    query.set('per_page', String(perPage));
    return `http://${info.host}${path}?${query.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  return { page: slice, headers: links.length === 0 ? {} : { link: links.join(', ') } };
}

// ---------------------------------------------------------------------------------------------
// Repositories

/** The GitHub repository object for a record. */
export function repoView(store: Store, repo: RepoRecord): Json {
  const login = store.login();
  return {
    id: repo.id,
    node_id: `repo-${repo.id}`,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1, node_id: 'user-1', type: 'User', site_admin: false },
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `/${login}/${repo.name}`,
    url: `/api/v3/repos/${login}/${repo.name}`,
    git_url: `/${login}/${repo.name}.git`,
  };
}

/** Resolve the repository a route names, or the 404 reply (a foreign owner is a 404, never a 403). */
export function repoOr404(store: Store, params: Readonly<Record<string, string>>): RepoRecord | Reply {
  const owner = params.owner ?? '';
  if (store.viewerLogin !== null && owner !== store.viewerLogin) return notFound();
  const repo = store.findRepo(params.repo ?? '');
  return repo ?? notFound();
}

export function isReply(value: RepoRecord | Reply): value is Reply {
  return (value as Reply).status !== undefined;
}

function createRepo(store: Store, info: RequestInfo): Reply {
  const body = jsonBody(info);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || /[\s/]/.test(name)) return unprocessable('Repository creation failed.');
  if (store.findRepo(name) !== undefined) return unprocessable('name already exists on this account');
  const repo = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
  return { status: 201, body: repoView(store, repo) };
}

function listUserRepos(store: Store, info: RequestInfo): Reply {
  const { page, headers } = paginate(store.repos.map((repo) => repoView(store, repo)), info, '/api/v3/user/repos');
  return { status: 200, body: page, headers };
}

function getRepo(store: Store, _info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  return { status: 200, body: repoView(store, repo) };
}

function patchRepo(store: Store, info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const body = jsonBody(info);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  if (typeof body.default_branch === 'string' && branchTip(repo, body.default_branch) !== undefined) repo.defaultBranch = body.default_branch;
  return { status: 200, body: repoView(store, repo) };
}

function deleteRepo(store: Store, _info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  store.deleteRepo(repo.name);
  return { status: 204 };
}

function getUser(store: Store): Reply {
  const login = store.login();
  return {
    status: 200,
    body: { login, id: 1, node_id: 'user-1', type: 'User', site_admin: false, name: login, email: `${login}@example.invalid` },
  };
}

// ---------------------------------------------------------------------------------------------
// Branches and refs

function branchView(repo: RepoRecord, name: string): Json {
  return { name, commit: { sha: branchTip(repo, name) ?? '', url: '' }, protected: false };
}

function listBranches(store: Store, _info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  return { status: 200, body: branchNames(repo).map((name) => branchView(repo, name)) };
}

function getBranch(store: Store, _info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const name = params['*'] ?? '';
  if (branchTip(repo, name) === undefined) return notFound('Branch not found');
  return { status: 200, body: branchView(repo, name) };
}

const SHA40 = /^[0-9a-f]{40}$/i;

function createRef(store: Store, info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const body = jsonBody(info);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/')) return unprocessable('Invalid ref');
  if (!SHA40.test(sha)) return unprocessable('Invalid sha');
  const object = getObject(repo, sha);
  if (object === undefined || object.type !== 'commit') return unprocessable('Object does not exist');
  if (repo.refs.has(ref)) return unprocessable('Reference already exists');
  repo.refs.set(ref, sha);
  return { status: 201, body: { ref, node_id: '', url: '', object: { type: 'commit', sha } } };
}

function getHeadRef(store: Store, _info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const ref = `refs/heads/${params['*'] ?? ''}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) return notFound();
  return { status: 200, body: { ref, node_id: '', url: '', object: { type: 'commit', sha } } };
}

// ---------------------------------------------------------------------------------------------
// Commits

function identityView(line: string): Json {
  const identity = parseIdentity(line);
  return { name: identity.name, email: identity.email, date: new Date(identity.epochSec * 1000).toISOString() };
}

export function commitView(repo: RepoRecord, sha: string): Json {
  const object = getObject(repo, sha);
  const commit = object !== undefined && object.type === 'commit' ? parseCommit(object.body) : { tree: '', parents: [], author: '', committer: '', message: '' };
  return {
    sha,
    node_id: '',
    commit: {
      author: identityView(commit.author),
      committer: identityView(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
  };
}

/** The commit a `sha` query or path value names: a branch tip first, then a raw commit sha. */
function resolveCommit(repo: RepoRecord, value: string | null): string | undefined {
  if (value === null || value === '') return branchTip(repo, repo.defaultBranch);
  const tip = branchTip(repo, value);
  if (tip !== undefined) return tip;
  const object = getObject(repo, value);
  return object !== undefined && object.type === 'commit' ? value : undefined;
}

function listCommits(store: Store, info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const start = resolveCommit(repo, info.query.get('sha'));
  if (start === undefined) {
    if (info.query.get('sha') !== null) return notFound();
    return { status: 409, body: { message: 'Git Repository is empty.' } };
  }
  const views = listCommitShas(repo, start).map((sha) => commitView(repo, sha));
  const { page, headers } = paginate(views, info, `/api/v3/repos/${params.owner}/${params.repo}/commits`);
  return { status: 200, body: page, headers };
}

function getCommit(store: Store, _info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const sha = params.sha ?? '';
  const object = getObject(repo, sha);
  if (object === undefined || object.type !== 'commit') return notFound();
  return { status: 200, body: commitView(repo, sha) };
}

// ---------------------------------------------------------------------------------------------
// Contents

/** The tree entries at a directory inside a tree, or undefined when the path is not a directory there. */
function treeAt(repo: RepoRecord, treeSha: string, dirPath: string): TreeEntry[] | undefined {
  let current = treeSha;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const object = getObject(repo, current);
      if (object === undefined || object.type !== 'tree') return undefined;
      const entry = parseTree(object.body).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return undefined;
      current = entry.sha;
    }
  }
  const object = getObject(repo, current);
  return object !== undefined && object.type === 'tree' ? parseTree(object.body) : undefined;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** GitHub wraps a file's base64 at 60 columns; decoders ignore the whitespace either way. */
function wrapBase64(bytes: Buffer): string {
  const encoded = bytes.toString('base64');
  if (encoded === '') return '';
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += 60) lines.push(encoded.slice(at, at + 60));
  return `${lines.join('\n')}\n`;
}

function fileView(repo: RepoRecord, path: string, entry: TreeEntry): Json {
  const object = getObject(repo, entry.sha);
  const bytes = object !== undefined && object.type === 'blob' ? object.body : Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    name: baseName(path),
    path,
    sha: entry.sha,
    content: wrapBase64(bytes),
    url: '',
    html_url: '',
    download_url: '',
  };
}

function getContents(store: Store, info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const commitSha = resolveCommit(repo, info.query.get('ref'));
  if (commitSha === undefined) return notFound();
  const commit = getObject(repo, commitSha);
  if (commit === undefined || commit.type !== 'commit') return notFound();
  const treeSha = parseCommit(commit.body).tree;
  const path = (params['*'] ?? '').replace(/^\/+|\/+$/g, '');

  if (path !== '') {
    const flat = flattenCommit(repo, commitSha);
    const hit = flat.get(path);
    if (hit !== undefined) {
      return { status: 200, body: fileView(repo, path, { mode: hit.mode, name: baseName(path), sha: hit.sha }) };
    }
  }
  const entries = treeAt(repo, treeSha, path);
  if (entries === undefined) return notFound();
  const listing = entries.map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : getObject(repo, entry.sha);
    return {
      type: isDir ? 'dir' : 'file',
      size: blob !== undefined && blob.type === 'blob' ? blob.body.length : 0,
      name: entry.name,
      path: childPath,
      sha: entry.sha,
      url: '',
      html_url: '',
      download_url: isDir ? null : '',
    };
  });
  return { status: 200, body: listing };
}

/**
 * The parent a contents write on `branch` builds on: the branch's own tip; for a branch that
 * does not exist yet, the default branch's tip (the write creates the branch — the fallback
 * the MCP setup relies on when POST /git/refs is unavailable); null on an unborn repository.
 */
function writeParent(repo: RepoRecord, branch: string): string | null {
  return branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch) ?? null;
}

function putContents(store: Store, info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const path = (params['*'] ?? '').replace(/^\/+|\/+$/g, '');
  if (path === '') return unprocessable('Invalid path');
  const body = jsonBody(info);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : '';
  const parent = writeParent(repo, branch);
  const flat = parent === null ? new Map<string, { mode: string; sha: string }>() : flattenCommit(repo, parent);
  const current = flat.get(path);

  if (current !== undefined) {
    if (typeof body.sha !== 'string') return unprocessable("sha wasn't supplied");
    if (body.sha.toLowerCase() !== current.sha.toLowerCase()) {
      return { status: 409, body: { message: `${path} sha does not match the current blob` } };
    }
  }
  const bytes = Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64');
  const result = commitChanges(store, repo, branch, new Map([[path, bytes]]), message, parent);
  const blobSha = result.blobShas.get(path) ?? '';
  return {
    status: current === undefined ? 201 : 200,
    body: {
      content: { type: 'file', encoding: 'base64', size: bytes.length, name: baseName(path), path, sha: blobSha },
      commit: { sha: result.commitSha, message },
    },
  };
}

function deleteContents(store: Store, info: RequestInfo, params: Readonly<Record<string, string>>): Reply {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const path = (params['*'] ?? '').replace(/^\/+|\/+$/g, '');
  const body = jsonBody(info);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const parent = branchTip(repo, branch);
  if (parent === undefined) return notFound();
  const flat = flattenCommit(repo, parent);
  const current = flat.get(path);
  if (current === undefined) return notFound();
  if (typeof body.sha === 'string' && body.sha.toLowerCase() !== current.sha.toLowerCase()) {
    return { status: 409, body: { message: `${path} sha does not match the current blob` } };
  }
  const message = typeof body.message === 'string' ? body.message : '';
  const result = commitChanges(store, repo, branch, new Map<string, Buffer | null>([[path, null]]), message, parent);
  return { status: 200, body: { content: null, commit: { sha: result.commitSha, message } } };
}

// ---------------------------------------------------------------------------------------------
// The route table for this block. Anything not listed here is app.ts's JSON 404; issues,
// labels and pull requests join this table in their own blocks.

const REPO: readonly string[] = ['api', 'v3', 'repos', ':owner', ':repo'];

export const REST_ROUTES: readonly Route[] = [
  { method: 'GET', segments: ['api', 'v3', 'meta'], handler: () => ({ status: 200, body: { installed_version: '1.0.0' } }) },
  { method: 'GET', segments: ['api', 'v3', 'rate_limit'], handler: () => ({ status: 200, body: { rate: { limit: 5000, remaining: 5000, reset: 0 }, resources: {} } }) },
  { method: 'GET', segments: ['api', 'v3', 'user'], handler: (store) => getUser(store) },
  { method: 'POST', segments: ['api', 'v3', 'user', 'repos'], handler: createRepo },
  { method: 'GET', segments: ['api', 'v3', 'user', 'repos'], handler: listUserRepos },
  { method: 'GET', segments: REPO, handler: getRepo },
  { method: 'PATCH', segments: REPO, handler: patchRepo },
  { method: 'DELETE', segments: REPO, handler: deleteRepo },
  { method: 'GET', segments: [...REPO, 'branches'], handler: listBranches },
  { method: 'GET', segments: [...REPO, 'branches', '*'], handler: getBranch },
  { method: 'GET', segments: [...REPO, 'commits'], handler: listCommits },
  { method: 'GET', segments: [...REPO, 'commits', ':sha'], handler: getCommit },
  { method: 'POST', segments: [...REPO, 'git', 'refs'], handler: createRef },
  { method: 'GET', segments: [...REPO, 'git', 'refs', 'heads', '*'], handler: getHeadRef },
  { method: 'GET', segments: [...REPO, 'contents', '*'], handler: getContents },
  { method: 'PUT', segments: [...REPO, 'contents', '*'], handler: putContents },
  { method: 'DELETE', segments: [...REPO, 'contents', '*'], handler: deleteContents },
];
