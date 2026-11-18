// github-core-clone-01: a standalone, GitHub-compatible git forge in one process.
//
// Surfaces, all served from an in-memory store with no outside service, no proxy
// and no git binary:
//   - git smart HTTP at /{owner}/{repo}.git (upload-pack protocol v2 incl. ls-refs,
//     receive-pack v0 with report-status / side-band-64k / delete-refs)
//   - REST v3 under /api/v3 (repositories, branches, commits, contents, labels,
//     issues, pull requests incl. squash merge)
//   - GraphQL v4 at /api/graphql (the documents gh and github-mcp-server send)
//   - MCP at /mcp (Streamable HTTP, 2026-07-28 server/discover era + legacy
//     initialize fallback)
//
// Determinism: nothing observable derives from the wall clock or unseeded
// randomness. Commit timestamps and created/updated dates come from
// MAKEFUN_TRIAL_NOW plus a deterministic counter; request ids come from a
// counter; ids are sequential. Two runs over the same request sequence leave
// byte-identical state.
//
// Runtime: Node 22, stdlib only (node:http, node:crypto, node:zlib). Erasable
// TypeScript only (run with node --experimental-strip-types).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------
// Identity and determinism
// -------------------------------------------------------------------------------------------

/** The login the bearer token names (wire.ts's seeded scenario viewer). */
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
const DEFAULT_BRANCH = 'main';
const ZERO_OID = '0'.repeat(40);
const AGENT_NAME = 'makefun-forge/1.0';
const FORGE_VERSION = '1.0.0';

/** The bearer token the suite presents, when the trial sets it. */
const EXPECTED_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The instance's opening time, the only "now" a request may carry. */
function trialNowSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.trunc(asNumber);
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) return Math.trunc(asDate / 1000);
  }
  return 1700000000;
}
const TRIAL_NOW = trialNowSec();

/** Deterministic counters: every observable number derives from these. */
let tickCounter = 0;
let requestCounter = 0;
let globalIdCounter = 0;

/** The next deterministic second: TRIAL_NOW plus one tick per timestamp taken. */
function nextTickSec(): number {
  tickCounter += 1;
  return TRIAL_NOW + tickCounter;
}

function isoOfSec(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function nextGlobalId(): number {
  globalIdCounter += 1;
  return globalIdCounter;
}

/** Opaque Relay-style global id: base64 of "<Kind>:<ids>", never a bare number. */
function globalId(kind: string, ...parts: (number | string)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Small utilities
// -------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function b64encode(data: string | Uint8Array): string {
  return asBuffer(data).toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(asBuffer(data)).digest('hex');
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// -------------------------------------------------------------------------------------------
// git object model
// -------------------------------------------------------------------------------------------

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const who = `${fields.author ?? VIEWER_IDENTITY} ${timestamp} +0000`;
  const committer = `${fields.committer ?? VIEWER_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

function parseTag(data: Uint8Array): { object: string; type: GitObjectType; tag: string } {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  return {
    object,
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
  };
}

type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `roots`, following commits, tags and trees. */
function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// -------------------------------------------------------------------------------------------
// pkt-line codec
// -------------------------------------------------------------------------------------------

const PKT_LINE_MAX = 65520;

function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from `buffer` starting at `start`. Returns the packets and the
 * offset just past the last consumed packet (bytes after a flush are the caller's:
 * receive-pack's raw pack follows its command flush).
 */
function decodePktLines(buffer: Buffer, start = 0): { packets: GitPacket[]; consumed: number } {
  const packets: GitPacket[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error('invalid pkt-line length');
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

/** Inflate one zlib stream at `offset`; returns its bytes and the offset past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA
 * and REF_DELTA. `resolveBase` supplies a base a thin pack leaves out.
 * Every object's SHA-1 is recomputed; a mismatch is an error.
 */
function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): Map<string, GitObject> {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), in a deterministic order. */
function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects].sort((a, b) => compareStr(hashObject(a.type, a.data), hashObject(b.type, b.data)));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------------------
// Store
// -------------------------------------------------------------------------------------------

interface Comment {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

interface Label {
  name: string;
  color: string;
}

interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullByNumber: Map<number, Pull>;
  nextNumber: number;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

class Store {
  repos = new Map<string, Repo>();

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** A repository belongs to the token's login; any other owner reads as absent (404, never 403). */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const sec = nextTickSec();
    const repo: Repo = {
      id: nextGlobalId(),
      owner: VIEWER_LOGIN,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      issueByNumber: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      nextNumber: 1,
      seq: globalIdCounter,
      createdAt: isoOfSec(sec),
      updatedAt: isoOfSec(sec),
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

const store = new Store();

/** Pack cache: identical fetch object sets reuse identical pack bytes. */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 200;

function cachedPack(oids: string[], lookup: ObjectLookup): Buffer {
  const key = [...oids].sort().join(',');
  const hit = packCache.get(key);
  if (hit) return hit;
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  const pack = writePack(objects);
  if (packCache.size >= PACK_CACHE_MAX) {
    const first = packCache.keys().next().value;
    if (first !== undefined) packCache.delete(first);
  }
  packCache.set(key, pack);
  return pack;
}

// -------------------------------------------------------------------------------------------
// Tree and commit builders (contents API, squash merges)
// -------------------------------------------------------------------------------------------

/** Build a tree object from a flat path -> blob-oid map, creating subtrees as needed. */
function buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Flatten a tree object into path -> {oid, mode}, recursively. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

/** Resolve a path inside a tree; returns the entry and its parent chain. */
function resolveTreePath(
  repo: Repo,
  treeOid: string,
  path: string,
): { kind: 'file' | 'dir'; oid: string; entries?: TreeEntry[] } | null {
  const segments = path === '' ? [] : path.split('/');
  let currentOid = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(currentOid);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    const entry = entries.find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) {
      if (entry.mode === '40000') {
        const dirObject = repo.objects.get(entry.oid);
        return { kind: 'dir', oid: entry.oid, entries: dirObject?.type === 'tree' ? parseTree(dirObject.data) : [] };
      }
      return { kind: 'file', oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    currentOid = entry.oid;
  }
  const rootObject = repo.objects.get(treeOid);
  return { kind: 'dir', oid: treeOid, entries: rootObject?.type === 'tree' ? parseTree(rootObject.data) : [] };
}

/** The tip commit oid of a branch ref, or null when the branch does not exist. */
function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Create a commit object on `repo`, store it, and return its oid. */
function createCommit(
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
): string {
  const data = buildCommit({ tree: treeOid, parents, message, timestamp: nextTickSec() });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** Set one file in a tree (by path), returning the new root tree oid. */
function setFileInTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
  const files = new Map<string, string>();
  if (baseTreeOid !== null) {
    const flat = new Map<string, { oid: string; mode: string }>();
    flattenTree(repo, baseTreeOid, '', flat);
    for (const [filePath, entry] of flat) files.set(filePath, entry.oid);
  }
  if (blobOid === null) files.delete(path);
  else files.set(path, blobOid);
  return buildTreeFromFiles(repo, files);
}

/** The newest common ancestor of two commits (linear histories: the first shared commit). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsB = new Set<string>();
  const queueB: string[] = [b];
  while (queueB.length > 0) {
    const oid = queueB.pop()!;
    if (ancestorsB.has(oid)) continue;
    ancestorsB.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') queueB.push(...parseCommit(object.data).parents);
  }
  const queueA: string[] = [a];
  const seenA = new Set<string>();
  while (queueA.length > 0) {
    const oid = queueA.shift()!;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    if (ancestorsB.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') queueA.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const queue: string[] = [tip];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// Fetch computation (upload-pack)
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Object ids to pack (sorted). */
  sendOids: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
  /** False when a want oid is missing from the store. */
  wantsOk: boolean;
}

/**
 * Compute what a fetch sends. Semantics the suite relies on:
 * - objects reachable from the wants, minus objects the client holds;
 * - a `have` that is a shallow boundary holds only that commit's own objects
 *   (commit + tree + blobs), not its ancestry;
 * - `deepen N` limits the commit generations (1 = the tips only); the new
 *   shallow boundaries are the deepest included generation; an old boundary
 *   whose parents are now included is unshallowed.
 */
function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
  deepenSince: string | null,
  deepenNot: string[],
): FetchPlan {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  // deepen-since arrives as a raw string (unix seconds or an ISO date); normalize to seconds.
  let deepenSinceTs: number | null = null;
  if (deepenSince !== null) {
    const asNumber = Number(deepenSince);
    if (Number.isFinite(asNumber)) deepenSinceTs = asNumber;
    else {
      const asDate = Date.parse(deepenSince);
      if (Number.isFinite(asDate)) deepenSinceTs = Math.trunc(asDate / 1000);
    }
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const want of wants) {
    for (const [ref, oid] of repo.refs) if (oid === want) wantedRefs.push({ oid: want, ref });
  }
  const wantsOk = wants.every((want) => repo.objects.has(want));
  if (!wantsOk) return { sendOids: [], shallow: [], unshallow: [], acks: [], wantedRefs, wantsOk: false };

  // The commits the fetch includes, with their generation from the wants.
  const included = new Map<string, number>();
  const excluded = new Set<string>();
  for (const ref of deepenNot) {
    const tip = repo.refs.get(ref);
    if (tip) for (const oid of collectReachable([tip], lookup)) excluded.add(oid);
  }
  // A want may name an annotated tag object: peel it (recursively) to its commit and carry the
  // tag object(s) themselves in the send set — a clone wants refs/tags/v1 by its tag oid.
  const tagWants = new Set<string>();
  const walkRoots: string[] = [];
  for (const want of wants) {
    let current = want;
    for (;;) {
      const object = repo.objects.get(current);
      if (object?.type === 'tag') {
        tagWants.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      break;
    }
    walkRoots.push(current);
  }
  const queue: Array<{ oid: string; gen: number }> = walkRoots.map((oid) => ({ oid, gen: 0 }));
  const seenWalk = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (seenWalk.has(oid) || excluded.has(oid)) continue;
    seenWalk.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (deepenSinceTs !== null && commitTimestamp(commit) < deepenSinceTs) continue;
    if (depth !== null && gen >= depth) continue;
    included.set(oid, gen);
    for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  // Objects the fetch carries: each included commit plus its full tree closure.
  const send = new Set<string>();
  for (const oid of tagWants) send.add(oid);
  for (const oid of included.keys()) {
    // The commit, its tree, and everything under that tree (not the parents).
    send.add(oid);
    const commitObject = repo.objects.get(oid);
    if (commitObject?.type === 'commit') {
      const treeOid = parseCommit(commitObject.data).tree;
      const flat = new Map<string, { oid: string; mode: string }>();
      flattenTree(repo, treeOid, '', flat);
      send.add(treeOid);
      const treeClosure = collectReachable([treeOid], lookup);
      for (const treeEntry of treeClosure) send.add(treeEntry);
      for (const entry of flat.values()) send.add(entry.oid);
    }
  }

  // Objects the client already holds.
  const held = new Set<string>();
  const boundarySet = new Set(shallowBoundaries);
  for (const have of haves) {
    if (boundarySet.has(have)) {
      held.add(have);
      const object = repo.objects.get(have);
      if (object?.type === 'commit') {
        const treeOid = parseCommit(object.data).tree;
        held.add(treeOid);
        for (const entry of collectReachable([treeOid], lookup)) held.add(entry);
      }
    } else {
      for (const oid of collectReachable([have], lookup)) held.add(oid);
    }
  }
  for (const oid of held) send.delete(oid);

  // Shallow boundaries: the deepest included generation (depth-limited fetches).
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null || deepenSince !== null) {
    const maxGen = Math.max(0, ...included.values());
    for (const [oid, gen] of included) if (gen === maxGen) shallow.push(oid);
    for (const old of shallowBoundaries) {
      const object = repo.objects.get(old);
      if (object?.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      if (parents.every((parent) => included.has(parent))) unshallow.push(old);
    }
  } else if (shallowBoundaries.length > 0) {
    // A full fetch completes every old boundary's history.
    for (const old of shallowBoundaries) {
      const object = repo.objects.get(old);
      if (object?.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => send.has(parent) || held.has(parent) || included.has(parent))) unshallow.push(old);
    }
  }

  // ACKs: haves that are ancestors-or-equal of a want (full reachability).
  const wantReachable = collectReachable(wants, lookup);
  const acks: string[] = [];
  for (const have of haves) if (wantReachable.has(have)) acks.push(have);

  return { sendOids: [...send].sort(), shallow, unshallow, acks, wantedRefs, wantsOk: true };
}

function commitTimestamp(commit: CommitView): number {
  const match = / (\d+) [+-]\d{4}$/.exec(commit.author);
  if (match) return Number(match[1]);
  const committerMatch = / (\d+) [+-]\d{4}$/.exec(commit.committer);
  return committerMatch ? Number(committerMatch[1]) : 0;
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------

let creationCounter = 0;

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': nextRequestId(), ...extraHeaders };
  if (status !== 204) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, headers);
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'x-github-request-id': nextRequestId(),
    'content-type': contentType,
    'content-length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function parseJsonBody(buffer: Buffer): unknown {
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw new Error('malformed JSON body');
  }
}

/** True when the request carries the suite's bearer token. */
function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const token = match[1].trim();
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return null;
  const host = req.headers.host ?? '127.0.0.1';
  const next = new URLSearchParams(query);
  next.set('per_page', String(perPage));
  next.set('page', String(page + 1));
  return `<http://${host}${basePath}?${next.toString()}>; rel="next"`;
}

// -------------------------------------------------------------------------------------------
// Serializers
// -------------------------------------------------------------------------------------------

function viewerJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: isoOfSec(TRIAL_NOW) };
  return { name: match[1], email: match[2], date: isoOfSec(Number(match[3])) };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return { sha: oid, commit: { message: '' } };
  const view = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      message: view.message.replace(/\n$/, ''),
      author: parseIdent(view.author),
      committer: parseIdent(view.committer),
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

