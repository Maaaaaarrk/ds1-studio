import { decodeRleBlock, encodeRleBlock } from './dt1Paint';
import { recordInfo, type Dt1Record } from './dt1Write';

/**
 * Tile-level DT1 operations on records (see dt1Write.ts): cloning a tile under a free number, mirroring it, and
 * rebuilding a wall tile's blocks from a whole picture.
 *
 * A record's block region holds `blockCount` 20-byte block headers, then the block data; each header: +0 i16 x,
 * +2 i16 y, +4 i16 (kept), +6 u8 gridX, +7 u8 gridY, +8 i16 format, +10 i32 length, +14 i16 (kept), +16 i32 offset
 * (from the start of the region). Format 1 blocks are 15-row 32-pixel isometric diamonds (floors, roofs); the others
 * are RLE (walls: 32 rows; floor RLE 0x2005: 15).
 *
 * Mirroring flips a tile left to right inside the game's 160-pixel cell: a block at x goes to 128 - x with its pixels
 * reversed. For floor and roof diamonds that also swaps the block's grid x and y (the 5x5 sub-tile grid is
 * transposed, as a horizontal flip of an isometric cell does); the sub-tile flags are transposed the same way; a wall
 * turns to face the other way (left <-> right, as WinDS1's orientation pairs).
 */

const H = { width: 12, orientation: 20, main: 24, sub: 28, flags: 40, blockCount: 80 } as const;
const ISO_PIXELS = [4, 8, 12, 16, 20, 24, 28, 32, 28, 24, 20, 16, 12, 8, 4];
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export interface RawBlock {
  x: number;
  y: number;
  unk4: number;
  gridX: number;
  gridY: number;
  format: number;
  unk14: number;
  data: Uint8Array;
}

export function readBlocks(r: Dt1Record): RawBlock[] {
  const count = view(r.header).getInt32(H.blockCount, true);
  if (!count || !r.blocks.length) return [];
  const v = view(r.blocks);
  const out: RawBlock[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * 20;
    const length = v.getInt32(o + 10, true);
    const offset = v.getInt32(o + 16, true);
    out.push({ x: v.getInt16(o, true), y: v.getInt16(o + 2, true), unk4: v.getInt16(o + 4, true), gridX: r.blocks[o + 6], gridY: r.blocks[o + 7], format: v.getInt16(o + 8, true), unk14: v.getInt16(o + 14, true), data: r.blocks.slice(offset, offset + length) });
  }
  return out;
}

/** The record with these blocks (block count and width updated; the rest of the header kept). */
export function withBlocks(r: Dt1Record, blocks: RawBlock[]): Dt1Record {
  const data = blocks.reduce((n, b) => n + b.data.length, 0);
  const region = new Uint8Array(blocks.length * 20 + data);
  const v = view(region);
  let at = blocks.length * 20;
  blocks.forEach((b, i) => {
    const o = i * 20;
    v.setInt16(o, b.x, true);
    v.setInt16(o + 2, b.y, true);
    v.setInt16(o + 4, b.unk4, true);
    region[o + 6] = b.gridX;
    region[o + 7] = b.gridY;
    v.setInt16(o + 8, b.format, true);
    v.setInt32(o + 10, b.data.length, true);
    v.setInt16(o + 14, b.unk14, true);
    v.setInt32(o + 16, at, true);
    region.set(b.data, at);
    at += b.data.length;
  });
  const header = r.header.slice();
  view(header).setInt32(H.blockCount, blocks.length, true);
  if (blocks.length) view(header).setInt32(H.width, Math.max(...blocks.map((b) => b.x + 32)), true);
  return { header, blocks: region };
}

/** Wall orientations that face the other way when mirrored (WinDS1's pairs); others stay. */
export const MIRROR_ORIENTATION: Record<number, number> = { 1: 2, 2: 1, 3: 4, 4: 3, 6: 7, 7: 6, 8: 9, 9: 8, 10: 11, 11: 10, 16: 17, 17: 16 };

