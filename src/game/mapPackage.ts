import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Ds1 } from '../formats/ds1';
import { COMPONENTS, parseCof } from '../formats/cof';
import { parseTxt } from '../formats/txt';
import { CLASSIC_MPQS, normalizePath, type LayeredFs } from '../vfs/vfs';
import { cofPath, layerPath, type SpriteSpec } from './sprites';
import { automapLevelFor, type AutomapTable } from './automap';
import { mergeMapRows } from './levelTables';

/**
 * Map packages: one zip holding a DS1 plus everything it needs (DT1s, modded object sprites, txt rows), so a map can
 * be handed to someone else and imported into their DS1 Studio. Everything here is pure or read-only; the caller
 * performs the actual writes.
 */

export const PACKAGE_FORMAT = 'ds1studio-package';
export const PACKAGE_VERSION = 1;
export const MANIFEST_NAME = 'ds1studio-package.json';

/** What the packager needs from a sprite spec (a `SpriteSpec` fits). */
export type SpriteSpecLike = Pick<SpriteSpec, 'base' | 'token' | 'mode' | 'cls' | 'parts'>;

export type FileOrigin = 'mod' | 'base-game';

export interface PackageFile {
  /** Game path, '/'-separated, as stored in the zip. */
  path: string;
  size: number;
  /** Hex SHA-1 of the bytes (omitted when no WebCrypto is available). */
  sha1?: string;
  /** 'base-game' files came from the classic MPQs; every player has them, so importing them is optional. */
  from: FileOrigin;
  /** True when the file is listed for reference only and was left out of the zip. */
  omitted?: boolean;
}

/** A txt row the map needs, with its column header so it can be merged by column name. */
export interface TxtRowEntry {
  /** Table name, e.g. `LvlPrest` or `LvlPrest.txt` (a full game path is accepted too). */
  table: string;
  /** Name of the column identifying the row, e.g. `Name` (LvlPrest) or `Id` (Levels, LvlTypes). */
  key: string;
  columns: string[];
  row: string[];
}

/**
 * The tables a map needs its rows from to load and work in game, with what each one does for it. A package without
 * some of them leaves the importer's own rows in charge, which may not match the map.
 */
export const MAP_TABLES = [
  { table: 'LvlPrest', role: 'makes the game load this map for its level (the file, its Dt1Mask, roof hiding)' },
  { table: 'Levels', role: 'the level itself: size, act, palette, world position, loading-screen image, light, monsters' },
  { table: 'LvlTypes', role: 'the tile libraries (DT1s) the level loads' },
  { table: 'CubeMain', role: 'the cube recipe that opens a portal to it: on import a new one is made (the package\'s is suggested)' },
  { table: 'AutoMap', role: "the automap pieces for the level type's tiles" },
] as const;

export interface TableCoverage {
  table: string;
  role: string;
  rows: number;
}

/** How many rows of each of MAP_TABLES a package (or an export) carries. */
export function tableCoverage(rows: TxtRowEntry[]): TableCoverage[] {
  const name = (t: string) => t.replace(/\.txt$/i, '').split('/').pop()!.toLowerCase();
  return MAP_TABLES.map((t) => ({ table: t.table, role: t.role, rows: rows.filter((r) => name(r.table) === t.table.toLowerCase()).length }));
}

/**
 * The warning for tables a map arrives without (empty when it has rows from all of them). CubeMain isn't one: the
 * import makes a new recipe for the importer's own tables instead of merging the package's (see ImportPlan.recipe).
 */
export function missingTablesWarning(coverage: TableCoverage[]): string {
  const missing = coverage.filter((c) => !c.rows && c.table !== 'CubeMain').map((c) => c.table);
  if (!missing.length) return '';
  const one = missing.length === 1;
  return `No ${missing.join(', ')} rows came with this map, so your own ${one ? 'table is' : 'tables are'} used as ${one ? 'it is' : 'they are'}. If ${one ? "it doesn't" : "they don't"} match this map and its tile libraries (the level's size and world position, the level type's DT1s and Dt1Mask, the loading-screen image, the automap), the game can crash when the map loads or while walking in it. After importing, use Map → Add to game and run the Compatibility check.`;
}

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  version: typeof PACKAGE_VERSION;
  /** ISO timestamp. */
  created: string;
  /** Game path of the DS1. */
  map: string;
  files: PackageFile[];
  txtRows: TxtRowEntry[];
  notes?: string;
}

