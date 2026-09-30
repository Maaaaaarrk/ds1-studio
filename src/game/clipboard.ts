import { EMPTY_CELL, isEmptyCell, type Ds1Object, type TileCell, type WallCell } from '../formats/ds1';
import { normalizePath } from '../vfs/vfs';
import type { TileLibrary } from './GameData';
import { layerKey, MapDocument, type Brush, type CellEdit, type LayerRef } from './MapDocument';
import { isBuiltinPath } from './specialTiles';

/** Inclusive cell rectangle. */
export interface CellRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A copied block of cells from every tile layer. */
export interface Clipboard {
  width: number;
  height: number;
  layers: { layer: LayerRef; cells: (TileCell | WallCell)[] }[];
  /** Objects/NPCs on the copied cells, with sub-tile coordinates relative to the top-left cell. */
  objects?: Ds1Object[];
  /** The DT1s the copied tiles came from, so pasting into another map can offer to load them. */
  dt1s?: string[];
  /** Source DT1 of each copied tile, by "orientation|main|sub". */
  tileSources?: Record<string, string>;
  /** Library entry being placed, for reusing a prepared import during this session. */
  presetId?: string;
}

/**
 * A selection: its bounding rectangle, and for irregular shapes (Shift+click and Shift+drag add cells and rectangles)
 * the cells in it. Anything that only needs a rectangle uses the bounding one; cell by cell work (copy, cut, delete,
 * fill, re-roll, find & replace) takes just the selected cells.
 */
export interface CellSelection extends CellRect {
  /** Selected cells as cellKey(x, y); absent = the whole rectangle. */
  cells?: ReadonlySet<number>;
}

export const cellKey = (x: number, y: number) => y * 65536 + x;

/** Whether (x, y) is selected (inside the rectangle and, for an irregular selection, one of its cells). */
export function inSelection(s: CellSelection, x: number, y: number): boolean {
  return x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1 && (!s.cells || s.cells.has(cellKey(x, y)));
}

/** How many cells are selected. */
export function selectionCount(s: CellSelection): number {
  return s.cells ? s.cells.size : (s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1);
}

/**
 * The selection with rectangle `r` added (Shift+click adds one cell, Shift+drag a rectangle). Stays a plain rectangle
 * when the result fills its bounding box.
 */
export function addToSelection(s: CellSelection | null, r: CellRect): CellSelection {
  if (!s) return { ...r };
  const box = { x0: Math.min(s.x0, r.x0), y0: Math.min(s.y0, r.y0), x1: Math.max(s.x1, r.x1), y1: Math.max(s.y1, r.y1) };
  const cells = new Set<number>();
  for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) if (inSelection(s, x, y)) cells.add(cellKey(x, y));
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) cells.add(cellKey(x, y));
  return cells.size === (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) ? box : { ...box, cells };
}

/**
 * The selection without rectangle `r` (Shift+click on a selected cell takes it out, Shift+drag from one a rectangle).
 * null when nothing is left.
 */
