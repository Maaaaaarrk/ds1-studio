import { isEmptyCell, type TileCell, type WallCell } from '../formats/ds1';
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
  return {
    width,
    height,
    layers: doc.layers().map((layer) => ({ layer, cells: [...cellsIn(r)].map(([x, y]) => doc.cell(layer, x, y)) })),
  };
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