export interface MapPackage {
  manifest: PackageManifest;
  files: { path: string; bytes: Uint8Array }[];
}

export interface BuildOptions {
  /** The DS1 as it should be shipped (usually `writeDs1(map.ds1)`, or the file's bytes). */
  ds1Bytes: Uint8Array;
  objectSpecs?: SpriteSpecLike[];
  txtRows?: TxtRowEntry[];
  notes?: string;
  /** Put DT1s from the base-game MPQs into the zip too (default true: they may be modded on the maker's side). */
  includeBaseGameDt1s?: boolean;
  /** Override for the manifest's `created` (tests). */
  created?: Date;
}

export interface BuildResult {
  zip: Uint8Array;
  manifest: PackageManifest;
  /** Referenced files that could not be found. */
  missing: string[];
}

/** Game path as stored in a package: forward slashes, no leading slash, original case kept. */
export function packagePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** True for paths that are absolute, drive-qualified, empty, or step outside the package root. */
export function isUnsafePath(p: string): boolean {
  if (!p || p.includes('\0')) return true;
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return true;
  return s.split('/').some((seg) => seg === '..' || seg === '.');
}

/** Whether a source label (from `LayeredFs.locate`) is one of the classic base-game archives. */
export function isBaseGameLabel(label: string): boolean {
  const name = label.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  return CLASSIC_MPQS.includes(name);
}

