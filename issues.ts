// The REST v3 issues surface: labels, issues and issue comments, on the same shared store
// rest.ts serves. Shapes and statuses follow GitHub's API as the kit's conformance suite
// (program/env/src/checks-rest.ts, the `issues` group) exercises it:
//
//   POST   /repos/{o}/{r}/labels                     201 {name, color, ...}; 422 on a missing
//                                                    or duplicate name
//   GET    /repos/{o}/{r}/labels                     200 list; GET/PATCH/DELETE .../labels/{name}
//   POST   /repos/{o}/{r}/issues                     201 the issue; 422 on an unknown label
//   GET    /repos/{o}/{r}/issues?state=&sort=        200 list, filtered, sorted, paginated
//   GET    /repos/{o}/{r}/issues/{n}                 200 one issue; PATCH updates it (200)
//   POST   /repos/{o}/{r}/issues/{n}/comments        201 {id, body}
//   GET    /repos/{o}/{r}/issues/{n}/comments        200 list
//   GET|PATCH|DELETE /repos/{o}/{r}/issues/comments/{id}
//
// Issue numbers come from the repository's one shared sequence (repo.nextNumber) — pull
// requests draw from it too in block 4, exactly as on GitHub. An issue's labels are stored
// as label ids, so renaming a label keeps it attached and deleting one detaches it, again
// as on GitHub.

import {
  isReply,
  jsonBody,
  notFound,
  paginate,
  repoOr404,
  type Handler,
  type Reply,
  type RequestInfo,
  type Route,
} from './rest.ts';
import type { CommentRecord, IssueRecord, LabelRecord, RepoRecord, Store } from './store.ts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Views

/** The GitHub user object for a login (this forge has one user; assignees echo logins). */
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