/** Resolve a ref-ish (branch name, tag name, or oid) to a commit oid, or null. */
function resolveRefish(repo: Repo, refish: string): string | null {
  const byBranch = repo.refs.get(`refs/heads/${refish}`);
  if (byBranch) return byBranch;
  const byTag = repo.refs.get(`refs/tags/${refish}`);
  if (byTag) {
    const object = repo.objects.get(byTag);
    if (object?.type === 'tag') return parseTag(object.data).object;
    return byTag;
  }
  if (isObjectId(refish)) {
    const object = repo.objects.get(refish);
    if (!object) return null;
    if (object.type === 'commit') return refish;
    if (object.type === 'tag') return parseTag(object.data).object;
    return null;
  }
  return null;
}

/** Line counts for a changed file: additions vs deletions by line multiset. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newLines) additions += Math.max(0, count - (oldLines.get(line) ?? 0));
  for (const [line, count] of oldLines) deletions += Math.max(0, count - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two trees (by root oid) into the pull-request files list. */
function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): PullFile[] {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  if (baseTreeOid !== null) flattenTree(repo, baseTreeOid, '', base);
  if (headTreeOid !== null) flattenTree(repo, headTreeOid, '', head);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const files: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const inBase = base.get(path);
    const inHead = head.get(path);
    if (inBase && !inHead) {
      const oldBlob = repo.objects.get(inBase.oid);
      const deletions = oldBlob?.type === 'blob' ? lineDiff(oldBlob.data.toString('utf8'), '').deletions : 0;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!inBase && inHead) {
      const newBlob = repo.objects.get(inHead.oid);
      const additions = newBlob?.type === 'blob' ? lineDiff('', newBlob.data.toString('utf8')).additions : 0;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (inBase && inHead && inBase.oid !== inHead.oid) {
      const oldBlob = repo.objects.get(inBase.oid);
      const newBlob = repo.objects.get(inHead.oid);
      const oldText = oldBlob?.type === 'blob' ? oldBlob.data.toString('utf8') : '';
      const newText = newBlob?.type === 'blob' ? newBlob.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

// -------------------------------------------------------------------------------------------
// REST handlers: repositories, branches, commits, refs, contents
// -------------------------------------------------------------------------------------------

function createRepoHandler(res: ServerResponse, body: unknown): void {
  if (!isRecord(body)) return sendError(res, 422, 'Validation Failed');
  const name = body.name;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 100) {
    return sendError(res, 422, 'Validation Failed: name is required');
  }
  if (store.getRepo(VIEWER_LOGIN, name) !== null) {
    return sendError(res, 422, 'Repository already exists');
  }
  const repo = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
  sendJson(res, 201, repoJson(repo));
}

function listViewerReposHandler(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const { perPage, page } = pageParams(query);
  const all = store.listViewerRepos();
  const items = paginate(all, perPage, page).map(repoJson);
  const link = linkHeader(req, '/api/v3/user/repos', query, perPage, page, all.length);
  sendJson(res, 200, items, link ? { link } : {});
}

function getRepoHandler(res: ServerResponse, owner: string, name: string): void {
  const repo = store.getRepo(owner, name);
  if (repo === null) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, repoJson(repo));
}

function patchRepoHandler(res: ServerResponse, owner: string, name: string, body: unknown): void {
  const repo = store.getRepo(owner, name);
  if (repo === null) return sendError(res, 404, 'Not Found');
  if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
  repo.updatedAt = isoOfSec(nextTickSec());
  sendJson(res, 200, repoJson(repo));
}

function deleteRepoHandler(res: ServerResponse, owner: string, name: string): void {
  const repo = store.getRepo(owner, name);
  if (repo === null) return sendError(res, 404, 'Not Found');
  store.deleteRepo(repo);
  sendJson(res, 204, null);
}

function listBranchesHandler(res: ServerResponse, repo: Repo): void {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => compareStr(String(a.name), String(b.name)));
  sendJson(res, 200, branches);
}

function getBranchHandler(res: ServerResponse, repo: Repo, branch: string): void {
  const tip = branchTip(repo, branch);
  if (tip === null) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
}

function listCommitsHandler(res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const shaParam = query.get('sha');
  let tip: string | null;
  if (shaParam === null) {
    tip = branchTip(repo, repo.defaultBranch);
  } else {
    tip = resolveRefish(repo, shaParam);
    if (tip === null) return sendError(res, 404, 'Not Found');
  }
  if (tip === null) return sendJson(res, 200, []);
  const out: Array<Record<string, unknown>> = [];
  const queue: string[] = [tip];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    out.push(commitJson(repo, oid));
    queue.push(...parseCommit(object.data).parents);
  }
  sendJson(res, 200, out);
}

function createRefHandler(res: ServerResponse, repo: Repo, body: unknown): void {
  if (!isRecord(body)) return sendError(res, 422, 'Validation Failed');
  const ref = body.ref;
  const sha = body.sha;
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) return sendError(res, 422, 'Validation Failed: ref is required');
  if (typeof sha !== 'string' || !repo.objects.has(sha)) return sendError(res, 422, 'Validation Failed: sha does not exist');
  if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
  repo.refs.set(ref, sha);
  sendJson(res, 201, { ref, object: { sha } });
}