async function sha1Hex(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = new Uint8Array(await subtle.digest('SHA-1', bytes.slice()));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sprite files an object needs, in the same layout `sprites.ts` loads them from: the COF and, per COF layer with an
 * armour type in the spec, its DCC (else DC6). Without a readable COF, every part is tried with the spec's class.
 */
async function spriteFiles(fs: LayeredFs, spec: SpriteSpecLike): Promise<{ found: string[]; missing: string[] }> {
  const found: string[] = [];
  const missing: string[] = [];
  const cof = cofPath(spec as SpriteSpec);
  const cofBytes = await fs.read(cof);
  if (!cofBytes) return { found, missing: [cof] };
  found.push(cof);
  let layers: { code: string; weaponClass: string }[];
  try {
    layers = parseCof(cofBytes).layers.map((l) => ({ code: COMPONENTS[l.component] ?? '', weaponClass: l.weaponClass }));
  } catch {
    layers = Object.keys(spec.parts).map((code) => ({ code, weaponClass: spec.cls }));
  }
  for (const { code, weaponClass } of layers) {
    const armor = code && spec.parts[code];
    if (!armor) continue;
    const stem = layerPath(spec as SpriteSpec, code, armor, weaponClass || spec.cls);
    const hit = [`${stem}.dcc`, `${stem}.dc6`].find((p) => fs.locate(p));
    if (hit) found.push(hit);
    else missing.push(`${stem}.dcc`);
  }
  return { found, missing };
}

/**
 * Zips a map with everything it needs. DT1s are included wherever they live (base-game ones marked as such);
 * object sprite files only when they come from a loose/mod source, since every player has the base-game ones.
 */
export async function buildMapPackage(
  fs: LayeredFs,
  map: { path: string; ds1: Ds1; dt1Paths: string[] },
  opts: BuildOptions,
): Promise<BuildResult> {
  const includeBaseDt1s = opts.includeBaseGameDt1s ?? true;
  const entries = new Map<string, { path: string; bytes: Uint8Array; from: FileOrigin; omit?: boolean }>();
  const missing: string[] = [];
  const miss = (p: string) => {
    if (!missing.some((m) => normalizePath(m) === normalizePath(p))) missing.push(p);
  };
  const originOf = (p: string): FileOrigin => {
    const label = fs.locate(p);
    return label && isBaseGameLabel(label) ? 'base-game' : 'mod';
  };

  const mapPath = packagePath(map.path);
  if (isUnsafePath(mapPath)) throw new Error(`bad map path: ${map.path}`);
  entries.set(normalizePath(mapPath), { path: mapPath, bytes: opts.ds1Bytes, from: 'mod' });

  for (const raw of map.dt1Paths) {
    const path = packagePath(raw);
    const key = normalizePath(path);
    if (entries.has(key)) continue;
    const bytes = await fs.read(path);
    if (!bytes) {
      miss(path);
      continue;
    }
    const from = originOf(path);
    entries.set(key, { path, bytes, from, omit: from === 'base-game' && !includeBaseDt1s });
  }

  for (const spec of opts.objectSpecs ?? []) {
    const { found, missing: gone } = await spriteFiles(fs, spec);
    gone.forEach(miss);
    for (const raw of found) {
      const path = packagePath(raw);
      const key = normalizePath(path);
      if (entries.has(key) || originOf(path) === 'base-game') continue;
      const bytes = await fs.read(path);
      if (bytes) entries.set(key, { path, bytes, from: 'mod' });
      else miss(path);
    }
  }

  const files: PackageFile[] = [];
  const zipInput: Zippable = {};
  for (const e of entries.values()) {
    const file: PackageFile = { path: e.path, size: e.bytes.length, from: e.from };
    const sha1 = await sha1Hex(e.bytes);
    if (sha1) file.sha1 = sha1;
    if (e.omit) file.omitted = true;
    else zipInput[e.path] = e.bytes;
    files.push(file);
  }

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    created: (opts.created ?? new Date()).toISOString(),
    map: mapPath,
    files,
    txtRows: (opts.txtRows ?? []).map((r) => ({ table: r.table, key: r.key, columns: [...r.columns], row: [...r.row] })),
  };
  if (opts.notes) manifest.notes = opts.notes;
  validateTxtRows(manifest.txtRows);
  zipInput[MANIFEST_NAME] = strToU8(JSON.stringify(manifest, null, 2));
  return { zip: zipSync(zipInput, { level: 6 }), manifest, missing };
}


function validateTxtRows(rows: unknown): asserts rows is TxtRowEntry[] {
  if (!Array.isArray(rows)) throw new Error('manifest: txtRows must be an array');
  for (const r of rows as Partial<TxtRowEntry>[]) {
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
    if (!r || typeof r.table !== 'string' || typeof r.key !== 'string' || !strings(r.columns) || !strings(r.row))
      throw new Error('manifest: malformed txt row');
    if (isUnsafePath(txtTablePath(r.table))) throw new Error(`manifest: bad table name ${r.table}`);
    if (!r.columns.includes(r.key)) throw new Error(`manifest: ${r.table} row has no "${r.key}" column`);
    if ([...r.columns, ...r.row].some((s) => /[\t\r\n]/.test(s))) throw new Error(`manifest: ${r.table} row contains tabs or line breaks`);
  }
}

/** Game path of a txt table: `LvlPrest` -> `data/global/excel/LvlPrest.txt`. */
export function txtTablePath(table: string): string {
  const t = packagePath(table);
  if (t.includes('/')) return t;
  return `data/global/excel/${/\.txt$/i.test(t) ? t : `${t}.txt`}`;
}