/** The GitHub label object. */
function labelView(store: Store, repo: RepoRecord, label: LabelRecord): Json {
  const login = store.login();
  return {
    id: label.id,
    node_id: `label-${label.id}`,
    url: `/api/v3/repos/${login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

/** The GitHub issue object: labels resolved live from the repo's label records. */
function issueView(store: Store, repo: RepoRecord, issue: IssueRecord): Json {
  const login = store.login();
  const labels = issue.labelIds
    .map((id) => repo.labels.find((label) => label.id === id))
    .filter((label): label is LabelRecord => label !== undefined)
    .map((label) => labelView(store, repo, label));
  return {
    id: issue.id,
    node_id: `issue-${issue.id}`,
    url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
    html_url: `/${login}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${login}/${repo.name}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.stateReason,
    locked: false,
    user: userView(issue.authorLogin),
    labels,
    assignees: issue.assigneeLogins.map((assignee) => userView(assignee)),
    assignee: issue.assigneeLogins.length === 0 ? null : userView(issue.assigneeLogins[0] ?? ''),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

/** The GitHub issue-comment object. */
function commentView(store: Store, repo: RepoRecord, issue: IssueRecord, comment: CommentRecord): Json {
  const login = store.login();
  return {
    id: comment.id,
    node_id: `comment-${comment.id}`,
    url: `/api/v3/repos/${login}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `/${login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
    body: comment.body,
    user: userView(comment.authorLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared resolution helpers

/** GitHub's 422 body: a message plus a per-field errors list. */
function validationFailed(errors: readonly { resource: string; field: string; code: string }[]): Reply {
  const summary = errors.map((error) => `${error.field} ${error.code === 'missing_field' ? 'is required' : error.code}`).join(', ');
  return {
    status: 422,
    body: { message: `Validation Failed: ${summary}`, errors: errors.map((error) => ({ ...error })) },
  };
}

/** Find a label by name (GitHub matches label names case-insensitively). */
function findLabel(repo: RepoRecord, name: string): LabelRecord | undefined {
  const wanted = name.toLowerCase();
  return repo.labels.find((label) => label.name.toLowerCase() === wanted);
}

/**
 * Resolve a request body's `labels` array (names) to label records. A name the repository
 * does not have is the 422 the suite's bad-label check requires; a non-array is ignored.
 */
function resolveLabels(repo: RepoRecord, value: unknown): LabelRecord[] | Reply {
  if (!Array.isArray(value)) return [];
  const resolved: LabelRecord[] = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry : typeof (entry as Json)?.name === 'string' ? String((entry as Json).name) : '';
    const label = name === '' ? undefined : findLabel(repo, name);
    if (label === undefined) {
      return {
        status: 422,
        body: {
          message: `Validation Failed: label "${name}" does not exist`,
          errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }],
        },
      };
    }
    if (!resolved.includes(label)) resolved.push(label);
  }
  return resolved;
}

function isLabelReply(value: LabelRecord[] | Reply): value is Reply {
  return !Array.isArray(value);
}

/** rest.ts's isReply is typed for the RepoRecord union; this serves the unions here. */
function failed<T>(value: T | Reply): value is Reply {
  return typeof value === 'object' && value !== null && typeof (value as Reply).status === 'number';
}

/** Parse an issue-number route parameter; NaN when it is not a plain integer. */
function issueNumberParam(params: Readonly<Record<string, string>>): number {
  const raw = params.number ?? '';
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

/** Resolve the issue a route names (plain issues only in this block), or the 404 reply. */
function issueOr404(repo: RepoRecord, params: Readonly<Record<string, string>>): IssueRecord | Reply {
  const number = issueNumberParam(params);
  const issue = Number.isNaN(number) ? undefined : repo.issues.find((candidate) => candidate.number === number && candidate.pull === null);
  return issue ?? notFound();
}

/** The string list a body field carries (assignees and the like); non-strings drop out. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

// ---------------------------------------------------------------------------------------------
// Labels

const createLabel: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const body = jsonBody(info);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') return validationFailed([{ resource: 'Label', field: 'name', code: 'missing_field' }]);
  if (findLabel(repo, name) !== undefined) {
    return {
      status: 422,
      body: { message: 'Validation Failed: name has already been taken', errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }] },
    };
  }
  let color = typeof body.color === 'string' ? body.color.replace(/^#/, '').toLowerCase() : 'ededed';
  if (!/^[0-9a-f]{6}$/.test(color)) {
    if (typeof body.color === 'string') return validationFailed([{ resource: 'Label', field: 'color', code: 'invalid' }]);
    color = 'ededed';
  }
  const label: LabelRecord = {
    id: store.recordId(),
    name,
    color,
    description: typeof body.description === 'string' ? body.description : null,
  };
  repo.labels.push(label);
  return { status: 201, body: labelView(store, repo, label) };
};

const listLabels: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const views = repo.labels.map((label) => labelView(store, repo, label));
  const { page, headers } = paginate(views, info, `/api/v3/repos/${params.owner}/${params.repo}/labels`);
  return { status: 200, body: page, headers };
};

/** Resolve the label a route names (the '*' capture, URL-decoded by the router), or 404. */
function labelOr404(repo: RepoRecord, params: Readonly<Record<string, string>>): LabelRecord | Reply {
  const label = findLabel(repo, params['*'] ?? '');
  return label ?? notFound();
}

const getLabel: Handler = (store, _info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const label = labelOr404(repo, params);
  if (failed(label)) return label;
  return { status: 200, body: labelView(store, repo, label) };
};

const patchLabel: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const label = labelOr404(repo, params);
  if (failed(label)) return label;
  const body = jsonBody(info);
  const newName = typeof body.new_name === 'string' ? body.new_name.trim() : '';
  if (newName !== '' && newName !== label.name) {
    const clash = findLabel(repo, newName);
    if (clash !== undefined && clash !== label) {
      return {
        status: 422,
        body: { message: 'Validation Failed: name has already been taken', errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }] },
      };
    }
    label.name = newName;
  }
  if (typeof body.color === 'string') {
    const color = body.color.replace(/^#/, '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(color)) return validationFailed([{ resource: 'Label', field: 'color', code: 'invalid' }]);
    label.color = color;
  }
  if (typeof body.description === 'string' || body.description === null) label.description = body.description;
  return { status: 200, body: labelView(store, repo, label) };
};

const deleteLabel: Handler = (store, _info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const label = labelOr404(repo, params);
  if (failed(label)) return label;
  repo.labels.splice(repo.labels.indexOf(label), 1);
  return { status: 204 };
};

// ---------------------------------------------------------------------------------------------
// Issues

const createIssue: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const body = jsonBody(info);
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return validationFailed([{ resource: 'Issue', field: 'title', code: 'missing_field' }]);
  const labels = resolveLabels(repo, body.labels);
  if (isLabelReply(labels)) return labels;
  const stamp = store.nowIso();
  const issue: IssueRecord = {
    id: store.recordId(),
    number: repo.nextNumber,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    stateReason: null,
    labelIds: labels.map((label) => label.id),
    assigneeLogins: stringList(body.assignees),
    authorLogin: store.login(),
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    comments: [],
    pull: null,
  };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return { status: 201, body: issueView(store, repo, issue) };
};

const listIssues: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const state = info.query.get('state') ?? 'open';
  let issues = repo.issues.filter((issue) => issue.pull === null);
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const labelFilter = info.query.get('labels');
  if (labelFilter !== null && labelFilter !== '') {
    const wanted = labelFilter.split(',').map((name) => findLabel(repo, name.trim())?.id ?? -1);
    issues = issues.filter((issue) => wanted.every((id) => issue.labelIds.includes(id)));
  }
  const sort = info.query.get('sort') ?? 'created';
  const direction = info.query.get('direction') ?? 'desc';
  const key = (issue: IssueRecord): string => (sort === 'updated' ? issue.updatedAt : issue.createdAt);
  const sorted = [...issues].sort((a, b) => {
    const order = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.number - b.number;
    return direction === 'asc' ? order : -order;
  });
  const views = sorted.map((issue) => issueView(store, repo, issue));
  const { page, headers } = paginate(views, info, `/api/v3/repos/${params.owner}/${params.repo}/issues`);
  return { status: 200, body: page, headers };
};

const getIssue: Handler = (store, _info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const issue = issueOr404(repo, params);
  if (failed(issue)) return issue;
  return { status: 200, body: issueView(store, repo, issue) };
};