function listRefsHandler(res: ServerResponse, repo: Repo): void {
  const refs: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => compareStr(a[0], b[0]))) {
    refs.push({ ref, object: { sha: oid } });
  }
  sendJson(res, 200, refs);
}

function getRefHandler(res: ServerResponse, repo: Repo, refName: string): void {
  const oid = repo.refs.get(refName);
  if (oid === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, { ref: refName, object: { sha: oid } });
}

function putContentsHandler(res: ServerResponse, repo: Repo, filePath: string, body: unknown): void {
  if (!isRecord(body)) return sendError(res, 422, 'Validation Failed');
  const message = typeof body.message === 'string' ? body.message : `Update ${filePath}`;
  const content = body.content;
  if (typeof content !== 'string' || content === '') return sendError(res, 422, 'Validation Failed: content is required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : null;
  let tip = branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    // A contents write on a new branch creates it from the default branch tip.
    tip = branchTip(repo, repo.defaultBranch);
  }
  const baseTreeOid = tip === null ? null : parseCommit(repo.objects.get(tip)!.data).tree;
  const existing = baseTreeOid === null ? null : resolveTreePath(repo, baseTreeOid, filePath);
  if (sha !== null) {
    if (existing === null || existing.kind !== 'file' || existing.oid !== sha) {
      return sendError(res, 409, 'Conflict: sha does not match the current file');
    }
  }
  const isUpdate = existing !== null && existing.kind === 'file';
  const blobBytes = b64decode(content);
  const blobOid = hashObject('blob', blobBytes);
  repo.objects.set(blobOid, { type: 'blob', data: blobBytes });
  const newTreeOid = setFileInTree(repo, baseTreeOid, filePath, blobOid);
  const commitOid = createCommit(repo, newTreeOid, tip === null ? [] : [tip], message.endsWith('\n') ? message : `${message}\n`);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  const baseName = filePath.split('/').pop() ?? filePath;
  sendJson(res, isUpdate ? 200 : 201, {
    content: { name: baseName, path: filePath, sha: blobOid, size: blobBytes.length, encoding: 'base64', type: 'file' },
    commit: { sha: commitOid, message },
  });
}

function getContentsHandler(res: ServerResponse, repo: Repo, filePath: string, query: URLSearchParams): void {
  const refParam = query.get('ref');
  let tip: string | null;
  if (refParam === null) {
    tip = branchTip(repo, repo.defaultBranch);
  } else {
    tip = resolveRefish(repo, refParam);
    if (tip === null) return sendError(res, 404, 'Not Found');
  }
  if (tip === null) return sendError(res, 404, 'Not Found');
  const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
  if (filePath === '') {
    const root = resolveTreePath(repo, treeOid, '');
    if (root === null || root.kind !== 'dir') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, dirEntries(repo, treeOid, '', root.entries ?? []));
  }
  const resolved = resolveTreePath(repo, treeOid, filePath);
  if (resolved === null) return sendError(res, 404, 'Not Found');
  if (resolved.kind === 'dir') {
    return sendJson(res, 200, dirEntries(repo, treeOid, filePath, resolved.entries ?? []));
  }
  const blob = repo.objects.get(resolved.oid);
  if (!blob || blob.type !== 'blob') return sendError(res, 404, 'Not Found');
  const baseName = filePath.split('/').pop() ?? filePath;
  sendJson(res, 200, {
    type: 'file',
    encoding: 'base64',
    content: b64encode(blob.data),
    sha: resolved.oid,
    size: blob.data.length,
    name: baseName,
    path: filePath,
  });
}

function dirEntries(repo: Repo, _treeOid: string, dirPath: string, entries: TreeEntry[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const entry of [...entries].sort(compareTreeEntries)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.type === 'blob' ? blob.data.length : 0 });
    }
  }
  return out;
}

function deleteContentsHandler(res: ServerResponse, repo: Repo, filePath: string, body: unknown): void {
  const branch = isRecord(body) && typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = isRecord(body) && typeof body.sha === 'string' ? body.sha : null;
  const message = isRecord(body) && typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
  const tip = branchTip(repo, branch);
  if (tip === null) return sendError(res, 404, 'Not Found');
  const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
  const existing = resolveTreePath(repo, treeOid, filePath);
  if (existing === null || existing.kind !== 'file') return sendError(res, 404, 'Not Found');
  if (sha !== null && existing.oid !== sha) return sendError(res, 409, 'Conflict: sha does not match the current file');
  const newTreeOid = setFileInTree(repo, treeOid, filePath, null);
  const commitOid = createCommit(repo, newTreeOid, [tip], message.endsWith('\n') ? message : `${message}\n`);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(res, 200, { commit: { sha: commitOid, message } });
}

// -------------------------------------------------------------------------------------------
// REST handlers: labels, issues, pull requests
// -------------------------------------------------------------------------------------------

function createLabelHandler(res: ServerResponse, repo: Repo, body: unknown): void {
  if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
    return sendError(res, 422, 'Validation Failed: name is required');
  }
  const existing = repo.labels.get(body.name);
  if (existing) return sendJson(res, 201, { name: existing.name, color: existing.color });
  const label: Label = { name: body.name, color: typeof body.color === 'string' ? body.color : 'ededed' };
  repo.labels.set(label.name, label);
  sendJson(res, 201, { name: label.name, color: label.color });
}

function createIssueInRepo(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
  const sec = nextTickSec();
  creationCounter += 1;
  const issue: Issue = {
    id: nextGlobalId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    comments: [],
    seq: creationCounter,
    createdAt: isoOfSec(sec),
    updatedAt: isoOfSec(sec),
  };
  repo.issues.push(issue);
  repo.issueByNumber.set(issue.number, issue);
  return issue;
}

function createIssueHandler(res: ServerResponse, repo: Repo, body: unknown): void {
  if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
    return sendError(res, 422, 'Validation Failed: title is required');
  }
  const labelNames: string[] = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return sendError(res, 422, `Label "${name}" does not exist`);
  }
  const issue = createIssueInRepo(repo, body.title, typeof body.body === 'string' ? body.body : '', labelNames);
  sendJson(res, 201, issueJson(issue));
}

function listIssuesHandler(req: IncomingMessage, res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  const { perPage, page } = pageParams(query);
  let items = [...repo.issues];
  if (state === 'open') items = items.filter((issue) => issue.state === 'open');
  else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') items = items.filter((issue) => issue.state === 'open');
  if (sort === 'created') {
    items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const total = items.length;
  const pageItems = paginate(items, perPage, page).map(issueJson);
  const link = linkHeader(req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, perPage, page, total);
  sendJson(res, 200, pageItems, link ? { link } : {});
}

function getIssueHandler(res: ServerResponse, repo: Repo, number: number): void {
  const issue = repo.issueByNumber.get(number);
  if (!issue) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, issueJson(issue));
}

function patchIssueHandler(res: ServerResponse, repo: Repo, number: number, body: unknown): void {
  const issue = repo.issueByNumber.get(number);
  if (!issue) return sendError(res, 404, 'Not Found');
  if (isRecord(body)) {
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
  }
  issue.updatedAt = isoOfSec(nextTickSec());
  sendJson(res, 200, issueJson(issue));
}

function createCommentHandler(res: ServerResponse, repo: Repo, number: number, body: unknown): void {
  const issue = repo.issueByNumber.get(number);
  if (!issue) return sendError(res, 404, 'Not Found');
  const text = isRecord(body) && typeof body.body === 'string' ? body.body : '';
  const sec = nextTickSec();
  creationCounter += 1;
  const comment: Comment = { id: nextGlobalId(), body: text, seq: creationCounter, createdAt: isoOfSec(sec) };
  issue.comments.push(comment);
  sendJson(res, 201, commentJson(comment));
}

function listCommentsHandler(res: ServerResponse, repo: Repo, number: number): void {
  const issue = repo.issueByNumber.get(number);
  if (!issue) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, issue.comments.map(commentJson));
}

function createPullInRepo(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
  const sec = nextTickSec();
  creationCounter += 1;
  const pull: Pull = {
    id: nextGlobalId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: creationCounter,
    createdAt: isoOfSec(sec),
    updatedAt: isoOfSec(sec),
  };
  repo.pulls.push(pull);
  repo.pullByNumber.set(pull.number, pull);
  return pull;
}

function createPullHandler(res: ServerResponse, repo: Repo, body: unknown): void {
  if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
    return sendError(res, 422, 'Validation Failed: title is required');
  }
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  const headSha = head === '' ? null : branchTip(repo, head);
  const baseSha = base === '' ? null : branchTip(repo, base);
  if (headSha === null || baseSha === null) return sendError(res, 422, 'Validation Failed: head or base branch does not exist');
  for (const pull of repo.pulls) {
    if (pull.state === 'open' && pull.headRef === head) {
      return sendError(res, 422, 'A pull request already exists for this head branch');
    }
  }
  const pull = createPullInRepo(repo, body.title, typeof body.body === 'string' ? body.body : '', head, base, headSha, baseSha);
  sendJson(res, 201, pullJson(pull));
}