/** Unzips and validates a package. Throws on a missing/invalid manifest or any unsafe path. */
export function readMapPackage(zip: Uint8Array): MapPackage {
  const entries = unzipSync(zip);
  const files: { path: string; bytes: Uint8Array }[] = [];
  let manifestBytes: Uint8Array | null = null;
  const seen = new Set<string>();
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/') && !bytes.length) continue; // directory entry
    if (isUnsafePath(name)) throw new Error(`package: unsafe path ${JSON.stringify(name)}`);
    if (name === MANIFEST_NAME) {
      manifestBytes = bytes;
      continue;
    }
    const key = normalizePath(name);
    if (seen.has(key)) throw new Error(`package: duplicate file ${name}`);
    seen.add(key);
    files.push({ path: packagePath(name), bytes });
  }
  if (!manifestBytes) throw new Error(`package: no ${MANIFEST_NAME}`);
  let m: Partial<PackageManifest>;
  try {
    m = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new Error('package: manifest is not valid JSON');
  }
  if (!m || typeof m !== 'object') throw new Error('package: manifest is not an object');
  if (m.format !== PACKAGE_FORMAT) throw new Error(`package: unknown format ${JSON.stringify(m.format)}`);
  if (m.version !== PACKAGE_VERSION) throw new Error(`package: unsupported version ${JSON.stringify(m.version)}`);
  if (typeof m.created !== 'string' || typeof m.map !== 'string') throw new Error('package: manifest lacks created/map');
  if (isUnsafePath(m.map) || !/\.ds1$/i.test(m.map)) throw new Error(`package: bad map path ${JSON.stringify(m.map)}`);
  if (!Array.isArray(m.files)) throw new Error('package: manifest files must be an array');
  const byPath = new Map(files.map((f) => [normalizePath(f.path), f]));
  for (const f of m.files as Partial<PackageFile>[]) {
    if (!f || typeof f.path !== 'string' || typeof f.size !== 'number' || (f.from !== 'mod' && f.from !== 'base-game'))
      throw new Error('package: malformed file entry');
    if (isUnsafePath(f.path)) throw new Error(`package: unsafe path ${JSON.stringify(f.path)}`);
    if (f.omitted) continue;
    const actual = byPath.get(normalizePath(f.path));
    if (!actual) throw new Error(`package: ${f.path} is listed but not in the zip`);
    if (actual.bytes.length !== f.size) throw new Error(`package: ${f.path} size mismatch`);
  }
  if (!byPath.has(normalizePath(m.map))) throw new Error(`package: map ${m.map} is not in the zip`);
  validateTxtRows(m.txtRows ?? []);
  if (m.notes !== undefined && typeof m.notes !== 'string') throw new Error('package: notes must be a string');
  const manifest: PackageManifest = { ...(m as PackageManifest), txtRows: m.txtRows ?? [] };
  return { manifest, files };
}

export type WriteAction = 'new' | 'overwrite' | 'identical';

export interface TxtMergePlan {
  table: string;
  /** Game path of the table. */
  path: string;
  /** Key column name. */
  key: string;
  keyValue: string;
  /** Whether a row with that key already exists (false also when the table itself is missing). */
  exists: boolean;
  action: TxtMergeAction | 'missing-table' | 'merged' | 'failed';
  /** What changed, in words (level tables are merged by meaning, not row by row). */
  note?: string;
}

export interface ImportPlan {
  writes: { path: string; bytes: Uint8Array; action: WriteAction }[];
  txtMerges: TxtMergePlan[];
  /** Resulting table contents for every table that changes (all of a table's rows applied in order). */
  txtWrites: { path: string; bytes: Uint8Array }[];
  /** Which of the map's tables came with the package (see MAP_TABLES). */
  coverage: TableCoverage[];
  /**
   * The package's cube recipe and map item, as a suggestion. They aren't merged: the item's code, the level it opens
   * and its name strings belong to the maker's tables, so the import makes a new recipe with the Cube recipe tool.
   */
  recipe: RecipeSuggestion | null;
}

export interface RecipeSuggestion {
  /** The recipe's inputs as CubeMain.txt writes them (quotes removed), e.g. `tbk`, `gem4,qty=3`. */
  inputs: string[];
  /** The map item's name in the package's Misc.txt. */
  itemName: string | null;
}

