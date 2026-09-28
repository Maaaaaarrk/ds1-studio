/**
 * Diablo II string tables (.tbl: string.tbl, expansionstring.tbl, patchstring.tbl). The game looks strings up by key
 * through a hash table stored in the file, and by number (element order), so the element order of existing strings
 * must never change: new strings are appended.
 *
 * Layout (little-endian): a 21-byte header — CRC u16, element count u16, hash table size u32, version u8, offset of
 * the string data u32, max probes u32, file size u32 — then one u16 per element (the hash node that holds it), then
 * the hash nodes (17 bytes: used u8, element index u16, hash u32, key offset u32, value offset u32, value length u16),
 * then the NUL-terminated keys and values.
 */

export interface TblEntry {
  key: string;
  value: string;
}

export interface Tbl {
  entries: TblEntry[];
  hashSize: number;
  version: number;
  crc: number;
}

const HEADER = 21;
const NODE = 17;

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
const toBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** The game's key hash (checked against every key of the game's own tables). */
export function tblHash(key: string, size: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 4) + (key.charCodeAt(i) & 0xff)) >>> 0;
    const high = h & 0xf0000000;
    if (high) {
      h = (h ^ (high >>> 24)) >>> 0;
      h = (h & ~high) >>> 0;
    }
  }
  return h % size;
}

function cstr(b: Uint8Array, at: number): string {
  let end = at;
  while (end < b.length && b[end] !== 0) end++;
  return latin1(b.subarray(at, end));
}

export interface TblRaw {
  count: number;
  hashSize: number;
  maxTries: number;
  nodes: { used: number; index: number; hash: number; keyOff: number; valOff: number; len: number }[];
  order: number[];
}

export function parseTblRaw(b: Uint8Array): TblRaw {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = v.getUint16(2, true);
  const hashSize = v.getUint32(4, true);
  const maxTries = v.getUint32(13, true);
  const order = Array.from({ length: count }, (_, i) => v.getUint16(HEADER + i * 2, true));
  const base = HEADER + count * 2;
  const nodes = Array.from({ length: hashSize }, (_, i) => {
    const o = base + i * NODE;
    return { used: v.getUint8(o), index: v.getUint16(o + 1, true), hash: v.getUint32(o + 3, true), keyOff: v.getUint32(o + 7, true), valOff: v.getUint32(o + 11, true), len: v.getUint16(o + 15, true) };
  });
  return { count, hashSize, maxTries, nodes, order };
}

export function parseTbl(b: Uint8Array): Tbl {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const raw = parseTblRaw(b);
  const entries = raw.order.map((n) => {
    const node = raw.nodes[n];
    return { key: cstr(b, node.keyOff), value: cstr(b, node.valOff) };
  });
  return { entries, hashSize: raw.hashSize, version: v.getUint8(8), crc: v.getUint16(0, true) };
}

/** Finds a key the way the game does: hash, then the following slots up to max probes. */
export function tblLookup(b: Uint8Array, key: string): string | null {
  const raw = parseTblRaw(b);
  const want = tblHash(key, raw.hashSize);
  // The game probes at most `maxTries` slots (the stored value counts probes: the longest search + 1).
  for (let t = 0; t < raw.maxTries; t++) {
    const node = raw.nodes[(want + t) % raw.hashSize];
    if (!node.used) return null;
    if (cstr(b, node.keyOff) === key) return cstr(b, node.valOff);
  }
  return null;
}

/**
 * Writes a table: entries keep their order (the game also finds strings by number), each placed in its hash slot or
 * the next free one. The hash table keeps its size, growing only to fit every string (mods' tables are often packed
 * exactly full; the game probes up to the stored max tries).
 */
export function writeTbl(t: Tbl): Uint8Array {
  const n = t.entries.length;
  const size = Math.max(t.hashSize, n);
  const slot = new Array<number>(size).fill(-1);
  const nodeOf = new Array<number>(n);
  let maxTries = 0;
  t.entries.forEach((e, i) => {
    const h = tblHash(e.key, size);
    let tries = 0;
    while (slot[(h + tries) % size] !== -1) tries++;
    slot[(h + tries) % size] = i;
    nodeOf[i] = (h + tries) % size;
    // Stored as a count of probes (the game's own tables hold the longest search + 1): one less and the string
    // that needs the longest search is never found, and shows as an empty box in game.
    maxTries = Math.max(maxTries, tries + 1);
  });
  const stringsAt = HEADER + n * 2 + size * NODE;
  const parts: Uint8Array[] = [];
  let off = stringsAt;
  const keyOff: number[] = [];
  const valOff: number[] = [];
  for (const e of t.entries) {
    const k = toBytes(e.key);
    const val = toBytes(e.value);
    keyOff.push(off);
    parts.push(k, new Uint8Array(1));
    off += k.length + 1;
    valOff.push(off);
    parts.push(val, new Uint8Array(1));
    off += val.length + 1;
  }
  const out = new Uint8Array(off);
  const v = new DataView(out.buffer);
  v.setUint16(0, t.crc, true);
  v.setUint16(2, n, true);
  v.setUint32(4, size, true);
  v.setUint8(8, t.version);
  v.setUint32(9, stringsAt, true);
  v.setUint32(13, maxTries, true);
  v.setUint32(17, off, true);
  for (let i = 0; i < n; i++) v.setUint16(HEADER + i * 2, nodeOf[i], true);
  const base = HEADER + n * 2;
  for (let s = 0; s < size; s++) {
    const i = slot[s];
    if (i < 0) continue;
    const o = base + s * NODE;
    v.setUint8(o, 1);
    v.setUint16(o + 1, i, true);
    v.setUint32(o + 3, tblHash(t.entries[i].key, size), true);
    v.setUint32(o + 7, keyOff[i], true);
    v.setUint32(o + 11, valOff[i], true);
    v.setUint16(o + 15, toBytes(t.entries[i].value).length + 1, true);
  }
  let p = stringsAt;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  // The game checks this: a stale value makes D2Lang halt at start-up ("Unrecoverable internal error").
  v.setUint16(0, tblCrc(out), true);
  return out;
}

/**
 * The header's CRC: CRC-16/CCITT (polynomial 0x1021, initial value 0xFFFF, not reflected) over the string data, from
 * the header's string offset to the end. Reproduces the stored value of the game's three tables and of PD2's.
 */
export function tblCrc(b: Uint8Array): number {
  const start = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(9, true);
  let c = 0xffff;
  for (let i = start; i < b.length; i++) {
    c ^= b[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

/** Adds or changes strings (existing keys keep their number; new ones are appended). */
export function setTblStrings(t: Tbl, strings: Record<string, string>): Tbl {
  const entries = t.entries.map((e) => (e.key in strings ? { key: e.key, value: strings[e.key] } : e));
  for (const [key, value] of Object.entries(strings)) if (!t.entries.some((e) => e.key === key)) entries.push({ key, value });
  return { ...t, entries };
}
