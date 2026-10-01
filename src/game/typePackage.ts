import { strToU8, zipSync, type Zippable } from 'fflate';
import { getCell, setCell, type TxtTableDoc } from '../formats/txtTable';
import { normalizePath, type LayeredFs } from '../vfs/vfs';
import type { GameData } from './GameData';
import { collectMapStrings, collectMapTxtRows, isBaseGameLabel } from './mapPackage';

/**
 * A whole level type as one tidy package, for whoever merges it into a mod (e.g. a mod's developers): every DT1 the
 * type loads once, at its game path (ideally all in the type's one folder), each table's rows for all the type's maps
 * in one file, the strings they name, and optionally the maps. The per-map packages repeat the shared DT1s and rows in
 * every zip; this is the consolidated form.
 */

export interface TypePackageResult {
  zip: Uint8Array;
  maps: string[];
  dt1s: { path: string; fromGame: boolean }[];
  tables: { table: string; rows: number }[];
  missing: string[];
}

/** The maps (LvlPrest File1..6) of every level using the type. */
export function mapsOfType(prest: TxtTableDoc, levels: TxtTableDoc, typeId: number): string[] {
  const ids = new Set(levels.rows.map((_, r) => r).filter((r) => getCell(levels, r, 'LevelType') === String(typeId)).map((r) => getCell(levels, r, 'Id')));
  const out: string[] = [];
  prest.rows.forEach((_, r) => {
    if (!ids.has(getCell(prest, r, 'LevelId'))) return;
    for (let f = 1; f <= 6; f++) {
      const v = getCell(prest, r, `File${f}`);
      if (v && v !== '0') out.push(`data/global/tiles/${v.replace(/\\/g, '/')}`);
    }
  });
  return [...new Map(out.map((p) => [normalizePath(p), p])).values()];
}

export async function buildTypePackage(gd: GameData, fs: LayeredFs, typeId: number, opts: { includeMaps: boolean; prest: TxtTableDoc; levels: TxtTableDoc }): Promise<TypePackageResult> {
  const type = gd.lvlType(typeId);
  if (!type) throw new Error(`LvlTypes.txt has no level type ${typeId}.`);
  const files: Zippable = {};
  const missing: string[] = [];
  const dt1s: TypePackageResult['dt1s'] = [];
  for (const f of type.files) {
    if (!f) continue;
    const path = `data/global/tiles/${f.replace(/\\/g, '/')}`;
    const bytes = await fs.read(normalizePath(path));
    if (!bytes) {
      missing.push(path);
      continue;
    }
    files[path] = bytes;
    dt1s.push({ path, fromGame: isBaseGameLabel(fs.locate(normalizePath(path)) ?? '') });
  }
  const maps = mapsOfType(opts.prest, opts.levels, typeId);
  const tables = new Map<string, { columns: string[]; rows: string[][]; seen: Set<string> }>();
  const strings: Record<string, string> = {};
  for (const m of maps) {
    if (opts.includeMaps) {
      const b = await fs.read(normalizePath(m));
      if (b) files[m] = b;
      else missing.push(m);
    }
    const rows = await collectMapTxtRows(fs, m);
    Object.assign(strings, await collectMapStrings(fs, rows));
    for (const r of rows) {
      const t = r.table.split('/').pop()!.replace(/\.txt$/i, '');
      const e = tables.get(t) ?? { columns: r.columns, rows: [], seen: new Set<string>() };
      const id = r.row.join('\t');
      if (!e.seen.has(id)) {
        e.seen.add(id);
        e.rows.push(r.row);
      }
      tables.set(t, e);
    }
  }
  for (const [t, e] of tables) files[`txt/${t}.txt`] = strToU8([e.columns.join('\t'), ...e.rows.map((r) => r.join('\t'))].join('\r\n') + '\r\n');
  if (Object.keys(strings).length) files['txt/strings (patchstring.tbl).txt'] = strToU8(['Key\tValue', ...Object.entries(strings).map(([k, v]) => `${k}\t${v}`)].join('\r\n') + '\r\n');
  const folders = [...new Set(dt1s.map((d) => d.path.replace(/\/[^/]+$/, '')))];
  files['README.txt'] = strToU8(
    [
      `Level type ${typeId} "${type.name}" - made with DS1 Studio, ${new Date().toISOString().slice(0, 10)}`,
      '',
      `Tile libraries (${dt1s.length}, the type's File slots in order), at their game paths:`,
      ...dt1s.map((d) => `  ${d.path}${d.fromGame ? '   (a copy of the base game file)' : ''}`),
      folders.length > 1 ? `  (in ${folders.length} folders: Game -> Level type... can gather them into one)` : '',
      '',
      `Maps of this level type (${maps.length}):${opts.includeMaps ? ' included at their game paths' : ' not included'}`,
      ...maps.map((m) => `  ${m}`),
      '',
      'txt/ holds the rows of each table for all these maps, one file per table (header + rows, as in our tables):',
      ...[...tables].map(([t, e]) => `  ${t}.txt   ${e.rows.length} row${e.rows.length === 1 ? '' : 's'}`),
      Object.keys(strings).length ? '  strings (patchstring.tbl).txt   the names those rows use' : '',
      '',
      'AutoMap rows are in table order: the game uses the first row that matches.',
    ]
      .join('\r\n') + '\r\n',
  );
  return { zip: zipSync(files, { level: 6 }), maps, dt1s, tables: [...tables].map(([table, e]) => ({ table, rows: e.rows.length })), missing };
}