export function removeFromSelection(s: CellSelection, r: CellRect): CellSelection | null {
  const cells = new Set<number>();
  for (let y = s.y0; y <= s.y1; y++)
    for (let x = s.x0; x <= s.x1; x++) if (inSelection(s, x, y) && !(x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) cells.add(cellKey(x, y));
  return cellsToSelection(cells);
}

/** A selection of exactly these cells (a plain rectangle when they fill their bounding box); null when empty. */
export function cellsToSelection(cells: Set<number>): CellSelection | null {
  if (!cells.size) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  for (const k of cells) {
    const x = k % 65536;
    const y = Math.floor(k / 65536);
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
  const box = { x0, y0, x1, y1 };
  return cells.size === (x1 - x0 + 1) * (y1 - y0 + 1) ? box : { ...box, cells };
}

/** The selection cut to a map of this size (after an undo, a restore or a crop); null when none of it is left. */
export function fitSelection(s: CellSelection | null, width: number, height: number): CellSelection | null {
  if (!s) return null;
  if (s.x0 >= 0 && s.y0 >= 0 && s.x1 < width && s.y1 < height) return s;
  const cells = new Set<number>();
  for (let y = Math.max(0, s.y0); y <= Math.min(height - 1, s.y1); y++)
    for (let x = Math.max(0, s.x0); x <= Math.min(width - 1, s.x1); x++) if (inSelection(s, x, y)) cells.add(cellKey(x, y));
  return cellsToSelection(cells);
}

/** The selection's cells as a mask over its bounding rectangle, row by row (null for a plain rectangle). */
export function selectionMask(s: CellSelection): boolean[] | null {
  if (!s.cells) return null;
  const out: boolean[] = [];
  for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) out.push(s.cells.has(cellKey(x, y)));
  return out;
}

export function rectFrom(a: [number, number], b: [number, number]): CellRect {
  return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
}

/** Clips a rectangle to the map; null when nothing is left. */
export function clampRect(r: CellRect, width: number, height: number): CellRect | null {
  const c = { x0: Math.max(r.x0, 0), y0: Math.max(r.y0, 0), x1: Math.min(r.x1, width - 1), y1: Math.min(r.y1, height - 1) };
  return c.x0 > c.x1 || c.y0 > c.y1 ? null : c;
}

export function rectSize(r: CellRect): [number, number] {
  return [r.x1 - r.x0 + 1, r.y1 - r.y0 + 1];
}

/** The selected cells (all of a plain rectangle's), row by row. */
function* cellsIn(r: CellSelection): Generator<[number, number]> {
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (inSelection(r, x, y)) yield [x, y];
}

/** Copies the selection's bounding rectangle; cells outside an irregular selection copy as empty (they don't paste). */
export function copyRect(doc: MapDocument, r: CellSelection): Clipboard {
  const [width, height] = rectSize(r);
  const inside = (o: Ds1Object) => inSelection(r, Math.floor(o.x / 5), Math.floor(o.y / 5));
  const box: [number, number][] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) box.push([x, y]);
  return {
    width,
    height,
    layers: doc.layers().map((layer) => ({
      layer,
      cells: box.map(([x, y]) => (inSelection(r, x, y) ? doc.cell(layer, x, y) : layer.kind === 'wall' ? { ...EMPTY_CELL, orientation: 0, orientationHigh: 0 } : EMPTY_CELL)),
    })),
    objects: doc.ds1.objects.filter(inside).map((o) => ({
      ...o,
      x: o.x - r.x0 * 5,
      y: o.y - r.y0 * 5,
      path: o.path.map((p) => ({ ...p, x: p.x - r.x0 * 5, y: p.y - r.y0 * 5 })),
      pathOrder: undefined,
    })),
  };
}

/** Objects of a clipboard placed with its top-left cell at (x, y), dropping any that land off the map. */
export function pasteObjects(doc: MapDocument, clip: Clipboard, x: number, y: number): Ds1Object[] {
  const dx = x * 5;
  const dy = y * 5;
  return (clip.objects ?? [])
    .map((o) => ({ ...o, x: o.x + dx, y: o.y + dy, path: o.path.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }))
    .filter((o) => doc.inBounds(Math.floor(o.x / 5), Math.floor(o.y / 5)));
}

export function clearEdits(doc: MapDocument, r: CellSelection, layers: LayerRef[]): CellEdit[] {
  return layers.flatMap((layer) => [...cellsIn(r)].map(([x, y]) => ({ layer, x, y, cell: MapDocument.painted(layer, doc.cell(layer, x, y), null) })));
}

export function fillEdits(doc: MapDocument, r: CellSelection, layer: LayerRef, brush: Brush): CellEdit[] {
  return [...cellsIn(r)].map(([x, y]) => ({ layer, x, y, cell: MapDocument.painted(layer, doc.cell(layer, x, y), brush) }));
}

/**
 * Edits that paste `clip` with its top-left cell at (x, y). Empty cells are transparent, so pasting a wall block keeps
 * the floor underneath. Layers the target map lacks (e.g. Wall 3) are skipped; cells past the map edge are clipped.
 */