function listPullsHandler(req: IncomingMessage, res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  const { perPage, page } = pageParams(query);
  let items = [...repo.pulls];
  if (state === 'open') items = items.filter((pull) => pull.state === 'open');
  else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') items = items.filter((pull) => pull.state === 'open');
  items.sort((a, b) => b.seq - a.seq);
  const total = items.length;
  const pageItems = paginate(items, perPage, page).map(pullJson);
  const link = linkHeader(req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, perPage, page, total);
  sendJson(res, 200, pageItems, link ? { link } : {});
}

function getPullHandler(res: ServerResponse, repo: Repo, number: number): void {
  const pull = repo.pullByNumber.get(number);
  if (!pull) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, pullJson(pull));
}

function listPullFilesHandler(res: ServerResponse, repo: Repo, number: number): void {
  const pull = repo.pullByNumber.get(number);
  if (!pull) return sendError(res, 404, 'Not Found');
  const baseTip = repo.objects.get(pull.baseSha);
  const headTip = repo.objects.get(pull.headSha);
  const baseTree = baseTip?.type === 'commit' ? parseCommit(baseTip.data).tree : null;
  const headTree = headTip?.type === 'commit' ? parseCommit(headTip.data).tree : null;
  sendJson(res, 200, diffTrees(repo, baseTree, headTree));
}

/**
 * Squash-merge a pull request onto its base branch. Returns the merge commit
 * (or a conflict), and updates the pull request and the base ref.
 */
function squashMerge(
  repo: Repo,
  pull: Pull,
): { ok: true; sha: string; message: string } | { ok: false; status: number; message: string } {
  if (pull.merged) return { ok: false, status: 405, message: 'Pull request already merged' };
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is closed' };
  // The base may have moved since the pull request was opened (an earlier merge landed):
  // conflict detection and the merge commit must use the CURRENT base tip, not pull.baseSha.
  const currentBaseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const headTip = repo.objects.get(pull.headSha);
  const baseTip = repo.objects.get(currentBaseSha);
  if (!headTip || headTip.type !== 'commit' || !baseTip || baseTip.type !== 'commit') {
    return { ok: false, status: 405, message: 'Pull request head or base is missing' };
  }
  if (isAncestor(repo, pull.headSha, currentBaseSha)) {
    // The head is already contained in the base: nothing new to merge.
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOfSec(nextTickSec());
    pull.mergeCommitSha = currentBaseSha;
    pull.updatedAt = pull.mergedAt;
    return { ok: true, sha: currentBaseSha, message: 'Already merged' };
  }
  const base = mergeBase(repo, pull.headSha, currentBaseSha);
  if (base === null) return { ok: false, status: 405, message: 'No merge base' };
  const baseCommit = repo.objects.get(base);
  if (!baseCommit || baseCommit.type !== 'commit') return { ok: false, status: 405, message: 'No merge base' };
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headTip.data).tree;
  const currentBaseTree = parseCommit(baseTip.data).tree;
  const headChanged = diffTrees(repo, baseTree, headTree);
  const baseChanged = diffTrees(repo, baseTree, currentBaseTree);
  const baseChangedByPath = new Map<string, PullFile>();
  for (const file of baseChanged) baseChangedByPath.set(file.filename, file);
  const headTreeFlat = new Map<string, { oid: string; mode: string }>();
  const baseTreeFlat = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, headTree, '', headTreeFlat);
  flattenTree(repo, currentBaseTree, '', baseTreeFlat);
  for (const file of headChanged) {
    const baseSide = baseChangedByPath.get(file.filename);
    if (!baseSide) continue;
    const headOid = headTreeFlat.get(file.filename)?.oid;
    const baseOid = baseTreeFlat.get(file.filename)?.oid;
    if (headOid !== undefined && baseOid !== undefined && headOid !== baseOid) {
      return { ok: false, status: 405, message: 'Merge conflict' };
    }
  }
  const message = `Merge pull request #${pull.number} from ${VIEWER_LOGIN}/${pull.headRef}\n\n${pull.title}`;
  const mergeSha = createCommit(repo, headTree, [currentBaseSha], `${message}\n`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoOfSec(nextTickSec());
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = pull.mergedAt;
  return { ok: true, sha: mergeSha, message };
}

function mergePullHandler(res: ServerResponse, repo: Repo, number: number): void {
  const pull = repo.pullByNumber.get(number);
  if (!pull) return sendError(res, 404, 'Not Found');
  const result = squashMerge(repo, pull);
  if (!result.ok) return sendError(res, result.status, result.message);
  sendJson(res, 200, { sha: result.sha, merged: true, message: result.message });
}

// -------------------------------------------------------------------------------------------
// REST router
// -------------------------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams, body: Buffer): Promise<boolean> {
  const segments = segmentsOf(pathname);
  const method = req.method ?? 'GET';
  // /api/v3 and /api/v3/
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    return false;
  }
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const rest = segments.slice(2);
  let jsonBody: unknown = undefined;
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (needsBody && body.length > 0) {
    try {
      jsonBody = parseJsonBody(body);
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return true;
    }
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: FORGE_VERSION });
    return true;
  }
  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, viewerJson());
    return true;
  }
  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      createRepoHandler(res, jsonBody);
      return true;
    }
    if (method === 'GET') {
      listViewerReposHandler(req, res, query);
      return true;
    }
    return false;
  }
  // /api/v3/repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const tail = rest.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') {
        getRepoHandler(res, owner, name);
        return true;
      }
      if (method === 'PATCH') {
        patchRepoHandler(res, owner, name, jsonBody);
        return true;
      }
      if (method === 'DELETE') {
        deleteRepoHandler(res, owner, name);
        return true;
      }
      return false;
    }
    const repo = store.getRepo(owner, name);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail[0] === 'branches' && method === 'GET') {
      if (tail.length === 1) {
        listBranchesHandler(res, repo);
        return true;
      }
      getBranchHandler(res, repo, tail.slice(1).join('/'));
      return true;
    }
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      listCommitsHandler(res, repo, query);
      return true;
    }
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2) {
        if (method === 'POST') {
          createRefHandler(res, repo, jsonBody);
          return true;
        }
        if (method === 'GET') {
          listRefsHandler(res, repo);
          return true;
        }
        return false;
      }
      if (method === 'GET') {
        getRefHandler(res, repo, `refs/${tail.slice(2).join('/')}`);
        return true;
      }
      return false;
    }
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') {
        putContentsHandler(res, repo, filePath, jsonBody);
        return true;
      }
      if (method === 'GET') {
        getContentsHandler(res, repo, filePath, query);
        return true;
      }
      if (method === 'DELETE') {
        deleteContentsHandler(res, repo, filePath, jsonBody);
        return true;
      }
      return false;
    }
    if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') {
      createLabelHandler(res, repo, jsonBody);
      return true;
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          createIssueHandler(res, repo, jsonBody);
          return true;
        }
        if (method === 'GET') {
          listIssuesHandler(req, res, repo, query);
          return true;
        }
        return false;
      }
      const issueNumber = Number(tail[1]);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (tail.length === 2) {
        if (method === 'GET') {
          getIssueHandler(res, repo, issueNumber);
          return true;
        }
        if (method === 'PATCH') {
          patchIssueHandler(res, repo, issueNumber, jsonBody);
          return true;
        }
        return false;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'POST') {
          createCommentHandler(res, repo, issueNumber, jsonBody);
          return true;
        }
        if (method === 'GET') {
          listCommentsHandler(res, repo, issueNumber);
          return true;
        }
        return false;
      }
      return false;
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          createPullHandler(res, repo, jsonBody);
          return true;
        }
        if (method === 'GET') {
          listPullsHandler(req, res, repo, query);
          return true;
        }
        return false;
      }
      const pullNumber = Number(tail[1]);
      if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        getPullHandler(res, repo, pullNumber);
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        listPullFilesHandler(res, repo, pullNumber);
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        mergePullHandler(res, repo, pullNumber);
        return true;
      }
      return false;
    }
    return false;
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// Git smart-HTTP handlers
// -------------------------------------------------------------------------------------------

const UPLOAD_PACK_CAPS = 'side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:refs/heads/main';
const RECEIVE_PACK_CAPS = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
const V2_CAPABILITY_LINES = ['agent=makefun-forge/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];

function sidebandPacket(band: number, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), data]);
  return encodePktLine(payload);
}

/** Split `data` into sideband band-1 packets (each a pkt-line, payload <= 60000 bytes). */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = 60000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    out.push(sidebandPacket(band, data.subarray(offset, Math.min(data.length, offset + chunkSize))));
  }
  return out;
}

interface AdvertisedRefLine {
  oid: string;
  ref: string;
  peeled?: string;
}

/** All refs of a repo, sorted by ref name, with peeled targets for annotated tags. */
function advertisedRefs(repo: Repo): AdvertisedRefLine[] {
  const out: AdvertisedRefLine[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => compareStr(a[0], b[0]));
  for (const [ref, oid] of refs) {
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      out.push({ oid, ref, peeled: target });
    } else {
      out.push({ oid, ref });
    }
  }
  return out;
}

