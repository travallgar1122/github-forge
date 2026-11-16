// The forge's HTTP server: the starter's health probe and API root, grown into the full
// surface. app.ts owns the wire discipline every surface shares — JSON replies with an
// X-GitHub-Request-Id, bearer-token auth on the API, a 400 for malformed JSON, and GitHub's
// JSON 404 for anything unrouted — and dispatches to the route tables (rest.ts, issues.ts,
// pulls.ts, graphql.ts), the git smart-HTTP surface in gitproto.ts, and the MCP endpoint
// in mcp.ts (dispatched off the raw body, like git). main.ts is
// the entry <-> env lifecycle and stays as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { REST_ROUTES, type Reply, type RequestInfo, type Route } from './rest.ts';
import { ISSUE_ROUTES } from './issues.ts';
import { PULL_ROUTES } from './pulls.ts';
import { GRAPHQL_ROUTES } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { gitInfoRefs, gitReceivePack, gitUploadPack, type GitReply } from './gitproto.ts';

/** Every route table, in dispatch order (repos, issues/labels/comments, pulls, then GraphQL). */
const ALL_ROUTES: readonly Route[] = [...REST_ROUTES, ...ISSUE_ROUTES, ...PULL_ROUTES, ...GRAPHQL_ROUTES];

/**
 * Dispatch cache: route resolution is a pure function of (method, path) — the captures
 * come from the path alone — so a resolved route is memoised and only its params are
 * copied per request. Bounded: past the cap the map is cleared rather than grown.
 */
const ROUTE_CACHE_LIMIT = 1024;
const routeCache = new Map<string, { route: Route; params: Record<string, string> } | null>();

