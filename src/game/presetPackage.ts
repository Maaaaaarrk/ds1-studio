import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { normalizePath, type LayeredFs } from '../vfs/vfs';
import { MAX_TILE_PATH } from './addToGame';
import { isBaseGameLabel, isUnsafePath } from './mapPackage';
import { parsePreset, presetPath, serializePreset, type Preset } from './presets';

/**
 * Preset packages: one preset, a category or all of them in a .zip, with the mod's own tile libraries they use, so
 * they can be shared between mods. The game's own DT1s (in its archives) are left out: everyone has them.
 *
 *   ds1studio-presets.json   { format, version, presets: [...file names], dt1s: [...tile paths] }
 *   presets/<file>.json      the presets, as saved in data/ds1studio/presets
 *   tiles/<path>             the mod DT1s they use, at their path under data/global/tiles
 */
export const PRESET_PACKAGE = 'ds1studio-presets';
const MANIFEST = 'ds1studio-presets.json';
const TILES = 'data/global/tiles/';

interface Manifest {
  format: typeof PRESET_PACKAGE;
  version: 1;
  presets: string[];
  dt1s: string[];
}

const rel = (p: string) => p.replace(/\\/g, '/').replace(/^\/?data\/global\/tiles\//i, '');

/** The package for these presets: their files plus every tile library they use that isn't one of the game's own. */
export async function buildPresetPackage(fs: LayeredFs, presets: Preset[]): Promise<{ zip: Uint8Array; dt1s: string[]; missing: string[] }> {
  const files: Zippable = {};
  const names: string[] = [];
  for (const p of presets) {
    const name = (p.file ?? presetPath(p)).split('/').pop()!;
    files[`presets/${name}`] = serializePreset(p);
    names.push(name);
  }
  const wanted = new Map<string, string>();
  for (const p of presets) for (const d of [...p.dt1s, ...Object.values(p.tileSources ?? {})]) wanted.set(normalizePath(d), d);
  const dt1s: string[] = [];
  const missing: string[] = [];
  for (const [norm] of wanted) {
    const where = fs.locate(norm);
    if (!where) {
      missing.push(rel(norm));
      continue;
    }
    if (isBaseGameLabel(where)) continue;
    const bytes = await fs.read(norm);
    if (!bytes) {
      missing.push(rel(norm));
      continue;
    }
    const path = rel(fs.exactPath(norm) ?? norm);
    files[`tiles/${path}`] = bytes;
    dt1s.push(path);
  }
  const manifest: Manifest = { format: PRESET_PACKAGE, version: 1, presets: names, dt1s };
  files[MANIFEST] = strToU8(JSON.stringify(manifest, null, 1));
  return { zip: zipSync(files, { level: 6 }), dt1s, missing };
}

export interface PresetImportPlan {
  /** The presets to save (new ids where one is taken; tile paths changed where a DT1 had to be renamed). */
  presets: Preset[];
  /** Tile libraries to write into the mod. */
  dt1Writes: { path: string; bytes: Uint8Array }[];
  /** DT1s already in the mod exactly as packaged (not written again). */
  same: string[];
  /** DT1s whose path holds a different file in this mod: written under a new name instead (tiles-relative). */
  renamed: { from: string; to: string }[];
  /** Presets already here unchanged (skipped). */
  duplicates: string[];
  /** Things that will be wrong after importing (tile libraries missing from this game/mod, unreadable files). */
  problems: string[];
}

/** What importing a package (.zip) or a single preset (.json) would add, without writing anything. */
export async function planPresetImport(fs: LayeredFs, bytes: Uint8Array, existing: Preset[]): Promise<PresetImportPlan> {
  const plan: PresetImportPlan = { presets: [], dt1Writes: [], same: [], renamed: [], duplicates: [], problems: [] };
  let presetFiles: { name: string; bytes: Uint8Array }[] = [];
  let tiles: Record<string, Uint8Array> = {};
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new Error('This file is not a readable .zip.');
    }
    const manifestBytes = entries[MANIFEST];
    if (!manifestBytes) throw new Error('This .zip is not a DS1 Studio preset package (no ds1studio-presets.json).');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(strFromU8(manifestBytes)) as Manifest;
    } catch {
      throw new Error('The package description (ds1studio-presets.json) is damaged.');
    }
    if (manifest.format !== PRESET_PACKAGE) throw new Error('This .zip is not a DS1 Studio preset package.');
    for (const [name, data] of Object.entries(entries)) {
      if (isUnsafePath(name)) continue;
      if (name.startsWith('presets/') && name.endsWith('.json')) presetFiles.push({ name: name.slice(8), bytes: data });
      else if (name.startsWith('tiles/') && name.toLowerCase().endsWith('.dt1')) tiles[name.slice(6)] = data;
    }
  } else {
    presetFiles = [{ name: 'preset.json', bytes }];
    tiles = {};
  }
  if (!presetFiles.length) throw new Error('There are no presets in this file.');

  // Tile libraries: kept at their path when free or identical, else written under a new name the presets point to.
  const moved = new Map<string, string>(); // normalized full path → new full path
  for (const [path, data] of Object.entries(tiles)) {
    const full = TILES + path;
    const here = await fs.read(full);
    if (here && same(here, data)) {
      plan.same.push(path);
      continue;
    }
    if (!here) {
      plan.dt1Writes.push({ path: full, bytes: data });
      continue;
    }
    // Another file under that name in this mod: keep both, the imported one renamed.
    const target = freeName(fs, path, plan.dt1Writes);
    if (!target) {
      plan.problems.push(`${path}: a different file with this name is already in your mod, and no free shorter name fits the game's ${MAX_TILE_PATH}-character limit. Import skipped it.`);
      continue;
    }
    plan.dt1Writes.push({ path: TILES + target, bytes: data });
    plan.renamed.push({ from: path, to: target });
    moved.set(normalizePath(full), TILES + target);
  }

  const taken = new Set(existing.map((p) => p.id));
  const missing = new Set<string>();
  for (const f of presetFiles) {
    const p = parsePreset(f.bytes);
    if (!p) {
      plan.problems.push(`${f.name}: not a DS1 Studio preset.`);
      continue;
    }
    const swap = (d: string) => moved.get(normalizePath(d)) ?? d;
    const next: Preset = {
      ...p,
      dt1s: p.dt1s.map(swap),
      tileSources: p.tileSources ? Object.fromEntries(Object.entries(p.tileSources).map(([k, v]) => [k, swap(v)])) : undefined,
      file: undefined,
    };
    const twin = existing.find((e) => e.id === p.id);
    if (twin && JSON.stringify(serializeForCompare(twin)) === JSON.stringify(serializeForCompare(next))) {
      plan.duplicates.push(p.name);
      continue;
    }
    if (taken.has(next.id)) next.id = Math.random().toString(36).slice(2, 10);
    taken.add(next.id);
    plan.presets.push(next);
    for (const d of next.dt1s) {
      const n = normalizePath(d);
      if (!fs.locate(n) && !plan.dt1Writes.some((w) => normalizePath(w.path) === n)) missing.add(rel(d));
    }
  }
  for (const m of missing) plan.problems.push(`${m} isn't in this game or mod (and wasn't in the package): presets using it show those tiles as missing.`);
  return plan;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function serializeForCompare(p: Preset): unknown {
  const { file: _f, occurrences: _o, foundIn: _i, ...rest } = p;
  return rest;
}

/** A free name for a clashing DT1 in its folder: <name>2.dt1, <name>3.dt1… (shortened to fit the path limit). */
function freeName(fs: LayeredFs, path: string, pending: { path: string }[]): string | null {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = path.slice(slash + 1).replace(/\.dt1$/i, '');
  for (let n = 2; n < 100; n++) {
    const suffix = String(n);
    const room = MAX_TILE_PATH - dir.length - suffix.length - 4;
    if (room < 1) return null;
    const candidate = `${dir}${base.slice(0, room)}${suffix}.dt1`;
    const full = TILES + candidate;
    if (!fs.locate(full) && !pending.some((w) => normalizePath(w.path) === normalizePath(full))) return candidate;
  }
  return null;
}