function uploadPackAdvertisement(repo: Repo, version2: boolean): Buffer {
  if (version2) {
    const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush', 'version 2\n', ...V2_CAPABILITY_LINES.map((line) => `${line}\n`), 'flush'];
    return encodePktLines(lines);
  }
  const defaultTip = branchTip(repo, repo.defaultBranch);
  const caps = UPLOAD_PACK_CAPS;
  const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush'];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    if (defaultTip !== null) {
      lines.push(`${defaultTip} HEAD\0${caps}\n`);
    } else {
      lines.push(`${ZERO_OID} HEAD\0${caps}\n`);
    }
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.ref}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.ref}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function receivePackAdvertisement(repo: Repo): Buffer {
  const defaultTip = branchTip(repo, repo.defaultBranch);
  const caps = RECEIVE_PACK_CAPS;
  const lines: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    if (defaultTip !== null) {
      lines.push(`${defaultTip} HEAD\0${caps}\n`);
    } else {
      lines.push(`${ZERO_OID} HEAD\0${caps}\n`);
    }
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.ref}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.ref}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function lsRefsHandler(res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets } = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const lines: Array<string | 'flush'> = [];
  const defaultTip = branchTip(repo, repo.defaultBranch);
  const showHead = prefixes.length === 0;
  if (showHead) {
    if (defaultTip !== null) {
      lines.push(`${defaultTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.ref.startsWith(prefix))) continue;
    const attrs: string[] = [];
    if (peel && ref.peeled !== undefined) attrs.push(`peeled:${ref.peeled}`);
    lines.push(`${ref.oid} ${ref.ref}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`);
  }
  lines.push('flush');
  sendRaw(res, 200, encodePktLines(lines), 'application/x-git-upload-pack-result');
}

function fetchV2Handler(res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let deepenSince: string | null = null;
  const deepenNot: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowBoundaries.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    else if (text.startsWith('deepen-since ')) deepenSince = text.slice('deepen-since '.length).trim();
    else if (text.startsWith('deepen-not ')) deepenNot.push(text.slice('deepen-not '.length).trim());
  }
  const result = computeFetch(repo, wants, haves, shallowBoundaries, depth, deepenSince, deepenNot);
  const parts: Buffer[] = [];
  const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
  if (result.acks.length > 0) {
    for (const ack of result.acks) ackLines.push(`ACK ${ack}\n`);
  } else {
    ackLines.push('NAK\n');
  }
  ackLines.push('ready\n', 'delim');
  parts.push(encodePktLines(ackLines));
  const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
  for (const oid of result.shallow) shallowLines.push(`shallow ${oid}\n`);
  for (const oid of result.unshallow) shallowLines.push(`unshallow ${oid}\n`);
  shallowLines.push('delim');
  parts.push(encodePktLines(shallowLines));
  const wantedLines: Array<string | 'delim'> = ['wanted-refs\n'];
  for (const wanted of result.wantedRefs) wantedLines.push(`${wanted.oid} ${wanted.ref}\n`);
  wantedLines.push('delim');
  parts.push(encodePktLines(wantedLines));
  if (result.sendOids.length > 0) {
    parts.push(encodePktLines(['packfile\n']));
    const pack = cachedPack([...result.sendOids], (oid) => repo.objects.get(oid));
    parts.push(Buffer.concat(sidebandPackets(1, pack)));
    parts.push(encodePktLines(['flush']));
  }
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function fetchV0Handler(res: ServerResponse, repo: Repo, body: Buffer): void {
  const first = decodePktLines(body);
  const wants: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let deepenSince: string | null = null;
  const deepenNot: string[] = [];
  for (const packet of first.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0].trim());
    else if (text.startsWith('shallow ')) shallowBoundaries.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    else if (text.startsWith('deepen-since ')) deepenSince = text.slice('deepen-since '.length).trim();
    else if (text.startsWith('deepen-not ')) deepenNot.push(text.slice('deepen-not '.length).trim());
  }
  const haves: string[] = [];
  if (first.consumed < body.length) {
    const second = decodePktLines(body, first.consumed);
    for (const packet of second.packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  const result = computeFetch(repo, wants, haves, shallowBoundaries, depth, deepenSince, deepenNot);
  const parts: Buffer[] = [];
  const lines: string[] = [];
  if (result.acks.length > 0) {
    for (const ack of result.acks) lines.push(`ACK ${ack}\n`);
  } else {
    lines.push('NAK\n');
  }
  for (const oid of result.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of result.unshallow) lines.push(`unshallow ${oid}\n`);
  if (lines.length > 0) parts.push(encodePktLines(lines));
  if (result.sendOids.length > 0) {
    const pack = cachedPack([...result.sendOids], (oid) => repo.objects.get(oid));
    parts.push(Buffer.concat(sidebandPackets(1, pack)));
  }
  parts.push(encodePktLines(['flush']));
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePackHandler(res: ServerResponse, repo: Repo, body: Buffer): void {
  let decoded: { packets: GitPacket[]; consumed: number };
  try {
    decoded = decodePktLines(body);
  } catch {
    sendError(res, 400, 'Malformed pkt-line stream');
    return;
  }
  const commands: PushCommand[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
      sendError(res, 400, 'Malformed receive-pack command');
      return;
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) {
    sendError(res, 400, 'No receive-pack commands');
    return;
  }
  // The pack follows the command section (a delete-only push carries no pack).
  const packBytes = body.subarray(decoded.consumed);
  if (packBytes.length > 0) {
    let read: Map<string, GitObject>;
    try {
      read = readPack(packBytes);
    } catch (err) {
      sendError(res, 400, `Malformed packfile: ${(err as Error).message}`);
      return;
    }
    for (const [oid, object] of read) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const reportLines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let reason: string | null = null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reason = 'remote ref does not exist';
      else if (current !== command.oldOid) reason = 'non-fast-forward';
    } else {
      const newObject = repo.objects.get(command.newOid);
      if (!newObject) reason = 'object not found';
      else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) reason = 'non-fast-forward';
      } else {
        if (current === undefined || current !== command.oldOid) reason = 'non-fast-forward';
        else if (!isAncestor(repo, command.oldOid, command.newOid)) reason = 'non-fast-forward';
      }
    }
    if (reason !== null) {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const reportStream = encodePktLines([...reportLines, 'flush']);
  const parts: Buffer[] = [Buffer.concat(sidebandPackets(1, reportStream)), encodePktLines(['flush'])];
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

async function handleGit(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams, body: Buffer): Promise<boolean> {
  const segments = segmentsOf(pathname);
  const method = req.method ?? 'GET';
  if (segments.length < 2 || !segments[1].endsWith('.git')) return false;
  const owner = segments[0];
  const repoName = segments[1].slice(0, -'.git'.length);
  const tail = segments.slice(2);
  const repo = store.getRepo(owner, repoName);
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  try {
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        sendRaw(res, 200, uploadPackAdvertisement(repo, version2), 'application/x-git-upload-pack-advertisement');
        return true;
      }
      if (service === 'git-receive-pack') {
        sendRaw(res, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
        return true;
      }
      sendError(res, 400, 'Unknown git service');
      return true;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (version2) {
        // Protocol v2 multiplexes ls-refs and fetch on this endpoint: dispatch on the command line.
        const first = decodePktLines(body);
        const firstData = first.packets.find((packet) => packet.kind === 'data');
        const command = firstData?.kind === 'data' ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';
        if (command === 'command=ls-refs') lsRefsHandler(res, repo, body);
        else if (command === 'command=fetch') fetchV2Handler(res, repo, body);
        else sendError(res, 400, 'Unknown git-upload-pack command');
      } else {
        fetchV0Handler(res, repo, body);
      }
      return true;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      receivePackHandler(res, repo, body);
      return true;
    }
  } catch (err) {
    sendError(res, 400, (err as Error).message);
    return true;
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// GraphQL: lexer and parser (covers the query/mutation documents the suite sends)
// -------------------------------------------------------------------------------------------

type GqlTokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
interface GqlToken {
  kind: GqlTokenKind;
  value: string;
}

function lexGql(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let index = 0;
  const push = (kind: GqlTokenKind, value: string): void => {
    tokens.push({ kind, value });
  };
  while (index < source.length) {
    const ch = source[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', index)) {
      push('punct', '...');
      index += 3;
      continue;
    }
    if ('{}()[]:!=$@=&|'.includes(ch)) {
      push('punct', ch);
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        const text = end < 0 ? source.slice(index + 3) : source.slice(index + 3, end);
        push('string', text.replace(/\\"""/g, '"""'));
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1];
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u' && index + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 6;
          } else {
            value += escapes[escaped] ?? escaped;
            index += 2;
          }
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      push('string', value);
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[index + 1] ?? ''))) {
      let text = '';
      if (ch === '-') {
        text += '-';
        index += 1;
      }
      let isFloat = false;
      while (index < source.length && /[0-9]/.test(source[index])) {
        text += source[index];
        index += 1;
      }
      if (source[index] === '.' && /[0-9]/.test(source[index + 1] ?? '')) {
        isFloat = true;
        text += '.';
        index += 1;
        while (index < source.length && /[0-9]/.test(source[index])) {
          text += source[index];
          index += 1;
        }
      }
      if (source[index] === 'e' || source[index] === 'E') {
        isFloat = true;
        text += source[index];
        index += 1;
        if (source[index] === '+' || source[index] === '-') {
          text += source[index];
          index += 1;
        }
        while (index < source.length && /[0-9]/.test(source[index])) {
          text += source[index];
          index += 1;
        }
      }
      push(isFloat ? 'float' : 'int', text);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let text = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) {
        text += source[index];
        index += 1;
      }
      push('name', text);
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  push('eof', '');
  return tokens;
}

type GqlValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'enum'; value: string }
  | { kind: 'literal'; value: unknown };

interface GqlField {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, GqlValueNode>;
  selections?: GqlSelection[];
}

type GqlSelection =
  | GqlField
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition?: string; selections: GqlSelection[] };

interface GqlOperation {
  kind: 'query' | 'mutation';
  name?: string;
  selections: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlSelection[]>;
}

class GqlParser {
  private readonly tokens: GqlToken[];
  private position = 0;

  constructor(source: string) {
    this.tokens = lexGql(source);
  }

  private peek(): GqlToken {
    return this.tokens[this.position];
  }

  private next(): GqlToken {
    const token = this.tokens[this.position];
    if (this.position < this.tokens.length - 1) this.position += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.acceptPunct('(')) this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind, name, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, GqlValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: GqlSelection[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, GqlValueNode> {
    this.expectPunct('(');
    const args: Record<string, GqlValueNode> = {};
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated arguments');
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'int') return { kind: 'literal', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'literal', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'literal', value: values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        object[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'literal', value: object };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)} in GraphQL document`);
  }
}

