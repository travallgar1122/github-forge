// The GraphQL v4 surface: POST /api/graphql, the documents gh and github-mcp-server send
// (the kit's checks-graphql.ts is the specification; NOTES.md carries the contract map).
// No GraphQL library — a small lexer/parser/executor written for exactly the language
// features those documents use: operation names, variable definitions, aliases, inline
// fragments, enum lists, inline input objects, null variables, and operation batching
// (a JSON array of {query, variables} answered by an array of envelopes).
//
// One source of truth: queries read the same store records REST serves, and every
// mutation EXECUTES the corresponding REST handler (looked up in ISSUE_ROUTES /
// PULL_ROUTES and invoked with a synthetic RequestInfo), so validation, the shared
// issue/PR numbering and the three-way merge exist exactly once. A non-2xx Reply becomes
// a GraphQL error carrying the Reply's message. GraphQL-level failures are HTTP 200 with
// an `errors` array; the 401 for a missing/wrong token is app.ts's gate, as for REST.
//
// Global ids are base64url("Type:key") — Repository:repo.id, Issue:record.id,
// PullRequest:record.id (issues and pulls share one record), IssueComment:comment.id,
// Label:label.id, User:1. The checks never decode an id; they require it non-empty,
// stable across reads, different from the plain numeric id, and round-tripping through
// node(id:) and the mutation inputs — this scheme gives all four.

import { ISSUE_ROUTES } from './issues.ts';
import { PULL_ROUTES, diffCounts, mergeBase, mergeTrees } from './pulls.ts';
import { parseCommit, parseIdentity } from './gitobj.ts';
import type { Reply, RequestInfo, Route } from './rest.ts';
import {
  branchTip,
  flattenCommit,
  getObject,
  listCommitShas,
  type CommentRecord,
  type IssueRecord,
  type LabelRecord,
  type PullRecord,
  type RepoRecord,
  type Store,
} from './store.ts';

type Json = Record<string, unknown>;

/** A GraphQL-level failure: the operation answers 200 with this message in `errors`. */
class GqlError extends Error {}

// ---------------------------------------------------------------------------------------------------------
// Global (Relay) ids

function globalId(type: string, key: number): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { type: string; key: number } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([A-Za-z]+):(\d+)$/.exec(text);
  if (match === null) return null;
  return { type: match[1] ?? '', key: Number(match[2]) };
}

