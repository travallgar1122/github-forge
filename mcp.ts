// The MCP surface: Model Context Protocol over streamable HTTP at POST /mcp, the
// agent-native arm of the forge (checks-mcp.ts in the kit is the spec; NOTES.md holds
// the map). The suite's client judges two eras and this module serves both: modern
// 2026-07-28, where `server/discover` answers identity + capabilities +
// supportedVersions in one request and no handshake or session follows, and the legacy
// handshake (`initialize` + `notifications/initialized`) with the same identity. No
// session id is ever issued, so no client carries one.
//
// Tools are the six the rules name, under their canonical github-mcp-server names.
// Every tool EXECUTES the corresponding REST route handler with a synthetic
// RequestInfo (the block-5 pattern): one store, one validation, one numbering
// sequence, one three-way merge — an effect made over MCP is the same object over
// REST, which is exactly what the checks cross-read. Argument problems (an unknown
// tool, a missing required argument) are JSON-RPC -32602; an execution failure (the
// REST reply is non-2xx) is a tool result with isError:true carrying the reply's
// message. A body that is not JSON is HTTP 400 with -32700, which is why app.ts
// dispatches /mcp off the raw body like the git surface.

import { ISSUE_ROUTES } from './issues.ts';
import { PULL_ROUTES } from './pulls.ts';
import { REST_ROUTES, type Reply, type RequestInfo, type Route } from './rest.ts';
import type { Store } from './store.ts';

type Json = Record<string, unknown>;

/** The revisions this server speaks: the current one first, then the handshake eras. */
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-03-26', '2025-06-18', '2024-11-05'];

/** The server's identity, identical over discover and initialize. */
const SERVER_INFO: Readonly<{ name: string; version: string }> = { name: 'github-forge', version: '1.0.0' };

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------------------
// REST invocation (the block-5 pattern): the behaviour exists exactly once, in the routes.

const REPO_SEGS: readonly string[] = ['api', 'v3', 'repos', ':owner', ':repo'];
const USER_REPOS_SEGS: readonly string[] = ['api', 'v3', 'user', 'repos'];
const ISSUES_SEGS: readonly string[] = [...REPO_SEGS, 'issues'];
const PULLS_SEGS: readonly string[] = [...REPO_SEGS, 'pulls'];
const MERGE_SEGS: readonly string[] = [...REPO_SEGS, 'pulls', ':number', 'merge'];

/** Invoke one REST route handler directly (same store, same validation, same writes). */
function invokeRoute(
  routes: readonly Route[],
  method: string,
  segments: readonly string[],
  store: Store,
  body: unknown,
  params: Readonly<Record<string, string>>,
  query?: URLSearchParams,
): Reply {
  const route = routes.find(
    (candidate) =>
      candidate.method === method &&
      candidate.segments.length === segments.length &&
      candidate.segments.every((segment, index) => segment === segments[index]),
  );
  if (route === undefined) return { status: 500, body: { message: 'the corresponding REST route is missing' } };
  const info: RequestInfo = { method, query: query ?? new URLSearchParams(), body, host: 'localhost' };
  return route.handler(store, info, params);
}

// ---------------------------------------------------------------------------------------------------------
// Tools

/** A string argument, or '' when absent or not a string. */
function strArg(args: Json, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string) : '';
}

/** An integer argument (a JSON number, or a numeric string), or null. */
function intArg(args: Json, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Json;
  /** The argument problem with this call, or null when the arguments are callable. */
  check(args: Json): string | null;
  /** Execute against the shared store (through the REST handlers). */
  call(store: Store, args: Json): Reply;
}

/** check() for tools whose required arguments are all non-empty strings. */
function requireStrings(...keys: string[]): (args: Json) => string | null {
  return (args: Json): string | null => {
    const missing = keys.filter((key) => strArg(args, key) === '');
    return missing.length === 0 ? null : `missing required argument(s): ${missing.join(', ')}`;
  };
}

