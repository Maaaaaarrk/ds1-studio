import { decodeCell, type Ds1, type TileCell, type WallCell } from './ds1';

/** Cells added (positive) or removed (negative) on each side of the map. */
export interface ResizeDelta {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const SUB = 5; // sub-tiles per cell

function emptyTile(): TileCell {
  return decodeCell(0);
}

function emptyWall(): WallCell {
  return { ...decodeCell(0), orientation: 0, orientationHigh: 0 };
}

/**
 * Grows or shrinks a map on any side. Cells, tags, objects, NPC paths and substitution groups keep their place relative
 * to the map content; anything pushed off the map is dropped.
 */
export function resizeDs1(ds1: Ds1, d: ResizeDelta): Ds1 {
  const width = ds1.width + d.left + d.right;
  const height = ds1.height + d.top + d.bottom;
  if (width < 1 || height < 1) throw new Error(`map would be ${width}x${height}`);

  const remap = <T>(cells: T[], empty: () => T): T[] => {
    const out: T[] = new Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const ox = x - d.left;
        const oy = y - d.top;
        out[y * width + x] = ox >= 0 && oy >= 0 && ox < ds1.width && oy < ds1.height ? cells[oy * ds1.width + ox] : empty();
      }
    return out;
  };

  const dx = d.left * SUB;
  const dy = d.top * SUB;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width * SUB && y < height * SUB;
  const objects = ds1.objects
    .map((o) => ({ ...o, x: o.x + dx, y: o.y + dy, path: o.path.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }))
    .filter((o) => inside(o.x, o.y))
    .map((o) => ({ ...o, path: o.path.filter((p) => inside(p.x, p.y)) }));
  const orphanPaths = ds1.orphanPaths
    .map((p) => ({ ...p, x: p.x + dx, y: p.y + dy, path: p.path.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy })) }))
    .filter((p) => inside(p.x, p.y));

  const groups = ds1.groups
    .map((g) => {
      const x0 = Math.max(g.x + d.left, 0);
      const y0 = Math.max(g.y + d.top, 0);
      const x1 = Math.min(g.x + d.left + g.width, width);
      const y1 = Math.min(g.y + d.top + g.height, height);
      return { ...g, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    })
    .filter((g) => g.width > 0 && g.height > 0);

  return {
    ...ds1,
    width,
    height,
    floors: ds1.floors.map((l) => remap(l, emptyTile)),
    walls: ds1.walls.map((l) => remap(l, emptyWall)),
    shadows: ds1.shadows.map((l) => remap(l, emptyTile)),
    tags: ds1.tags.map((t) => Uint32Array.from(remap(Array.from(t), () => 0))),
    objects,
    orphanPaths,
    groups,
  };
}

export interface NewMapOptions {
  width: number;
  height: number;
  act: number; // 0-based
  floorLayers: number; // 1-2
  wallLayers: number; // 1-4
  /** 0 = no tag layer; 1 or 2 = tag layer + substitution groups. */
  tagType: number;
  /** Embedded DT1 file list (informational; the game uses LvlTypes.txt). */
  files: string[];
}

/** A blank version-18 map. */
export function newDs1(o: NewMapOptions): Ds1 {
  const cells = o.width * o.height;
  const hasTag = o.tagType === 1 || o.tagType === 2;
  return {
    version: 18,
    width: o.width,
    height: o.height,
    act: o.act,
    actRaw: o.act,
    tagType: o.tagType,
    files: o.files,
    walls: Array.from({ length: o.wallLayers }, () => Array.from({ length: cells }, emptyWall)),
    floors: Array.from({ length: o.floorLayers }, () => Array.from({ length: cells }, emptyTile)),
    shadows: [Array.from({ length: cells }, emptyTile)],
    tags: hasTag ? [new Uint32Array(cells)] : [],
    objects: [],
    groups: [],
    groupsHeader: 0,
    orphanPaths: [],
    hasPathSection: true,
    trailing: 0,
  };
}

/** Embedded-file-list form of a DT1 path, as WinDS1 and the original tools write it. */
export function embeddedFileName(dt1Path: string): string {
  const rel = dt1Path.replace(/\\/g, '/').replace(/^.*?data\//i, 'data/');
  return `/d2/${rel.replace(/\.dt1$/i, '.tg1')}`;
}
