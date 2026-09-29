import { isEmptyCell } from '../formats/ds1';
import type { Dt1Tile } from '../formats/dt1';
import { inSelection, type CellSelection } from './clipboard';
import { type Brush, type CellEdit, type MapDocument } from './MapDocument';
import { type TileLibrary } from './GameData';
import { paintEdits } from './editTools';
export interface FloorChoice { path: string; index: number; tile: Dt1Tile; brush: Brush }
export interface RerollOptions { preserveWalkability: boolean; avoidRepeats: boolean; seed: number }
const walkSignature = (t: Dt1Tile) => [...t.subTileFlags].map(f => f & 1).join('');
const brushKey = (b: Brush) => b.main + '/' + b.sub;
const hash = (n: number) => { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0; };
/** Balanced, deterministic placement: preserve empty/edge cells and avoid adjacent repetitions where possible. */
export function smartFloorReroll(doc: MapDocument, lib: TileLibrary, area: CellSelection, layer: number, choices: FloorChoice[], options: RerollOptions): { edits: CellEdit[]; skipped: number } {
  if (!choices.length || !doc.ds1.floors[layer]) return { edits: [], skipped: 0 };
  if (choices.some(c => c.tile.orientation !== 0 || c.brush.orientation !== 0)) throw new Error('Reroll accepts floor tiles only.');
  const candidates = [...new Map(choices.map(c => [brushKey(c.brush), c])).values()];
  const signatures = new Map(candidates.map(c => [brushKey(c.brush), new Set(choices.filter(v => brushKey(v.brush) === brushKey(c.brush)).map(v => walkSignature(v.tile)))]));
  const edits: CellEdit[] = [], counts = new Map<string, number>(), assigned = new Map<number, string>();
  let skipped = 0;
  const keyAt = (x: number, y: number) => {
    const i = y * doc.ds1.width + x;
    if (assigned.has(i)) return assigned.get(i);
    const c = doc.ds1.floors[layer][i]; return c && !isEmptyCell(c) ? c.mainIndex + '/' + c.subIndex : null;
  };
  for (let y = Math.max(0, area.y0); y <= Math.min(doc.ds1.height - 1, area.y1); y++)
    for (let x = Math.max(0, area.x0); x <= Math.min(doc.ds1.width - 1, area.x1); x++) {
      if (!inSelection(area, x, y)) continue;
      const cell = doc.ds1.floors[layer][y * doc.ds1.width + x];
      if (isEmptyCell(cell)) continue;
      const original = lib.pick(0, cell.mainIndex, cell.subIndex, (x + y * doc.ds1.width) * 8 + layer);
      const eligible = options.preserveWalkability ? candidates.filter(c => original && signatures.get(brushKey(c.brush))!.size === 1 && walkSignature(c.tile) === walkSignature(original)) : candidates;
      if (!eligible.length) { skipped++; continue; }
      const neighbors = [x > 0 ? keyAt(x - 1, y) : null, y > 0 ? keyAt(x, y - 1) : null];
      const score = (c: FloorChoice) => {
        const k = brushKey(c.brush);
        return (options.avoidRepeats ? neighbors.filter(n => n === k).length * (doc.ds1.width * doc.ds1.height + 1) * 1000 : 0) + (counts.get(k) ?? 0) * 1000 +
          hash(options.seed ^ Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(c.brush.main * 256 + c.brush.sub + 1, 83492791)) % 997;
      };
      const pick = [...eligible].sort((a, b) => score(a) - score(b))[0];
      const k = brushKey(pick.brush); counts.set(k, (counts.get(k) ?? 0) + 1); assigned.set(y * doc.ds1.width + x, k);
      edits.push(...paintEdits(doc, { kind: 'floor', index: layer }, [[x, y]], [pick.brush]));
    }
  return { edits, skipped };
}