export function pasteEdits(doc: MapDocument, clip: Clipboard, x: number, y: number, includeNewLayers = false): CellEdit[] {
  const have = new Set(doc.layers().map(layerKey));
  const edits: CellEdit[] = [];
  for (const { layer, cells } of clip.layers) {
    if (!have.has(layerKey(layer)) && !(includeNewLayers && layer.index >= 0 && layer.index < (layer.kind === 'wall' ? 4 : layer.kind === 'floor' ? 2 : 1))) continue;
    cells.forEach((cell, i) => {
      const cx = x + (i % clip.width);
      const cy = y + Math.floor(i / clip.width);
      if (!isEmptyCell(cell) && doc.inBounds(cx, cy)) edits.push({ layer, x: cx, y: cy, cell });
    });
  }
  return edits;
}

/** Most layers a DS1 can hold of each kind. */
export const MAX_WALL_LAYERS = 4;
export const MAX_FLOOR_LAYERS = 2;

export interface OverlapPaste {
  edits: CellEdit[];
  /** Layer counts the map needs for these edits (more than it has when a layer must be added). */
  walls: number;
  floors: number;
  /** Cells that found no free layer and replace what is there. */
  replaced: number;
}

/**
 * Like `pasteEdits`, but stacks onto what is already there (Alt while placing): a wall or floor cell that would land
 * on an occupied cell goes into the next free layer of the same kind instead, adding a layer when the map has room
 * for one (up to 4 walls / 2 floors). When every layer is taken, the cell replaces the one in its own layer.
 */
export function overlapEdits(doc: MapDocument, clip: Clipboard, x: number, y: number): OverlapPaste {
  const ds1 = doc.ds1;
  const counts = { wall: ds1.walls.length, floor: ds1.floors.length, shadow: ds1.shadows.length };
  const max = { wall: MAX_WALL_LAYERS, floor: MAX_FLOOR_LAYERS, shadow: ds1.shadows.length };
  const taken = new Set<string>();
  const occupied = (layer: LayerRef, cx: number, cy: number) => {
    if (taken.has(`${layerKey(layer)}:${cx},${cy}`)) return true;
    const have = layer.kind === 'wall' ? ds1.walls.length : layer.kind === 'floor' ? ds1.floors.length : ds1.shadows.length;
    return layer.index < have && !isEmptyCell(doc.cell(layer, cx, cy));
  };
  const edits: CellEdit[] = [];
  let replaced = 0;
  for (const { layer, cells } of clip.layers) {
    cells.forEach((cell, i) => {
      const cx = x + (i % clip.width);
      const cy = y + Math.floor(i / clip.width);
      if (isEmptyCell(cell) || !doc.inBounds(cx, cy)) return;
      let target: LayerRef | null = null;
      if (layer.kind === 'shadow') target = layer.index < counts.shadow ? layer : null;
      else {
        // Its own layer first, then the others of that kind, front to back.
        const order = [layer.index, ...Array.from({ length: max[layer.kind] }, (_, n) => n).filter((n) => n !== layer.index)];
        for (const n of order) {
          const l: LayerRef = { kind: layer.kind, index: n };
          if (!occupied(l, cx, cy)) {
            target = l;
            break;
          }
        }
        if (!target && layer.index < max[layer.kind]) {
          target = layer;
          replaced++;
        }
      }
      if (!target) return;
      taken.add(`${layerKey(target)}:${cx},${cy}`);
      if (target.kind !== 'shadow') counts[target.kind] = Math.max(counts[target.kind], target.index + 1);
      edits.push({ layer: target, x: cx, y: cy, cell });
    });
  }
  return { edits, walls: counts.wall, floors: counts.floor, replaced };
}

/** The tile key a clipboard cell needs from the tile library. */
function orientationOf(layer: LayerRef, cell: TileCell | WallCell): number {
  return layer.kind === 'floor' ? 0 : layer.kind === 'shadow' ? 13 : (cell as WallCell).orientation;
}

/** Libraries the copied tiles come from (read from the source map's library), overall and per tile. */
export function clipboardSources(clip: Clipboard, lib: TileLibrary): { dt1s: string[]; tileSources: Record<string, string> } {
  const out = new Set<string>();
  const tileSources: Record<string, string> = {};
  for (const { layer, cells } of clip.layers)
    for (const c of cells) {
      if (isEmptyCell(c)) continue;
      const o = orientationOf(layer, c);
      if (o === 10 || o === 11) continue; // special tiles need no DT1 (built-in markers)
      const t = lib.pick(o, c.mainIndex, c.subIndex, 0);
      const src = t && lib.sourceOf(t);
      if (src && !isBuiltinPath(src.path)) {
        out.add(normalizePath(src.path));
        tileSources[`${o}|${c.mainIndex}|${c.subIndex}`] = normalizePath(src.path);
      }
    }
  return { dt1s: [...out].sort(), tileSources };
}