/** The package's cube recipe and item (see ImportPlan.recipe). */
export function recipeSuggestion(rows: TxtRowEntry[]): RecipeSuggestion | null {
  const name = (t: string) => t.replace(/\.txt$/i, '').split('/').pop()!.toLowerCase();
  const cube = rows.find((r) => name(r.table) === 'cubemain');
  if (!cube) return null;
  const cell = (r: TxtRowEntry, col: string) => (r.row[r.columns.indexOf(col)] ?? '').replace(/"/g, '').trim();
  const inputs = [1, 2, 3, 4, 5, 6, 7].map((i) => cell(cube, `input ${i}`)).filter(Boolean);
  const code = cell(cube, 'output').split(',')[0];
  const item = rows.find((r) => name(r.table) === 'misc' && cell(r, 'code') === code);
  return { inputs, itemName: item ? cell(item, 'name') || null : null };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Decides what importing a package would change, comparing byte-wise against the current fs. Writes nothing.
 * (Async because `LayeredFs.read` is.)
 */
export async function planImport(pkg: MapPackage, fs: LayeredFs): Promise<ImportPlan> {
  const writes: ImportPlan['writes'] = [];
  for (const f of pkg.files) {
    const current = await fs.read(f.path);
    writes.push({ path: f.path, bytes: f.bytes, action: !current ? 'new' : sameBytes(current, f.bytes) ? 'identical' : 'overwrite' });
  }
  const txtMerges: TxtMergePlan[] = [];
  const tables = new Map<string, { path: string; original: Uint8Array; bytes: Uint8Array }>();
  const tableName = (t: string) => t.replace(/\.txt$/i, '').split('/').pop()!.toLowerCase();
  const LEVEL_TABLES = ['lvlprest', 'levels', 'lvltypes'];
  const core = pkg.manifest.txtRows.filter((r) => LEVEL_TABLES.includes(tableName(r.table)));
  // LvlPrest / Levels / LvlTypes are merged by meaning: DT1s go into free LvlTypes slots, clashing ids get new ones
  // and the Dt1Mask is recomputed against this install's slots.
  let levelIds = new Map<string, string>();
  let typeIds = new Map<string, string>();
  if (core.length) {
    const dt1s = pkg.manifest.files.filter((f) => /\.dt1$/i.test(f.path)).map((f) => f.path);
    try {
      const merged = await mergeMapRows(fs, pkg.manifest.map, core, dt1s);
      levelIds = merged.levelIds;
      typeIds = merged.typeIds;
      for (const w of merged.writes) {
        const original = (await fs.read(w.path))!;
        tables.set(normalizePath(w.path), { path: w.path, original, bytes: w.bytes });
        for (const note of w.summary) txtMerges.push({ table: w.table, path: w.path, key: '', keyValue: '', exists: true, action: 'merged', note });
      }
      if (!merged.writes.length) txtMerges.push({ table: 'Level tables', path: '', key: '', keyValue: '', exists: true, action: 'unchanged', note: 'already set up' });
    } catch (e) {
      const missing = /not found/.test((e as Error).message);
      txtMerges.push({ table: 'Level tables', path: '', key: '', keyValue: '', exists: false, action: missing ? 'missing-table' : 'failed', note: (e as Error).message });
    }
  }
  for (const r0 of pkg.manifest.txtRows) {
    // Level tables were merged above; the recipe and its item are made anew for this install (ImportPlan.recipe).
    if (LEVEL_TABLES.includes(tableName(r0.table)) || ['cubemain', 'misc'].includes(tableName(r0.table))) continue;
    const r = tableName(r0.table) === 'automap' ? remapAutomapLevel(r0, typeIds) : remapLevelIds(r0, levelIds);
    const path = txtTablePath(r.table);
    const keyValue = r.row[r.columns.indexOf(r.key)] ?? '';
    const key = normalizePath(path);
    let t = tables.get(key);
    if (!t) {
      const bytes = await fs.read(path);
      if (bytes) tables.set(key, (t = { path, original: bytes, bytes }));
    }
    if (!t) {
      txtMerges.push({ table: r.table, path, key: r.key, keyValue, exists: false, action: 'missing-table' });
      continue;
    }
    // AutoMap rows have no key of their own (a level type has many): each is added unless an identical one is there.
    const merged = tableName(r.table) === 'automap' ? addTxtRow(t.bytes, r.columns, r.row) : mergeTxtRow(t.bytes, r.columns, r.row, r.key);
    txtMerges.push({ table: r.table, path, key: r.key, keyValue, exists: merged.action !== 'appended', action: merged.action });
    t.bytes = merged.bytes;
  }
  const txtWrites = [...tables.values()].filter((t) => !sameBytes(t.original, t.bytes)).map((t) => ({ path: t.path, bytes: t.bytes }));
  return { writes, txtMerges, txtWrites, coverage: tableCoverage(pkg.manifest.txtRows), recipe: recipeSuggestion(pkg.manifest.txtRows) };
}

export type TxtMergeAction = 'appended' | 'replaced' | 'unchanged';

/** Columns of the extra tables that hold a Levels.txt Id. */
const LEVEL_ID_COLUMNS: Record<string, string[]> = { lvlmaze: ['Level'] };

function remapLevelIds(r: TxtRowEntry, ids: Map<string, string>): TxtRowEntry {
  const cols = LEVEL_ID_COLUMNS[r.table.replace(/\.txt$/i, '').split('/').pop()!.toLowerCase()];
  if (!cols || !ids.size) return r;
  const row = r.row.map((v, i) => (cols.includes(r.columns[i]) && ids.has(v.trim()) ? ids.get(v.trim())! : v));
  return { ...r, row };
}

/** AutoMap rows name their level type by LvlTypes Name or Id: an Id the import renumbered follows it. */
function remapAutomapLevel(r: TxtRowEntry, ids: Map<string, string>): TxtRowEntry {
  const i = r.columns.indexOf('LevelName');
  const v = i >= 0 ? r.row[i]?.trim() : undefined;
  if (v === undefined || !ids.has(v)) return r;
  return { ...r, row: r.row.map((c, j) => (j === i ? ids.get(v)! : c)) };
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

function toLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new Error(`character ${JSON.stringify(s[i])} cannot be stored in a txt table`);
    out[i] = c;
  }
  return out;
}

/**
 * Merges one row into a tab-separated D2 txt table by column name. The row whose `keyColumn` matches is replaced
 * (cells for columns the package doesn't know keep their values); otherwise the row is appended after the last
 * non-blank line. Never adds columns: unknown ones are ignored. Every other byte, line endings included, is kept.
 */
/** A txt table's lines with their terminators (so untouched lines are copied verbatim), its header and line ending. */
function txtLines(tableBytes: Uint8Array) {
  const text = latin1(tableBytes);
  const lines: { body: string; eol: string }[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  for (let m = re.exec(text); m && m.index < text.length; m = re.exec(text)) lines.push({ body: m[1], eol: m[2] });
  if (!lines.length) throw new Error('txt table is empty');
  return { lines, header: lines[0].body.split('\t'), eol: lines[0].eol || '\r\n' };
}

/** The table with `line` added after its last non-blank line. */
function appendLine(lines: { body: string; eol: string }[], line: string, eol: string): Uint8Array {
  let last = lines.length - 1;
  while (last > 0 && !lines[last].body.trim()) last--;
  const before = lines.slice(0, last + 1);
  const after = lines.slice(last + 1);
  let out: string;
  if (before[last].eol) out = before.map((l) => l.body + l.eol).join('') + line + eol;
  else out = before.map((l) => l.body + l.eol).join('') + eol + line; // file had no final line break; keep it that way
  out += after.map((l) => l.body + l.eol).join('');
  return toLatin1(out);
}

/**
 * Adds a row to a table without a key column of its own (AutoMap.txt), by column name, unless a row with the same
 * values in every column the two share is already there.
 */
export function addTxtRow(tableBytes: Uint8Array, columns: string[], row: string[]): { bytes: Uint8Array; action: TxtMergeAction } {
  const { lines, header, eol } = txtLines(tableBytes);
  // The same header: cell by cell (AutoMap.txt names a column twice); else by column name.
  const sameHeader = columns.length === header.length && columns.every((c, i) => c === header[i]);
  const cells = header.map((col, i) => {
    const j = sameHeader ? i : columns.indexOf(col);
    return j < 0 ? '' : (row[j] ?? '');
  });
  if (cells.some((c) => /[\t\r\n]/.test(c))) throw new Error('row contains tabs or line breaks');
  const shared = header.map((col, i) => (sameHeader || columns.includes(col) ? i : -1)).filter((i) => i >= 0);
  const same = (body: string) => {
    const old = body.split('\t');
    return shared.every((c) => (old[c] ?? '').trim() === cells[c].trim());
  };
  if (lines.some((l, i) => i > 0 && l.body.trim() && same(l.body))) return { bytes: tableBytes, action: 'unchanged' };
  return { bytes: appendLine(lines, cells.join('\t'), eol), action: 'appended' };
}

export function mergeTxtRow(
  tableBytes: Uint8Array,
  columns: string[],
  row: string[],
  keyColumn: string,
): { bytes: Uint8Array; action: TxtMergeAction } {
  const { lines, header, eol } = txtLines(tableBytes);

  const keyIdx = header.indexOf(keyColumn);
  if (keyIdx < 0) throw new Error(`table has no "${keyColumn}" column`);
  const srcKeyIdx = columns.indexOf(keyColumn);
  const keyValue = srcKeyIdx >= 0 ? (row[srcKeyIdx] ?? '') : '';
  if (!keyValue.trim()) throw new Error(`row has no value for key column "${keyColumn}"`);
  const valueOf = (col: string): string | undefined => {
    const i = columns.indexOf(col);
    return i < 0 ? undefined : (row[i] ?? '');
  };
  for (const col of header) if (/[\t\r\n]/.test(valueOf(col) ?? '')) throw new Error(`value for "${col}" contains tabs or line breaks`);

  const target = lines.findIndex((l, i) => i > 0 && (l.body.split('\t')[keyIdx] ?? '').trim() === keyValue.trim());
  if (target >= 0) {
    const old = lines[target].body.split('\t');
    const cells = header.map((col, i) => valueOf(col) ?? old[i] ?? '');
    // Keep any cells beyond the header (some tables carry stray trailing tabs).
    const merged = [...cells, ...old.slice(header.length)];
    const same = header.every((_, i) => (old[i] ?? '') === merged[i]);
    if (same) return { bytes: tableBytes, action: 'unchanged' };
    lines[target] = { body: merged.join('\t'), eol: lines[target].eol };
    return { bytes: toLatin1(lines.map((l) => l.body + l.eol).join('')), action: 'replaced' };
  }

  // Only the appended text differs, so the original bytes form a prefix (plus any trailing blank lines after it).
  return { bytes: appendLine(lines, header.map((col) => valueOf(col) ?? '').join('\t'), eol), action: 'appended' };
}

/**
 * The txt rows a map needs: LvlPrest rows naming its file, their Levels rows (by LevelId), and those levels'
 * LvlTypes rows. Rows are read from the current fs with their table headers.
 */
export async function collectMapTxtRows(fs: LayeredFs, mapPath: string): Promise<TxtRowEntry[]> {
  const out: TxtRowEntry[] = [];
  const load = async (name: string) => {
    const bytes = await fs.read(`data/global/excel/${name}.txt`);
    return bytes ? parseTxt(bytes) : null;
  };
  const [prest, levels, types] = await Promise.all([load('LvlPrest'), load('Levels'), load('LvlTypes')]);
  if (!prest) return out;
  const rel = normalizePath(mapPath).replace(/^data\/global\/tiles\//, '');
  const levelIds = new Set<string>();
  for (const r of prest.rows) {
    const files = [1, 2, 3, 4, 5, 6].map((i) => normalizePath(r[`File${i}`] ?? ''));
    if (!files.includes(rel) || !r['Name']) continue;
    out.push({ table: 'LvlPrest', key: 'Name', columns: prest.columns, row: prest.columns.map((c) => r[c] ?? '') });
    if (Number(r['LevelId']) > 0) levelIds.add(String(Number(r['LevelId'])));
  }
  const typeIds = new Set<string>();
  for (const r of levels?.rows ?? []) {
    if (!levelIds.has(r['Id']?.trim())) continue;
    out.push({ table: 'Levels', key: 'Id', columns: levels!.columns, row: levels!.columns.map((c) => r[c] ?? '') });
    if (r['LevelType']?.trim()) typeIds.add(r['LevelType'].trim());
  }
  for (const r of types?.rows ?? []) {
    if (!typeIds.has(r['Id']?.trim()) || r['Name'] === 'Expansion') continue;
    out.push({ table: 'LvlTypes', key: 'Id', columns: types!.columns, row: types!.columns.map((c) => r[c] ?? '') });
  }
  // The automap pieces of those level types, found the way the automap editor finds them (the game's own tables use
  // short names like "1 Town" for "Act 1 - Town"; mods their LvlTypes Name or Id).
  // Read by position: AutoMap.txt's header names Type2 twice, so rows keyed by column name would lose a cel.
  const automapBytes = typeIds.size ? await fs.read('data/global/excel/AutoMap.txt') : null;
  if (automapBytes) {
    const [head, ...lines] = new TextDecoder('latin1').decode(automapBytes).split(/\r?\n/);
    const columns = head.split('\t');
    const rows = lines.filter((l) => l.trim()).map((l) => l.split('\t'));
    const at = columns.indexOf('LevelName');
    const levels = [...new Set(rows.map((r) => r[at] ?? '').filter((l) => l.trim()))];
    const names = new Set<string>();
    for (const r of types?.rows ?? []) {
      if (!typeIds.has(r['Id']?.trim())) continue;
      const level = automapLevelFor({ levels } as AutomapTable, r['Name'], undefined, Number(r['Id']));
      if (level) names.add(level.trim().toLowerCase());
    }
    for (const r of rows)
      if (names.has((r[at] ?? '').trim().toLowerCase())) out.push({ table: 'AutoMap', key: 'LevelName', columns, row: columns.map((_, i) => r[i] ?? '') });
  }
  const levelRows = (levels?.rows ?? []).filter((r) => levelIds.has(r['Id']?.trim()));
  const push = (table: string, key: string, t: NonNullable<Awaited<ReturnType<typeof load>>>, r: Record<string, string>) =>
    out.push({ table, key, columns: t.columns, row: t.columns.map((c) => r[c] ?? '') });

  // The level's warps (Levels Warp0..7 -> LvlWarp Id) and its maze settings (LvlMaze Level).
  const warps = new Set(levelRows.flatMap((r) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => r[`Warp${i}`]?.trim()).filter((v) => v && v !== '-1' && v !== '0')));
  if (warps.size) {
    const lvlWarp = await load('LvlWarp');
    for (const r of lvlWarp?.rows ?? []) if (warps.has(r['Id']?.trim())) push('LvlWarp', 'Id', lvlWarp!, r);
  }
  if (levelIds.size) {
    const maze = await load('LvlMaze');
    for (const r of maze?.rows ?? []) if (levelIds.has(r['Level']?.trim())) push('LvlMaze', 'Level', maze!, r);
  }
  // A cube recipe made for this map (Map → Cube recipe tags it) and the item it makes.
  const mapName = rel.split('/').pop()!.replace(/\.ds1$/i, '').toLowerCase();
  const cube = await load('CubeMain');
  const codes = new Set<string>();
  for (const r of cube?.rows ?? []) {
    if (!(r['description'] ?? '').toLowerCase().includes(`[map:${mapName}]`)) continue;
    push('CubeMain', 'description', cube!, r);
    const code = (r['output'] ?? '').split(',')[0].replace(/"/g, '').trim();
    if (code) codes.add(code);
  }
  if (codes.size) {
    const misc = await load('Misc');
    for (const r of misc?.rows ?? []) if (codes.has(r['code']?.trim())) push('Misc', 'code', misc!, r);
  }
  return out;
}