/** Sub-tile flags (25 bytes, file order) of the mirrored tile: the 5x5 grid transposed. */
export function mirrorFlags(flags: Uint8Array): Uint8Array {
  // File order is the overlay grid upside down (see walkEdit fileIndex): row r of the file = overlay row 4 - r.
  const at = (row: number, col: number) => (4 - row) * 5 + col;
  const out = new Uint8Array(25);
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) out[at(col, row)] = flags[at(row, col)];
  return out;
}

function mirrorBlock(b: RawBlock): RawBlock {
  const x = 128 - b.x;
  if (b.format === 1) {
    const data = b.data.slice();
    let p = 0;
    for (let row = 0; row < 15; row++) {
      const n = ISO_PIXELS[row];
      data.set(b.data.slice(p, p + n).reverse(), p);
      p += n;
    }
    return { ...b, x, gridX: b.gridY, gridY: b.gridX, data };
  }
  const { pixels, rows } = decodeRleBlock(b.data);
  const flipped = new Uint8Array(32 * 32);
  for (let y = 0; y < 32; y++) for (let xx = 0; xx < 32; xx++) flipped[y * 32 + (31 - xx)] = pixels[y * 32 + xx];
  return { ...b, x, data: encodeRleBlock(flipped, rows) };
}

/** The tile mirrored left to right: pixels, sub-tile flags and (for walls) the way it faces. */
export function mirrorRecord(r: Dt1Record): Dt1Record {
  const out = withBlocks(r, readBlocks(r).map(mirrorBlock));
  const h = view(out.header);
  const o = h.getInt32(H.orientation, true);
  if (MIRROR_ORIENTATION[o] !== undefined) h.setInt32(H.orientation, MIRROR_ORIENTATION[o], true);
  out.header.set(mirrorFlags(r.header.slice(H.flags, H.flags + 25)), H.flags);
  return out;
}

/** The north-corner wall's other half (orientations 3 and 4 share their main/sub and are placed together). */
export const cornerPartner = (o: number) => (o === 3 ? 4 : o === 4 ? 3 : null);

/** The lowest sub index free for (orientation, main) among `records` (for a corner: free for both halves). */
export function freeSub(records: Dt1Record[], orientation: number, main: number): number {
  const keys = new Set(records.map((r) => recordInfo(r)).map((i) => `${i.orientation}|${i.main}|${i.sub}`));
  const os = [orientation, ...(cornerPartner(orientation) !== null ? [cornerPartner(orientation)!] : [])];
  for (let s = 0; s < 256; s++) if (os.every((o) => !keys.has(`${o}|${main}|${s}`))) return s;
  return -1;
}

/**
 * Rebuilds a wall-type tile (all RLE blocks) from a picture covering its decodeTile area (origin = the area's top
 * left in tile coordinates): a 32x32 block for every grid cell holding a pixel, so the picture may have any shape.
 */
export function rebuildRleRecord(r: Dt1Record, img: { width: number; height: number; offsetX: number; offsetY: number; pixels: Uint8Array }): Dt1Record {
  const old = readBlocks(r);
  if (old.some((b) => b.format === 1)) throw new Error('Floor and roof diamonds keep their shape: paint inside them instead.');
  const format = old[0]?.format ?? 0x1001;
  const minRows = format === 0x1001 ? 32 : 15;
  const blocks: RawBlock[] = [];
  for (let by = 0; by < img.height; by += 32)
    for (let bx = 0; bx < img.width; bx += 32) {
      const px = new Uint8Array(32 * 32);
      let any = false;
      for (let y = 0; y < 32 && by + y < img.height; y++)
        for (let x = 0; x < 32 && bx + x < img.width; x++) {
          const c = img.pixels[(by + y) * img.width + bx + x];
          if (c) (px[y * 32 + x] = c), (any = true);
        }
      if (any) blocks.push({ x: img.offsetX + bx, y: img.offsetY + by, unk4: 0, gridX: 0, gridY: 0, format, unk14: 0, data: encodeRleBlock(px, minRows) });
    }
  return withBlocks(r, blocks);
}