function stringProp(description: string): Json {
  return { type: 'string', description };
}

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The name of the repository to create.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    check: requireStrings('name'),
    call(store: Store, args: Json): Reply {
      const body: Json = { name: strArg(args, 'name') };
      if (typeof args.description === 'string') body.description = args.description;
      if (typeof args.private === 'boolean') body.private = args.private;
      return invokeRoute(REST_ROUTES, 'POST', USER_REPOS_SEGS, store, body, {});
    },
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
    check: requireStrings('owner', 'repo'),
    call(store: Store, args: Json): Reply {
      return invokeRoute(REST_ROUTES, 'GET', REPO_SEGS, store, undefined, { owner: strArg(args, 'owner'), repo: strArg(args, 'repo') });
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the issue.'),
        body: stringProp('The body of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
    check: requireStrings('owner', 'repo', 'title'),
    call(store: Store, args: Json): Reply {
      const body: Json = { title: strArg(args, 'title') };
      if (typeof args.body === 'string') body.body = args.body;
      return invokeRoute(ISSUE_ROUTES, 'POST', ISSUES_SEGS, store, body, { owner: strArg(args, 'owner'), repo: strArg(args, 'repo') });
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        state: stringProp('Filter by issue state: open, closed, or all. Defaults to open.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
    check: requireStrings('owner', 'repo'),
    call(store: Store, args: Json): Reply {
      const state = strArg(args, 'state');
      const query = new URLSearchParams({ state: state === '' ? 'open' : state, per_page: '100' });
      return invokeRoute(ISSUE_ROUTES, 'GET', ISSUES_SEGS, store, undefined, { owner: strArg(args, 'owner'), repo: strArg(args, 'repo') }, query);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the pull request.'),
        body: stringProp('The body of the pull request.'),
        head: stringProp('The name of the branch to merge from.'),
        base: stringProp('The name of the branch to merge into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
    check: requireStrings('owner', 'repo', 'title', 'head', 'base'),
    call(store: Store, args: Json): Reply {
      const body: Json = { title: strArg(args, 'title'), head: strArg(args, 'head'), base: strArg(args, 'base') };
      if (typeof args.body === 'string') body.body = args.body;
      return invokeRoute(PULL_ROUTES, 'POST', PULLS_SEGS, store, body, { owner: strArg(args, 'owner'), repo: strArg(args, 'repo') });
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash merge, as the REST merge endpoint performs by default in this suite).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
    check(args: Json): string | null {
      const missing = ['owner', 'repo'].filter((key) => strArg(args, key) === '');
      if (intArg(args, 'pull_number') === null) missing.push('pull_number');
      return missing.length === 0 ? null : `missing required argument(s): ${missing.join(', ')}`;
    },
    call(store: Store, args: Json): Reply {
      const number = intArg(args, 'pull_number') ?? 0;
      return invokeRoute(PULL_ROUTES, 'PUT', MERGE_SEGS, store, { merge_method: 'squash' }, { owner: strArg(args, 'owner'), repo: strArg(args, 'repo'), number: String(number) });
    },
  },
];

/** The tools/list answer: a module-level constant, so two answers serialize byte-identically. */
const TOOL_LIST: readonly Json[] = TOOL_DEFS.map((def) => ({ name: def.name, description: def.description, inputSchema: def.inputSchema }));

/** A REST reply as an MCP tool result: the body's JSON as a text block (and structured content), or isError. */
function toolResult(reply: Reply): Json {
  if (reply.status >= 200 && reply.status < 300) {
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    const result: Json = { content: [{ type: 'text', text }] };
    if (reply.body !== undefined) result.structuredContent = reply.body;
    return result;
  }
  const body = isRecord(reply.body) ? reply.body : {};
  const message = typeof body.message === 'string' ? body.message : `the REST call failed with status ${reply.status}`;
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------------------------------------
// JSON-RPC layer

type RpcId = string | number | null;

function okEnvelope(id: RpcId, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

function errorEnvelope(id: RpcId, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The modern era's one-request identity: versions, capabilities and server info together. */
function discoverResult(): Json {
  return { supportedVersions: [...SUPPORTED_VERSIONS], capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } };
}

/** The legacy handshake's answer: echo a supported revision, the same identity and capabilities. */
function initializeResult(params: unknown): Json {
  const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
  return { protocolVersion, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } };
}

/** One tools/call: resolve the tool, validate its arguments, execute it against the store. */
function callTool(store: Store, id: RpcId, params: unknown): Json {
  if (!isRecord(params) || typeof params.name !== 'string' || params.name === '') {
    return errorEnvelope(id, -32602, 'Invalid params: a tool name is required');
  }
  const def = TOOL_DEFS.find((candidate) => candidate.name === params.name);
  if (def === undefined) return errorEnvelope(id, -32602, `Invalid params: unknown tool ${params.name}`);
  const args = isRecord(params.arguments) ? params.arguments : {};
  const problem = def.check(args);
  if (problem !== null) return errorEnvelope(id, -32602, `Invalid params: ${problem}`);
  return okEnvelope(id, toolResult(def.call(store, args)));
}

/**
 * One JSON-RPC message answered, or null when it is a notification (notifications are
 * never answered and never executed). A message that is not a request at all is an
 * Invalid Request error under whatever id it carried.
 */
function handleMessage(store: Store, message: unknown): Json | null {
  if (!isRecord(message) || typeof message.method !== 'string') {
    const id = isRecord(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
    return errorEnvelope(id, -32600, 'Invalid Request');
  }
  if (!('id' in message)) return null;
  const id: RpcId = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
  switch (message.method) {
    case 'server/discover':
      return okEnvelope(id, discoverResult());
    case 'initialize':
      return okEnvelope(id, initializeResult(message.params));
    case 'ping':
      return okEnvelope(id, {});
    case 'tools/list':
      return okEnvelope(id, { tools: TOOL_LIST });
    case 'tools/call':
      return callTool(store, id, message.params);
    default:
      return errorEnvelope(id, -32601, `Method not found: ${message.method}`);
  }
}

/**
 * The /mcp endpoint, dispatched by app.ts off the raw body (auth has already run).
 * POST answers one JSON-RPC response per request (a batch answers an array), a
 * notification-only body answers 202 with no body, and a body that is not JSON
 * answers HTTP 400 with the JSON-RPC parse error. GET has no stream to offer (405);
 * DELETE acknowledges a session goodbye that this server never needs (200).
 */
export function handleMcp(store: Store, method: string, raw: Buffer): Reply {
  if (method === 'DELETE') return { status: 200 };
  if (method !== 'POST') return { status: 405, body: errorEnvelope(null, -32601, 'Method not found') };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: errorEnvelope(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const responses: Json[] = [];
    for (const item of parsed) {
      const response = handleMessage(store, item);
      if (response !== null) responses.push(response);
    }
    return responses.length === 0 ? { status: 202 } : { status: 200, body: responses };
  }
  const response = handleMessage(store, parsed);
  return response === null ? { status: 202 } : { status: 200, body: response };
}