function resolveGqlValue(node: GqlValueNode, variables: Record<string, unknown>): unknown {
  if (node.kind === 'var') return variables[node.name];
  if (node.kind === 'enum') return node.value;
  const value = node.value;
  if (Array.isArray(value)) return value.map((entry) => resolveGqlValue(entry as GqlValueNode, variables));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveGqlValue(entry as GqlValueNode, variables);
    return out;
  }
  return value;
}

function resolveGqlArgs(args: Record<string, GqlValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(args)) out[key] = resolveGqlValue(node, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// GraphQL: resolvers and executor
// -------------------------------------------------------------------------------------------

type GqlValue = Record<string, unknown> & { __typename: string };

function gqlUser(login: string, id: number): GqlValue {
  return { __typename: 'User', login, id, name: login, email: `${login}@example.invalid` };
}

function gqlRepoWrapper(repo: Repo): GqlValue {
  return { __typename: 'Repository', repo };
}

function gqlIssueWrapper(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', repo, issue };
}

function gqlPullWrapper(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', repo, pull };
}

function findRepoById(id: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let items = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    items = items.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : {};
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
  items.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const afterSeq = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (afterSeq !== null) {
    items = items.filter((issue) => (direction === 'DESC' ? issue.seq < afterSeq : issue.seq > afterSeq));
  }
  const total = items.length;
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : total;
  const page = items.slice(0, first);
  const hasNextPage = items.length > first;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].seq) : null;
  return {
    __typename: 'IssueConnection',
    repo,
    items: page,
    total,
    hasNextPage,
    endCursor,
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let items = [...repo.pulls];
  const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : {};
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  items.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const afterSeq = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (afterSeq !== null) {
    items = items.filter((pull) => (direction === 'DESC' ? pull.seq < afterSeq : pull.seq > afterSeq));
  }
  const total = items.length;
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : total;
  const page = items.slice(0, first);
  const hasNextPage = items.length > first;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].seq) : null;
  return {
    __typename: 'PullRequestConnection',
    repo,
    items: page,
    total,
    hasNextPage,
    endCursor,
  };
}

/** True when the head and base both changed the same file to different content. */
function pullHasConflict(repo: Repo, pull: Pull): boolean {
  const currentBaseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const headTip = repo.objects.get(pull.headSha);
  const baseTip = repo.objects.get(currentBaseSha);
  if (!headTip || headTip.type !== 'commit' || !baseTip || baseTip.type !== 'commit') return false;
  const base = mergeBase(repo, pull.headSha, currentBaseSha);
  if (base === null) return false;
  const baseCommit = repo.objects.get(base);
  if (!baseCommit || baseCommit.type !== 'commit') return false;
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headTip.data).tree;
  const currentBaseTree = parseCommit(baseTip.data).tree;
  const headChanged = diffTrees(repo, baseTree, headTree);
  const baseChanged = diffTrees(repo, baseTree, currentBaseTree);
  const baseByPath = new Map<string, PullFile>();
  for (const file of baseChanged) baseByPath.set(file.filename, file);
  const headFlat = new Map<string, { oid: string; mode: string }>();
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, headTree, '', headFlat);
  flattenTree(repo, currentBaseTree, '', baseFlat);
  for (const file of headChanged) {
    if (!baseByPath.has(file.filename)) continue;
    const headOid = headFlat.get(file.filename)?.oid;
    const baseOid = baseFlat.get(file.filename)?.oid;
    if (headOid !== undefined && baseOid !== undefined && headOid !== baseOid) return true;
  }
  return false;
}

function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const currentBaseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  if (isAncestor(repo, pull.headSha, currentBaseSha)) return 'MERGEABLE';
  if (mergeBase(repo, pull.headSha, currentBaseSha) === null) return 'UNKNOWN';
  return pullHasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

const ISSUE_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'url'];
const PULL_REQUEST_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'repository'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

function typeInfo(name: string): GqlValue | null {
  if (name === 'Issue') {
    return { __typename: '__Type', name: 'Issue', kind: 'OBJECT', fields: ISSUE_FIELDS, enumValues: null };
  }
  if (name === 'PullRequest') {
    return { __typename: '__Type', name: 'PullRequest', kind: 'OBJECT', fields: PULL_REQUEST_FIELDS, enumValues: null };
  }
  if (name === 'Repository') {
    return { __typename: '__Type', name: 'Repository', kind: 'OBJECT', fields: REPOSITORY_FIELDS, enumValues: null };
  }
  if (name === 'SearchType') {
    return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES };
  }
  return null;
}

function decodeGlobalIdOrThrow(id: unknown): { kind: string; parts: string[] } {
  if (typeof id !== 'string') throw new Error('Invalid global id');
  const decoded = decodeGlobalId(id);
  if (decoded === null) throw new Error(`Invalid global id ${JSON.stringify(id)}`);
  return decoded;
}

function repoFromGlobalId(id: unknown): Repo {
  const decoded = decodeGlobalIdOrThrow(id);
  if (decoded.kind !== 'Repository' || decoded.parts.length < 1) throw new Error('Expected a Repository id');
  const repo = findRepoById(Number(decoded.parts[0]));
  if (repo === null) throw new Error('Repository not found');
  return repo;
}

function issueFromGlobalId(id: unknown): { repo: Repo; issue: Issue } {
  const decoded = decodeGlobalIdOrThrow(id);
  if (decoded.kind !== 'Issue' || decoded.parts.length < 2) throw new Error('Expected an Issue id');
  const repo = findRepoById(Number(decoded.parts[0]));
  const issue = repo?.issueByNumber.get(Number(decoded.parts[1]));
  if (repo === undefined || repo === null || !issue) throw new Error('Issue not found');
  return { repo, issue };
}

function pullFromGlobalId(id: unknown): { repo: Repo; pull: Pull } {
  const decoded = decodeGlobalIdOrThrow(id);
  if (decoded.kind !== 'PullRequest' || decoded.parts.length < 2) throw new Error('Expected a PullRequest id');
  const repo = findRepoById(Number(decoded.parts[0]));
  const pull = repo?.pullByNumber.get(Number(decoded.parts[1]));
  if (repo === undefined || repo === null || !pull) throw new Error('Pull request not found');
  return { repo, pull };
}

