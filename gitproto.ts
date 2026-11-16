// Git smart HTTP, implemented from the protocol itself: pkt-line framing, ref
// advertisements (v0 and v2), the v2 ls-refs and fetch commands, the v0 fetch
// negotiation, and receive-pack with report-status. Objects live in the shared
// store (store.ts), so anything pushed is immediately visible to REST and
// anything REST commits can be cloned. Stdlib only: node:zlib inflates and
// deflates pack entries, node:crypto hashes them. Packs this server sends carry
// full objects only (no deltas); packs it receives are read completely,
// including OFS_DELTA / REF_DELTA chains and thin packs whose bases already sit
// in the repository.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, parseCommit, parseTree, type GitObjectType } from './gitobj.ts';
import { getObject, type RepoRecord, type Store, type StoredObject } from './store.ts';

/** One git-surface answer: an HTTP status, a content type and raw body bytes. */
export interface GitReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const ZERO = '0'.repeat(40);
const AGENT = 'makefun-forge/1.0';
const TEXT = 'text/plain; charset=utf-8';

function notFound(): GitReply {
  return { status: 404, contentType: TEXT, body: Buffer.from('Repository not found\n', 'utf8') };
}

function badRequest(message: string): GitReply {
  return { status: 400, contentType: TEXT, body: Buffer.from(`error: ${message}\n`, 'utf8') };
}

/** The repository a git path names, with rest.ts's rule: a foreign owner is a 404. */
function resolveRepo(store: Store, owner: string, repoName: string): RepoRecord | undefined {
  if (store.viewerLogin !== null && owner !== store.viewerLogin) return undefined;
  return store.findRepo(repoName);
}

// ---------------------------------------------------------------------------------------------
// pkt-line

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** Frame one payload as a pkt-line (4 hex length digits, then the payload). */
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

interface Packet {
  readonly kind: 'data' | 'flush' | 'delim' | 'end';
  readonly payload: Buffer;
}

/**
 * Walk a pkt-line stream from `start`. With `stopAtFlush`, the walk ends just past the
 * first flush packet and `next` is where the unframed remainder (a packfile) begins.
 * Malformed framing throws; callers turn that into a 400 and keep serving.
 */
function walkPackets(body: Buffer, start: number, stopAtFlush: boolean): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line');
    const hex = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > body.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

/** The text of a data packet without its trailing newline. */
function packetLine(packet: Packet): string {
  return packet.payload.toString('utf8').replace(/\n$/, '');
}

// ---------------------------------------------------------------------------------------------
// object graph walks

/** The `object` header of a tag object body, or null when it is not a well-formed tag. */
function tagTarget(body: Buffer): string | null {
  const text = body.toString('utf8');
  const end = text.indexOf('\n\n');
  const head = end === -1 ? text : text.slice(0, end);
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return null;
}

/** Follow tag objects until a non-tag object id comes out (the peeled target). */
function peelToNonTag(repo: RepoRecord, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = getObject(repo, current);
    if (object === undefined || object.type !== 'tag') return current;
    const target = tagTarget(object.body);
    if (target === null) return current;
    current = target;
  }
  return current;
}

interface ClosureResult {
  readonly objects: Set<string>;
  readonly commits: Set<string>;
  /** Included commits whose parents exist in the store but were cut by the depth. */
  readonly boundary: Set<string>;
}

/**
 * The objects reachable from `roots`. Commit ancestry is breadth-first, so `depth`
 * counts generations exactly; trees and blobs of an included commit are always
 * complete. `shallowStop` commits are included but their parents are not walked
 * (the have-side of a fetch from a shallow client).
 */
