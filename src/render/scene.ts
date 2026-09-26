import { isEmptyCell, type Ds1 } from '../formats/ds1';
import { decodeTile, isLowerWall, Orientation, type Dt1Tile } from '../formats/dt1';
import type { TileLibrary } from '../game/GameData';

/** Size of one DS1 cell on screen: a 160x80 isometric diamond. */
export const TILE_W = 160;
export const TILE_H = 80;

export type DrawKind = 'floor' | 'shadow' | 'lowerWall' | 'wall' | 'roof' | 'special';

export interface DrawItem {
  tile: Dt1Tile;
  kind: DrawKind;
  /** Source layer index within its kind (floor 0-1, wall 0-3). */
  layer: number;
  cellX: number;
  cellY: number;
  /** World-space position of the tile's block origin (add the decoded image's offset to get its top-left). */
  x: number;
  y: number;
  /** Animation frames (animated floors), ordered by frame index; `tile` is frame 0. */
  frames?: Dt1Tile[];
}

export interface MissingTile {
  kind: DrawKind;
  layer: number;
  cellX: number;
  cellY: number;
  orientation: number;
  main: number;
  sub: number;
}

export interface Scene {
  items: DrawItem[];
  missing: MissingTile[];
  /** Special tiles (orientation 10/11) with no graphic available, drawn as markers. */
  unmarkedSpecials: { cellX: number; cellY: number; main: number; sub: number }[];
  animated: boolean;
  /** World-space bounds of the map's diamond grid. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Top vertex of cell (x, y)'s diamond in world space. */
export function cellToWorld(x: number, y: number): [number, number] {
  return [(x - y) * (TILE_W / 2), (x + y) * (TILE_H / 2)];
}

/** Inverse of cellToWorld (fractional cell coordinates). */
export function worldToCell(wx: number, wy: number): [number, number] {
  const a = wx / (TILE_W / 2);
  const b = wy / (TILE_H / 2);
  return [(a + b) / 2, (b - a) / 2];
}

/** Centre of sub-tile (sx, sy) in world space (5x5 sub-tiles per cell; objects and NPC paths use these). */
export function subTileToWorld(sx: number, sy: number): [number, number] {
  return [(sx - sy) * (TILE_W / 10), (sx + sy) * (TILE_H / 10) + TILE_H / 10];
}

/** Inverse of subTileToWorld (fractional). */
export function worldToSubTile(wx: number, wy: number): [number, number] {
  const a = wx / (TILE_W / 10);
  const b = (wy - TILE_H / 10) / (TILE_H / 10);
  return [(a + b) / 2, (b - a) / 2];
}

/** World position of a tile's block origin when placed in cell (cx, cy). */
export function placeTile(tile: Dt1Tile, cx: number, cy: number): [number, number] {
  const [px, py] = cellToWorld(cx, cy);
  // Blocks are relative to the diamond's left corner; walls/shadows hang from its bottom vertex; roofs float above.
  const yAdjust = tile.orientation === Orientation.Floor ? 0 : tile.orientation === Orientation.Roof ? -tile.roofHeight : TILE_H;
  return [px - TILE_W / 2, py + yAdjust];
}

const isSpecial = (o: number) => o === Orientation.SpecialTile1 || o === Orientation.SpecialTile2;

type WallBucket = 'lowerWall' | 'wall' | 'roof' | 'special';

/**
 * Resolves every cell to positioned tiles in draw order, matching WinDS1 and the game:
 * lower walls, floors, shadows, then upright walls back to front, roofs, and editor-only special tiles last.
 */
export function buildScene(ds1: Ds1, lib: TileLibrary): Scene {
  const items: DrawItem[] = [];
  const missing: MissingTile[] = [];
  const unmarkedSpecials: Scene['unmarkedSpecials'] = [];
  const { width, height } = ds1;
  let animated = false;

  const add = (kind: DrawKind, layer: number, cx: number, cy: number, orientation: number, main: number, sub: number, seed: number) => {
    const tile = lib.pick(orientation, main, sub, seed);
    if (!tile) {
      if (kind === 'special') unmarkedSpecials.push({ cellX: cx, cellY: cy, main, sub });
      // Main index 30/31 floors are the game's "blank" void filler (act1/outdoors/blank.dt1); absent = draw nothing.
      else if (!(orientation === Orientation.Floor && main >= 30)) missing.push({ kind, layer, cellX: cx, cellY: cy, orientation, main, sub });
      return;
    }
    const [x, y] = placeTile(tile, cx, cy);
    const item: DrawItem = { tile, kind, layer, cellX: cx, cellY: cy, x, y };
    if (tile.animated) {
      const frames = lib.frames(orientation, main, sub);
      if (frames.length > 1) {
        item.frames = frames;
        animated = true;
      }
    }
    items.push(item);
    if (kind === 'special') {
      const label = lib.label(orientation, main, sub);
      if (label && label !== tile) items.push({ tile: label, kind, layer, cellX: cx, cellY: cy, x: placeTile(label, cx, cy)[0], y: placeTile(label, cx, cy)[1] });
    }
    // A north-corner wall is drawn as two tiles: orientation 3 plus its orientation-4 partner.
    if (orientation === Orientation.RightPartOfNorthCornerWall) {
      const partner = lib.pick(Orientation.LeftPartOfNorthCornerWall, main, sub, seed);
      if (partner) {
        const [px, py] = placeTile(partner, cx, cy);
        items.push({ tile: partner, kind, layer, cellX: cx, cellY: cy, x: px, y: py });
      }
    }
  };
  const seedOf = (cx: number, cy: number, layer: number) => (cy * width + cx) * 8 + layer;

  // Wall cells in isometric depth order (back to front), bucketed by kind.
  const buckets: Record<WallBucket, [number, number, number][]> = { lowerWall: [], wall: [], roof: [], special: [] };
  for (let d = 0; d < width + height - 1; d++) {
    for (let cy = Math.max(0, d - width + 1); cy <= Math.min(d, height - 1); cy++) {
      const cx = d - cy;
      for (let layer = 0; layer < ds1.walls.length; layer++) {
        const c = ds1.walls[layer][cy * width + cx];
        if (isEmptyCell(c)) continue;
        const o = c.orientation;
        // Hidden tiles are not drawn by the game; special tiles are editor markers and always shown.
        if (isSpecial(o)) buckets.special.push([layer, cx, cy]);
        else if (!c.hidden) buckets[o === Orientation.Roof ? 'roof' : isLowerWall(o) ? 'lowerWall' : 'wall'].push([layer, cx, cy]);
      }
    }
  }
  const addWalls = (kind: WallBucket) => {
    for (const [layer, cx, cy] of buckets[kind]) {
      const c = ds1.walls[layer][cy * width + cx];
      add(kind, layer, cx, cy, c.orientation, c.mainIndex, c.subIndex, seedOf(cx, cy, layer + 5));
    }
  };
  const addGround = (kind: 'floor' | 'shadow', layers: Ds1['floors'], orientation: number, seedLayer: (l: number) => number) => {
    layers.forEach((cells, layer) => {
      for (let cy = 0; cy < height; cy++)
        for (let cx = 0; cx < width; cx++) {
          const c = cells[cy * width + cx];
          if (!isEmptyCell(c) && !c.hidden) add(kind, layer, cx, cy, orientation, c.mainIndex, c.subIndex, seedOf(cx, cy, seedLayer(layer)));
        }
    });
  };

  addWalls('lowerWall');
  addGround('floor', ds1.floors, Orientation.Floor, (l) => l);
  addGround('shadow', ds1.shadows, Orientation.Shadow, () => 4);
  addWalls('wall');
  addWalls('roof');
  addWalls('special');

  const [lx] = cellToWorld(0, height);
  const [rx] = cellToWorld(width, 0);
  const [, by] = cellToWorld(width, height);
  return { items, missing, unmarkedSpecials, animated, bounds: { minX: lx, minY: 0, maxX: rx, maxY: by } };
}

/** Sub-tile flag bits (DT1). */
export const SubTileFlag = {
  BlockWalk: 0x01,
  BlockLight: 0x02,
  BlockJump: 0x04,
  BlockPlayerWalk: 0x08,
} as const;

/**
 * Combined sub-tile flags per cell, like WinDS1's walkable overlay: the flags of every floor and wall tile in the cell
 * OR'd together, plus "unwalkable" for cells whose floor/wall has prop3 bit 0x02 or which have no floor at all.
 * Result index: (cy * width + cx) * 25 + sy * 5 + sx, with (sx, sy) sub-tile coordinates inside the cell.
 */
export function walkability(ds1: Ds1, scene: Scene): Uint8Array {
  const { width, height } = ds1;
  const out = new Uint8Array(width * height * 25);
  for (const it of scene.items) {
    if (it.kind === 'shadow' || it.kind === 'special') continue;
    const base = (it.cellY * width + it.cellX) * 25;
    const f = it.tile.subTileFlags;
    // File byte t: column t%5 runs along the cell's x axis, row t/5 runs against its y axis.
    for (let t = 0; t < 25; t++) out[base + (4 - Math.floor(t / 5)) * 5 + (t % 5)] |= f[t];
  }
  const layers = [...ds1.floors, ...ds1.walls];
  for (let i = 0; i < width * height; i++) {
    const marked = layers.some((l) => l[i].prop1 !== 0 && (l[i].prop3 & 0x02) !== 0);
    const noFloor = ds1.floors.every((l) => l[i].prop1 === 0);
    if (marked || noFloor) for (let k = 0; k < 25; k++) out[i * 25 + k] |= SubTileFlag.BlockWalk;
  }
  return out;
}

/** Topmost drawn item whose opaque pixels cover world point (wx, wy). Shadows are skipped. */
export function hitTest(scene: Scene, wx: number, wy: number, visible: (it: DrawItem) => boolean): DrawItem | null {
  return hitTestAll(scene, wx, wy, visible, 1)[0] ?? null;
}

/** Same layer + cell (a scene rebuild makes new items, so identity doesn't survive edits). */
export function sameItem(a: DrawItem, b: DrawItem): boolean {
  return a.kind === b.kind && a.layer === b.layer && a.cellX === b.cellX && a.cellY === b.cellY;
}

/**
 * Every tile with an opaque pixel under a world point, frontmost first (overlapping trees, a wall over a floor…).
 * The two halves of a north-corner wall count once.
 */
export function hitTestAll(scene: Scene, wx: number, wy: number, visible: (it: DrawItem) => boolean, limit = Infinity): DrawItem[] {
  const out: DrawItem[] = [];
  for (let i = scene.items.length - 1; i >= 0 && out.length < limit; i--) {
    const it = scene.items[i];
    if (it.kind === 'shadow' || !visible(it)) continue;
    // Cheap reject on the block bounding box before decoding pixels.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of it.tile.blocks) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + 32);
      maxY = Math.max(maxY, b.y + (b.format === 1 ? 15 : 32));
    }
    const lx = Math.floor(wx - it.x);
    const ly = Math.floor(wy - it.y);
    if (lx < minX || ly < minY || lx >= maxX || ly >= maxY) continue;
    const img = decodeTile(it.tile);
    if (!img) continue;
    const px = lx - img.offsetX;
    const py = ly - img.offsetY;
    if (px >= 0 && px < img.width && py >= 0 && py < img.height && img.pixels[py * img.width + px] !== 0 && !out.some((o) => sameItem(o, it))) out.push(it);
  }
  return out;
}