function resolveGqlField(parent: GqlValue, name: string, args: Record<string, unknown>): unknown {
  if (name === '__typename') return parent.__typename;
  const typename = parent.__typename;
  if (typename === 'Query') {
    if (name === 'viewer') return gqlUser(VIEWER_LOGIN, VIEWER_ID);
    if (name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : gqlRepoWrapper(repo);
    }
    if (name === 'node') {
      const decoded = decodeGlobalIdOrThrow(args.id);
      if (decoded.kind === 'Repository' && decoded.parts.length >= 1) {
        const repo = findRepoById(Number(decoded.parts[0]));
        return repo === null ? null : gqlRepoWrapper(repo);
      }
      if (decoded.kind === 'Issue' && decoded.parts.length >= 2) {
        const repo = findRepoById(Number(decoded.parts[0]));
        const issue = repo?.issueByNumber.get(Number(decoded.parts[1]));
        return repo && issue ? gqlIssueWrapper(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest' && decoded.parts.length >= 2) {
        const repo = findRepoById(Number(decoded.parts[0]));
        const pull = repo?.pullByNumber.get(Number(decoded.parts[1]));
        return repo && pull ? gqlPullWrapper(repo, pull) : null;
      }
      return null;
    }
    if (name === '__type') {
      return typeof args.name === 'string' ? typeInfo(args.name) : null;
    }
    throw new Error(`Cannot query field "${name}" on type "Query".`);
  }
  if (typename === 'Mutation') {
    if (name === 'createIssue') {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const repo = repoFromGlobalId(input.repositoryId);
      const issue = createIssueInRepo(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', issue: gqlIssueWrapper(repo, issue) };
    }
    if (name === 'closeIssue') {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const { repo, issue } = issueFromGlobalId(input.issueId);
      issue.state = 'closed';
      issue.updatedAt = isoOfSec(nextTickSec());
      return { __typename: 'CloseIssuePayload', issue: gqlIssueWrapper(repo, issue) };
    }
    if (name === 'createPullRequest') {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const repo = repoFromGlobalId(input.repositoryId);
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) throw new Error('Head or base branch does not exist');
      for (const pull of repo.pulls) {
        if (pull.state === 'open' && pull.headRef === headRef) throw new Error('A pull request already exists for this head branch');
      }
      const pull = createPullInRepo(repo, String(input.title ?? ''), '', headRef, baseRef, headSha, baseSha);
      return { __typename: 'CreatePullRequestPayload', pullRequest: gqlPullWrapper(repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const { repo, pull } = pullFromGlobalId(input.pullRequestId);
      const result = squashMerge(repo, pull);
      if (!result.ok) throw new Error(result.message);
      return { __typename: 'MergePullRequestPayload', pullRequest: gqlPullWrapper(repo, pull) };
    }
    if (name === 'addComment') {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const { repo, issue } = issueFromGlobalId(input.subjectId);
      const sec = nextTickSec();
      creationCounter += 1;
      const comment: Comment = { id: nextGlobalId(), body: typeof input.body === 'string' ? input.body : '', seq: creationCounter, createdAt: isoOfSec(sec) };
      issue.comments.push(comment);
      const node: GqlValue = { __typename: 'Comment', id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node } };
    }
    throw new Error(`Cannot query field "${name}" on type "Mutation".`);
  }
  if (typename === 'Repository') {
    const repo = parent.repo as Repo;
    if (name === 'id') return globalId('Repository', repo.id);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') return gqlUser(repo.owner, VIEWER_ID);
    if (name === 'description') return repo.description;
    if (name === 'private') return repo.private;
    if (name === 'defaultBranchRef') {
      const tip = branchTip(repo, repo.defaultBranch);
      return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' };
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'createdAt') return repo.createdAt;
    if (name === 'updatedAt') return repo.updatedAt;
    if (name === 'issue') {
      const issue = repo.issueByNumber.get(Number(args.number));
      return issue ? gqlIssueWrapper(repo, issue) : null;
    }
    if (name === 'issues') return issueConnection(repo, args);
    if (name === 'pullRequest') {
      const pull = repo.pullByNumber.get(Number(args.number));
      return pull ? gqlPullWrapper(repo, pull) : null;
    }
    if (name === 'pullRequests') return pullConnection(repo, args);
    throw new Error(`Cannot query field "${name}" on type "Repository".`);
  }
  if (typename === 'Issue') {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    if (name === 'id') return globalId('Issue', repo.id, issue.number);
    if (name === 'databaseId') return issue.id;
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'createdAt') return issue.createdAt;
    if (name === 'updatedAt') return issue.updatedAt;
    if (name === 'author') return gqlUser(VIEWER_LOGIN, VIEWER_ID);
    if (name === 'repository') return gqlRepoWrapper(repo);
    if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (name === 'labels') {
      return { __typename: 'LabelConnection', nodes: issue.labels.map((label) => ({ __typename: 'Label', name: label, color: 'ededed' })) };
    }
    if (name === 'comments') {
      const nodes = issue.comments.map((comment) => ({
        __typename: 'Comment',
        id: globalId('IssueComment', repo.id, issue.number, comment.id),
        body: comment.body,
      }));
      return { __typename: 'CommentConnection', nodes };
    }
    throw new Error(`Cannot query field "${name}" on type "Issue".`);
  }
  if (typename === 'PullRequest') {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    if (name === 'id') return globalId('PullRequest', repo.id, pull.number);
    if (name === 'databaseId') return pull.id;
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') return pullMergeable(repo, pull);
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'headRef') return { __typename: 'Ref', name: pull.headRef, prefix: 'refs/heads/' };
    if (name === 'baseRef') return { __typename: 'Ref', name: pull.baseRef, prefix: 'refs/heads/' };
    if (name === 'createdAt') return pull.createdAt;
    if (name === 'updatedAt') return pull.updatedAt;
    if (name === 'author') return gqlUser(VIEWER_LOGIN, VIEWER_ID);
    if (name === 'repository') return gqlRepoWrapper(repo);
    if (name === 'files') {
      const baseTip = repo.objects.get(pull.baseSha);
      const headTip = repo.objects.get(pull.headSha);
      const baseTree = baseTip?.type === 'commit' ? parseCommit(baseTip.data).tree : null;
      const headTree = headTip?.type === 'commit' ? parseCommit(headTip.data).tree : null;
      const all = diffTrees(repo, baseTree, headTree);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : all.length;
      const page = all.slice(0, first);
      return {
        __typename: 'FileConnection',
        nodes: page.map((file) => ({ __typename: 'PullRequestFile', path: file.filename })),
        totalCount: all.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: all.length > first, endCursor: null },
      };
    }
    throw new Error(`Cannot query field "${name}" on type "PullRequest".`);
  }
  if (typename === 'User') {
    if (name === 'login') return parent.login as string;
    if (name === 'id') return parent.id as number;
    if (name === 'databaseId') return parent.id as number;
    if (name === 'name') return parent.name as string;
    if (name === 'email') return parent.email as string;
    throw new Error(`Cannot query field "${name}" on type "User".`);
  }
  if (typename === 'Ref') {
    if (name === 'name') return parent.name as string;
    if (name === 'prefix') return parent.prefix as string;
    throw new Error(`Cannot query field "${name}" on type "Ref".`);
  }
  if (typename === 'IssueConnection' || typename === 'PullRequestConnection') {
    const items = parent.items as Array<Issue | Pull>;
    const repo = parent.repo as Repo;
    if (name === 'nodes') {
      return items.map((item) => (typename === 'IssueConnection' ? gqlIssueWrapper(repo, item as Issue) : gqlPullWrapper(repo, item as Pull)));
    }
    if (name === 'edges') {
      return items.map((item) => ({
        __typename: typename === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge',
        node: typename === 'IssueConnection' ? gqlIssueWrapper(repo, item as Issue) : gqlPullWrapper(repo, item as Pull),
        cursor: encodeCursor(item.seq),
      }));
    }
    if (name === 'pageInfo') {
      return { __typename: 'PageInfo', hasNextPage: parent.hasNextPage as boolean, endCursor: parent.endCursor as string | null };
    }
    if (name === 'totalCount') return parent.total as number;
    throw new Error(`Cannot query field "${name}" on type "${typename}".`);
  }
  if (typename === 'IssueEdge' || typename === 'PullRequestEdge') {
    if (name === 'node') return parent.node as GqlValue;
    if (name === 'cursor') return parent.cursor as string;
    throw new Error(`Cannot query field "${name}" on type "${typename}".`);
  }
  if (typename === 'PageInfo') {
    if (name === 'hasNextPage') return parent.hasNextPage as boolean;
    if (name === 'endCursor') return parent.endCursor as string | null;
    if (name === 'hasPreviousPage') return false;
    if (name === 'startCursor') return null;
    throw new Error(`Cannot query field "${name}" on type "PageInfo".`);
  }
  if (typename === '__Type') {
    if (name === 'name') return parent.name as string;
    if (name === 'kind') return parent.kind as string;
    if (name === 'fields') {
      const fields = parent.fields as string[] | null;
      return fields === null ? null : fields.map((field) => ({ __typename: '__Field', name: field }));
    }
    if (name === 'enumValues') {
      const values = parent.enumValues as string[] | null;
      return values === null ? null : values.map((value) => ({ __typename: '__EnumValue', name: value }));
    }
    throw new Error(`Cannot query field "${name}" on type "__Type".`);
  }
  if (typename === '__Field' || typename === '__EnumValue') {
    if (name === 'name') return parent.name as string;
    throw new Error(`Cannot query field "${name}" on type "${typename}".`);
  }
  if (typename === 'LabelConnection' || typename === 'CommentConnection') {
    if (name === 'nodes') return parent.nodes as unknown[];
    if (name === 'totalCount') return (parent.nodes as unknown[]).length;
    throw new Error(`Cannot query field "${name}" on type "${typename}".`);
  }
  if (typename === 'Label') {
    if (name === 'name') return parent.name as string;
    if (name === 'color') return parent.color as string;
    throw new Error(`Cannot query field "${name}" on type "Label".`);
  }
  if (typename === 'Comment') {
    if (name === 'id') return parent.id as string;
    if (name === 'body') return parent.body as string;
    if (name === 'author') return gqlUser(VIEWER_LOGIN, VIEWER_ID);
    throw new Error(`Cannot query field "${name}" on type "Comment".`);
  }
  if (typename === 'FileConnection') {
    if (name === 'nodes') return parent.nodes as unknown[];
    if (name === 'totalCount') return parent.totalCount as number;
    if (name === 'pageInfo') return parent.pageInfo as GqlValue;
    throw new Error(`Cannot query field "${name}" on type "FileConnection".`);
  }
  if (typename === 'PullRequestFile') {
    if (name === 'path') return parent.path as string;
    throw new Error(`Cannot query field "${name}" on type "PullRequestFile".`);
  }
  if (typename === 'CreateIssuePayload' || typename === 'CloseIssuePayload') {
    if (name === 'issue') return parent.issue as GqlValue;
    throw new Error(`Cannot query field "${name}" on type "${typename}".`);
  }
  if (typename === 'CreatePullRequestPayload' || typename === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return parent.pullRequest as GqlValue;
    throw new Error(`Cannot query field "${name}" on type "${typename}".`);
  }
  if (typename === 'AddCommentPayload') {
    if (name === 'commentEdge') return parent.commentEdge as GqlValue;
    throw new Error(`Cannot query field "${name}" on type "AddCommentPayload".`);
  }
  if (typename === 'CommentEdge') {
    if (name === 'node') return parent.node as GqlValue;
    throw new Error(`Cannot query field "${name}" on type "CommentEdge".`);
  }
  throw new Error(`Cannot query field "${name}" on type "${typename}".`);
}