export interface GatherPlan {
  /** Each library's copy: where from, where to (game paths), and the bytes. Slot order is kept. */
  copies: { slot: number; from: string; to: string; bytes: Uint8Array }[];
  /** LvlTypes.txt with the type's File slots pointing at the copies. */
  types: TxtTableDoc;
  /** Already in the folder (nothing to do for them). */
  already: number;
}

/** A readable file name for a library in the gathered folder (unique among `taken`). */
export function gatheredName(path: string, taken: Set<string>, exists: (name: string) => boolean = () => false): string {
  const parts = path.replace(/\\/g, '/').replace(/^data\/global\/tiles\//i, '').split('/');
  const file = parts.pop()!.toLowerCase();
  const parent = (parts.pop() ?? '').toLowerCase();
  const base = file.replace(/\.dt1$/i, '');
  // DS1 Studio's generated files (studio/a…, f…, p…) say what they hold; others keep their name, or take their folder's.
  let name = parent === 'studio' && /^[afp][a-z0-9]{6,}$/.test(base) ? { a: 'automap', f: 'floors', p: 'tiles' }[base[0] as 'a' | 'f' | 'p'] : taken.has(file) ? `${parent ? `${parent}_` : ''}${base}` : base;
  name = name.replace(/[^a-z0-9_]+/g, '_');
  let out = `${name}.dt1`;
  for (let n = 2; taken.has(out) || exists(out); n++) out = `${name}_${n}.dt1`;
  taken.add(out);
  return out;
}

/**
 * Copies every mod library of a level type into one folder (`folder`, relative to data/global/tiles) under readable,
 * unique names and points the type's File slots at the copies, slot for slot, so no Dt1Mask, map or AutoMap row
 * changes. The originals stay (other types or maps may use them). Base-game libraries are copied too when
 * `includeGame` (the folder then holds everything the type loads).
 */
export async function planGatherType(fs: LayeredFs, typesDoc: TxtTableDoc, typeId: number, folder: string, includeGame: boolean): Promise<GatherPlan> {
  const row = typesDoc.rows.findIndex((_, r) => getCell(typesDoc, r, 'Id') === String(typeId));
  if (row < 0) throw new Error(`LvlTypes.txt has no level type ${typeId}.`);
  const dir = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const taken = new Set<string>();
  // Names already in the folder count as taken unless it's that very file.
  for (let i = 1; i <= 32; i++) {
    const v = getCell(typesDoc, row, `File ${i}`).replace(/\\/g, '/');
    if (v && v !== '0' && normalizePath(v).startsWith(normalizePath(dir) + '/')) taken.add(v.split('/').pop()!.toLowerCase());
  }
  let types = typesDoc;
  const copies: GatherPlan['copies'] = [];
  let already = 0;
  for (let i = 1; i <= 32; i++) {
    const v = getCell(typesDoc, row, `File ${i}`).replace(/\\/g, '/');
    if (!v || v === '0') continue;
    if (normalizePath(v).startsWith(normalizePath(dir) + '/')) {
      already++;
      continue;
    }
    const from = `data/global/tiles/${v}`;
    if (!includeGame && isBaseGameLabel(fs.locate(normalizePath(from)) ?? '')) continue;
    const bytes = await fs.read(normalizePath(from));
    if (!bytes) throw new Error(`${from} was not found.`);
    const name = gatheredName(from, taken, (n) => !!fs.locate(normalizePath(`data/global/tiles/${dir}/${n}`)));
    const to = `data/global/tiles/${dir}/${name}`;
    copies.push({ slot: i, from, to, bytes });
    types = setCell(types, row, `File ${i}`, `${dir}/${name}`);
  }
  return { copies, types, already };
}

/**
 * The folder to suggest gathering a level type into: its home folder when that holds nothing but the type's own
 * libraries (as after an earlier gather), else a new folder named after the type.
 */
export function suggestGatherFolder(fs: LayeredFs, typeName: string, files: string[], home: string | null): string {
  const mine = new Set(files.filter(Boolean).map((f) => normalizePath(`data/global/tiles/${f.replace(/\\/g, '/')}`)));
  if (home) {
    const prefix = normalizePath(`data/global/tiles/${home}/`);
    const there = fs.list((p) => p.startsWith(prefix) && p.endsWith('.dt1') && !p.slice(prefix.length).includes('/'));
    if (there.length && there.every((p) => mine.has(normalizePath(p)))) return home;
  }
  return typeName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'LevelType';
}
