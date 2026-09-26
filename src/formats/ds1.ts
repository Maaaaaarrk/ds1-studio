import { BinaryReader } from '../util/BinaryReader';

/**
 * DS1 = Diablo II map preset. A grid of tile cells (width x height), in several layers:
 * walls (+ their orientation), floors, one shadow layer and an optional tag (substitution) layer,
 * followed by objects, substitution groups and NPC paths.
 *
 * Format reference: Paul Siramy's WinDS1 sources / DS1 docs.
 */

/** A floor/wall/shadow cell, kept as its raw 32-bit value plus decoded fields. */
export interface TileCell {
  prop1: number; // byte 0: 0 = empty cell; otherwise used as a random seed/variation
  prop2: number; // byte 1: sub-index (low bits)
  prop3: number; // byte 2
  prop4: number; // byte 3
  /** DT1 "main index" (6 bits, from prop3 high nibble + prop4 low 2 bits). */
  mainIndex: number;
  /** DT1 "sub index". */
  subIndex: number;
  hidden: boolean;
}

export interface WallCell extends TileCell {
  /** DT1 orientation: 1-14 walls/specials, 15 roof, 16-19 lower walls. 0 = floor-like. */
  orientation: number;
}

export interface Ds1Object {
  type: number; // 1 = NPC/monster, 2 = object
  id: number;
  x: number; // sub-tile coordinates (5 per tile)
  y: number;
  flags: number;
  path: NpcPathPoint[];
}

export interface NpcPathPoint {
  x: number;
  y: number;
  action: number;
}

export interface SubstitutionGroup {
  x: number;
  y: number;
  width: number;
  height: number;
  unknown: number;
}

export interface Ds1 {
  version: number;
  width: number; // in tiles
  height: number;
  act: number; // 0-based (0..4)
  tagType: number; // 0 none, 1/2 = has a tag layer + substitution groups
  files: string[];
  /** walls[layer][y * width + x] */
  walls: WallCell[][];
  floors: TileCell[][];
  shadows: TileCell[][];
  tags: Uint32Array[];
  objects: Ds1Object[];
  groups: SubstitutionGroup[];
  /** Bytes after the last parsed section (should be empty for well-formed files). */
  trailing: number;
}

/** Orientation lookup for DS1 versions < 7, which used a different numbering. */
const OLD_ORIENTATION = [
  0x00, 0x01, 0x02, 0x01, 0x02, 0x03, 0x03, 0x05, 0x05, 0x06, 0x06, 0x07, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
  0x0f, 0x10, 0x11, 0x12, 0x14,
];

export function decodeCell(v: number): TileCell {
  const prop1 = v & 0xff;
  const prop2 = (v >>> 8) & 0xff;
  const prop3 = (v >>> 16) & 0xff;
  const prop4 = (v >>> 24) & 0xff;
  return {
    prop1,
    prop2,
    prop3,
    prop4,
    mainIndex: (prop3 >> 4) | ((prop4 & 0x03) << 4),
    subIndex: prop2,
    hidden: (prop4 & 0x80) !== 0,
  };
}

/** True when a cell holds no tile. */
export function isEmptyCell(c: TileCell): boolean {
  return c.prop1 === 0;
}

const enum Stream {
  Wall = 1, // + layer (1..4)
  Orientation = 5, // + layer (5..8)
  Floor = 9, // + layer (9..10)
  Shadow = 11,
  Tag = 12,
}