// ---------------------------------------------------------------------------------------------------------
// Lexer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: end === -1 ? source.slice(i + 3) : source.slice(i + 3, end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const e = source[j + 1] ?? '';
          if (e === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] ?? '')) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.]/.test(source[j] ?? '')) {
        if (source[j] === '.') isFloat = true;
        j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] ?? '')) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`Syntax error: unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// Parser (AST for the subset the documents use)

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: readonly { readonly name: string; readonly value: ValueNode }[] };

interface ArgumentNode {
  readonly name: string;
  readonly value: ValueNode;
}

type SelectionNode =
  | {
      readonly kind: 'field';
      readonly alias: string | null;
      readonly name: string;
      readonly args: readonly ArgumentNode[];
      readonly selectionSet: readonly SelectionNode[] | null;
    }
  | { readonly kind: 'inline'; readonly typeCondition: string | null; readonly selectionSet: readonly SelectionNode[] }
  | { readonly kind: 'spread'; readonly name: string };

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selectionSet: readonly SelectionNode[];
}

interface FragmentNode {
  readonly typeCondition: string;
  readonly selectionSet: readonly SelectionNode[];
}

interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, FragmentNode>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new GqlError(`Syntax error: expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GqlError('Syntax error: expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragmentName = this.expectName();
        if (this.expectName() !== 'on') throw new GqlError('Syntax error: expected "on" in a fragment definition');
        const condition = this.expectName();
        this.skipDirectives();
        fragments.set(fragmentName, { typeCondition: condition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new GqlError(`Syntax error: unexpected token ${JSON.stringify(token.value)}`);
    }
    return { operations, fragments };
  }

  /** Variable definitions are parsed for shape only; values come from the request's variables. */
  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GqlError(`Syntax error: unexpected value token ${JSON.stringify(token.value)}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      const ahead = this.peek();
      if (ahead.kind === 'name' && ahead.value === 'on') {
        this.next();
        const condition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition: condition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }
}

/** Resolve an argument value against the operation's variables (enums arrive as strings). */
function resolveValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: readonly ArgumentNode[], variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) {
    const value = resolveValue(arg.value, variables);
    if (value !== undefined) out[arg.name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Object wrappers: the executor's values. Every object carries its GraphQL type name;
// resolvers below switch on it. Scalars travel as plain JS values.

interface GqlObj {
  readonly gqlType: string;
  readonly [key: string]: unknown;
}

function userObj(login: string): GqlObj {
  return { gqlType: 'User', login };
}

function repoObj(repo: RepoRecord): GqlObj {
  return { gqlType: 'Repository', repo };
}

function refObj(repo: RepoRecord, name: string, sha: string): GqlObj {
  return { gqlType: 'Ref', repo, name, sha };
}

function commitObj(repo: RepoRecord, sha: string): GqlObj {
  return { gqlType: 'Commit', repo, sha };
}

function issueObj(repo: RepoRecord, issue: IssueRecord): GqlObj {
  return { gqlType: 'Issue', repo, issue };
}

function pullObj(repo: RepoRecord, issue: IssueRecord): GqlObj {
  return { gqlType: 'PullRequest', repo, issue };
}

function commentObj(repo: RepoRecord, issue: IssueRecord, comment: CommentRecord): GqlObj {
  return { gqlType: 'IssueComment', repo, issue, comment };
}

function labelObj(repo: RepoRecord, label: LabelRecord): GqlObj {
  return { gqlType: 'Label', repo, label };
}

/** The global id of any wrapped object (the Node interface's one field). */
function nodeIdOf(parent: GqlObj): string {
  switch (parent.gqlType) {
    case 'Repository':
      return globalId('Repository', (parent.repo as RepoRecord).id);
    case 'Issue':
      return globalId('Issue', (parent.issue as IssueRecord).id);
    case 'PullRequest':
      return globalId('PullRequest', (parent.issue as IssueRecord).id);
    case 'IssueComment':
      return globalId('IssueComment', (parent.comment as CommentRecord).id);
    case 'Label':
      return globalId('Label', (parent.label as LabelRecord).id);
    case 'User':
      return globalId('User', 1);
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Connections

function cursorFor(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

interface PageInfoShape {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor: string | null;
  readonly endCursor: string | null;
}

/** Slice a full, ordered item list by the `after` cursor and the `first` count. */
function buildConnection(
  connType: string,
  edgeType: string,
  items: readonly GqlObj[],
  cursors: readonly string[],
  args: Readonly<Record<string, unknown>>,
): GqlObj {
  let start = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    const index = cursors.indexOf(after);
    if (index >= 0) start = index + 1;
  }
  const rest = items.slice(start);
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : rest.length;
  const page = rest.slice(0, first);
  const pageCursors = cursors.slice(start, start + page.length);
  const pageInfo: PageInfoShape = {
    hasNextPage: rest.length > page.length,
    hasPreviousPage: start > 0,
    startCursor: pageCursors[0] ?? null,
    endCursor: pageCursors[pageCursors.length - 1] ?? null,
  };
  return { gqlType: connType, edgeType, nodes: page, cursors: pageCursors, totalCount: items.length, pageInfo };
}

/** Sort issue-shaped records the way the connections promise: by the orderBy field, newest first unless ASC. */
function sortRecords(records: readonly IssueRecord[], args: Readonly<Record<string, unknown>>): IssueRecord[] {
  const orderBy = typeof args.orderBy === 'object' && args.orderBy !== null ? (args.orderBy as Record<string, unknown>) : {};
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  const key = (issue: IssueRecord): string | number =>
    field === 'UPDATED_AT' ? issue.updatedAt : field === 'COMMENTS' ? issue.comments.length : issue.createdAt;
  const sorted = [...records].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const order = ka < kb ? -1 : ka > kb ? 1 : a.number - b.number;
    return direction === 'ASC' ? order : -order;
  });
  return sorted;
}

/** The state names a connection filter carries, mapped onto the shared records. */
function stateMatches(issue: IssueRecord, states: readonly string[], isPull: boolean): boolean {
  return states.some((state) => {
    if (isPull) {
      const pull = issue.pull as PullRecord;
      if (state === 'MERGED') return pull.merged;
      if (state === 'OPEN') return issue.state === 'open' && !pull.merged;
      if (state === 'CLOSED') return issue.state === 'closed' && !pull.merged;
      return false;
    }
    if (state === 'OPEN') return issue.state === 'open';
    if (state === 'CLOSED') return issue.state === 'closed';
    return false;
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function issuesConnection(store: Store, repo: RepoRecord, args: Readonly<Record<string, unknown>>): GqlObj {
  let records = repo.issues.filter((issue) => issue.pull === null);
  const states = stringList(args.states);
  if (states.length > 0) records = records.filter((issue) => stateMatches(issue, states, false));
  const sorted = sortRecords(records, args);
  return buildConnection(
    'IssueConnection',
    'IssueEdge',
    sorted.map((issue) => issueObj(repo, issue)),
    sorted.map((issue) => cursorFor(`issue:${issue.number}`)),
    args,
  );
}

function pullsConnection(store: Store, repo: RepoRecord, args: Readonly<Record<string, unknown>>): GqlObj {
  let records = repo.issues.filter((issue) => issue.pull !== null);
  const states = stringList(args.states);
  // GitHub's connection default is the open pull requests.
  records = records.filter((issue) => stateMatches(issue, states.length > 0 ? states : ['OPEN'], true));
  const sorted = sortRecords(records, args);
  return buildConnection(
    'PullRequestConnection',
    'PullRequestEdge',
    sorted.map((issue) => pullObj(repo, issue)),
    sorted.map((issue) => cursorFor(`pull:${issue.number}`)),
    args,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Pull-request derivations shared by the PullRequest fields (files, mergeable, commits)

interface PullFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changeType: string;
}

/** The live tips of a pull (branch tips while the branches exist, else the captured ones). */
function pullTips(repo: RepoRecord, pull: PullRecord): { headSha: string; baseSha: string } {
  return {
    headSha: branchTip(repo, pull.headRef) ?? pull.headSha,
    baseSha: branchTip(repo, pull.baseRef) ?? pull.baseSha,
  };
}

/** The changed files of a pull: the merge base's tree against the head's tree, as REST's files view diffs them. */
function pullFiles(repo: RepoRecord, issue: IssueRecord): PullFile[] {
  const pull = issue.pull as PullRecord;
  const { headSha, baseSha } = pullTips(repo, pull);
  const ancestor = mergeBase(repo, headSha, baseSha);
  const before = ancestor === undefined ? new Map<string, { mode: string; sha: string }>() : flattenCommit(repo, ancestor);
  const after = flattenCommit(repo, headSha);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files: PullFile[] = [];
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.sha === newEntry.sha && oldEntry.mode === newEntry.mode) continue;
    const counts = diffCounts(repo, oldEntry?.sha, newEntry?.sha);
    files.push({
      path,
      additions: counts.additions,
      deletions: counts.deletions,
      changeType: oldEntry === undefined ? 'ADDED' : newEntry === undefined ? 'DELETED' : 'MODIFIED',
    });
  }
  return files;
}

/** A dry-run three-way merge over the same trees REST's merge uses: MERGEABLE or CONFLICTING. */
function pullMergeable(repo: RepoRecord, issue: IssueRecord): string {
  const pull = issue.pull as PullRecord;
  if (pull.merged || issue.state !== 'open') return 'UNKNOWN';
  const { headSha, baseSha } = pullTips(repo, pull);
  const ancestor = mergeBase(repo, headSha, baseSha);
  if (ancestor === undefined) return 'UNKNOWN';
  const merged = mergeTrees(flattenCommit(repo, ancestor), flattenCommit(repo, baseSha), flattenCommit(repo, headSha));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

function filesConnection(repo: RepoRecord, issue: IssueRecord, args: Readonly<Record<string, unknown>>): GqlObj {
  const files = pullFiles(repo, issue);
  const items = files.map((file) => ({ gqlType: 'PullRequestChangedFile', ...file }) as GqlObj);
  return buildConnection(
    'PullRequestChangedFileConnection',
    'PullRequestChangedFileEdge',
    items,
    files.map((file, index) => cursorFor(`file:${index}`)),
    args,
  );
}

function commitsConnection(repo: RepoRecord, issue: IssueRecord, args: Readonly<Record<string, unknown>>): GqlObj {
  const pull = issue.pull as PullRecord;
  const { headSha, baseSha } = pullTips(repo, pull);
  const ancestor = mergeBase(repo, headSha, baseSha);
  const excluded = ancestor === undefined ? new Set<string>() : new Set(listCommitShas(repo, ancestor));
  const shas = listCommitShas(repo, headSha).filter((sha) => !excluded.has(sha));
  return buildConnection(
    'PullRequestCommitConnection',
    'PullRequestCommitEdge',
    shas.map((sha) => commitObj(repo, sha)),
    shas.map((sha) => cursorFor(`commit:${sha}`)),
    args,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Mutations: run the REST handlers, so the behaviour exists exactly once.

const REPO_SEGS: readonly string[] = ['api', 'v3', 'repos', ':owner', ':repo'];
const ISSUES_SEGS: readonly string[] = [...REPO_SEGS, 'issues'];
const ISSUE_SEGS: readonly string[] = [...REPO_SEGS, 'issues', ':number'];
const COMMENTS_SEGS: readonly string[] = [...REPO_SEGS, 'issues', ':number', 'comments'];
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
): Reply {
  const route = routes.find(
    (candidate) =>
      candidate.method === method &&
      candidate.segments.length === segments.length &&
      candidate.segments.every((segment, index) => segment === segments[index]),
  );
  if (route === undefined) throw new GqlError('the corresponding REST route is missing');
  const info: RequestInfo = { method, query: new URLSearchParams(), body, host: 'localhost' };
  return route.handler(store, info, params);
}

/** The GraphQL error a failed REST call becomes: the Reply's own message. */
function replyError(reply: Reply): GqlError {
  const body = typeof reply.body === 'object' && reply.body !== null ? (reply.body as Json) : {};
  const message = typeof body.message === 'string' ? body.message : `the REST call failed with status ${reply.status}`;
  return new GqlError(message);
}

/** Find an issue/PR record by its global record id, with the repository it lives in. */
function findRecord(store: Store, key: number): { repo: RepoRecord; issue: IssueRecord } | null {
  for (const repo of store.repos) {
    const issue = repo.issues.find((candidate) => candidate.id === key);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

/** Resolve a mutation input's repository global id to the record. */
function repoFromGlobalId(store: Store, id: unknown): RepoRecord {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.type !== 'Repository') throw new GqlError('Could not resolve the repository id');
  const repo = store.repos.find((candidate) => candidate.id === decoded.key);
  if (repo === undefined) throw new GqlError('Could not resolve the repository id');
  return repo;
}

/** Resolve an issue global id to a plain issue record (pull records are not issues here). */
function issueFromGlobalId(store: Store, id: unknown): { repo: RepoRecord; issue: IssueRecord } {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.type !== 'Issue') throw new GqlError('Could not resolve the issue id');
  const found = findRecord(store, decoded.key);
  if (found === null || found.issue.pull !== null) throw new GqlError('Could not resolve the issue id');
  return found;
}

/** Resolve a pull-request global id to its record. */
function pullFromGlobalId(store: Store, id: unknown): { repo: RepoRecord; issue: IssueRecord } {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.type !== 'PullRequest') throw new GqlError('Could not resolve the pull request id');
  const found = findRecord(store, decoded.key);
  if (found === null || found.issue.pull === null) throw new GqlError('Could not resolve the pull request id');
  return found;
}

function inputOf(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return typeof args.input === 'object' && args.input !== null ? (args.input as Record<string, unknown>) : {};
}

function clientMutationId(input: Readonly<Record<string, unknown>>): unknown {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}

// ---------------------------------------------------------------------------------------------------------
// The schema: one table of types and fields. It drives execution (the resolver and the
// return type to descend into), validation (an unknown field is an error naming it) and
// introspection (__type's field/enum lists are read from it), so the three cannot drift.

interface ExecCtx {
  readonly store: Store;
  readonly doc: DocumentNode;
  readonly variables: Readonly<Record<string, unknown>>;
}

type Resolver = (ctx: ExecCtx, parent: GqlObj, args: Readonly<Record<string, unknown>>) => unknown;

interface FieldDef {
  readonly type: string;
  readonly resolve: Resolver;
}

interface TypeDef {
  readonly kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'SCALAR';
  readonly fields?: Readonly<Record<string, FieldDef>>;
  readonly enumValues?: readonly string[];
}

function field(type: string, resolve: Resolver): FieldDef {
  return { type, resolve };
}

const EPOCH_ISO = '2025-01-01T00:00:00.000Z';

/** The commit data of a Commit wrapper, parsed from the object store (empty parts when absent). */
function commitData(parent: GqlObj): { message: string; author: string; committer: string } {
  const repo = parent.repo as RepoRecord;
  const object = getObject(repo, parent.sha as string);
  if (object === undefined || object.type !== 'commit') return { message: '', author: '', committer: '' };
  const parsed = parseCommit(object.body);
  return { message: parsed.message, author: parsed.author, committer: parsed.committer };
}

function gitActorObj(line: string): GqlObj {
  const identity = parseIdentity(line);
  return {
    gqlType: 'GitActor',
    name: identity.name,
    email: identity.email,
    date: identity.epochSec > 0 ? new Date(identity.epochSec * 1000).toISOString() : EPOCH_ISO,
  };
}

/** The fields every connection type shares; the wrapper carries nodes/cursors/pageInfo/totalCount. */
function connectionFields(nodeType: string, edgeType: string): Record<string, FieldDef> {
  return {
    nodes: field(`[${nodeType}]`, (_ctx, parent) => parent.nodes as GqlObj[]),
    edges: field(`[${edgeType}]`, (_ctx, parent) => {
      const nodes = parent.nodes as GqlObj[];
      const cursors = parent.cursors as string[];
      return nodes.map((node, index) => ({ gqlType: parent.edgeType as string, node, cursor: cursors[index] ?? '' }) as GqlObj);
    }),
    pageInfo: field('PageInfo', (_ctx, parent) => ({ gqlType: 'PageInfo', ...(parent.pageInfo as PageInfoShape) }) as GqlObj),
    totalCount: field('Int', (_ctx, parent) => parent.totalCount as number),
  };
}

function edgeFields(nodeType: string): Record<string, FieldDef> {
  return {
    node: field(nodeType, (_ctx, parent) => parent.node as GqlObj),
    cursor: field('String', (_ctx, parent) => parent.cursor as string),
  };
}

/** An introspection __Type wrapper for a schema type name. */
function typeObj(name: string): GqlObj {
  return { gqlType: '__Type', name };
}

const NODE_IMPLEMENTORS: ReadonlySet<string> = new Set(['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label']);

const TYPES: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: field('User', (ctx) => userObj(ctx.store.login())),
      repository: field('Repository', (ctx, _parent, args) => {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        if (ctx.store.viewerLogin !== null && owner !== ctx.store.viewerLogin) return null;
        const repo = ctx.store.findRepo(name);
        return repo === undefined ? null : repoObj(repo);
      }),
      node: field('Node', (ctx, _parent, args) => {
        const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = ctx.store.repos.find((candidate) => candidate.id === decoded.key);
          return repo === undefined ? null : repoObj(repo);
        }
        if (decoded.type === 'User') return decoded.key === 1 ? userObj(ctx.store.login()) : null;
        const found = findRecord(ctx.store, decoded.key);
        if (found === null) return null;
        if (decoded.type === 'Issue' && found.issue.pull === null) return issueObj(found.repo, found.issue);
        if (decoded.type === 'PullRequest' && found.issue.pull !== null) return pullObj(found.repo, found.issue);
        return null;
      }),
      user: field('User', (ctx, _parent, args) => (args.login === ctx.store.login() ? userObj(ctx.store.login()) : null)),
      rateLimit: field('RateLimit', () => ({ gqlType: 'RateLimit' }) as GqlObj),
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: field('CreateIssuePayload', (ctx, _parent, args) => {
        const input = inputOf(args);
        const repo = repoFromGlobalId(ctx.store, input.repositoryId);
        const reply = invokeRoute(ISSUE_ROUTES, 'POST', ISSUES_SEGS, ctx.store, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
        }, { owner: ctx.store.login(), repo: repo.name });
        if (reply.status !== 201) throw replyError(reply);
        const number = (reply.body as Json).number as number;
        const record = repo.issues.find((issue) => issue.number === number) as IssueRecord;
        return { gqlType: 'CreateIssuePayload', issue: issueObj(repo, record), clientMutationId: clientMutationId(input) } as GqlObj;
      }),
      closeIssue: field('CloseIssuePayload', (ctx, _parent, args) => {
        const input = inputOf(args);
        const found = issueFromGlobalId(ctx.store, input.issueId);
        const reply = invokeRoute(ISSUE_ROUTES, 'PATCH', ISSUE_SEGS, ctx.store, { state: 'closed' },
          { owner: ctx.store.login(), repo: found.repo.name, number: String(found.issue.number) });
        if (reply.status !== 200) throw replyError(reply);
        return { gqlType: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: clientMutationId(input) } as GqlObj;
      }),
      reopenIssue: field('ReopenIssuePayload', (ctx, _parent, args) => {
        const input = inputOf(args);
        const found = issueFromGlobalId(ctx.store, input.issueId);
        const reply = invokeRoute(ISSUE_ROUTES, 'PATCH', ISSUE_SEGS, ctx.store, { state: 'open' },
          { owner: ctx.store.login(), repo: found.repo.name, number: String(found.issue.number) });
        if (reply.status !== 200) throw replyError(reply);
        return { gqlType: 'ReopenIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: clientMutationId(input) } as GqlObj;
      }),
      createPullRequest: field('CreatePullRequestPayload', (ctx, _parent, args) => {
        const input = inputOf(args);
        const repo = repoFromGlobalId(ctx.store, input.repositoryId);
        const reply = invokeRoute(PULL_ROUTES, 'POST', PULLS_SEGS, ctx.store, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          head: typeof input.headRefName === 'string' ? input.headRefName : '',
          base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
        }, { owner: ctx.store.login(), repo: repo.name });
        if (reply.status !== 201) throw replyError(reply);
        const number = (reply.body as Json).number as number;
        const record = repo.issues.find((issue) => issue.number === number) as IssueRecord;
        return { gqlType: 'CreatePullRequestPayload', pullRequest: pullObj(repo, record), clientMutationId: clientMutationId(input) } as GqlObj;
      }),
      mergePullRequest: field('MergePullRequestPayload', (ctx, _parent, args) => {
        const input = inputOf(args);
        const found = pullFromGlobalId(ctx.store, input.pullRequestId);
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
        const reply = invokeRoute(PULL_ROUTES, 'PUT', MERGE_SEGS, ctx.store, { merge_method: method },
          { owner: ctx.store.login(), repo: found.repo.name, number: String(found.issue.number) });
        if (reply.status !== 200) throw replyError(reply);
        return { gqlType: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.issue), clientMutationId: clientMutationId(input) } as GqlObj;
      }),
      addComment: field('AddCommentPayload', (ctx, _parent, args) => {
        const input = inputOf(args);
        const found = issueFromGlobalId(ctx.store, input.subjectId);
        const reply = invokeRoute(ISSUE_ROUTES, 'POST', COMMENTS_SEGS, ctx.store, {
          body: typeof input.body === 'string' ? input.body : '',
        }, { owner: ctx.store.login(), repo: found.repo.name, number: String(found.issue.number) });
        if (reply.status !== 201) throw replyError(reply);
        const commentId = (reply.body as Json).id as number;
        const comment = found.issue.comments.find((candidate) => candidate.id === commentId) as CommentRecord;
        const edge: GqlObj = {
          gqlType: 'IssueCommentEdge',
          node: commentObj(found.repo, found.issue, comment),
          cursor: cursorFor(`comment:${comment.id}`),
        };
        return { gqlType: 'AddCommentPayload', commentEdge: edge, subject: issueObj(found.repo, found.issue), clientMutationId: clientMutationId(input) } as GqlObj;
      }),
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (_ctx, parent) => nodeIdOf(parent)),
      login: field('String', (_ctx, parent) => parent.login as string),
      name: field('String', (_ctx, parent) => parent.login as string),
      avatarUrl: field('URI', () => ''),
      url: field('URI', (_ctx, parent) => `/${parent.login as string}`),
      bio: field('String', () => null),
      company: field('String', () => null),
      location: field('String', () => null),
      isSiteAdmin: field('Boolean', () => false),
      createdAt: field('DateTime', () => EPOCH_ISO),
      updatedAt: field('DateTime', () => EPOCH_ISO),
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (_ctx, parent) => nodeIdOf(parent)),
      databaseId: field('Int', (_ctx, parent) => (parent.repo as RepoRecord).id),
      name: field('String', (_ctx, parent) => (parent.repo as RepoRecord).name),
      nameWithOwner: field('String', (ctx, parent) => `${ctx.store.login()}/${(parent.repo as RepoRecord).name}`),
      description: field('String', (_ctx, parent) => (parent.repo as RepoRecord).description),
      isPrivate: field('Boolean', (_ctx, parent) => (parent.repo as RepoRecord).private),
      isFork: field('Boolean', () => false),
      url: field('URI', (ctx, parent) => `/api/v3/repos/${ctx.store.login()}/${(parent.repo as RepoRecord).name}`),
      homepageUrl: field('URI', () => null),
      createdAt: field('DateTime', (_ctx, parent) => (parent.repo as RepoRecord).createdAt),
      updatedAt: field('DateTime', (_ctx, parent) => (parent.repo as RepoRecord).createdAt),
      pushedAt: field('DateTime', (_ctx, parent) => (parent.repo as RepoRecord).createdAt),
      owner: field('User', (ctx) => userObj(ctx.store.login())),
      defaultBranchRef: field('Ref', (_ctx, parent) => {
        const repo = parent.repo as RepoRecord;
        const tip = branchTip(repo, repo.defaultBranch);
        return tip === undefined ? null : refObj(repo, repo.defaultBranch, tip);
      }),
      viewerPermission: field('RepositoryPermission', () => 'ADMIN'),
      hasIssuesEnabled: field('Boolean', () => true),
      hasProjectsEnabled: field('Boolean', () => false),
      hasWikiEnabled: field('Boolean', () => true),
      stargazerCount: field('Int', () => 0),
      forkCount: field('Int', () => 0),
      primaryLanguage: field('Language', () => null),
      licenseInfo: field('License', () => null),
      issue: field('Issue', (_ctx, parent, args) => {
        const repo = parent.repo as RepoRecord;
        const record = repo.issues.find((issue) => issue.number === args.number && issue.pull === null);
        return record === undefined ? null : issueObj(repo, record);
      }),
      issues: field('IssueConnection', (ctx, parent, args) => issuesConnection(ctx.store, parent.repo as RepoRecord, args)),
      pullRequest: field('PullRequest', (_ctx, parent, args) => {
        const repo = parent.repo as RepoRecord;
        const record = repo.issues.find((issue) => issue.number === args.number && issue.pull !== null);
        return record === undefined ? null : pullObj(repo, record);
      }),
      pullRequests: field('PullRequestConnection', (ctx, parent, args) => pullsConnection(ctx.store, parent.repo as RepoRecord, args)),
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: field('String', (_ctx, parent) => parent.name as string),
      prefix: field('String', () => 'refs/heads/'),
      target: field('Commit', (_ctx, parent) => commitObj(parent.repo as RepoRecord, parent.sha as string)),
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      oid: field('GitObjectID', (_ctx, parent) => parent.sha as string),
      abbreviatedOid: field('String', (_ctx, parent) => (parent.sha as string).slice(0, 7)),
      message: field('String', (_ctx, parent) => commitData(parent).message),
      messageHeadline: field('String', (_ctx, parent) => commitData(parent).message.split('\n')[0] ?? ''),
      committedDate: field('DateTime', (_ctx, parent) => gitActorObj(commitData(parent).committer).date as string),
      authoredDate: field('DateTime', (_ctx, parent) => gitActorObj(commitData(parent).author).date as string),
      author: field('GitActor', (_ctx, parent) => gitActorObj(commitData(parent).author)),
      committer: field('GitActor', (_ctx, parent) => gitActorObj(commitData(parent).committer)),
      url: field('URI', () => ''),
    },
  },
  GitActor: {
    kind: 'OBJECT',
    fields: {
      name: field('String', (_ctx, parent) => parent.name as string),
      email: field('String', (_ctx, parent) => parent.email as string),
      date: field('DateTime', (_ctx, parent) => parent.date as string),
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (_ctx, parent) => nodeIdOf(parent)),
      databaseId: field('Int', (_ctx, parent) => (parent.issue as IssueRecord).id),
      number: field('Int', (_ctx, parent) => (parent.issue as IssueRecord).number),
      title: field('String', (_ctx, parent) => (parent.issue as IssueRecord).title),
      body: field('String', (_ctx, parent) => (parent.issue as IssueRecord).body),
      bodyText: field('String', (_ctx, parent) => (parent.issue as IssueRecord).body),
      state: field('IssueState', (_ctx, parent) => ((parent.issue as IssueRecord).state === 'open' ? 'OPEN' : 'CLOSED')),
      closed: field('Boolean', (_ctx, parent) => (parent.issue as IssueRecord).state === 'closed'),
      locked: field('Boolean', () => false),
      author: field('User', (_ctx, parent) => userObj((parent.issue as IssueRecord).authorLogin)),
      createdAt: field('DateTime', (_ctx, parent) => (parent.issue as IssueRecord).createdAt),
      updatedAt: field('DateTime', (_ctx, parent) => (parent.issue as IssueRecord).updatedAt),
      closedAt: field('DateTime', (_ctx, parent) => (parent.issue as IssueRecord).closedAt),
      url: field('URI', (ctx, parent) => {
        const repo = parent.repo as RepoRecord;
        return `/api/v3/repos/${ctx.store.login()}/${repo.name}/issues/${(parent.issue as IssueRecord).number}`;
      }),
      repository: field('Repository', (_ctx, parent) => repoObj(parent.repo as RepoRecord)),
      labels: field('LabelConnection', (_ctx, parent, args) => {
        const repo = parent.repo as RepoRecord;
        const issue = parent.issue as IssueRecord;
        const labels = issue.labelIds
          .map((id) => repo.labels.find((label) => label.id === id))
          .filter((label): label is LabelRecord => label !== undefined);
        return buildConnection('LabelConnection', 'LabelEdge', labels.map((label) => labelObj(repo, label)), labels.map((label) => cursorFor(`label:${label.id}`)), args);
      }),
      assignees: field('UserConnection', (_ctx, parent, args) => {
        const issue = parent.issue as IssueRecord;
        return buildConnection('UserConnection', 'UserEdge', issue.assigneeLogins.map((login) => userObj(login)), issue.assigneeLogins.map((login) => cursorFor(`user:${login}`)), args);
      }),
      comments: field('IssueCommentConnection', (_ctx, parent, args) => {
        const repo = parent.repo as RepoRecord;
        const issue = parent.issue as IssueRecord;
        return buildConnection('IssueCommentConnection', 'IssueCommentEdge', issue.comments.map((comment) => commentObj(repo, issue, comment)), issue.comments.map((comment) => cursorFor(`comment:${comment.id}`)), args);
      }),
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (_ctx, parent) => nodeIdOf(parent)),
      databaseId: field('Int', (_ctx, parent) => (parent.issue as IssueRecord).id),
      number: field('Int', (_ctx, parent) => (parent.issue as IssueRecord).number),
      title: field('String', (_ctx, parent) => (parent.issue as IssueRecord).title),
      body: field('String', (_ctx, parent) => (parent.issue as IssueRecord).body),
      state: field('PullRequestState', (_ctx, parent) => {
        const issue = parent.issue as IssueRecord;
        if ((issue.pull as PullRecord).merged) return 'MERGED';
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      }),
      merged: field('Boolean', (_ctx, parent) => (parent.issue as IssueRecord).pull?.merged ?? false),
      mergedAt: field('DateTime', (_ctx, parent) => (parent.issue as IssueRecord).pull?.mergedAt ?? null),
      mergeCommit: field('Commit', (_ctx, parent) => {
        const issue = parent.issue as IssueRecord;
        const sha = (issue.pull as PullRecord).mergeCommitSha;
        return sha === null ? null : commitObj(parent.repo as RepoRecord, sha);
      }),
      headRefName: field('String', (_ctx, parent) => (parent.issue as IssueRecord).pull?.headRef ?? ''),
      baseRefName: field('String', (_ctx, parent) => (parent.issue as IssueRecord).pull?.baseRef ?? ''),
      headRef: field('Ref', (_ctx, parent) => {
        const repo = parent.repo as RepoRecord;
        const pull = (parent.issue as IssueRecord).pull as PullRecord;
        const tip = branchTip(repo, pull.headRef);
        return tip === undefined ? null : refObj(repo, pull.headRef, tip);
      }),
      baseRef: field('Ref', (_ctx, parent) => {
        const repo = parent.repo as RepoRecord;
        const pull = (parent.issue as IssueRecord).pull as PullRecord;
        const tip = branchTip(repo, pull.baseRef);
        return tip === undefined ? null : refObj(repo, pull.baseRef, tip);
      }),
      mergeable: field('MergeableState', (_ctx, parent) => pullMergeable(parent.repo as RepoRecord, parent.issue as IssueRecord)),
      isDraft: field('Boolean', (_ctx, parent) => (parent.issue as IssueRecord).pull?.draft ?? false),
      author: field('User', (_ctx, parent) => userObj((parent.issue as IssueRecord).authorLogin)),
      createdAt: field('DateTime', (_ctx, parent) => (parent.issue as IssueRecord).createdAt),
      updatedAt: field('DateTime', (_ctx, parent) => (parent.issue as IssueRecord).updatedAt),
      closedAt: field('DateTime', (_ctx, parent) => (parent.issue as IssueRecord).closedAt),
      url: field('URI', (ctx, parent) => {
        const repo = parent.repo as RepoRecord;
        return `/api/v3/repos/${ctx.store.login()}/${repo.name}/pulls/${(parent.issue as IssueRecord).number}`;
      }),
      repository: field('Repository', (_ctx, parent) => repoObj(parent.repo as RepoRecord)),
      additions: field('Int', (_ctx, parent) => pullFiles(parent.repo as RepoRecord, parent.issue as IssueRecord).reduce((sum, file) => sum + file.additions, 0)),
      deletions: field('Int', (_ctx, parent) => pullFiles(parent.repo as RepoRecord, parent.issue as IssueRecord).reduce((sum, file) => sum + file.deletions, 0)),
      changedFiles: field('Int', (_ctx, parent) => pullFiles(parent.repo as RepoRecord, parent.issue as IssueRecord).length),
      files: field('PullRequestChangedFileConnection', (_ctx, parent, args) => filesConnection(parent.repo as RepoRecord, parent.issue as IssueRecord, args)),
      commits: field('PullRequestCommitConnection', (_ctx, parent, args) => commitsConnection(parent.repo as RepoRecord, parent.issue as IssueRecord, args)),
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: field('String', (_ctx, parent) => parent.path as string),
      additions: field('Int', (_ctx, parent) => parent.additions as number),
      deletions: field('Int', (_ctx, parent) => parent.deletions as number),
      changeType: field('String', (_ctx, parent) => parent.changeType as string),
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (_ctx, parent) => nodeIdOf(parent)),
      databaseId: field('Int', (_ctx, parent) => (parent.comment as CommentRecord).id),
      body: field('String', (_ctx, parent) => (parent.comment as CommentRecord).body),
      author: field('User', (_ctx, parent) => userObj((parent.comment as CommentRecord).authorLogin)),
      createdAt: field('DateTime', (_ctx, parent) => (parent.comment as CommentRecord).createdAt),
      updatedAt: field('DateTime', (_ctx, parent) => (parent.comment as CommentRecord).updatedAt),
      url: field('URI', () => ''),
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (_ctx, parent) => nodeIdOf(parent)),
      name: field('String', (_ctx, parent) => (parent.label as LabelRecord).name),
      color: field('String', (_ctx, parent) => (parent.label as LabelRecord).color),
      description: field('String', (_ctx, parent) => (parent.label as LabelRecord).description),
      url: field('URI', () => ''),
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      // The connection's pageInfo resolver spreads the shape onto this wrapper, so the
      // fields read themselves off the parent directly.
      hasNextPage: field('Boolean', (_ctx, parent) => parent.hasNextPage as boolean),
      hasPreviousPage: field('Boolean', (_ctx, parent) => parent.hasPreviousPage as boolean),
      startCursor: field('String', (_ctx, parent) => parent.startCursor as string | null),
      endCursor: field('String', (_ctx, parent) => parent.endCursor as string | null),
    },
  },
  IssueConnection: { kind: 'OBJECT', fields: connectionFields('Issue', 'IssueEdge') },
  PullRequestConnection: { kind: 'OBJECT', fields: connectionFields('PullRequest', 'PullRequestEdge') },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: connectionFields('PullRequestChangedFile', 'PullRequestChangedFileEdge') },
  IssueCommentConnection: { kind: 'OBJECT', fields: connectionFields('IssueComment', 'IssueCommentEdge') },
  LabelConnection: { kind: 'OBJECT', fields: connectionFields('Label', 'LabelEdge') },
  UserConnection: { kind: 'OBJECT', fields: connectionFields('User', 'UserEdge') },
  PullRequestCommitConnection: { kind: 'OBJECT', fields: connectionFields('Commit', 'PullRequestCommitEdge') },
  IssueEdge: { kind: 'OBJECT', fields: edgeFields('Issue') },
  PullRequestEdge: { kind: 'OBJECT', fields: edgeFields('PullRequest') },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: edgeFields('PullRequestChangedFile') },
  IssueCommentEdge: { kind: 'OBJECT', fields: edgeFields('IssueComment') },
  LabelEdge: { kind: 'OBJECT', fields: edgeFields('Label') },
  UserEdge: { kind: 'OBJECT', fields: edgeFields('User') },
  PullRequestCommitEdge: { kind: 'OBJECT', fields: edgeFields('Commit') },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: field('Issue', (_ctx, parent) => parent.issue as GqlObj),
      clientMutationId: field('String', (_ctx, parent) => parent.clientMutationId),
    },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: field('Issue', (_ctx, parent) => parent.issue as GqlObj),
      clientMutationId: field('String', (_ctx, parent) => parent.clientMutationId),
    },
  },
  ReopenIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: field('Issue', (_ctx, parent) => parent.issue as GqlObj),
      clientMutationId: field('String', (_ctx, parent) => parent.clientMutationId),
    },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: field('PullRequest', (_ctx, parent) => parent.pullRequest as GqlObj),
      clientMutationId: field('String', (_ctx, parent) => parent.clientMutationId),
    },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: field('PullRequest', (_ctx, parent) => parent.pullRequest as GqlObj),
      clientMutationId: field('String', (_ctx, parent) => parent.clientMutationId),
    },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: field('IssueCommentEdge', (_ctx, parent) => parent.commentEdge as GqlObj),
      subject: field('Issue', (_ctx, parent) => parent.subject as GqlObj),
      clientMutationId: field('String', (_ctx, parent) => parent.clientMutationId),
    },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: field('Int', () => 5000),
      cost: field('Int', () => 1),
      remaining: field('Int', () => 5000),
      resetAt: field('DateTime', () => EPOCH_ISO),
    },
  },
  Node: {
    kind: 'INTERFACE',
    fields: {
      id: field('ID', (_ctx, parent) => nodeIdOf(parent)),
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: field('String', (_ctx, parent) => parent.name as string),
      kind: field('String', (_ctx, parent) => TYPES[parent.name as string]?.kind ?? 'SCALAR'),
      description: field('String', () => null),
      fields: field('[__Field]', (_ctx, parent) => {
        const def = TYPES[parent.name as string];
        if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE') || def.fields === undefined) return null;
        return Object.entries(def.fields).map(([name, def2]) => ({ gqlType: '__Field', name, typeName: baseTypeName(def2.type) }) as GqlObj);
      }),
      enumValues: field('[__EnumValue]', (_ctx, parent) => {
        const def = TYPES[parent.name as string];
        if (def === undefined || def.kind !== 'ENUM' || def.enumValues === undefined) return null;
        return def.enumValues.map((name) => ({ gqlType: '__EnumValue', name }) as GqlObj);
      }),
      inputFields: field('[__InputValue]', () => null),
      possibleTypes: field('[__Type]', (_ctx, parent) => {
        if ((parent.name as string) !== 'Node') return null;
        return [...NODE_IMPLEMENTORS].map((name) => typeObj(name));
      }),
      ofType: field('__Type', () => null),
      specifiedByURL: field('String', () => null),
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: field('String', (_ctx, parent) => parent.name as string),
      description: field('String', () => null),
      args: field('[__InputValue]', () => []),
      type: field('__Type', (_ctx, parent) => typeObj(parent.typeName as string)),
      isDeprecated: field('Boolean', () => false),
      deprecationReason: field('String', () => null),
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: field('String', (_ctx, parent) => parent.name as string),
      description: field('String', () => null),
      isDeprecated: field('Boolean', () => false),
      deprecationReason: field('String', () => null),
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: field('String', (_ctx, parent) => parent.name as string),
      description: field('String', () => null),
      type: field('__Type', () => null),
      defaultValue: field('String', () => null),
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: field('[__Type]', () => Object.keys(TYPES).filter((name) => !name.startsWith('__')).map((name) => typeObj(name))),
      queryType: field('__Type', () => typeObj('Query')),
      mutationType: field('__Type', () => typeObj('Mutation')),
      subscriptionType: field('__Type', () => null),
      directives: field('[__Directive]', () => []),
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: field('String', (_ctx, parent) => parent.name as string),
      description: field('String', () => null),
      locations: field('[String]', () => []),
      args: field('[__InputValue]', () => []),
    },
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
};

/** The named type inside a type reference: '[Issue!]!' -> 'Issue'. */
function baseTypeName(typeRef: string): string {
  return typeRef.replace(/[[\]!\s]/g, '');
}

// ---------------------------------------------------------------------------------------------------------
// Validation: a separate pass over the document against the schema table. An unknown
// field is an error naming it, in GitHub's phrasing — the invalid-field check requires
// exactly that, over HTTP 200, and every other check requires NO errors on valid work,
// so validation must accept everything the resolvers can serve.

function validateSelections(
  typeName: string,
  selections: readonly SelectionNode[],
  doc: DocumentNode,
  errors: string[],
  depth: number,
): void {
  if (depth > 64) return;
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (selection.name === '__type' || selection.name === '__schema') {
        if (typeName !== 'Query') {
          errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
          continue;
        }
        if (selection.selectionSet !== null) {
          validateSelections(selection.name === '__type' ? '__Type' : '__Schema', selection.selectionSet, doc, errors, depth + 1);
        }
        continue;
      }
      const def = TYPES[typeName]?.fields?.[selection.name];
      if (def === undefined) {
        errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
        continue;
      }
      if (selection.selectionSet !== null) {
        const target = TYPES[baseTypeName(def.type)];
        if (target !== undefined && (target.kind === 'OBJECT' || target.kind === 'INTERFACE')) {
          validateSelections(baseTypeName(def.type), selection.selectionSet, doc, errors, depth + 1);
        }
      }
    } else if (selection.kind === 'inline') {
      validateSelections(selection.typeCondition ?? typeName, selection.selectionSet, doc, errors, depth + 1);
    } else {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push(`Unknown fragment '${selection.name}'`);
        continue;
      }
      validateSelections(fragment.typeCondition, fragment.selectionSet, doc, errors, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Executor

function typeMatches(objectType: string, condition: string): boolean {
  return objectType === condition || (condition === 'Node' && NODE_IMPLEMENTORS.has(objectType));
}

function executeSelectionSet(
  ctx: ExecCtx,
  typeName: string,
  parent: GqlObj,
  selections: readonly SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (sels: readonly SelectionNode[], currentType: string, obj: GqlObj): void => {
    for (const selection of sels) {
      if (selection.kind === 'field') {
        const key = selection.alias ?? selection.name;
        if (selection.name === '__typename') {
          out[key] = obj.gqlType;
          continue;
        }
        if (selection.name === '__type') {
          const nameArg = resolveArgs(selection.args, ctx.variables).name;
          const target = typeof nameArg === 'string' && TYPES[nameArg] !== undefined ? typeObj(nameArg) : null;
          out[key] = completeValue(ctx, '__Type', target, selection.selectionSet);
          continue;
        }
        if (selection.name === '__schema') {
          out[key] = completeValue(ctx, '__Schema', { gqlType: '__Schema' } as GqlObj, selection.selectionSet);
          continue;
        }
        const def = TYPES[currentType]?.fields?.[selection.name];
        if (def === undefined) throw new GqlError(`Field '${selection.name}' doesn't exist on type '${currentType}'`);
        const raw = def.resolve(ctx, obj, resolveArgs(selection.args, ctx.variables));
        out[key] = completeValue(ctx, def.type, raw, selection.selectionSet);
      } else if (selection.kind === 'inline') {
        if (selection.typeCondition === null || typeMatches(obj.gqlType, selection.typeCondition)) {
          visit(selection.selectionSet, selection.typeCondition ?? currentType, obj);
        }
      } else {
        const fragment = ctx.doc.fragments.get(selection.name);
        if (fragment !== undefined && typeMatches(obj.gqlType, fragment.typeCondition)) {
          visit(fragment.selectionSet, fragment.typeCondition, obj);
        }
      }
    }
  };
  visit(selections, typeName, parent);
  return out;
}