const patchIssue: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const issue = issueOr404(repo, params);
  if (failed(issue)) return issue;
  const body = jsonBody(info);
  if (body.labels !== undefined) {
    const labels = resolveLabels(repo, body.labels);
    if (isLabelReply(labels)) return labels;
    issue.labelIds = labels.map((label) => label.id);
  }
  if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.assignees !== undefined) issue.assigneeLogins = stringList(body.assignees);
  if (typeof body.state_reason === 'string' || body.state_reason === null) issue.stateReason = body.state_reason;
  if (body.state !== undefined) {
    if (body.state !== 'open' && body.state !== 'closed') {
      return validationFailed([{ resource: 'Issue', field: 'state', code: 'invalid' }]);
    }
    if (body.state !== issue.state) {
      issue.state = body.state;
      issue.closedAt = body.state === 'closed' ? store.nowIso() : null;
    }
  }
  issue.updatedAt = store.nowIso();
  return { status: 200, body: issueView(store, repo, issue) };
};

// ---------------------------------------------------------------------------------------------
// Comments

const createComment: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const issue = issueOr404(repo, params);
  if (failed(issue)) return issue;
  const body = jsonBody(info);
  if (typeof body.body !== 'string') return validationFailed([{ resource: 'IssueComment', field: 'body', code: 'missing_field' }]);
  const stamp = store.nowIso();
  const comment: CommentRecord = {
    id: store.recordId(),
    body: body.body,
    authorLogin: store.login(),
    createdAt: stamp,
    updatedAt: stamp,
  };
  issue.comments.push(comment);
  issue.updatedAt = stamp;
  return { status: 201, body: commentView(store, repo, issue, comment) };
};

const listComments: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const issue = issueOr404(repo, params);
  if (failed(issue)) return issue;
  const views = issue.comments.map((comment) => commentView(store, repo, issue, comment));
  const { page, headers } = paginate(views, info, `/api/v3/repos/${params.owner}/${params.repo}/issues/${params.number}/comments`);
  return { status: 200, body: page, headers };
};

/** Resolve a comment by its global id inside one repository, with the issue it hangs on. */
function commentOr404(repo: RepoRecord, params: Readonly<Record<string, string>>): { issue: IssueRecord; comment: CommentRecord } | Reply {
  const raw = params.id ?? '';
  const id = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isNaN(id)) {
    for (const issue of repo.issues) {
      const comment = issue.comments.find((candidate) => candidate.id === id);
      if (comment !== undefined) return { issue, comment };
    }
  }
  return notFound();
}

const getComment: Handler = (store, _info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const found = commentOr404(repo, params);
  if (failed(found)) return found;
  return { status: 200, body: commentView(store, repo, found.issue, found.comment) };
};

const patchComment: Handler = (store, info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const found = commentOr404(repo, params);
  if (failed(found)) return found;
  const body = jsonBody(info);
  if (typeof body.body !== 'string') return validationFailed([{ resource: 'IssueComment', field: 'body', code: 'missing_field' }]);
  found.comment.body = body.body;
  found.comment.updatedAt = store.nowIso();
  return { status: 200, body: commentView(store, repo, found.issue, found.comment) };
};

const deleteComment: Handler = (store, _info, params) => {
  const repo = repoOr404(store, params);
  if (isReply(repo)) return repo;
  const found = commentOr404(repo, params);
  if (failed(found)) return found;
  found.issue.comments.splice(found.issue.comments.indexOf(found.comment), 1);
  return { status: 204 };
};

// ---------------------------------------------------------------------------------------------
// The route table for this block; app.ts serves it beside rest.ts's table.

const REPO: readonly string[] = ['api', 'v3', 'repos', ':owner', ':repo'];

export const ISSUE_ROUTES: readonly Route[] = [
  { method: 'POST', segments: [...REPO, 'labels'], handler: createLabel },
  { method: 'GET', segments: [...REPO, 'labels'], handler: listLabels },
  { method: 'GET', segments: [...REPO, 'labels', '*'], handler: getLabel },
  { method: 'PATCH', segments: [...REPO, 'labels', '*'], handler: patchLabel },
  { method: 'DELETE', segments: [...REPO, 'labels', '*'], handler: deleteLabel },
  { method: 'POST', segments: [...REPO, 'issues'], handler: createIssue },
  { method: 'GET', segments: [...REPO, 'issues'], handler: listIssues },
  { method: 'GET', segments: [...REPO, 'issues', ':number'], handler: getIssue },
  { method: 'PATCH', segments: [...REPO, 'issues', ':number'], handler: patchIssue },
  { method: 'POST', segments: [...REPO, 'issues', ':number', 'comments'], handler: createComment },
  { method: 'GET', segments: [...REPO, 'issues', ':number', 'comments'], handler: listComments },
  { method: 'GET', segments: [...REPO, 'issues', 'comments', ':id'], handler: getComment },
  { method: 'PATCH', segments: [...REPO, 'issues', 'comments', ':id'], handler: patchComment },
  { method: 'DELETE', segments: [...REPO, 'issues', 'comments', ':id'], handler: deleteComment },
];
