import { isEmptyCell, type Ds1 } from '../formats/ds1';
import { decodeTile, isLowerWall, Orientation, type Dt1Tile } from '../formats/dt1';
import type { TileLibrary } from '../game/GameData';

/** Size of one DS1 cell on screen: a 160x80 isometric diamond. */
export const TILE_W = 160;
export const TILE_H = 80;

export type DrawKind = 'floor' | 'shadow' | 'lowerWall' | 'wall' | 'roof';

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

/** Sub-tile (5x5 per cell) coordinates, used by objects and NPC paths, to world space. */
export function subTileToWorld(sx: number, sy: number): [number, number] {
  return [(sx - sy) * (TILE_W / 10), (sx + sy) * (TILE_H / 10)];
}

/** World position of a tile's block origin when placed in cell (cx, cy). */
export function placeTile(tile: Dt1Tile, cx: number, cy: number): [number, number] {
  const [px, py] = cellToWorld(cx, cy);
  // Blocks are relative to the diamond's left corner; walls/shadows hang from its bottom vertex; roofs float above.
  const yAdjust = tile.orientation === Orientation.Floor ? 0 : tile.orientation === Orientation.Roof ? -tile.roofHeight : TILE_H;
  return [px - TILE_W / 2, py + yAdjust];
}

export function buildScene(ds1: Ds1, lib: TileLibrary): Scene {
  const items: DrawItem[] = [];
  const missing: MissingTile[] = [];
  const { width, height } = ds1;

  const add = (kind: DrawKind, layer: number, cx: number, cy: number, orientation: number, main: number, sub: number, seed: number) => {
    const tile = lib.pick(orientation, main, sub, seed);
    if (!tile) {
      // Main index 30/31 floors are the game's "blank" void filler (act1/outdoors/blank.dt1); absent = draw nothing.
      if (orientation === Orientation.Floor && main >= 30) return;
      missing.push({ kind, layer, cellX: cx, cellY: cy, orientation, main, sub });
      return;
    }
    const [x, y] = placeTile(tile, cx, cy);
    items.push({ tile, kind, layer, cellX: cx, cellY: cy, x, y });
  };
  const seedOf = (cx: number, cy: number, layer: number) => (cy * width + cx) * 8 + layer;

  // 1. Floors, bottom layer first.
  ds1.floors.forEach((cells, layer) => {
    for (let cy = 0; cy < height; cy++)
      for (let cx = 0; cx < width; cx++) {
        const c = cells[cy * width + cx];
        if (!isEmptyCell(c) && !c.hidden) add('floor', layer, cx, cy, Orientation.Floor, c.mainIndex, c.subIndex, seedOf(cx, cy, layer));
      }
  });

  // 2. Shadows.
  ds1.shadows.forEach((cells, layer) => {
    for (let cy = 0; cy < height; cy++)
      for (let cx = 0; cx < width; cx++) {
        const c = cells[cy * width + cx];
        if (!isEmptyCell(c) && !c.hidden) add('shadow', layer, cx, cy, Orientation.Shadow, c.mainIndex, c.subIndex, seedOf(cx, cy, 4));
      }
  });

  // 3. Walls in isometric depth order (back to front); lower walls go under everything upright, roofs on top.
  const lower: [number, number, number][] = [];
  const upright: [number, number, number][] = [];
  const roofs: [number, number, number][] = [];
  for (let d = 0; d < width + height - 1; d++) {
    for (let cy = Math.max(0, d - width + 1); cy <= Math.min(d, height - 1); cy++) {
      const cx = d - cy;
      for (let layer = 0; layer < ds1.walls.length; layer++) {
        const c = ds1.walls[layer][cy * width + cx];
        if (isEmptyCell(c) || c.hidden) continue;
        const o = c.orientation;
        if (o === Orientation.SpecialTile1 || o === Orientation.SpecialTile2) continue; // editor-only markers
        const bucket = o === Orientation.Roof ? roofs : isLowerWall(o) ? lower : upright;
        bucket.push([layer, cx, cy]);
      }
    }
  }
  const addWall = (kind: DrawKind, [layer, cx, cy]: [number, number, number]) => {
    const c = ds1.walls[layer][cy * width + cx];
    const seed = seedOf(cx, cy, layer + 5);
    add(kind, layer, cx, cy, c.orientation, c.mainIndex, c.subIndex, seed);
    // A north-corner wall is drawn as two tiles: orientation 3 plus its orientation-4 partner.
    if (c.orientation === Orientation.RightPartOfNorthCornerWall) {
      const partner = lib.pick(Orientation.LeftPartOfNorthCornerWall, c.mainIndex, c.subIndex, seed);
      if (partner) {
        const [x, y] = placeTile(partner, cx, cy);
        items.push({ tile: partner, kind, layer, cellX: cx, cellY: cy, x, y });
      }
    }
  };
  lower.forEach((w) => addWall('lowerWall', w));
  upright.forEach((w) => addWall('wall', w));
  roofs.forEach((w) => addWall('roof', w));

  const [lx] = cellToWorld(0, height);
  const [rx] = cellToWorld(width, 0);
  const [, by] = cellToWorld(width, height);
  return { items, missing, bounds: { minX: lx, minY: 0, maxX: rx, maxY: by } };
}

/** Topmost drawn item whose opaque pixels cover world point (wx, wy). Shadows are skipped. */
export function hitTest(scene: Scene, wx: number, wy: number, visible: (it: DrawItem) => boolean): DrawItem | null {
  for (let i = scene.items.length - 1; i >= 0; i--) {
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
    if (img && img.pixels[(ly - img.offsetY) * img.width + (lx - img.offsetX)] !== 0) return it;
  }
  return null;
}