function closure(
  repo: RepoRecord,
  roots: readonly string[],
  options: { depth?: number; shallowStop?: ReadonlySet<string> } = {},
): ClosureResult {
  const objects = new Set<string>();
  const extraRoots: string[] = [];
  const rootCommits: string[] = [];
  for (const root of roots) {
    let current = root;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = getObject(repo, current);
      if (object === undefined) break;
      if (object.type === 'tag') {
        if (objects.has(current)) break;
        objects.add(current);
        const target = tagTarget(object.body);
        if (target === null) break;
        current = target;
        continue;
      }
      if (object.type === 'commit') rootCommits.push(current);
      else extraRoots.push(current);
      break;
    }
  }
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const commit of rootCommits) {
    if (!dist.has(commit)) {
      dist.set(commit, 0);
      queue.push(commit);
    }
  }
  for (let at = 0; at < queue.length; at += 1) {
    const commit = queue[at] ?? '';
    const depthHere = dist.get(commit) ?? 0;
    if (options.shallowStop !== undefined && options.shallowStop.has(commit)) continue;
    const object = getObject(repo, commit);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.body).parents) {
      if (dist.has(parent)) continue;
      const next = depthHere + 1;
      if (options.depth !== undefined && next >= options.depth) continue;
      if (getObject(repo, parent) === undefined) continue;
      dist.set(parent, next);
      queue.push(parent);
    }
  }
  const commits = new Set(dist.keys());
  for (const commit of commits) objects.add(commit);
  const addTree = (treeSha: string): void => {
    const stack = [treeSha];
    while (stack.length > 0) {
      const sha = stack.pop() ?? '';
      if (objects.has(sha)) continue;
      const object = getObject(repo, sha);
      if (object === undefined || object.type !== 'tree') continue;
      objects.add(sha);
      for (const entry of parseTree(object.body)) {
        if (entry.mode === '160000') continue;
        const child = getObject(repo, entry.sha);
        if (child === undefined) continue;
        if (child.type === 'tree') stack.push(entry.sha);
        else objects.add(entry.sha);
      }
    }
  };
  for (const commit of commits) {
    const object = getObject(repo, commit);
    if (object !== undefined && object.type === 'commit') addTree(parseCommit(object.body).tree);
  }
  for (const extra of extraRoots) {
    const object = getObject(repo, extra);
    if (object === undefined) continue;
    if (object.type === 'tree') addTree(extra);
    else objects.add(extra);
  }
  const boundary = new Set<string>();
  if (options.depth !== undefined) {
    for (const commit of commits) {
      const object = getObject(repo, commit);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.body).parents) {
        if (!commits.has(parent) && getObject(repo, parent) !== undefined) {
          boundary.add(commit);
          break;
        }
      }
    }
  }
  return { objects, commits, boundary };
}

/** True when `ancestor` is `descendant` itself or reachable from it over parent links. */
function isAncestor(repo: RepoRecord, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.pop() ?? '';
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = getObject(repo, current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.body).parents) queue.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// packfiles

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** One object's pack entry header: the type/size varint the pack format opens an entry with. */
function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  let first = (TYPE_CODE[type] << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a PACK v2 file from full objects (no deltas), trailer-signed with SHA-1. */
function writePack(objects: readonly StoredObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.body.length));
    parts.push(deflateSync(object.body));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate the zlib stream at `offset` (bounded by `limit`); returns bytes and the next offset. */
function inflateAt(pack: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const result = inflateSync(pack.subarray(offset, limit), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten || result.engine.bytesWritten <= 0) {
    throw new Error(`zlib stream at pack offset ${offset} consumed no bytes`);
  }
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream (source/target sizes, then copy and insert ops) to its base. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size is truncated');
      const byte = delta[offset] ?? 0;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] ?? 0) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] ?? 0) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) {
        throw new Error('delta copy is out of range');
      }
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const count = op & 0x7f;
      if (offset + count > delta.length || written + count > targetSize) {
        throw new Error('delta insert is out of range');
      }
      delta.copy(out, written, offset, offset + count);
      offset += count;
      written += count;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawEntry {
  readonly offset: number;
  readonly typeCode: number;
  readonly size: number;
  readonly data: Buffer;
  readonly baseOffset: number;
  readonly baseOid: string;
}

