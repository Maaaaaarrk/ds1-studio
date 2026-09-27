import { isEmptyCell, type Ds1Object, type TileCell, type WallCell } from '../formats/ds1';
import { inSelection, type CellSelection } from './clipboard';
import { MapDocument, type Brush, type CellEdit, type LayerRef } from './MapDocument';

/**
 * Map-wide editing helpers: flood fill, find & replace, re-rolling tile variants, painting with a mix of tiles, and
 * the objects that go with a selection. All return plain edit lists; the caller applies them as one undo step.
 */

type AnyCell = TileCell | WallCell;

/** A tile as painted in a map: main/sub index, plus the orientation on wall layers. */
export interface TileKey {
  orientation: number;
  main: number;
  sub: number;
}

export function keyOf(layer: LayerRef, cell: AnyCell): TileKey | null {
  if (isEmptyCell(cell)) return null;
  return { orientation: layer.kind === 'floor' ? 0 : layer.kind === 'shadow' ? 13 : (cell as WallCell).orientation, main: cell.mainIndex, sub: cell.subIndex };
}

const sameKey = (a: TileKey | null, b: TileKey | null) => (a === null || b === null ? a === b : a.orientation === b.orientation && a.main === b.main && a.sub === b.sub);
export const keyText = (k: TileKey) => `${k.main}/${k.sub}`;

/** Whether (x, y) is in `r` (a selection's cells when irregular); null = anywhere. */
const inRect = (r: CellSelection | null, x: number, y: number) => !r || inSelection(r, x, y);

/** A tile to paint: the brush, or a random one of a mix (each cell picks its own). */
export function brushFor(mix: Brush[], random: () => number = Math.random): Brush | null {
  if (!mix.length) return null;
  return mix.length === 1 ? mix[0] : mix[Math.floor(random() * mix.length)];
}

/**
 * Cells connected to (x, y) on `layer` (edge neighbours) holding the same tile, or all empty when it is empty,
 * kept inside `within` when given.
 */
export function floodRegion(doc: MapDocument, layer: LayerRef, x: number, y: number, within: CellSelection | null = null): [number, number][] {
  const { width, height } = doc.ds1;
  if (!doc.inBounds(x, y) || !inRect(within, x, y)) return [];
  const target = keyOf(layer, doc.cell(layer, x, y));
  const seen = new Uint8Array(width * height);
  const out: [number, number][] = [];
  const stack: [number, number][] = [[x, y]];
  seen[y * width + x] = 1;
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    out.push([cx, cy]);
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || seen[ny * width + nx] || !inRect(within, nx, ny)) continue;
      seen[ny * width + nx] = 1;
      if (sameKey(keyOf(layer, doc.cell(layer, nx, ny)), target)) stack.push([nx, ny]);
    }
  }
  return out;
}

/** Paints `cells` on `layer` with the mix (null/empty = erase). `orient` fixes a wall brush's orientation for the layer. */
export function paintEdits(doc: MapDocument, layer: LayerRef, cells: [number, number][], mix: Brush[] | null, random: () => number = Math.random): CellEdit[] {
  return cells
    .filter(([x, y]) => doc.inBounds(x, y))
    .map(([x, y]) => ({ layer, x, y, cell: MapDocument.painted(layer, doc.cell(layer, x, y), mix?.length ? brushFor(mix, random) : null) }));
}

/** The cells of a rectangle, or of a selection (just its cells when irregular). */
export function rectCells(r: CellSelection): [number, number][] {
  const out: [number, number][] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (inSelection(r, x, y)) out.push([x, y]);
  return out;
}

/** Every use of `from` on the given layers (inside `within` when given). */
export function findTile(doc: MapDocument, layers: LayerRef[], from: TileKey, within: CellSelection | null = null): { layer: LayerRef; x: number; y: number }[] {
  const out: { layer: LayerRef; x: number; y: number }[] = [];
  const { width, height } = doc.ds1;
  for (const layer of layers)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) if (inRect(within, x, y) && sameKey(keyOf(layer, doc.cell(layer, x, y)), from)) out.push({ layer, x, y });
  return out;
}

/** Replaces every use of `from` with `to` (keeping each cell's other properties). */
export function replaceEdits(doc: MapDocument, layers: LayerRef[], from: TileKey, to: TileKey, within: CellSelection | null = null): CellEdit[] {
  return findTile(doc, layers, from, within).map(({ layer, x, y }) => ({ layer, x, y, cell: MapDocument.painted(layer, doc.cell(layer, x, y), to) }));
}

/**
 * Re-rolls the tiles in `r`: every cell gets a random tile among those of the same main index (and orientation)
 * already used in the selection, weighted by how often each is used. Mixes up visible repeats without bringing in
 * tiles that weren't there.
 */
export function rerollEdits(doc: MapDocument, r: CellSelection, layers: LayerRef[], random: () => number = Math.random): CellEdit[] {
  const edits: CellEdit[] = [];
  for (const layer of layers) {
    const cells = rectCells(r).map(([x, y]) => ({ x, y, key: keyOf(layer, doc.cell(layer, x, y)) }));
    const groups = new Map<string, TileKey[]>();
    for (const c of cells) {
      if (!c.key) continue;
      const g = `${c.key.orientation}|${c.key.main}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(c.key);
    }
    for (const c of cells) {
      if (!c.key) continue;
      const pool = groups.get(`${c.key.orientation}|${c.key.main}`)!;
      if (new Set(pool.map(keyText)).size < 2) continue;
      edits.push({ layer, x: c.x, y: c.y, cell: MapDocument.painted(layer, doc.cell(layer, c.x, c.y), pool[Math.floor(random() * pool.length)]) });
    }
  }
  return edits;
}

/** True when an object stands on a cell of `r`. */
export function objectInRect(o: Ds1Object, r: CellSelection): boolean {
  return inSelection(r, Math.floor(o.x / 5), Math.floor(o.y / 5));
}