/**
 * What pasting `clip` into a map with library `lib` would get wrong: tiles the target can't draw at all (`tiles`),
 * tiles it has under the same numbers from a different DT1 so they'd look different (`different`), and which of the
 * clipboard's DT1s (not loaded there) provide them.
 */
export function missingForPaste(clip: Clipboard, lib: TileLibrary): { tiles: number; different: number; dt1s: string[] } {
  const missing = new Set<string>();
  const different = new Set<string>();
  const needed = new Set<string>();
  const loaded = new Set(lib.loaded.filter((l) => l.found).map((l) => normalizePath(l.path)));
  for (const { layer, cells } of clip.layers)
    for (const c of cells) {
      if (isEmptyCell(c)) continue;
      const o = orientationOf(layer, c);
      if (o === 10 || o === 11) continue;
      const k = `${o}|${c.mainIndex}|${c.subIndex}`;
      const from = clip.tileSources?.[k];
      const variants = lib.variants(o, c.mainIndex, c.subIndex);
      if (!variants.length) {
        missing.add(k);
        if (from) needed.add(from);
      } else if (from && !variants.every((t) => normalizePath(lib.sourceOf(t)?.path ?? '') === normalizePath(from))) {
        different.add(k);
        needed.add(from);
      }
    }
  // Without per-tile sources (older clipboards, presets), offer every unloaded DT1 the clipboard lists.
  const dt1s = clip.tileSources ? [...needed].sort() : missing.size ? (clip.dt1s ?? []).filter((p) => !loaded.has(normalizePath(p))) : [];
  return { tiles: missing.size, different: different.size, dt1s };
}

/** What a copied tile is, for choosing what a preset keeps. */
export type ClipPart = 'floors' | 'walls' | 'roofs' | 'shadows' | 'markers' | 'objects';
export const CLIP_PARTS: { id: ClipPart; label: string }[] = [
  { id: 'floors', label: 'Floors' },
  { id: 'walls', label: 'Walls' },
  { id: 'roofs', label: 'Roofs' },
  { id: 'shadows', label: 'Shadows' },
  { id: 'markers', label: 'Markers' },
  { id: 'objects', label: 'Objects & NPCs' },
];

/** The part a cell of a layer belongs to (wall layers hold walls, roofs and special-tile markers). */
export function partOf(layer: LayerRef, cell: TileCell | WallCell): ClipPart {
  if (layer.kind === 'floor') return 'floors';
  if (layer.kind === 'shadow') return 'shadows';
  const o = (cell as WallCell).orientation;
  if (o === 15) return 'roofs';
  if (o === 10 || o === 11) return 'markers';
  return 'walls';
}

/** How many tiles (or objects) of each part a clipboard holds. */
export function countParts(clip: Clipboard): Record<ClipPart, number> {
  const n: Record<ClipPart, number> = { floors: 0, walls: 0, roofs: 0, shadows: 0, markers: 0, objects: clip.objects?.length ?? 0 };
  for (const { layer, cells } of clip.layers) for (const c of cells) if (!isEmptyCell(c)) n[partOf(layer, c)]++;
  return n;
}

/** The clipboard with only the parts in `keep` (the rest empty; layers left empty dropped). */
export function filterClipboard(clip: Clipboard, keep: ReadonlySet<ClipPart>): Clipboard {
  const empty = (layer: LayerRef): TileCell | WallCell => (layer.kind === 'wall' ? { ...EMPTY_CELL, orientation: 0, orientationHigh: 0 } : EMPTY_CELL);
  return {
    ...clip,
    layers: clip.layers
      .map(({ layer, cells }) => ({ layer, cells: cells.map((c) => (isEmptyCell(c) || keep.has(partOf(layer, c)) ? c : empty(layer))) }))
      .filter((l) => l.cells.some((c) => !isEmptyCell(c))),
    objects: keep.has('objects') ? clip.objects : [],
  };
}
