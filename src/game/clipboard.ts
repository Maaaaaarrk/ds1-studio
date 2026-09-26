import { isEmptyCell, type Ds1Object, type TileCell, type WallCell } from '../formats/ds1';
import { layerKey, MapDocument, type Brush, type CellEdit, type LayerRef } from './MapDocument';

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

function* cellsIn(r: CellRect): Generator<[number, number]> {
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) yield [x, y];
}

export function copyRect(doc: MapDocument, r: CellRect): Clipboard {
  const [width, height] = rectSize(r);
  const inside = (o: Ds1Object) => {
    const cx = Math.floor(o.x / 5);
    const cy = Math.floor(o.y / 5);
    return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1;
  };
  return {
    width,
    height,
    layers: doc.layers().map((layer) => ({ layer, cells: [...cellsIn(r)].map(([x, y]) => doc.cell(layer, x, y)) })),
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

export function clearEdits(doc: MapDocument, r: CellRect, layers: LayerRef[]): CellEdit[] {
  return layers.flatMap((layer) => [...cellsIn(r)].map(([x, y]) => ({ layer, x, y, cell: MapDocument.painted(layer, doc.cell(layer, x, y), null) })));
}

export function fillEdits(doc: MapDocument, r: CellRect, layer: LayerRef, brush: Brush): CellEdit[] {
  return [...cellsIn(r)].map(([x, y]) => ({ layer, x, y, cell: MapDocument.painted(layer, doc.cell(layer, x, y), brush) }));
}

/**
 * Edits that paste `clip` with its top-left cell at (x, y). Empty cells are transparent, so pasting a wall block keeps
 * the floor underneath. Layers the target map lacks (e.g. Wall 3) are skipped; cells past the map edge are clipped.
 */
export function pasteEdits(doc: MapDocument, clip: Clipboard, x: number, y: number): CellEdit[] {
  const have = new Set(doc.layers().map(layerKey));
  const edits: CellEdit[] = [];
  for (const { layer, cells } of clip.layers) {
    if (!have.has(layerKey(layer))) continue;
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