/**
 * Everything stacked at a point, front to back: tiles with a visible pixel right there first, then tiles whose image
 * covers the point where it happens to be transparent, then the rest of that cell's layers (its shadow included). This
 * is what Shift+wheel steps through, so nothing that overlaps the spot is out of reach.
 */
export function stackAt(scene: Scene, wx: number, wy: number, visible: (it: DrawItem) => boolean): DrawItem[] {
  const out = hitTestAll(scene, wx, wy, visible);
  const add = (it: DrawItem) => {
    if (!out.some((o) => sameItem(o, it))) out.push(it);
  };
  for (let i = scene.items.length - 1; i >= 0; i--) {
    const it = scene.items[i];
    if (it.kind === 'shadow' || !visible(it)) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of it.tile.blocks) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + 32);
      maxY = Math.max(maxY, b.y + (b.format === 1 ? 15 : 32));
    }
    const lx = wx - it.x;
    const ly = wy - it.y;
    if (lx >= minX && ly >= minY && lx < maxX && ly < maxY) add(it);
  }
  const [cx, cy] = worldToCell(wx, wy).map(Math.floor);
  const home = out[0] ?? { cellX: cx, cellY: cy };
  for (let i = scene.items.length - 1; i >= 0; i--) {
    const it = scene.items[i];
    if (it.cellX === home.cellX && it.cellY === home.cellY && visible(it)) add(it);
  }
  return out;
}

/** The tile(s) drawn for one cell (a north-corner wall is two tiles), positioned in world space. */
export function tilesAt(
  lib: TileLibrary,
  orientation: number,
  main: number,
  sub: number,
  cx: number,
  cy: number,
  seed = 0,
): { tile: Dt1Tile; x: number; y: number }[] {
  if (orientation === Orientation.SpecialTile1 || orientation === Orientation.SpecialTile2) return [];
  const out: { tile: Dt1Tile; x: number; y: number }[] = [];
  const add = (tile: Dt1Tile | null) => {
    if (!tile) return;
    const [x, y] = placeTile(tile, cx, cy);
    out.push({ tile, x, y });
  };
  add(lib.pick(orientation, main, sub, seed));
  if (out.length && orientation === Orientation.RightPartOfNorthCornerWall) add(lib.pick(Orientation.LeftPartOfNorthCornerWall, main, sub, seed));
  return out;
}
