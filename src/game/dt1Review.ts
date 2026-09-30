import { type Ds1 } from '../formats/ds1';
import { Orientation } from '../formats/dt1';
import { buildDt1, dt1Records } from '../formats/dt1Write';
import { getCell, setCell, type TxtTableDoc } from '../formats/txtTable';
import { normalizePath } from '../vfs/vfs';

/**
 * Reviewing the tile libraries a map uses: which of their tiles the map places, taking one tile out of a DT1, and
 * renaming a DT1 everywhere the game's tables name it.
 */

/** A tile's key as the game looks it up: orientation, main and sub index. */
export const tileKey = (orientation: number, main: number, sub: number) => `${orientation}|${main}|${sub}`;

/** Every tile key the map places, with how many cells use it (a north corner wall also draws its other half, 4). */
export function mapTileUsage(ds1: Ds1): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  for (const layer of ds1.floors) for (const c of layer) if (c.prop1) add(tileKey(Orientation.Floor, c.mainIndex, c.subIndex));
  for (const layer of ds1.walls)
    for (const c of layer) {
      if (!c.prop1) continue;
      add(tileKey(c.orientation, c.mainIndex, c.subIndex));
      if (c.orientation === Orientation.RightPartOfNorthCornerWall) add(tileKey(Orientation.LeftPartOfNorthCornerWall, c.mainIndex, c.subIndex));
    }
  for (const layer of ds1.shadows) for (const c of layer) if (c.prop1) add(tileKey(Orientation.Shadow, c.mainIndex, c.subIndex));
  return out;
}

/** The cells placing a tile key (for showing them on the map). */
export function cellsUsing(ds1: Ds1, key: string): { x: number; y: number }[] {
  const [o, m, s] = key.split('|').map(Number);
  const at = new Set<number>();
  const hit = (layer: { prop1: number; mainIndex: number; subIndex: number }[], orientation: (i: number) => number) =>
    layer.forEach((c, i) => {
      if (c.prop1 && c.mainIndex === m && c.subIndex === s && orientation(i) === o) at.add(i);
    });
  if (o === Orientation.Floor) ds1.floors.forEach((l) => hit(l, () => Orientation.Floor));
  else if (o === Orientation.Shadow) ds1.shadows.forEach((l) => hit(l, () => Orientation.Shadow));
  else
    ds1.walls.forEach((l) =>
      hit(l, (i) => (o === Orientation.LeftPartOfNorthCornerWall && l[i].orientation === Orientation.RightPartOfNorthCornerWall ? o : l[i].orientation)),
    );
  return [...at].sort((a, b) => a - b).map((i) => ({ x: i % ds1.width, y: Math.floor(i / ds1.width) }));
}

/** A DT1 without its tile `index` (file order); every other tile stays byte for byte. */
export function withoutTile(bytes: Uint8Array, index: number): Uint8Array {
  const records = dt1Records(bytes);
  if (index < 0 || index >= records.length) throw new Error(`The DT1 has no tile #${index}`);
  records.splice(index, 1);
  return buildDt1(records);
}

/**
 * LvlTypes.txt with every File column naming `oldRel` (tiles-relative, any case) pointing at `newRel` instead, and
 * the level types that changed.
 */
export function renameInLvlTypes(types: TxtTableDoc, oldRel: string, newRel: string): { doc: TxtTableDoc; changed: string[] } {
  const want = normalizePath(`data/global/tiles/${oldRel}`);
  let doc = types;
  const changed: string[] = [];
  for (let r = 0; r < doc.rows.length; r++)
    for (let f = 1; f <= 32; f++) {
      const v = getCell(doc, r, `File ${f}`);
      if (!v || v === '0' || normalizePath(`data/global/tiles/${v}`) !== want) continue;
      doc = setCell(doc, r, `File ${f}`, newRel);
      const name = `${getCell(doc, r, 'Id')} ${getCell(doc, r, 'Name')}`.trim();
      if (!changed.includes(name)) changed.push(name);
    }
  return { doc, changed };
}

/** The level types (from LvlTypes.txt) that list a DT1, as "id name". */
export function typesUsing(types: { id: number; name: string; files: string[] }[], path: string): string[] {
  const want = normalizePath(path);
  return types.filter((t) => t.files.some((f) => f && normalizePath(`data/global/tiles/${f}`) === want)).map((t) => `${t.id} ${t.name}`);
}

/** Points every LvlPrest File1–File6 cell that names `oldRel` (a map, relative to data/global/tiles) at `newRel`. */
export function renameInLvlPrest(prest: TxtTableDoc, oldRel: string, newRel: string): { doc: TxtTableDoc; changed: string[] } {
  const want = normalizePath(`data/global/tiles/${oldRel}`);
  let doc = prest;
  const changed: string[] = [];
  for (let r = 0; r < doc.rows.length; r++)
    for (let f = 1; f <= 6; f++) {
      const v = getCell(doc, r, `File${f}`);
      if (!v || v === '0' || normalizePath(`data/global/tiles/${v}`) !== want) continue;
      doc = setCell(doc, r, `File${f}`, newRel);
      const name = `${getCell(doc, r, 'Def')} ${getCell(doc, r, 'Name')}`.trim();
      if (!changed.includes(name)) changed.push(name);
    }
  return { doc, changed };
}

/** A shorter tile path (relative to data/global/tiles) for one over `max` characters: the file name is cut first. */
export function suggestShortPath(rel: string, max: number): string {
  if (rel.length <= max) return rel;
  const slash = rel.lastIndexOf('/');
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
  const file = rel.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot) : '';
  const base = (dot > 0 ? file.slice(0, dot) : file).replace(/[\s_-]+/g, '');
  const room = max - dir.length - ext.length;
  if (room >= 3) return `${dir}${base.slice(0, room)}${ext}`;
  // The folder alone is too long: keep only its last part.
  const last = dir.split('/').filter(Boolean).pop() ?? '';
  const d2 = last ? `${last.slice(0, 12)}/` : '';
  return `${d2}${base.slice(0, Math.max(3, max - d2.length - ext.length))}${ext}`;
}
