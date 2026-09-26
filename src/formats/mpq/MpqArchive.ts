import { unzlibSync } from 'fflate';
import type { RandomAccess } from '../../util/RandomAccess';
import { decryptBlock, hashString, HashType } from './crypto';
import { explode } from './explode';

const MPQ_MAGIC = 0x1a51504d; // 'MPQ\x1A'
const MPQ_USERDATA_MAGIC = 0x1b51504d; // 'MPQ\x1B'

const FLAG_IMPLODE = 0x00000100;
const FLAG_COMPRESS = 0x00000200;
const FLAG_ENCRYPTED = 0x00010000;
const FLAG_FIX_KEY = 0x00020000;
const FLAG_SINGLE_UNIT = 0x01000000;
const FLAG_SECTOR_CRC = 0x04000000;
const FLAG_EXISTS = 0x80000000;

const HASH_EMPTY = 0xffffffff;
const HASH_DELETED = 0xfffffffe;

const COMP_HUFFMAN = 0x01;
const COMP_ZLIB = 0x02;
const COMP_PKWARE = 0x08;
const COMP_BZIP2 = 0x10;

interface HashEntry {
  nameA: number;
  nameB: number;
  locale: number;
  blockIndex: number;
}

interface BlockEntry {
  offset: number; // absolute file offset
  relOffset: number; // offset relative to the MPQ header (used for FIX_KEY)
  compressedSize: number;
  fileSize: number;
  flags: number;
}

/** Read-only MPQ (format v0, as used by Diablo II) archive. */
export class MpqArchive {
  private constructor(
    readonly name: string,
    private readonly src: RandomAccess,
    private readonly sectorSize: number,
    private readonly hashTable: HashEntry[],
    private readonly blockTable: BlockEntry[],
  ) {}

  static async open(name: string, src: RandomAccess): Promise<MpqArchive> {
    const base = await findHeader(src);
    const h = new DataView((await src.read(base, 32)).buffer);
    const sectorShift = h.getUint16(14, true);
    const hashOffset = base + h.getUint32(16, true);
    const blockOffset = base + h.getUint32(20, true);
    const hashCount = h.getUint32(24, true);
    // Some "protected" mod archives lie about the block count; clamp to what fits in the file.
    const blockCount = Math.min(h.getUint32(28, true), Math.floor((src.size - blockOffset) / 16));

    const hashBytes = await src.read(hashOffset, hashCount * 16);
    decryptBlock(hashBytes, hashString('(hash table)', HashType.FileKey));
    const hv = new DataView(hashBytes.buffer);
    const hashTable: HashEntry[] = new Array(hashCount);
    for (let i = 0; i < hashCount; i++) {
      hashTable[i] = {
        nameA: hv.getUint32(i * 16, true),
        nameB: hv.getUint32(i * 16 + 4, true),
        locale: hv.getUint16(i * 16 + 8, true),
        blockIndex: hv.getUint32(i * 16 + 12, true),
      };
    }

    const blockBytes = await src.read(blockOffset, blockCount * 16);
    decryptBlock(blockBytes, hashString('(block table)', HashType.FileKey));
    const bv = new DataView(blockBytes.buffer);
    const blockTable: BlockEntry[] = new Array(blockCount);
    for (let i = 0; i < blockCount; i++) {
      blockTable[i] = {
        offset: base + bv.getUint32(i * 16, true),
        relOffset: bv.getUint32(i * 16, true),
        compressedSize: bv.getUint32(i * 16 + 4, true),
        fileSize: bv.getUint32(i * 16 + 8, true),
        flags: bv.getUint32(i * 16 + 12, true),
      };
    }

    return new MpqArchive(name, src, 512 << sectorShift, hashTable, blockTable);
  }

  private findBlock(path: string): BlockEntry | null {
    const n = this.hashTable.length;
    if (n === 0) return null;
    const name = normalizeMpqPath(path);
    const start = hashString(name, HashType.TableOffset) % n;
    const a = hashString(name, HashType.NameA);
    const b = hashString(name, HashType.NameB);
    let fallback: BlockEntry | null = null;
    for (let i = 0; i < n; i++) {
      const e = this.hashTable[(start + i) % n];
      if (e.blockIndex === HASH_EMPTY) break;
      if (e.blockIndex === HASH_DELETED || e.nameA !== a || e.nameB !== b) continue;
      const block = this.blockTable[e.blockIndex];
      if (!block || !(block.flags & FLAG_EXISTS)) continue;
      if (e.locale === 0) return block; // prefer neutral locale
      fallback ??= block;
    }
    return fallback;
  }