function executeGqlSelections(
  parent: GqlValue,
  selections: GqlSelection[],
  doc: GqlDocument,
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeGqlSelections(parent, fragment, doc, variables, errors));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === parent.__typename) {
        Object.assign(out, executeGqlSelections(parent, selection.selections, doc, variables, errors));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    try {
      const args = resolveGqlArgs(selection.args, variables);
      let value: unknown = resolveGqlField(parent, selection.name, args);
      if (selection.selections !== undefined && value !== null && value !== undefined) {
        value = applyGqlSelections(value, selection.selections, doc, variables, errors);
      }
      out[responseKey] = value;
    } catch (err) {
      errors.push({ message: (err as Error).message });
      out[responseKey] = null;
    }
  }
  return out;
}

function applyGqlSelections(
  value: unknown,
  selections: GqlSelection[],
  doc: GqlDocument,
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (isRecord(item) ? executeGqlSelections(item as GqlValue, selections, doc, variables, errors) : item));
  }
  if (isRecord(value)) return executeGqlSelections(value as GqlValue, selections, doc, variables, errors);
  return value;
}

interface GqlExecutionResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeGqlDocument(doc: GqlDocument, operationName: string | undefined, variables: Record<string, unknown>): GqlExecutionResult {
  let operation = doc.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in GraphQL document' }] };
  if (operationName !== undefined) {
    const found = doc.operations.find((candidate) => candidate.name === operationName);
    if (found === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    operation = found;
  }
  const root: GqlValue = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const errors: Array<{ message: string }> = [];
  const data = executeGqlSelections(root, operation.selections, doc, variables, errors);
  const result: GqlExecutionResult = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

function executeGqlRequest(entry: unknown): GqlExecutionResult {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL request must include a query string' }] };
  }
  let doc: GqlDocument;
  try {
    doc = new GqlParser(entry.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  return executeGqlDocument(doc, operationName, variables);
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonBody(body);
  } catch {
    sendJson(res, 200, { errors: [{ message: 'Invalid JSON body' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => executeGqlRequest(entry)));
  } else {
    sendJson(res, 200, executeGqlRequest(parsed));
  }
  return true;
}

// -------------------------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over Streamable HTTP (server/discover era + legacy initialize)
// -------------------------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** Fixed tool list: identical content and order on every tools/list call. */
const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

class McpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function mcpArgString(args: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Resolve owner/repo from the call's arguments, accepting the usual aliases. */
function mcpResolveRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = mcpArgString(args, 'full_name', 'fullName', 'repository_full_name');
  if (fullName !== null && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/');
    if (owner !== '' && repo !== '') return { owner, repo };
  }
  const owner = mcpArgString(args, 'owner', 'owner_login');
  const repo = mcpArgString(args, 'repo', 'repository', 'repo_name');
  if (owner !== null && repo !== null) return { owner, repo };
  return null;
}

function mcpToolResult(data: unknown): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (tool === undefined) throw new McpError(-32601, `Unknown tool: ${name}`);
  if (tool.name === 'create_repo') {
    const repoName = mcpArgString(args, 'name', 'repo', 'repository');
    if (repoName === null) return mcpToolError('Missing required argument: name');
    const owner = mcpArgString(args, 'owner') ?? VIEWER_LOGIN;
    if (owner !== VIEWER_LOGIN) return mcpToolError(`Repository owner not found: ${owner}`);
    if (store.getRepo(VIEWER_LOGIN, repoName) !== null) return mcpToolError('Repository already exists');
    const description = mcpArgString(args, 'description', 'body') ?? '';
    const repo = store.createRepo(repoName, args.private === true, description);
    return mcpToolResult({ ...repoJson(repo), full_name: `${repo.owner}/${repo.name}` });
  }
  if (tool.name === 'get_repo') {
    const resolved = mcpResolveRepo(args);
    if (resolved === null) return mcpToolError('Missing required arguments: owner and repo');
    const repo = store.getRepo(resolved.owner, resolved.repo);
    if (repo === null) return mcpToolError('Repository not found');
    return mcpToolResult({ ...repoJson(repo), full_name: `${repo.owner}/${repo.name}` });
  }
  if (tool.name === 'create_issue') {
    const resolved = mcpResolveRepo(args);
    const title = mcpArgString(args, 'title');
    if (resolved === null) return mcpToolError('Missing required arguments: owner and repo');
    if (title === null) return mcpToolError('Missing required argument: title');
    const repo = store.getRepo(resolved.owner, resolved.repo);
    if (repo === null) return mcpToolError('Repository not found');
    const body = mcpArgString(args, 'body', 'description') ?? '';
    const issue = createIssueInRepo(repo, title, body, []);
    return mcpToolResult(issueJson(issue));
  }
  if (tool.name === 'list_issues') {
    const resolved = mcpResolveRepo(args);
    if (resolved === null) return mcpToolError('Missing required arguments: owner and repo');
    const repo = store.getRepo(resolved.owner, resolved.repo);
    if (repo === null) return mcpToolError('Repository not found');
    const state = (mcpArgString(args, 'state') ?? 'open').toLowerCase();
    let items = [...repo.issues].sort((a, b) => b.seq - a.seq);
    if (state === 'open') items = items.filter((issue) => issue.state === 'open');
    else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
    const data = items.map(issueJson);
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { issues: data } };
  }
  if (tool.name === 'create_pull_request') {
    const resolved = mcpResolveRepo(args);
    const title = mcpArgString(args, 'title');
    const head = mcpArgString(args, 'head', 'head_branch', 'head_ref', 'headRef');
    const base = mcpArgString(args, 'base', 'base_branch', 'base_ref', 'baseRef');
    if (resolved === null) return mcpToolError('Missing required arguments: owner and repo');
    if (title === null) return mcpToolError('Missing required argument: title');
    if (head === null || base === null) return mcpToolError('Missing required arguments: head and base');
    const repo = store.getRepo(resolved.owner, resolved.repo);
    if (repo === null) return mcpToolError('Repository not found');
    const headSha = branchTip(repo, head);
    const baseSha = branchTip(repo, base);
    if (headSha === null || baseSha === null) return mcpToolError('Head or base branch does not exist');
    for (const pull of repo.pulls) {
      if (pull.state === 'open' && pull.headRef === head) return mcpToolError('A pull request already exists for this head branch');
    }
    const body = mcpArgString(args, 'body', 'description') ?? '';
    const pull = createPullInRepo(repo, title, body, head, base, headSha, baseSha);
    return mcpToolResult(pullJson(pull));
  }
  if (tool.name === 'merge_pull_request') {
    const resolved = mcpResolveRepo(args);
    const rawNumber = args.pull_number ?? args.number ?? args.pullNumber ?? args.pr_number;
    const pullNumber = typeof rawNumber === 'number' ? rawNumber : Number(rawNumber);
    if (resolved === null) return mcpToolError('Missing required arguments: owner and repo');
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) return mcpToolError('Missing required argument: pull_number');
    const repo = store.getRepo(resolved.owner, resolved.repo);
    if (repo === null) return mcpToolError('Repository not found');
    const pull = repo.pullByNumber.get(pullNumber);
    if (!pull) return mcpToolError('Pull request not found');
    const result = squashMerge(repo, pull);
    if (!result.ok) return mcpToolError(result.message);
    return mcpToolResult({ sha: result.sha, merged: true, message: result.message });
  }
  throw new McpError(-32601, `Unknown tool: ${name}`);
}

const MCP_SERVER_INFO = { name: 'makefun-forge', version: FORGE_VERSION };

function mcpServerInfoMeta(): Record<string, unknown> {
  return { 'io.modelcontextprotocol/serverInfo': { ...MCP_SERVER_INFO } };
}

/** One JSON-RPC request object. Returns null for notifications (no response). */
function handleMcpRequest(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry) || typeof entry.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: isRecord(entry) && 'id' in entry ? (entry.id as unknown) : null,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }
  const id = 'id' in entry ? (entry.id as unknown) : undefined;
  if (id === undefined) return null; // Notification: no response body.
  const method = entry.method;
  const params = isRecord(entry.params) ? (entry.params as Record<string, unknown>) : {};
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'server/discover') {
    return ok({
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { ...MCP_SERVER_INFO },
      _meta: mcpServerInfoMeta(),
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const version = requested === '2026-07-28' || requested === '2025-11-25' ? requested : '2026-07-28';
    return ok({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { ...MCP_SERVER_INFO },
      _meta: mcpServerInfoMeta(),
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: MCP_TOOLS });
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      return ok(mcpCallTool(name, args));
    } catch (err) {
      if (err instanceof McpError) return fail(err.code, err.message);
      return fail(-32603, (err as Error).message);
    }
  }
  return fail(-32601, `Method not found: ${method}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return true;
  }
  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonBody(body);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      const response = handleMcpRequest(entry);
      if (response !== null) results.push(response);
    }
    sendJson(res, 200, results);
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const response = handleMcpRequest(parsed);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  sendJson(res, 200, response);
  return true;
}

// -------------------------------------------------------------------------------------------
// Dispatcher and app factory
// -------------------------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const { pathname, query } = pathOf(req);
  let body: Buffer = Buffer.alloc(0);
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    body = await readBody(req);
  }
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'POST' && pathname === '/api/graphql') {
    await handleGraphql(req, res, body);
    return;
  }
  if (pathname === '/mcp') {
    await handleMcp(req, res, body);
    return;
  }
  if (pathname.startsWith('/api/')) {
    if (await handleRest(req, res, pathname, query, body)) return;
  }
  if (await handleGit(req, res, pathname, query, body)) return;
  sendError(res, 404, 'Not Found');
}

/** Build the forge's HTTP server. The caller binds it and registers with the env. */
export function createApp(): Server {
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      try {
        if (!res.headersSent) sendError(res, 500, (err as Error).message);
        else res.end();
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  return server;
}