export function parseDs1(bytes: Uint8Array): Ds1 {
  const r = new BinaryReader(bytes);
  const version = r.i32();
  const width = r.i32() + 1;
  const height = r.i32() + 1;
  if (version < 1 || version > 18) throw new Error(`unsupported DS1 version ${version}`);
  if (width <= 0 || height <= 0 || width * height > 1 << 22) throw new Error(`bad DS1 size ${width}x${height}`);

  let act = 0;
  if (version >= 8) act = Math.min(Math.max(r.i32(), 0), 4);

  let tagType = 0;
  if (version >= 10) tagType = r.i32();

  const files: string[] = [];
  if (version >= 3) {
    const n = r.i32();
    for (let i = 0; i < n; i++) files.push(r.cstring());
  }

  if (version >= 9 && version <= 13) r.skip(8);

  let wallLayers = 1;
  let floorLayers = 1;
  const hasTag = tagType === 1 || tagType === 2;
  if (version >= 4) {
    wallLayers = r.i32();
    if (version >= 16) floorLayers = r.i32();
  }
  if (wallLayers < 0 || wallLayers > 4 || floorLayers < 0 || floorLayers > 2) {
    throw new Error(`bad DS1 layer counts (walls=${wallLayers}, floors=${floorLayers})`);
  }

  const streams: number[] = [];
  if (version < 4) {
    streams.push(Stream.Wall, Stream.Floor, Stream.Orientation, Stream.Tag, Stream.Shadow);
  } else {
    for (let i = 0; i < wallLayers; i++) streams.push(Stream.Wall + i, Stream.Orientation + i);
    for (let i = 0; i < floorLayers; i++) streams.push(Stream.Floor + i);
    streams.push(Stream.Shadow);
    if (hasTag) streams.push(Stream.Tag);
  }

  const cells = width * height;
  const wallRaw: Uint32Array[] = [];
  const orientRaw: Uint32Array[] = [];
  const floors: TileCell[][] = [];
  const shadows: TileCell[][] = [];
  const tags: Uint32Array[] = [];

  for (const s of streams) {
    const raw = new Uint32Array(cells);
    for (let i = 0; i < cells; i++) raw[i] = r.u32();
    if (s >= Stream.Wall && s < Stream.Orientation) wallRaw[s - Stream.Wall] = raw;
    else if (s >= Stream.Orientation && s < Stream.Floor) orientRaw[s - Stream.Orientation] = raw;
    else if (s === Stream.Floor || s === Stream.Floor + 1) floors.push(Array.from(raw, decodeCell));
    else if (s === Stream.Shadow) shadows.push(Array.from(raw, decodeCell));
    else if (s === Stream.Tag) tags.push(raw);
  }

  const walls: WallCell[][] = wallRaw.map((raw, layer) =>
    Array.from(raw, (v, i) => {
      let orientation = orientRaw[layer] ? orientRaw[layer][i] & 0xff : 0;
      if (version < 7) orientation = OLD_ORIENTATION[orientation] ?? orientation;
      return { ...decodeCell(v), orientation };
    }),
  );

  const objects: Ds1Object[] = [];
  if (version >= 2) {
    const n = r.i32();
    for (let i = 0; i < n; i++) {
      const type = r.i32();
      const id = r.i32();
      const x = r.i32();
      const y = r.i32();
      const flags = version > 5 ? r.i32() : 0;
      objects.push({ type, id, x, y, flags, path: [] });
    }
  }

  const groups: SubstitutionGroup[] = [];
  if (version >= 12 && hasTag && r.remaining > 0) {
    if (version >= 18) r.skip(4);
    const n = r.i32();
    for (let i = 0; i < n && r.remaining >= 16; i++) {
      const g = { x: r.i32(), y: r.i32(), width: r.i32(), height: r.i32(), unknown: 0 };
      if (version >= 13) g.unknown = r.i32();
      groups.push(g);
    }
  }

  if (version >= 14 && r.remaining >= 4) {
    const n = r.i32();
    for (let i = 0; i < n; i++) {
      const points = r.i32();
      const x = r.i32();
      const y = r.i32();
      const path: NpcPathPoint[] = [];
      for (let p = 0; p < points; p++) {
        path.push({ x: r.i32(), y: r.i32(), action: version >= 15 ? r.i32() : 1 });
      }
      // Paths are attached to the object standing at (x, y).
      const owner = objects.find((o) => o.x === x && o.y === y);
      if (owner) owner.path = path;
    }
  }

  return { version, width, height, act, tagType, files, walls, floors, shadows, tags, objects, groups, trailing: r.remaining };
}

/** Converts a DS1 embedded file reference ("/d2/data/global/tiles/act1/town/floor.tg1") to a DT1 path. */
export function ds1FileToDt1Path(file: string): string | null {
  const m = /data[\\/].*$/i.exec(file);
  if (!m) return null;
  return m[0].replace(/\.[a-z0-9]+$/i, '.dt1').replace(/\\/g, '/');
}