  has(path: string): boolean {
    return this.findBlock(path) !== null;
  }

  /** Reads and decompresses a file, or returns null if it is not in the archive. */
  async read(path: string): Promise<Uint8Array | null> {
    const block = this.findBlock(path);
    if (!block) return null;
    const name = normalizeMpqPath(path);

    let key = 0;
    if (block.flags & FLAG_ENCRYPTED) {
      const base = name.slice(name.lastIndexOf('\\') + 1);
      key = hashString(base, HashType.FileKey);
      if (block.flags & FLAG_FIX_KEY) key = ((key + block.relOffset) ^ block.fileSize) >>> 0;
    }

    const raw = await this.src.read(block.offset, block.compressedSize);
    const packed = (block.flags & (FLAG_IMPLODE | FLAG_COMPRESS)) !== 0;

    if (block.flags & FLAG_SINGLE_UNIT) {
      if (block.flags & FLAG_ENCRYPTED) decryptBlock(raw, key);
      return packed && block.compressedSize < block.fileSize
        ? decompressSector(raw, block.fileSize, block.flags)
        : raw.subarray(0, block.fileSize);
    }

    const sectorCount = Math.ceil(block.fileSize / this.sectorSize);
    const out = new Uint8Array(block.fileSize);

    if (!packed) {
      for (let i = 0; i < sectorCount; i++) {
        const start = i * this.sectorSize;
        const sector = raw.subarray(start, Math.min(start + this.sectorSize, block.fileSize));
        if (block.flags & FLAG_ENCRYPTED) decryptBlock(sector, (key + i) >>> 0);
        out.set(sector, start);
      }
      return out;
    }

    const tableEntries = sectorCount + 1 + (block.flags & FLAG_SECTOR_CRC ? 1 : 0);
    const table = raw.slice(0, tableEntries * 4);
    if (block.flags & FLAG_ENCRYPTED) decryptBlock(table, (key - 1) >>> 0);
    const tv = new DataView(table.buffer);

    for (let i = 0; i < sectorCount; i++) {
      const s0 = tv.getUint32(i * 4, true);
      const s1 = tv.getUint32(i * 4 + 4, true);
      if (s1 < s0 || s1 > raw.length) throw new Error(`${this.name}:${path}: corrupt sector table`);
      const sector = raw.slice(s0, s1);
      if (block.flags & FLAG_ENCRYPTED) decryptBlock(sector, (key + i) >>> 0);
      const expected = Math.min(this.sectorSize, block.fileSize - i * this.sectorSize);
      const data = sector.length < expected ? decompressSector(sector, expected, block.flags) : sector;
      out.set(data.subarray(0, expected), i * this.sectorSize);
    }
    return out;
  }
}

export function normalizeMpqPath(path: string): string {
  return path.replace(/\//g, '\\').replace(/^\\+/, '');
}

async function findHeader(src: RandomAccess): Promise<number> {
  for (let off = 0; off + 32 <= src.size; off += 512) {
    const v = new DataView((await src.read(off, 16)).buffer);
    const magic = v.getUint32(0, true);
    if (magic === MPQ_MAGIC) return off;
    if (magic === MPQ_USERDATA_MAGIC) return off + v.getUint32(8, true);
    if (off > 64 * 1024 * 1024) break;
  }
  throw new Error('not an MPQ archive (header not found)');
}

function decompressSector(data: Uint8Array, expected: number, flags: number): Uint8Array {
  if (flags & FLAG_IMPLODE) return explode(data, expected);

  const mask = data[0];
  let buf = data.subarray(1);
  if (mask & ~(COMP_ZLIB | COMP_PKWARE)) {
    const what = mask & COMP_BZIP2 ? 'bzip2' : mask & COMP_HUFFMAN ? 'huffman' : `0x${mask.toString(16)}`;
    throw new Error(`unsupported MPQ compression (${what})`);
  }
  // Decompression runs in the reverse order of compression: zlib/bzip2 were applied last.
  if (mask & COMP_ZLIB) buf = unzlibSync(buf);
  if (mask & COMP_PKWARE) buf = explode(buf, expected);
  return buf;
}