/**
 * Read a packfile completely: every entry inflated, OFS_DELTA and REF_DELTA chains
 * resolved (a REF_DELTA base the pack omits — a thin pack — comes from `resolveBase`),
 * the trailer checksum verified, every object's id recomputed. Throws on any defect.
 */
function readPack(pack: Buffer, resolveBase: (oid: string) => StoredObject | undefined): Map<string, StoredObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const digest = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.subarray(trailerStart).toString('hex') !== digest) throw new Error('pack checksum mismatch');
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size is truncated');
      byte = pack[offset] ?? 0;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size is too long');
    }
    let baseOffset = -1;
    let baseOid = '';
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta base is truncated');
      let value = (pack[offset] ?? 0) & 0x7f;
      let baseByte = pack[offset] ?? 0;
      offset += 1;
      while (baseByte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base is truncated');
        baseByte = pack[offset] ?? 0;
        offset += 1;
        value = (value + 1) * 128 + (baseByte & 0x7f);
      }
      baseOffset = entryOffset - value;
      if (baseOffset < 12 || baseOffset >= entryOffset) throw new Error('ofs-delta base offset is invalid');
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base is truncated');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack entry type ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    offset = inflated.next;
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: inflated.data, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, StoredObject>();
  const resolvedByOid = new Map<string, StoredObject>();
  const memo = new Map<number, { oid: string; type: GitObjectType; data: Buffer }>();
  const resolving = new Set<number>();
  const resolveEntry = (entry: RawEntry): { oid: string; type: GitObjectType; data: Buffer } => {
    const hit = memo.get(entry.offset);
    if (hit !== undefined) return hit;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolveEntry(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const inPack = resolvedByOid.get(entry.baseOid);
      if (inPack !== undefined) {
        type = inPack.type;
        data = applyDelta(inPack.body, entry.data);
      } else {
        const external = resolveBase(entry.baseOid);
        if (external === undefined) throw new Error(`ref-delta base ${entry.baseOid} is unknown`);
        type = external.type;
        data = applyDelta(external.body, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const resolved = { oid, type, data };
    memo.set(entry.offset, resolved);
    resolvedByOid.set(oid, { type, body: data });
    resolving.delete(entry.offset);
    return resolved;
  };
  for (const entry of raw) {
    const resolved = resolveEntry(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, body: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// advertisements

function headTarget(repo: RepoRecord): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function sortedRefs(repo: RepoRecord): Array<readonly [string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The v0 ref advertisement: service preamble, HEAD first, caps riding the first ref line. */
function v0Advertisement(repo: RepoRecord, service: string): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`
      : `multi_ack_detailed side-band-64k ofs-delta shallow symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
  const lines: string[] = [];
  const headOid = repo.refs.get(headTarget(repo));
  if (headOid !== undefined) lines.push(`${headOid} HEAD`);
  for (const [name, oid] of sortedRefs(repo)) {
    lines.push(`${oid} ${name}`);
    const object = getObject(repo, oid);
    if (object !== undefined && object.type === 'tag') lines.push(`${peelToNonTag(repo, oid)} ${name}^{}`);
  }
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: `version 2` first, one capability a line. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

/** GET info/refs for either service. */
export function gitInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string | null,
  protocolV2: boolean,
): GitReply {
  const repo = resolveRepo(store, owner, repoName);
  if (repo === undefined || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) return notFound();
  const body = service === 'git-upload-pack' && protocolV2 ? v2Advertisement() : v0Advertisement(repo, service);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

// ---------------------------------------------------------------------------------------------
// upload-pack

/** Wrap pack bytes in side-band band-1 pkt-lines (32 KiB a packet, far under the cap). */
function sidebandChunks(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  return parts;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

/** The fetch object selection shared by v0 and v2: wants' closure minus haves' closure. */
function selectFetch(repo: RepoRecord, args: FetchArgs): { pack: Buffer; boundary: Set<string>; unshallow: string[] } {
  const clientShallow = new Set(args.shallow);
  const want = closure(repo, args.wants, { depth: args.depth });
  const have = closure(repo, args.haves, { shallowStop: clientShallow });
  const send: StoredObject[] = [];
  for (const oid of want.objects) {
    if (have.objects.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object !== undefined) send.push(object);
  }
  const unshallow: string[] = [];
  for (const sha of clientShallow) {
    if (want.commits.has(sha) && !want.boundary.has(sha)) unshallow.push(sha);
  }
  return { pack: writePack(send), boundary: want.boundary, unshallow };
}

/** The argument lines of a v2 command: the data packets after the delim packet. */
function commandArgs(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    lines.push(packetLine(packet));
  }
  return lines;
}

function parseFetchLines(lines: readonly string[], args: FetchArgs): void {
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7));
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    }
    else if (line === 'done') args.done = true;
    // deepen-since, deepen-not, thin-pack, no-progress, ofs-delta, filter:
    // accepted and not needed — the pack is complete and delta-free either way.
  }
}

/** The v2 ls-refs command. */
function lsRefs(repo: RepoRecord, packets: readonly Packet[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of commandArgs(packets)) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = headTarget(repo);
  const headOid = repo.refs.get(head);
  if (matches('HEAD')) {
    if (headOid !== undefined) lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${head}` : ''}`);
    else if (unborn) lines.push(`unborn HEAD symref-target:${head}`);
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = getObject(repo, oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${peelToNonTag(repo, oid)}`;
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pkt(`${line}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 fetch command, shaped the way upload-pack shapes it and git 2.43 reads it
 * (both verified against the real client):
 * - A request carrying `done` (the kit client always, real git when it has no haves to
 *   negotiate) gets NO acknowledgments section — git rejects one there ("expected
 *   'packfile', received 'acknowledgments'"); shallow-info + packfile only.
 * - A request without `done` (real git negotiating its haves) gets the acknowledgments
 *   section (ACK of the last common have + `ready`, or NAK) and then the packfile IN THE
 *   SAME response — after `ready` git reads the packfile section next, never a second
 *   request ("expected packfile to be sent after 'ready'"). Negotiation always completes
 *   here in one round: every stated have is honored, so the pack is exact. */
function fetchV2(repo: RepoRecord, packets: readonly Packet[]): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  parseFetchLines(commandArgs(packets), args);
  const { pack, boundary, unshallow } = selectFetch(repo, args);
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(pkt('acknowledgments\n'));
    const common = [...args.haves].reverse().find((have) => getObject(repo, have) !== undefined);
    if (common !== undefined) {
      parts.push(pkt(`ACK ${common}\n`), pkt('ready\n'));
    } else {
      parts.push(pkt('NAK\n'));
    }
    // Sections inside one v2 response are separated by a delim packet, never a flush —
    // a flush reads as end-of-response (verified against git-upload-pack's own output).
    parts.push(DELIM);
  }
  if (boundary.size > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const sha of boundary) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sidebandChunks(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v0 fetch negotiation: shallow lines, ACK/NAK, then the sideband pack. */
function fetchV0(repo: RepoRecord, packets: readonly Packet[]): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  const caps = new Set<string>();
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packetLine(packet);
    if (line.startsWith('want ')) {
      const fields = line.slice(5).split(' ');
      args.wants.push(fields[0] ?? '');
      for (const cap of fields.slice(1)) if (cap !== '') caps.add(cap);
    } else {
      parseFetchLines([line], args);
    }
  }
  const { pack, boundary, unshallow } = selectFetch(repo, args);
  const parts: Buffer[] = [];
  for (const sha of boundary) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  const commonHaves = args.haves.filter((have) => getObject(repo, have) !== undefined);
  if (caps.has('multi_ack_detailed')) {
    for (const have of commonHaves) parts.push(pkt(`ACK ${have} common\n`));
    if (commonHaves.length > 0) parts.push(pkt(`ACK ${commonHaves[commonHaves.length - 1] ?? ''} ready\n`));
    else parts.push(pkt('NAK\n'));
  } else if (commonHaves.length > 0) {
    parts.push(pkt(`ACK ${commonHaves[commonHaves.length - 1] ?? ''}\n`));
  } else {
    parts.push(pkt('NAK\n'));
  }
  if (caps.has('side-band-64k') || caps.has('side-band')) {
    parts.push(...sidebandChunks(pack));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  // No sideband negotiated: the pack follows the negotiation lines unframed.
  return Buffer.concat([...parts, pack]);
}

/** POST git-upload-pack: a v2 command dispatch, or the v0 fetch negotiation. */
export function gitUploadPack(store: Store, owner: string, repoName: string, body: Buffer, protocolV2: boolean): GitReply {
  const repo = resolveRepo(store, owner, repoName);
  if (repo === undefined) return notFound();
  try {
    const { packets } = walkPackets(body, 0, false);
    let response: Buffer;
    if (protocolV2) {
      const first = packets.find((packet) => packet.kind === 'data');
      const command = first !== undefined ? packetLine(first) : '';
      if (command === 'command=ls-refs') response = lsRefs(repo, packets);
      else if (command === 'command=fetch') response = fetchV2(repo, packets);
      else return badRequest(`unknown v2 command ${JSON.stringify(command.slice(0, 40))}`);
    } else {
      response = fetchV0(repo, packets);
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: response };
  } catch (err) {
    return badRequest((err as Error).message);
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * Validate and apply one ref update against the evolving refs; returns the refusal
 * reason for the report's `ng` line, or null when the update was applied.
 */
function applyCommand(repo: RepoRecord, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO;
  if (current !== command.oldOid) return 'stale info';
  if (command.newOid === ZERO) {
    if (command.ref === headTarget(repo)) return 'deletion of the current branch prohibited';
    repo.refs.delete(command.ref);
    return null;
  }
  if (getObject(repo, command.newOid) === undefined) return 'missing object';
  if (current !== ZERO) {
    if (command.ref.startsWith('refs/heads/')) {
      if (!isAncestor(repo, current, command.newOid)) return 'non-fast-forward';
    } else if (command.ref.startsWith('refs/tags/') && current !== command.newOid) {
      return 'would clobber existing tag';
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

/** POST git-receive-pack: unpack, apply per command, answer with report-status. */
export function gitReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitReply {
  const repo = resolveRepo(store, owner, repoName);
  if (repo === undefined) return notFound();
  try {
    const { packets, next } = walkPackets(body, 0, true);
    const packBytes = body.subarray(next);
    const commands: PushCommand[] = [];
    const caps = new Set<string>();
    packets.forEach((packet, index) => {
      if (packet.kind !== 'data') return;
      let line = packetLine(packet);
      if (index === 0) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') caps.add(cap);
          line = line.slice(0, nul);
        }
      }
      const fields = line.split(' ');
      if (fields.length === 3) {
        commands.push({ oldOid: fields[0] ?? '', newOid: fields[1] ?? '', ref: fields[2] ?? '' });
      }
    });
    if (commands.length === 0) throw new Error('no ref commands in the request');

    let unpackError: string | null = null;
    if (packBytes.length > 0) {
      try {
        const objects = readPack(packBytes, (oid) => getObject(repo, oid));
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackError = (err as Error).message;
      }
    }

    const reportLines: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
    for (const command of commands) {
      const reason = unpackError !== null ? 'unpack failed' : applyCommand(repo, command);
      reportLines.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
    }
    const reportParts = reportLines.map((line) => pkt(`${line}\n`));
    reportParts.push(FLUSH);
    const report = Buffer.concat(reportParts);
    if (!caps.has('side-band-64k')) {
      return { status: 200, contentType: 'application/x-git-receive-pack-result', body: report };
    }
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let at = 0; at < report.length; at += CHUNK) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(at, at + CHUNK)])));
    }
    parts.push(FLUSH);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
  } catch (err) {
    return badRequest((err as Error).message);
  }
}
