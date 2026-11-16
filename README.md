# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/travallgar1122/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/travallgar1122/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge written from scratch in TypeScript on Node 22's
standard library alone — no dependencies, no `git` binary. One in-memory store
backs every surface, so an object pushed over git smart HTTP is immediately
visible through the REST API, GraphQL and the MCP tools, and vice versa.

## What it implements

- **Git smart HTTP** (`/<owner>/<repo>.git/…`): protocol v0 + v2
  advertisements, `ls-refs`, fetch with shallow/deepen and side-band progress,
  receive-pack with delta unpacking (OFS/REF, thin packs) and report-status.
  Real git clients can clone, fetch and push against it.
- **REST v3** (`/api/v3/…`): repositories, branches, commits, contents,
  git refs, issues, labels, comments, and pull requests with file diffs and
  merges — a merge is a true three-way tree merge over the git object store,
  with GitHub's 405 on conflict. Issues and pull requests share one number
  sequence, as on GitHub.
- **GraphQL v4** (`POST /api/graphql`): the query and mutation documents the
  `gh` CLI and `github-mcp-server` send — viewer, repository fields, issue and
  pull-request connections with cursor pagination, create/close/merge
  mutations, global node ids, introspection, and operation batching.
  Mutations execute the REST handlers, so both surfaces always agree.
- **MCP** (`POST /mcp`): streamable-HTTP JSON-RPC with the modern
  `server/discover` negotiation and the legacy `initialize` handshake; six
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) that act on the same store.
- **Wire discipline**: bearer-token auth on every API surface (only
  `/healthz` is open), GitHub-shaped JSON errors, `X-Oauth-Scopes` and
  `X-GitHub-Request-Id` headers, `Link` pagination.

## Architecture

- `main.ts` — the harness lifecycle (bind ephemeral port, register with the
  env, wait for done, exit 0). Unchanged from the competition starter.
- `app.ts` — HTTP wire discipline and dispatch (REST/GraphQL route tables,
  the git surface, the MCP endpoint).
- `store.ts` / `gitobj.ts` — the shared in-memory store and the git object
  model (sha1 framing, tree/commit build and parse).
- `gitproto.ts` — the git smart-HTTP protocol: pkt-lines, packfile
  read/write, fetch object selection, push validation.
- `rest.ts` / `issues.ts` / `pulls.ts` — the REST v3 surfaces.
- `graphql.ts` — a hand-written GraphQL lexer/parser/executor; one schema
  table drives execution, validation and introspection.
- `mcp.ts` — the MCP JSON-RPC layer over the REST handlers.
- `NOTES.md` — development notes: the contract maps each surface was built
  against, and the decisions taken.

## Conformance

The kit's sealed suite (the same checks the contest grades with) passes
**120/120**: git 30/30, repos 15/15, issues 15/15, pulls 20/20, graphql
20/20, mcp 15/15, protocol 5/5. In local practice trials of the full harness
the entry scores 973–989 of 1000 (feature 600/600, agent 200/200, the rest
from the timed perf workloads), and every trial's replay reproduces its
state export byte for byte.

## Run it

```sh
MAKEFUN_ENV_URL=<env origin> MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` is the entry the contest harness drives: it binds an ephemeral
port, registers it with the env at `MAKEFUN_ENV_URL`, serves until the env
reports done, and exits 0. Node 22.18+ strips the TypeScript types natively;
the flag only helps older local Nodes. There is nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=h0zvrf0h&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