/** Resolve a request to its route + params, through the cache. Null when nothing matches. */
function resolveRoute(method: string, path: string, segments: readonly string[]): { route: Route; params: Record<string, string> } | null {
  const key = `${method} ${path}`;
  const cached = routeCache.get(key);
  if (cached !== undefined) {
    return cached === null ? null : { route: cached.route, params: { ...cached.params } };
  }
  let resolved: { route: Route; params: Record<string, string> } | null = null;
  for (const route of ALL_ROUTES) {
    if (route.method !== method) continue;
    const params = matchSegments(route.segments, segments);
    if (params !== null) {
      resolved = { route, params };
      break;
    }
  }
  if (routeCache.size >= ROUTE_CACHE_LIMIT) routeCache.clear();
  routeCache.set(key, resolved);
  return resolved === null ? null : { route: resolved.route, params: { ...resolved.params } };
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Serialize one reply: a JSON body with its length, or an empty body for 204-style replies. */
function sendReply(res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = { 'x-github-request-id': randomUUID(), ...(reply.headers ?? {}) };
  if (reply.body === undefined) {
    res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': 0, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(reply.body)}\n`;
  res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Serialize one git-surface reply: raw bytes under the surface's own content type. */
function sendRaw(res: ServerResponse, reply: GitReply): void {
  res.writeHead(reply.status, {
    'content-type': reply.contentType,
    'content-length': reply.body.length,
    'x-github-request-id': randomUUID(),
  });
  res.end(reply.body);
}

/** Read a whole request body (contents deletes and git pushes carry one on any method). */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

/** One path segment decoded, or the raw segment when its escapes are malformed. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Match a route pattern against path segments: ':name' captures one segment, a trailing '*'
 * captures the rest joined with '/' (possibly empty). Returns the captures, or null.
 */
function matchSegments(pattern: readonly string[], segments: readonly string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  let at = 0;
  for (const part of pattern) {
    if (part === '*') {
      params['*'] = segments.slice(at).join('/');
      return params;
    }
    if (at >= segments.length) return null;
    const segment = segments[at] ?? '';
    if (part.startsWith(':')) params[part.slice(1)] = segment;
    else if (part !== segment) return null;
    at += 1;
  }
  return at === segments.length ? params : null;
}

/**
 * Learn the viewer's login from the first owner-carrying path served: a REST repository
 * path, or a git path (/<owner>/<repo>.git/...). The token names one login and the suite
 * only ever probes a second login after the owner's own reads, so the first owner seen is
 * the viewer's; store.ts's adoption keeps it.
 */
function adoptOwnerFromPath(store: Store, segments: readonly string[]): void {
  if (segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos' && segments[3] !== undefined) {
    store.adoptOwner(segments[3]);
  } else if (segments.length >= 2 && (segments[1] ?? '').endsWith('.git') && segments[0] !== undefined) {
    store.adoptOwner(segments[0]);
  }
}

/** Handle one request against the store; never throws (a failure is a JSON 500). */
async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const segments = path.split('/').filter((segment) => segment !== '').map(decodeSegment);

  // The env's boot check calls this twice: 200 {"ok":true}. No auth, as the starter shipped.
  if (method === 'GET' && path === '/healthz') {
    sendReply(res, { status: 200, body: { ok: true } });
    return;
  }

  const raw = await readBody(req);
  adoptOwnerFromPath(store, segments);

  // Auth: when the process carries the shop token, every API call must present it — the
  // git smart-HTTP surface included (its clients send the same bearer token). A missing
  // token and a wrong token are both 401 with a message body; /healthz above is the only
  // unauthenticated route.
  const isGitPath = segments.length >= 2 && (segments[1] ?? '').endsWith('.git');
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '' && (isGitPath || path === '/mcp' || path === '/api' || path.startsWith('/api/'))) {
    const presented = req.headers.authorization;
    if (presented !== `Bearer ${expected}`) {
      sendReply(res, { status: 401, body: { message: presented === undefined ? 'Requires authentication' : 'Bad credentials' } });
      return;
    }
  }

  // A JSON body that does not parse is a 400 on the API surface.
  let body: unknown;
  const contentType = req.headers['content-type'] ?? '';
  if (raw.length > 0 && contentType.includes('json')) {
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      if (path.startsWith('/api/')) {
        sendReply(res, { status: 400, body: { message: 'Problems parsing JSON' } });
        return;
      }
    }
  }

  // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
  if (method === 'GET' && path === '/api/v3') {
    sendReply(res, {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    });
    return;
  }

  // The git smart-HTTP surface: /<owner>/<repo>.git/info/refs and the two service POSTs.
  // Handlers answer every such path themselves (404 included); anything else under a
  // .git path falls through to the JSON 404 below.
  if (isGitPath) {
    const owner = segments[0] ?? '';
    const repoName = (segments[1] ?? '').slice(0, -'.git'.length);
    const sub = segments.slice(2).join('/');
    const protocolV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (method === 'GET' && sub === 'info/refs') {
      sendRaw(res, gitInfoRefs(store, owner, repoName, url.searchParams.get('service'), protocolV2));
      return;
    }
    if (method === 'POST' && sub === 'git-upload-pack') {
      sendRaw(res, gitUploadPack(store, owner, repoName, raw, protocolV2));
      return;
    }
    if (method === 'POST' && sub === 'git-receive-pack') {
      sendRaw(res, gitReceivePack(store, owner, repoName, raw));
      return;
    }
  }

  // The MCP surface: /mcp speaks JSON-RPC off the raw body — its parse errors are
  // JSON-RPC -32700 with HTTP 400 (not the API's 400 shape) and its notifications
  // answer 202 — so, like the git surface, it is dispatched before the route loop.
  // Auth above already covers this path.
  if (path === '/mcp') {
    sendReply(res, handleMcp(store, method, raw));
    return;
  }

  const info: RequestInfo = { method, query: url.searchParams, body, host: req.headers.host ?? 'localhost' };
  const resolved = resolveRoute(method, path, segments);
  if (resolved !== null) {
    sendReply(res, resolved.route.handler(store, info, resolved.params));
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendReply(res, { status: 404, body: { message: 'Not Found' } });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(store, req, res).catch(() => {
      try {
        sendReply(res, { status: 500, body: { message: 'Internal Server Error' } });
      } catch {
        // The reply already went out or the socket is gone; nothing more to do.
      }
    });
  });
}
