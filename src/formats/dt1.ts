import { BinaryReader } from '../util/BinaryReader';

/**
 * DT1 = Diablo II tile library. Each tile is made of 32px-wide blocks, either isometric
 * (32x15 diamonds, used by floors/roofs) or RLE-encoded (32x32, used by walls).
 */

export const enum Orientation {
  Floor = 0,
  LeftWall = 1,
  RightWall = 2,
  RightPartOfNorthCornerWall = 3,
  LeftPartOfNorthCornerWall = 4,
  LeftEndWall = 5,
  RightEndWall = 6,
  SouthCornerWall = 7,
  LeftWallWithDoor = 8,
  RightWallWithDoor = 9,
  SpecialTile1 = 10,
  SpecialTile2 = 11,
  PillarsColumnsAndStandaloneObjects = 12,
  Shadow = 13,
  Tree = 14,
  Roof = 15,
  LowerWallsEquivalentToLeftWall = 16,
  LowerWallsEquivalentToRightWall = 17,
  LowerWallsEquivalentToRightLeftNorthCornerWall = 18,
  LowerWallsEquivalentToSouthCornerwall = 19,
}

export function isLowerWall(o: number): boolean {
  return o >= 16;
}

export interface Dt1Block {
  x: number;
  y: number;
  gridX: number;
  gridY: number;
  format: number; // 1 = isometric, otherwise RLE
  data: Uint8Array;
}

export interface Dt1Tile {
  direction: number;
  roofHeight: number;
  soundIndex: number;
  animated: boolean;
  height: number;
  width: number;
  orientation: number;
  mainIndex: number;
  subIndex: number;
  rarity: number; // also the frame index for animated tiles
  /** 25 sub-tile flags, walkability etc. Index = y * 5 + x (bottom-up in the file, see DT1 docs). */
  subTileFlags: Uint8Array;
  blocks: Dt1Block[];
}

export interface Dt1 {
  version: [number, number];
  tiles: Dt1Tile[];
}

export function parseDt1(bytes: Uint8Array): Dt1 {
  const r = new BinaryReader(bytes);
  const v1 = r.i32();
  const v2 = r.i32();
  if (v1 !== 7 || v2 !== 6) throw new Error(`unsupported DT1 version ${v1}.${v2}`);
  r.skip(260);
  const count = r.i32();
  const headerPtr = r.i32();
  r.seek(headerPtr);

  const tiles: Dt1Tile[] = [];
  const blockInfo: { ptr: number; count: number }[] = [];
  for (let i = 0; i < count; i++) {
    const direction = r.i32();
    const roofHeight = r.i16();
    const soundIndex = r.u8();
    const animated = r.u8() !== 0;
    const height = r.i32();
    const width = r.i32();
    r.skip(4);
    const orientation = r.i32();
    const mainIndex = r.i32();
    const subIndex = r.i32();
    const rarity = r.i32();
    r.skip(4);
    const subTileFlags = r.bytesView(25).slice();
    r.skip(7);
    const blockPtr = r.i32();
    r.skip(4); // block data length
    const blockCount = r.i32();
    r.skip(12);
    tiles.push({
      direction, roofHeight, soundIndex, animated, height, width,
      orientation, mainIndex, subIndex, rarity, subTileFlags, blocks: [],
    });
    blockInfo.push({ ptr: blockPtr, count: blockCount });
  }

  for (let i = 0; i < count; i++) {
    const { ptr, count: n } = blockInfo[i];
    if (n <= 0 || ptr <= 0) continue;
    r.seek(ptr);
    const headers: { x: number; y: number; gridX: number; gridY: number; format: number; length: number; offset: number }[] = [];
    for (let b = 0; b < n; b++) {
      const x = r.i16();
      const y = r.i16();
      r.skip(2);
      const gridX = r.u8();
      const gridY = r.u8();
      const format = r.i16();
      const length = r.i32();
      r.skip(2);
      const offset = r.i32();
      headers.push({ x, y, gridX, gridY, format, length, offset });
    }
    tiles[i].blocks = headers.map((h) => ({
      x: h.x, y: h.y, gridX: h.gridX, gridY: h.gridY, format: h.format,
      data: bytes.subarray(ptr + h.offset, ptr + h.offset + h.length),
    }));
  }

  return { version: [v1, v2], tiles };
}

const ISO_X_JUMP = [14, 12, 10, 8, 6, 4, 2, 0, 2, 4, 6, 8, 10, 12, 14];
const ISO_PIXELS = [4, 8, 12, 16, 20, 24, 28, 32, 28, 24, 20, 16, 12, 8, 4];

/** An indexed-color image of a whole tile. Pixel value 0 = transparent. */
export interface TileImage {
  width: number;
  height: number;
  /** Offset of the image's top-left corner from the tile origin (the block coordinate space). */
  offsetX: number;
  offsetY: number;
  pixels: Uint8Array;
}

/** Decodes all blocks of a tile into one indexed image sized to the blocks' bounding box. */
export function decodeTile(tile: Dt1Tile): TileImage | null {
  if (tile.blocks.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of tile.blocks) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + 32);
    maxY = Math.max(maxY, b.y + (b.format === 1 ? 15 : 32));
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const pixels = new Uint8Array(width * height);

  for (const b of tile.blocks) {
    const ox = b.x - minX;
    const oy = b.y - minY;
    const d = b.data;
    if (b.format === 1) {
      // Isometric block: 15 rows forming a diamond.
      let p = 0;
      for (let row = 0; row < 15 && p < d.length; row++) {
        const n = ISO_PIXELS[row];
        const dst = (oy + row) * width + ox + ISO_X_JUMP[row];
        pixels.set(d.subarray(p, p + n), dst);
        p += n;
      }
    } else {
      // RLE block: pairs of (skip, count) followed by `count` pixels; (0,0) ends the row.
      let p = 0;
      let x = 0;
      let y = 0;
      while (p + 1 < d.length && y < 32) {
        const skip = d[p++];
        const n = d[p++];
        if (skip === 0 && n === 0) {
          x = 0;
          y++;
          continue;
        }
        x += skip;
        const dst = (oy + y) * width + ox + x;
        pixels.set(d.subarray(p, p + n), dst);
        p += n;
        x += n;
      }
    }
  }
  return { width, height, offsetX: minX, offsetY: minY, pixels };
}
