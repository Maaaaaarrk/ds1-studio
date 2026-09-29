/**
 * Writing DT1 files from tile records. A tile is stored as a 96-byte header plus its own region of block headers and
 * pixel data (the block headers' offsets are relative to that region), so a tile copies between files byte for byte:
 * only its region pointer changes. Layout: see parseDt1.
 */

import { parseDt1 } from './dt1';
export const DT1_HEADER_SIZE = 276;
export const DT1_TILE_HEADER_SIZE = 96;

/** Byte offsets inside a tile header. */
const H = { direction: 0, roofHeight: 4, sound: 6, animated: 7, height: 8, width: 12, orientation: 20, main: 24, sub: 28, rarity: 32, reserved: 36, flags: 40, blockPtr: 72, blockLength: 76, blockCount: 80 } as const;

/** A tile as a DT1 stores it: its header and its block region (block headers + pixel data). */
export interface Dt1Record {
  header: Uint8Array;
  blocks: Uint8Array;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Every tile of a DT1 as a record, in file order. */
export function dt1Records(bytes: Uint8Array): Dt1Record[] {
  parseDt1(bytes); // Refuse truncated records before a rewrite can silently discard their pixel data.
  const v = view(bytes);
  const count = v.getInt32(268, true);
  const headerPtr = v.getInt32(272, true);
  const out: Dt1Record[] = [];
  for (let i = 0; i < count; i++) {
    const at = headerPtr + i * DT1_TILE_HEADER_SIZE;
    const header = bytes.slice(at, at + DT1_TILE_HEADER_SIZE);
    const h = view(header);
    const ptr = h.getInt32(H.blockPtr, true);
    const length = h.getInt32(H.blockLength, true);
    out.push({ header, blocks: h.getInt32(H.blockCount, true) > 0 && ptr > 0 ? bytes.slice(ptr, ptr + length) : new Uint8Array(0) });
  }
  return out;
}

/** The record's key and flags. */
export function recordInfo(r: Dt1Record): { orientation: number; main: number; sub: number; flags: Uint8Array } {
  const h = view(r.header);
  return { orientation: h.getInt32(H.orientation, true), main: h.getInt32(H.main, true), sub: h.getInt32(H.sub, true), flags: r.header.slice(H.flags, H.flags + 25) };
}

/** A copy of a record with a new main and/or sub index and/or sub-tile flags (25 bytes, file order). */
export function changedRecord(r: Dt1Record, change: { main?: number; sub?: number; flags?: Uint8Array }): Dt1Record {
  const header = r.header.slice();
  const h = view(header);
  if (change.main !== undefined) h.setInt32(H.main, change.main, true);
  if (change.sub !== undefined) h.setInt32(H.sub, change.sub, true);
  if (change.flags) header.set(change.flags.subarray(0, 25), H.flags);
  return { header, blocks: r.blocks.slice() };
}

/**
 * A tile with no graphics, only sub-tile flags: an invisible floor tile that blocks what its flags say. The game has
 * its own (Tal Rasha's tomb: floor tiles with no blocks and every sub-tile "block walk"); this copies their header.
 */
export function blockerRecord(main: number, sub: number, flags: Uint8Array): Dt1Record {
  const header = new Uint8Array(DT1_TILE_HEADER_SIZE);
  const h = view(header);
  h.setInt32(H.direction, 3, true);
  header[H.sound] = 1;
  h.setInt32(H.height, -128, true);
  h.setInt32(H.width, 160, true);
  h.setInt32(H.orientation, 0, true);
  h.setInt32(H.main, main, true);
  h.setInt32(H.sub, sub, true);
  header.set([0xff, 0x00, 0xff, 0x00], H.reserved);
  header.set(flags.subarray(0, 25), H.flags);
  return { header, blocks: new Uint8Array(0) };
}

/** A DT1 (version 7.6) holding these tiles. */
export function buildDt1(records: Dt1Record[]): Uint8Array {
  const regions = records.reduce((n, r) => n + r.blocks.length, 0);
  const out = new Uint8Array(DT1_HEADER_SIZE + records.length * DT1_TILE_HEADER_SIZE + regions);
  const v = view(out);
  v.setInt32(0, 7, true);
  v.setInt32(4, 6, true);
  v.setInt32(268, records.length, true);
  v.setInt32(272, DT1_HEADER_SIZE, true);
  let data = DT1_HEADER_SIZE + records.length * DT1_TILE_HEADER_SIZE;
  records.forEach((r, i) => {
    const at = DT1_HEADER_SIZE + i * DT1_TILE_HEADER_SIZE;
    out.set(r.header, at);
    // Tiles without blocks point just past the headers, as the game's own files do.
    v.setInt32(at + H.blockPtr, data, true);
    v.setInt32(at + H.blockLength, r.blocks.length, true);
    out.set(r.blocks, data);
    data += r.blocks.length;
  });
  return out;
}
