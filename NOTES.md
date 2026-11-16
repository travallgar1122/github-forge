# Development notes — github-core-clone-01

Facts dug out of the kit (program/env/src/*, sdk/*) while building. The check files are the
specification; this file is the map.

## Check groups (manifest.ts, 120 checks total)

| group | checks | surface |
| --- | --- | --- |
| git | 30 | git smart HTTP (clone/fetch/push, pack protocol) |
| repos | 15 | REST repos/branches/commits/contents |
| issues | 15 | REST issues/comments/labels |
| pulls | 20 | REST pull requests/files/merges |
| graphql | 20 | GraphQL v4 documents from gh + github-mcp-server |
| mcp | 15 | MCP streamable HTTP (also the whole 200-point agent column) |
| protocol | 5 | shared wire discipline (REST share in checks-rest.ts) |

Score = feature round(600 * passed/120) + agent round(200 * mcpPassed/15) + perf (4 timed
workloads vs calibration.json T_ref). Trial: Node 22 stdlib only, no git binary, repo mounted
read-only, 900 s wall, 2 CPU / 1 GB.

## Running the suite locally (proven)

Start the app on any port with a token, then point the kit's own runner at it:

```sh
# terminal 1 — the server (a tiny /tmp launcher imports createApp from app.ts and listens)
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types /tmp/serve.ts   # port from its stdout

# terminal 2 — the sealed suite, same checks as grading
cd <kit>
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:<port> --token test-token [--json] [--perf]
```

sdk/run.ts imports sdk/conformance/* (byte-identical copies of program/env/src). It probes
/healthz, then runs all 120 checks sequentially against the FIXED practice seed; the graded
instances use fresh seeds, so nothing from the scenario may be hardcoded. main.ts itself
cannot run standalone (it exits 1 without MAKEFUN_ENV_URL) — that is by design.

## REST contract for this block (from checks-rest.ts)

- GET /api/v3/ → 200 + header `X-Oauth-Scopes: repo, read:org` (starter behaviour, kept).
- GET /api/v3/meta → 200 `{"installed_version": <non-empty string>}`.
- POST /api/v3/user/repos → 201 `{name, private, default_branch, ...}`; a duplicate name may
  be 422 (the pagination check tolerates 422 for already-created seeded repos).
- GET /api/v3/repos/{o}/{r} → 200; absent → 404 `{"message": string}`.
- PATCH → 200 with the updated description; DELETE → 204, then GET is 404.
- GET /api/v3/user/repos?per_page=10 → pages of at most per_page, `Link: <abs-url>; rel="next"`
  chaining until absent; URLs must stay on the entry's own origin (built from the Host header).
- POST /api/v3/repos/{o}/{r}/git/refs `{ref: "refs/heads/<b>", sha}` → 201 `{ref, object:{sha}}`.
- GET .../branches → `[{name, commit:{sha}}]`, must include the default branch.
- GET .../commits[?sha=<branch-or-sha>] → `[{sha, commit:{message}}]`, newest first; a commit
  made on a side branch must NOT appear in the default listing before any merge.
- PUT .../contents/{path} `{message, content(base64), branch?, sha?}` → 201 create / 200
  update, body `{content:{sha, encoding:"base64"}, commit:{sha}}`. An unborn repository
  accepts the first PUT (that is how every check seeds its repo). A stale `sha` is 409.
- GET .../contents/{path}[?ref=] → file `{type:"file", encoding:"base64", content, sha, size}`
  where sha is the BLOB sha and size the byte length; a directory path answers an array of
  `{type:"file"|"dir", name, path, sha}`.
- DELETE .../contents/{path} `{message, sha}` → 200 `{commit:{sha}}`; GET afterwards is 404.
- Every reply: content-type application/json, a non-empty `X-GitHub-Request-Id` header, and a
  string `message` in error bodies. Malformed JSON request body → 400. No X-RateLimit-* needed.

## Auth and ownership (the subtle part)

- Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the same value is in the
  server process's environment. Missing token → 401 `{"message": ...}` (checked on REST GET
  repo, GraphQL POST, and MCP tools/call). Wrong token is refused the same way. /healthz is
  the only unauthenticated route.
- The token is opaque: nothing tells the server the viewer's login. The suite's REST checks
  address repositories under the scenario viewer's login, and the one foreign-owner probe
  (repos.foreign-token) runs only after the owner's own reads; the MCP checks instead READ
  the login from GET /api/v3/user and use whatever it returns. Design: single-tenant store —
  the first owner segment served (REST repos path or /<owner>/<repo>.git/...) is adopted as
  the viewer's login, repos are keyed by name, any other owner is 404, and GET /api/v3/user
  reports the adopted login. Do not hardcode any login.
- Commit identity for REST-made commits is `<login> <login@example.invalid>` with a
  monotonic timestamp; revisit if a later block's checks read commit authors from REST.

## Object model (built in block 1, consumed by block 2)

- gitobj.ts: sha1 over `"<type> <len>\0<body>"`; tree build/parse (dirs sort as `name/`,
  mode `40000`); commit build/parse (message stored verbatim).
- store.ts: per-repo object Map + refs Map; flattenTree/storeFlatTree convert between nested
  trees and path maps for the contents API; commitChanges commits a path->bytes|null map on a
  branch with an explicit parent; listCommitShas walks ancestors newest-first.
- Block 2 adds: packfile read/write (node:zlib), info/refs, upload-pack, receive-pack under
  /<owner>/<repo>.git/. Repos are created only through REST; a push cannot invent one.

## Layout

- main.ts — starter lifecycle, byte-identical, never edited.
- app.ts — HTTP wire discipline + router (this block).
- rest.ts — REST route table + handlers + pagination helper (issues/pulls join here later).
- store.ts / gitobj.ts — shared state and git objects.
- gitproto.ts — git smart HTTP (block 2): pkt-line, pack read/write, advertisements,
  ls-refs, fetch (v0 + v2, shallow), receive-pack with report-status.
- issues.ts — REST issues/labels/comments (block 3): ISSUE_ROUTES, served by app.ts
  beside rest.ts's table; records live on RepoRecord (labels, issues).

## Git smart HTTP — scenario map (block 2, from checks-git.ts + git-client.ts)

The kit client is the spec. Defaults: it asks for protocol v2 on upload-pack
(`Git-Protocol: version=2` header on info/refs, ls-refs and fetch POSTs), never on
receive-pack. 30 checks:

- Advertisements: `advertise-v2` (v2 answer required; caps must include `fetch` and
  `ls-refs`; `object-format` if present must be sha1), `advertise-receive-pack` (v0,
  caps ⊇ report-status, side-band-64k, delete-refs; refs listed), `advertise-headers`
  (content types `application/x-<service>-advertisement`; v0 body starts with the
  `# service=...` pkt-line; receive-pack body must start with it; a v2 request may
  start with the preamble or `version 2`), `unknown-repo-404` (404 both services,
  server stays up).
- ls-refs (v2 command): `ls-refs` (HEAD line with `symref-target:`, tag refs with
  `peeled:`), `ls-refs-prefix` (ref-prefix filters HEAD too; unmatched prefix = 0
  refs), `clone-empty` (unborn HEAD via `unborn HEAD symref-target:...` when the
  `unborn` arg is sent — advertise `ls-refs=unborn`; zero objects, no pack).
- Fetch: v2 sections `acknowledgments` (NAK, or ACK + `ready`), `shallow-info`
  (`shallow`/`unshallow` lines), `packfile` (sideband band 1 chunks, band 2 progress,
  band 3 = error; every pkt-line ≤ 65520). Checks: clone object/blob/tree/commit
  byte-exactness, annotated tags, `fetch-incremental` (haves prune the closure),
  `fetch-nothing-new` (want == have → empty pack), shallow depth 1 (tip only +
  shallow-info names the tip), deepen 2 (parent delivered, grandparent not,
  boundary moves: `shallow <parent>` + `unshallow <old tip>`), shallow new tip,
  `pack-integrity` (PACK v2/v3, trailer sha1, declared count), `pack-deltas`
  (deltas optional — full objects pass), `sideband-framing` (raw fetch observed
  packet by packet). The client always sends `thin-pack`, `no-progress`, `ofs-delta`
  args in v2 fetch; the server may ignore all three.
- Push (receive-pack, v0): command list `<old> <new> <ref>` (caps after NUL on the
  first line: report-status, side-band-64k, ofs-delta, agent — all only if
  advertised), flush, then a raw pack (absent for delete-only pushes; an empty
  0-object pack for creates at existing tips). Report: `unpack ok` first, then per
  ref `ok <ref>` / `ng <ref> <reason>` in command order, the whole report pkt-lined
  inside side-band band 1 when side-band-64k was negotiated. Refusals must still
  unpack ok and change nothing; the non-fast-forward reason must be exactly
  `non-fast-forward`. Mixed lists apply only the ok commands. Deletes of branches
  and tags work; deleting the HEAD branch is refused (git's denyDeleteCurrent).
- Robustness: `repo-survives-errors` posts `zzzznot-a-pkt-line` to git-upload-pack —
  any HTTP error is fine, the server must keep serving afterwards.
- Auth: the client sends `Authorization: Bearer <token>` on every git request, so
  the git surface sits behind the same bearer gate as REST (401 JSON). A missing
  repo is 404 even for POSTs.

Protocol decisions taken here:

- Advertisements: v2 (when the header asks) starts directly with `version 2`
  (no `# service=` preamble — real git's v2 parser expects it first; the kit allows
  either). v0 answers and receive-pack always carry the preamble. v0 upload-pack
  caps: `multi_ack_detailed side-band-64k ofs-delta shallow symref=HEAD:<target>
  agent=...`; receive-pack caps: `report-status delete-refs side-band-64k
  ofs-delta agent=...` (no report-status-v2: the v1 report parses identically).
- Object selection for fetch = closure(wants, depth, minus client's shallow
  boundary) − closure(haves, stopped at the client's shallow lines). Depth counts
  commit generations; trees/blobs of included commits are always complete. The
  shallow boundary reported back = included commits whose parents exist in the
  store but were cut by the depth; client boundary commits that stop being
  boundary are reported `unshallow`.
- Packs are written with full objects only (no deltas), PACK v2, zlib per object.
  Packs received are read fully: OFS_DELTA/REF_DELTA resolved recursively, thin
  bases taken from the repo store, trailer checksum verified before `unpack ok`.
- Ref updates validate per command against the evolving refs: stale old →
  `stale info`; branch update that is not a descendant → `non-fast-forward`;
  rewriting an existing tag → `would clobber existing tag`; unknown new object →
  `missing object`. Unpacked objects are stored even when their ref is refused
  (they stay unreachable, as in git).

## Block 2 results (suite + real git, 17 Nov 2026)

- Suite (kit sdk/run.ts, local server, test token): **git 30/30, repos 15/15,
  total 52/120** (block-1 baseline was 22/120). Remaining groups untouched:
  issues 0/15, pulls 2/20, graphql 1/20, mcp 0/15, protocol 4/5 (the one miss is
  protocol.error-message, which rides on the issues surface — block 3).
- Real git 2.43 end-to-end (repo created via REST; auth via
  `-c http.extraHeader="Authorization: Bearer test-token"`; remote
  `http://127.0.0.1:<port>/<owner>/<repo>.git`): push of commit 1 (text file,
  2 KB random binary, nested subdirectory) OK; clone back + `diff -r` identical;
  push commit 2 + new branch `feature` OK; REST branches/commits show the pushed
  state; branch delete via push OK and visible in REST; `git fetch` in the clone
  after those pushes OK (lands on commit 2); `git clone --depth 1` OK (exactly
  one commit, tip content).
- Two protocol lessons from the real client, both now encoded in gitproto.ts:
  1. v2 fetch response shape depends on the request's `done`: with `done`, NO
     acknowledgments section (git: "expected 'packfile', received
     'acknowledgments'"); without `done`, acknowledgments (ACK last common +
     `ready`, or NAK) come first and the packfile follows IN THE SAME response
     (git: "expected packfile to be sent after 'ready'"). The kit client sends
     `done` always and never checks `ready`, so one shape serves both.
  2. Sections inside one v2 response are separated by a delim packet (`0001`),
     never a flush (`0000`) — a flush reads as end-of-response. Verified against
     git-upload-pack's own packet trace over file://. (The v0 advertisement and
     ls-refs still end with a flush; receive-pack report framing is unchanged.)
- Also fixed en route: `deepen` parsing sliced one character too far
  (`'deepen '` is 7 chars), which silently dropped every depth argument.

## Issues / labels / comments — contract (block 3, from checks-rest.ts)

The `issues` group is 15 checks; every one of them rides on a small surface. Fixtures:
each check builds its own repo (prepareRepo) and creates the scenario label through
POST /labels {name, color: "ededed"} expecting 201 + `{name: non-empty}`.

- Labels: POST /labels → 201 label object. (The suite tests nothing else on labels;
  GET list/one, PATCH {new_name, color, description} and DELETE → 204 are implemented
  GitHub-style anyway.) Label names match case-insensitively; a duplicate name or a
  missing name is a 422 `{message, errors[]}`.
- Issues: POST /issues {title, body, labels?: string[]} → 201 issueShape
  `{number int≥1, title, body, state: open|closed, labels: [{name}]}` — title/body echo
  verbatim, state starts "open". An unknown label name is 422 with a string `message`
  (this one response also carries protocol.error-message, together with the plain 404
  and 401 message bodies). A missing title is likewise a 422.
- Numbers: issues take repo.nextNumber, the ONE sequence pull requests share from
  block 4 — numbers-increment only asks second = first + 1 within one repo.
- List: GET /issues?state=open|closed|all (default open), sort=created (default;
  updated also honoured), direction=asc|desc (default desc = newest first), labels=
  comma-names filter (issue must carry all), paginated like every other list. Sort key
  is the stored created_at; creation order and number order coincide.
- GET /issues/{n} → the issue; PATCH {state:"closed"} → 200 `{number, state}` and the
  close persists (closed_at set; reopening clears it). PATCH also takes title, body,
  labels (replace; unknown → 422), assignees, state_reason.
- Comments: POST /issues/{n}/comments {body} → 201 `{id int≥1, body}` with the posted
  body verbatim; GET lists them. By-id GET/PATCH/DELETE live at
  /issues/comments/{id} (204 on delete), as on GitHub.
- Store: RepoRecord gained `labels: LabelRecord[]` and `issues: IssueRecord[]`. An
  issue stores label IDS, so a label rename keeps it attached and a delete detaches
  it; views resolve ids to live label objects. IssueRecord.pull stays null here —
  block 4 hangs pull data on the same record type and the same numbering. Label,
  issue and comment ids come from one instance-wide Store.recordId() sequence;
  timestamps from Store.nowIso() (the shared monotonic tick, ISO-rendered).
- Wiring: issues.ts exports ISSUE_ROUTES; app.ts serves [...REST_ROUTES,
  ...ISSUE_ROUTES]. rest.ts only gained `export` on jsonBody/notFound/unprocessable/
  repoOr404/isReply so issues.ts can share them (no behaviour change).

## Block 3 results (suite, 17 Nov 2026)

- Suite (kit sdk/run.ts, local server, test token): **issues 15/15, protocol 5/5,
  repos 15/15, git 30/30 — total 68/120** (block-2 baseline was 52/120), feature
  column 340. Remaining: pulls 2/20 (block 4), graphql 1/20 (block 5), mcp 0/15
  (block 6).
- Manual smoke beyond the suite (fresh server, owner adopted as `smoke`): label
  create 201 with `#`-stripped lowercase color, duplicate → 422 already_exists,
  missing name → 422 missing_field, GET one 200, PATCH rename+color 200 and the
  renamed label still attached to an issue created against the new name, assignees
  echoed; comment create/get-by-id/patch/delete (204) with the issue's comments
  count tracking each step; label delete → 204 detaches it from the issue and the
  ?labels= filter; issue on a missing repo 404; missing issue 404; missing title 422.
  All as expected.
- Reminder for manual testing: the store adopts the FIRST owner segment served, so
  smoke scripts must use one owner consistently (the suite's is the scenario login).

## Pull requests — contract (block 4, from checks-rest.ts)

The `pulls` group is 20 checks. Fixtures (preparePull): branch from the initial commit,
one or more contents commits on the head, then POST /pulls {head, base: defaultBranch,
title, body} expecting 201 + pullShape `{number, state, title, body, head{ref, sha},
base{ref, sha}}`; every later assertion re-reads through GET /pulls/{n}.

- Create: head/base arrive as branch NAMES (a `refs/heads/` prefix or an `owner:` prefix
  is stripped). head.sha / base.sha in views resolve from the LIVE branch tips (the
  captured-at-creation tips are the fallback once a branch is gone), which is what the
  create-head-sha / create-base-sha checks read. GitHub-style 422s guard creation: missing
  title (an `issue: <number>` body field can supply title/body instead), unknown head or
  base branch, no commits between base and head (covers head == base), and a duplicate
  open pull for the same head→base pair.
- Files: GET /pulls/{n}/files diffs the MERGE BASE of the live tips against the head tip
  (flattened trees): added / removed / modified with LCS line counts (coarse fallback
  past ~4M line pairs); the shape is `{filename, status, additions, deletions, changes}`
  and a freshly added scenario file must show status added|modified|changed with
  additions ≥ 1. GET /pulls/{n}/commits lists the head's commits past the merge base.
- Merge: PUT /pulls/{n}/merge — unknown number is 404 (message body). The suite only ever
  sends merge_method "squash" and expects 200 `{sha, merged: true, message}`; the pull
  then reads state "closed", merged true, a non-empty merged_at, and merge_commit_sha
  equal to the returned sha; the sha must appear in GET /commits?sha=<base> and the head's
  content must be readable on the base branch. Merge is a THREE-WAY tree merge
  (merge-base tree / base-tip tree / head-tip tree): a path changed on one side takes
  that side; changed differently on both is a conflict → 405 `{message}` (the
  merge-conflict check merges one of two rival edits, then expects exactly 405 for the
  second). Squash lands ONE commit (parent = base tip, merged tree, message
  "<title> (#<n>)" + body); "merge" lands a two-parent commit; "rebase" replays the
  head's own commits onto the base tip. Merging a closed or already-merged pull, or an
  unknown merge_method, is 405.
- List: GET /pulls defaults to state=open (a merged pull must NOT appear), ?state=all
  lists open and merged alike; head/base filters and created/updated sort honoured,
  paginated like every other list.
- Store: IssueRecord.pull is now PullRecord | null (headRef, baseRef, captured tips,
  draft, merged, mergedAt, mergeCommitSha) — the record issues.ts created with
  `pull: null` is the same row a pull fills in, so the shared numbering (repo.nextNumber)
  and comment threads carry over untouched. GET /issues/{n} for a pull's number stays
  404 (issues.ts resolves plain issues only); the suite never asks otherwise.
- Wiring: pulls.ts exports PULL_ROUTES; app.ts serves [...REST_ROUTES, ...ISSUE_ROUTES,
  ...PULL_ROUTES]. store.ts gained commitTree() (commit a prebuilt tree with explicit
  parents — the merge shapes commitChanges cannot express); rest.ts only gained
  `export` on commitView so pulls.ts can render /pulls/{n}/commits (no behaviour change).

## Block 4 results (suite + manual smoke, 17 Nov 2026)

- Suite (kit sdk/run.ts, local server, test token): **pulls 20/20, issues 15/15,
  protocol 5/5, repos 15/15, git 30/30 — total 86/120** (block-3 baseline was 68/120),
  feature column 430. Remaining: graphql 1/20 (block 5), mcp 0/15 (block 6).
- Manual smoke beyond the suite (fresh server, owner `smoke4`, 19/19 as expected):
  create 422s (duplicate open pair, head == base, unknown head branch), PATCH title /
  close / reopen, merge of a closed pull → 405, /pulls/{n}/commits lists exactly the
  head's one new commit, files counts from the LCS diff (one modified file: +2/−1),
  merge_method "merge" lands a real two-parent commit whose tree is the merged content
  on main, an issue created after the pull takes number 2 (shared sequence intact).

## GraphQL — contract map (block 5, from checks-graphql.ts + graphql-client.ts)

The `graphql` group is 20 checks. The client posts to /api/graphql (base URL, NOT /api/v3):
one operation as a JSON object {query, variables}, or a JSON ARRAY of such objects
(GitHub operation batching) answered by an array of envelopes in order. An envelope is
{data, errors?}; a GraphQL-level failure is HTTP 200 with an `errors` array, never an
HTTP error — the one exception is auth: no bearer token is a 401 (app.ts's gate already
covers /api/*). Every check but invalid-field treats ANY errors array as failure, so
happy paths must be error-free, and an unknown repository must answer repository: null
with NO errors.

The 18 documents are fixed (GRAPHQL_DOCUMENTS in checks-graphql.ts): ViewerLogin,
RepositoryFields, Issue_fields + PullRequestAndRepositoryFields + SearchType_enumValues
(introspection probes), OpenIssues, IssueByNumber, IssueCreate, IssueClose, PullRequests,
PullRequestFiles, PullRequestId, PullRequestCreate, MergePullRequest, AddComment,
ViewerInvalidField, NodeRepository, IssuesPage. Language features exercised: operation
names, variable definitions (String!/Int!/ID!/*Input!, one nullable $after: String),
aliases (`Issue: __type(...)`), inline fragments (`... on Repository`), variables, string
and int literals, inline enum lists (`states: [OPEN]`), inline input objects
(`orderBy: {field: CREATED_AT, direction: DESC}`), a null variable (`after: null`), and
batching. No named fragments, no directives.

Field contract:
- Query.viewer{login} = the adopted login (same store.login() as REST).
- Query.repository(owner, name): id, databaseId (positive int = RepoRecord.id), name,
  nameWithOwner, owner{login}, defaultBranchRef{name} (asserted only when the fixture
  pushed a first commit), viewerPermission in ADMIN/MAINTAIN/WRITE/TRIAGE/READ,
  hasIssuesEnabled true, issue(number), issues(...), pullRequest(number),
  pullRequests(first). Unknown name -> null, no errors.
- Global ids: the checks never decode an id; they require non-empty, STABLE across
  reads, NOT the plain databaseId/number as a string, and round-tripping through
  node(id:) and the mutation inputs (repositoryId, issueId, pullRequestId, subjectId).
  Scheme chosen: base64url("Type:key") — Repository:repo.id, Issue:record.id,
  PullRequest:record.id (the shared issue/PR record), IssueComment:comment.id,
  User:1, Label:label.id.
- Repository.issues(first, states, orderBy, after): plain issues only (pull records
  excluded, as in REST), states [OPEN] filters to open, orderBy CREATED_AT DESC means
  newest (highest number) first; connection {nodes, pageInfo{hasNextPage, endCursor}}.
  The pagination check pages a dedicated repo's 7 issues as 5 + 2 by cursor with no
  orderBy argument, so the default order just has to be one stable order partitioned
  by the cursor (createdAt DESC, the REST list default). Cursor = opaque per-node
  string; `after` drops everything up to and including its node.
- Repository.pullRequests(first): the open fixture pull must appear (GitHub's default
  states = [OPEN]); node fields number, headRefName, baseRefName, state OPEN,
  mergeable in MERGEABLE/CONFLICTING/UNKNOWN (computed by a dry-run three-way merge).
- Repository.pullRequest(number): id/number for the merge input; files(first){nodes
  {path}} = the REST files diff (merge base vs head), path is the field read.
- Mutations (inputs arrive as ONE $input variable): createIssue{repositoryId, title,
  body} -> {issue{number, id}}; closeIssue{issueId} -> {issue{number, id, state CLOSED}};
  createPullRequest{repositoryId, baseRefName, headRefName, title} -> {pullRequest
  {number, id, state OPEN, headRefName, baseRefName}}; mergePullRequest{pullRequestId,
  mergeMethod: "SQUASH"} -> {pullRequest{number, merged: true, state}}; addComment
  {subjectId, body} -> {commentEdge{node{id, body}}}. Every mutation is cross-checked
  through REST afterwards, so mutations EXECUTE the REST handlers themselves (found in
  ISSUE_ROUTES / PULL_ROUTES and invoked with a synthetic RequestInfo): one validation,
  one numbering sequence, one three-way merge. A non-2xx Reply becomes a GraphQL error
  carrying the Reply's message.
- Introspection: __type(name:) with fields(includeDeprecated){name} /
  enumValues(includeDeprecated){name}. Required names — Issue: id, number, title,
  state, body. PullRequest: id, number, headRefName, baseRefName, mergeable, state,
  merged, files. Repository: id, databaseId, name, nameWithOwner, owner,
  defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests,
  pullRequest. SearchType enumValues must include ISSUE. The schema table that drives
  the executor's validation IS the introspection source, so the lists cannot drift.
- Invalid field: HTTP 200, errors array whose message NAMES the field (GitHub phrasing
  "Field '<name>' doesn't exist on type '<Type>'"). Validation runs as a separate pass
  over the document against the schema table before execution.
- node(id:): returns the wrapped object; `... on Repository` must yield name and
  nameWithOwner. Issue state renders OPEN/CLOSED; a merged pull renders state MERGED
  (REST keeps state "closed" + merged true; the GraphQL check reads only `merged`).

## Block 5 results (suite, 17 Nov 2026)

- Suite (kit sdk/run.ts, local server, test token): **graphql 20/20, pulls 20/20,
  issues 15/15, protocol 5/5, repos 15/15, git 30/30 — total 105/120** (block-4
  baseline was 86/120), feature column 525. Remaining: mcp 0/15 (block 6).
- Implementation: graphql.ts (1.476 baris) — lexer/parser/executor tulisan sendiri;
  satu tabel skema (TYPES) menggerakkan resolver + validasi + introspeksi sekaligus.
  app.ts hanya menambah GRAPHQL_ROUTES ke ALL_ROUTES; pulls.ts hanya menambah
  `export` pada mergeBase/mergeTrees/diffCounts (tanpa perubahan perilaku); main.ts
  tidak disentuh.
- Keputusan yang terbukti dari suite: mutasi memanggil handler REST secara langsung
  (createIssue #5, closeIssue #6, PR fixture #7, createPullRequest #8,
  mergePullRequest squash #9, addComment #10 — semua terbaca konsisten lewat REST);
  id global base64url("Type:key") lolos uji opacity/stability/round-trip; batching
  dua operasi menjawab dua envelope berurutan; invalid-field = 200 + errors yang
  menamai field-nya; pagination cursor 5 + 2 atas 7 issue.
- Satu-satunya kegagalan run pertama (19/20): issues-pagination HTTP 500 — resolver
  PageInfo membaca parent.pageInfo padahal resolver koneksi menyebar (spread) shape-nya
  ke wrapper; diperbaiki membaca field langsung dari wrapper, run kedua 20/20.

## MCP — contract map (block 6, from checks-mcp.ts + mcp-client.ts)

The `mcp` group is 15 checks and also the whole 200-point agent column. The client
(mcp-client.ts) speaks streamable HTTP at POST <base>/mcp and judges TWO eras:

- Modern 2026-07-28: connect() probes `server/discover` FIRST. A result (record) settles
  the era: supportedVersions (YYYY-MM-DD strings) picks the revision (the preferred
  2026-07-28 when listed), serverInfo comes from the result's top-level `serverInfo`
  (or `_meta['io.modelcontextprotocol/serverInfo']`), capabilities from the result.
  No handshake, no session; every later request just carries `_meta` + headers.
- Legacy: discover refused with HTTP 404/405 or JSON-RPC -32601 → the client falls back
  to `initialize` (offers 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05; accepts the
  echoed protocolVersion), then sends `notifications/initialized`. Any other discover
  refusal (401/403/5xx/-32022 without usable versions) makes connect() THROW = checks fail.
- Decision: implement discover (modern) as the primary path AND initialize with the same
  identity/capabilities for robustness; notifications answer 202 with no body; no
  Mcp-Session-Id is ever issued (the client then never sends one and close() skips DELETE).
  Responses are plain JSON bodies (the client also accepts request-scoped SSE, but JSON
  is simpler and fully supported).

The 15 checks, reduced to wire obligations:

- initialize + server-discover: the discover result must carry serverInfo{name, version}
  (both non-empty) and capabilities.tools (a record), plus a non-empty supportedVersions.
- tools-list: >= 6 tools; the six canonical names must be findable (exact, alias, or
  normalized suffix): create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request. Use the exact canonical names.
- tool-schemas: EVERY listed tool needs a non-empty description and inputSchema.type
  === 'object'. (So list exactly the six — no half-specified extras.)
- Argument mapping: the suite maps its semantic args onto the schema's property names by
  normalized name + synonyms (owner->owner_login/org/...; repo->repository/...; a
  full_name property would receive "owner/repo" when no repo property exists). Using the
  documented property names makes mapping identity: create_repo {name, description?,
  private?}; get_repo {owner, repo}; create_issue {owner, repo, title, body?};
  list_issues {owner, repo, state?}; create_pull_request {owner, repo, title, body?,
  head, base}; merge_pull_request {owner, repo, pull_number}. A REQUIRED property the
  suite cannot fill fails the check — keep required to exactly what the suite sends.
- create-issue / list-issues / create-pull-request / merge-pull-request / rest-parity:
  tool effects are cross-read over REST (issue listed with the same title; list_issues
  text must contain the title or `"number": N`; the pull reads back with the same
  head/base refs; after merge_pull_request REST reads merged:true; MCP-created repo and
  issue are the same REST objects with ids stable across two reads). So tools EXECUTE
  the REST route handlers with a synthetic RequestInfo — the block-5 pattern
  (invokeRoute over REST_ROUTES / ISSUE_ROUTES / PULL_ROUTES) — one store, one
  validation, one numbering sequence, one three-way merge. Tool result = content text
  block holding the REST body's JSON (+ structuredContent with the same value, which
  resultJson prefers when extracting a pull/issue number).
- unknown-tool: tools/call with an unknown name -> JSON-RPC error -32602 (or -32601),
  never HTTP 500. missing-arguments: tools/call create_issue {} -> -32602 or a result
  with isError:true. Decision: argument problems (unknown tool, missing/invalid required
  args) are JSON-RPC -32602; execution failures (the REST Reply is non-2xx) are results
  with isError:true and the Reply's message as the text.
- parse-error: a non-JSON body -> HTTP 400 with JSON-RPC -32700 (the id is null — the
  body cannot be parsed). This is why /mcp is dispatched in app.ts off the RAW body
  (like the git surface), not through the pre-parsed route loop: app.ts's own JSON
  guard only covers /api/* and would otherwise 404 this. Auth already covers /mcp in
  app.ts's gate (path === '/mcp'), which is also what auth-required judges: a tools/call
  without the Authorization header -> HTTP 401 before any JSON-RPC handling.
- concurrent-calls: two in-flight get_repo calls with STRING ids must each answer under
  their own id with their own repo in the text — plain per-request handling, echo the id
  verbatim (string or number), no shared response state.
- tools-list-idempotent: the tools array is a module-level constant, so two tools/list
  answers serialize byte-identically.
- Wiring: mcp.ts exports handleMcp(store, method, raw); app.ts dispatches `path ===
  '/mcp'` to it off the raw body, right before the route loop (auth above already gates
  the path). GET answers 405, DELETE 200 (a session goodbye this server never needs —
  it issues no session id). Batched JSON-RPC arrays are answered element-wise.

## Block 6 results (suite, 17 Nov 2026)

- Suite (kit sdk/run.ts, FRESH local server, test token): **mcp 15/15, graphql 20/20,
  pulls 20/20, issues 15/15, protocol 5/5, repos 15/15, git 30/30 — TOTAL 120/120**,
  feature column 600, agent column 200 (score 800 before perf; perf is only measured
  with --perf / in the graded trials — block 7's concern). Block-5 baseline was
  105/120; the conformance suite is now fully green.
- Implementation: mcp.ts (baru, 340 baris) — JSON-RPC 2.0 layer (discover +
  initialize + ping + tools/list + tools/call, notifications -> 202, parse error ->
  HTTP 400 / -32700, unknown method -> -32601, unknown tool / missing args -> -32602,
  REST failure -> isError:true) over the block-5 invokeRoute pattern; the six tools
  (create_repo, get_repo, create_issue, list_issues, create_pull_request,
  merge_pull_request) run the REST handlers, merge_pull_request merging with
  merge_method "squash". app.ts gained the import, the /mcp dispatch branch and a
  comment touch; main.ts tidak disentuh.
- Era decision proven by the run: the client settled MODERN (server/discover) —
  initialize check reads "server/discover: github-forge 1.0.0, protocol 2026-07-28,
  tools capability present"; the legacy initialize path is implemented but untested
  by the suite (the client only falls back when discover is refused).
- Process lesson, worth repeating for block 7: the suite MUST run against a fresh
  server process. A second run against the same process replays the fixed practice
  seed into a dirty store and fails spuriously (duplicate repo names -> 422, stale
  push old-tips, an already-existing PR, shifted issue pagination). Kill + restart
  the launcher between suite runs.

## Block 7 results (practice trials + perf + finalisation, 17 Nov 2026)

- Practice trials via the kit's own `grade-local --driver process` (the sealed
  env + scorer, practice instances drawn from drand round 33447412), FRESH
  entry process per trial, replay checked after every live pass:
  - trial-0: feature 600, agent 200, perf 178, **total 978** (first run;
    a repeat run in the 3-instance batch measured perf 173–178)
  - trial-1: feature 600, agent 200, perf 189, **total 989**
  - trial-2: feature 600, agent 200, perf 182, **total 982**
  - Every trial's replay reproduced state.json byte for byte (sha256
    a0e98d49…5590, the same digest the calibration runs of the reference forge
    produced — the suite's fixed scenario leaves the same export).
- Perf mechanics (bench.ts + calibration.json): points per workload =
  round(clamp(25 − 12.5·log2(p50/T_ref), 0, 50)); T_ref is the reference
  forge's median round on the production cluster (push 1641 ms, clone
  267 ms, read 2760 ms, write 349 ms). The four workloads: push = 200
  sequential receive-pack updates of a 1 KiB commit; clone = 50 concurrent
  depth-1 clones of a 200-commit repo; read = 2000 sequential GETs of one
  issue on a keep-alive connection; write = 200 sequential issue POSTs.
- Per-workload points across the final 3-trial batch: push 50/50/50
  (p50 303–366 ms), read 50/50/50 (647–705 ms), write 43–48 (96–127 ms),
  clone 34–37 (137–160 ms). Push and read are at the cap; write is within a
  few points of it; clone is the softest — its wall time is dominated by
  3 HTTP round trips × 50 concurrent clones plus client-side checksum work,
  not by server CPU (a depth-1 pack is exactly 3 objects: the closure's BFS
  stops at the depth bound, verified in gitproto.ts).
- Micro-benchmarks (local, node:http keep-alive client): GET issue
  ≈ 0.15 ms/op end to end, POST issue ≈ 0.18 ms/op — the loopback HTTP stack
  is the floor, the handlers are a small fraction of it. The one optimisation
  taken: a dispatch cache in app.ts (route resolution is a pure function of
  method + path; params are copied per request; the map is bounded and
  cleared past 1024 entries). Post-change trials: perf 178/182/181
  (mean 180.3 vs 181.3 before — inside the venue's own run-to-run spread,
  which calibration.json itself flags at ~26% on the tie-break), perf_p50_us
  mean improved 253 µs → 249 µs, and the conformance suite stayed 120/120
  against a fresh server. The cache is kept for the CPU it saves under the
  trial's 2-CPU cap, not for a points claim.
- Finalisation: README.md written from the competition's official template
  (title, the three make.fun badges, description, "Run it", footer);
  main.ts, package.json, tsconfig.json and LICENSE verified byte-identical
  to the starter; .makefun/owner.json is the starter's 58-byte file; the
  tree carries no test output, bundles or logs. Final conformance run from
  the finished tree, fresh server: 120/120 (see the block-7 commit).

## Block 8 (entrypoint authorship — thinking_reproduces, 17 Nov 2026)

The problem: at HEAD 68ffd83 main.ts was still the kit starter byte for byte
(sha256 a18dcc32…, the starter's digest in kit.json), so the transcript
gate's ledger excludes it as "kit" and the entrypoint holds 0 authored
lines — thinking_reproduces fails on the entrypoint whatever the rest of
the repo does.

The lifecycle contract, re-derived from the harness side only
(program/env/src/wire.ts, RULES.txt, program/generator/draw.mjs — the
starter was never opened):

- The harness hands the entry MAKEFUN_ENV_URL (the env's origin) and
  MAKEFUN_SHOP_TOKEN; the entry is run on Node 22
  (`node --experimental-strip-types main.ts`, per package.json).
- createApp() (app.ts) returns an unbound node:http Server; the entry
  binds listen(0) — an ephemeral port, never 8080 (the env's own).
- POST $MAKEFUN_ENV_URL/register with JSON {"port": N}: the env records
  the peer address of that request plus N as the entry's base URL and
  dials it from then on. First register wins: 200 {"ok": true}; a later
  one gets 409 {"ok": false, "error": "already_registered"} and does not
  move the base; a malformed body gets 400. Register inside the boot
  budget (20 s) or the trial scores 0.
- GET $MAKEFUN_ENV_URL/done is answered at once, never held open:
  {"done": false} while the suite runs (boot /healthz ×2, conformance,
  benchmark, export), then {"done": true} once the export is written;
  on that answer the entry exits 0. The contract's own poll cadence is
  250 ms doubling to a 2 s ceiling, a done request capped at 30 s
  (wire.ts DONE_POLL_INTERVAL_MS / DONE_POLL_MAX_MS /
  DONE_REQUEST_TIMEOUT_MS).

What was done, in session order:

1. Wrote main.src.ts — a fresh, readable implementation of that lifecycle
   (register retried with backoff until the env accepts or reports a
   winner; the done poll treats failures as "not yet"; close +
   closeAllConnections, then exit 0) — before ever reading main.ts or
   the starter, so no starter line entered the session as a read.
2. Ran the kit's compress as its own command, exactly as the check's
   packed remedy prescribes:
   `node <kit>/cli/makefun.mjs compress main.src.ts --out main.ts`
   → main.ts 4,676 → 2,378 bytes (stub sha256 ba6574d6…), the pair
   recorded in ~/.makefun/compress.json.
3. Verification killed that route: the packed entry is a Python program.
   COMPRESS_STUB_HEAD in the kit CLI is literally
   `#coding:l1\nimport lzma;exec(lzma.decompress('` — makefun-compress/v1
   packs a Python source for a Python entry (its help: "into the
   entrypoint a size cap fits", default --out main.py). Run under this
   competition's Node harness it dies at parse time: grade-local
   trial-0 reported "the entry exited with code 1 after 0.1 s" and
   scored 0/0/0. A local reproduction (fake env + `node
   --experimental-strip-types main.ts`) shows the same SyntaxError.
   This competition has no size cap and runs its entry on Node only
   (competition.yaml: "Node 22 runs … your entry the way the grader
   runs it; nothing else is installed"), so a packed entry cannot
   score here at all.
4. Fell back to the check's own remedy for a kit entrypoint
   (kitEntrypointReproducesFix in the kit CLI): "Have your agent change
   main.ts itself, in a session you upload: the entrypoint must hold
   lines it wrote, and a line it writes that is a line of the starter
   still counts as the kit's." main.ts was deleted unread and rewritten
   in this session with the same implementation as main.src.ts
   (5,516 bytes), so the entrypoint now holds authored lines and stays
   a runnable TypeScript entry. The compress record in
   ~/.makefun/compress.json is thereby stale (HEAD's main.ts is not the
   stub's bytes): bundle's packSources then sends no pack for it and
   only warns — no refused pack reaches the ledger.

Verification of the final tree (all after the rewrite):

- Fake env end to end: the entry registered {"port": 39249}, polled
  /done, and exited 0 once the env answered {"done": true}.
- Conformance (kit sdk/run.ts, fresh server): 120/120 — git 30,
  repos 15, issues 15, pulls 20, protocol 5, graphql 20, mcp 15;
  columns feature 600, agent 200. (The suite is single-use per process:
  a second run against the same server replays the fixed seed into a
  dirty store and fails by design; always grade a fresh process.)
- Practice trial-0 via grade-local --driver process --worktree:
  entry exited code 0 after 8.1 s; feature 600, agent 200, perf 184,
  **total 984** (baseline band 973–989); replay reproduced the state
  export byte for byte.
