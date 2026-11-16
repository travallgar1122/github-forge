// Git object primitives: SHA-1 ids over the canonical git framing ("<type> <len>\0<body>"),
// and build/parse for tree and commit bodies. Pure functions over Buffers; the store in
// store.ts owns persistence. Written from the git object format, not copied from anywhere.

import { createHash } from 'node:crypto';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

/** The id of an object: sha1 of the framed body, lowercase hex. */
export function hashObject(type: GitObjectType, body: Buffer): string {
  const frame = Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body]);
  return createHash('sha1').update(frame).digest('hex');
}

/** One tree entry; `mode` is the git mode string ('100644' file, '100755' exec, '40000' dir, '120000' link). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

/** Git's tree sort key: names compare as bytes, directories as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries to a tree object body, in git's canonical order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object body back into its entries, in stored order. */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = body.toString('utf8', offset, space);
    const nul = body.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > body.length) break;
    const name = body.toString('utf8', space + 1, nul);
    const sha = body.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** The parts of a commit object this forge reads and writes. */
export interface CommitData {
  readonly tree: string;
  readonly parents: readonly string[];
  /** The full author line after the keyword: "Name <email> 1700000000 +0000". */
  readonly author: string;
  /** The full committer line, same shape as the author line. */
  readonly committer: string;
  readonly message: string;
}

/** Serialize a commit to its object body. The message is stored verbatim. */
export function buildCommit(commit: CommitData): Buffer {
  let text = `tree ${commit.tree}\n`;
  for (const parent of commit.parents) text += `parent ${parent}\n`;
  text += `author ${commit.author}\n`;
  text += `committer ${commit.committer}\n`;
  text += `\n${commit.message}`;
  return Buffer.from(text, 'utf8');
}

/** Parse a commit object body. Unknown headers are ignored; the message is everything after the blank line. */
export function parseCommit(body: Buffer): CommitData {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Split an author/committer line into name, email and epoch seconds (0 when unparseable). */
export function parseIdentity(line: string): { name: string; email: string; epochSec: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (match === null) return { name: line.trim(), email: '', epochSec: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', epochSec: Number(match[3] ?? 0) };
}