function completeValue(
  ctx: ExecCtx,
  typeRef: string,
  raw: unknown,
  selectionSet: readonly SelectionNode[] | null,
): unknown {
  let type = typeRef.trim();
  if (type.endsWith('!')) type = type.slice(0, -1);
  if (raw === null || raw === undefined) return null;
  if (type.startsWith('[') && type.endsWith(']')) {
    const inner = type.slice(1, -1);
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((item) => completeValue(ctx, inner, item, selectionSet));
  }
  const def = TYPES[type];
  if (def !== undefined && (def.kind === 'OBJECT' || def.kind === 'INTERFACE')) {
    return executeSelectionSet(ctx, type, raw as GqlObj, selectionSet ?? []);
  }
  if (type === 'ID') return String(raw);
  return raw;
}

// ---------------------------------------------------------------------------------------------------------
// Request handling: one operation object, or an array of them (operation batching).

function executeOne(store: Store, entry: unknown): Json {
  try {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'a GraphQL request must be a JSON object' }] };
    }
    const request = entry as Json;
    if (typeof request.query !== 'string') {
      return { data: null, errors: [{ message: 'a GraphQL request must carry a query string' }] };
    }
    const variables =
      typeof request.variables === 'object' && request.variables !== null && !Array.isArray(request.variables)
        ? (request.variables as Record<string, unknown>)
        : {};
    const doc = new Parser(request.query).parseDocument();
    const wanted = typeof request.operationName === 'string' ? request.operationName : null;
    const operation =
      doc.operations.find((candidate) => candidate.name === wanted) ?? (wanted === null ? doc.operations[0] : undefined);
    if (operation === undefined) return { data: null, errors: [{ message: 'the operation was not found' }] };
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const errors: string[] = [];
    validateSelections(rootType, operation.selectionSet, doc, errors, 0);
    if (errors.length > 0) return { data: null, errors: errors.map((message) => ({ message })) };
    const ctx: ExecCtx = { store, doc, variables };
    const data = executeSelectionSet(ctx, rootType, { gqlType: rootType } as GqlObj, operation.selectionSet);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

/** The route app.ts serves: 200 always (auth is the app gate); a batched body answers an array. */
export const GRAPHQL_ROUTES: readonly Route[] = [
  {
    method: 'POST',
    segments: ['api', 'graphql'],
    handler: (store, info) => ({
      status: 200,
      body: Array.isArray(info.body) ? info.body.map((entry) => executeOne(store, entry)) : executeOne(store, info.body),
    }),
  },
];
