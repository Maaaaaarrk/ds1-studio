import { ds1FileToDt1Path, isEmptyCell, parseDs1, type Ds1 } from '../formats/ds1';
import { parseDt1, type Dt1Tile } from '../formats/dt1';
import { buildDt1, dt1Records } from '../formats/dt1Write';
import { parseTxt } from '../formats/txt';
import { GameData } from './GameData';
import type { LayerRef } from './MapDocument';
import { normalizePath } from '../vfs/vfs';

export const tileIdentity = (orientation: number, main: number, sub: number) => [orientation, main, sub].join('|');
export interface TileUse { x: number; y: number; layer: LayerRef }
/** Include both halves of north corners, all animation frames and all random variants of each key. */
export function mapTileUses(ds1: Ds1): Map<string, TileUse[]> {
  const keys = new Map<string, TileUse[]>();
  const add = (key: string, use: TileUse) => {
    const list = keys.get(key);
    if (list) list.push(use); else keys.set(key, [use]);
  };
  for (const kind of ['floor', 'wall', 'shadow'] as const) {
    const layers = kind === 'floor' ? ds1.floors : kind === 'wall' ? ds1.walls : ds1.shadows;
    layers.forEach((cells, index) => cells.forEach((c, i) => {
      if (isEmptyCell(c)) return;
      const orientation = kind === 'wall' ? (c as typeof ds1.walls[0][0]).orientation : kind === 'floor' ? 0 : 13;
      const use = { x: i % ds1.width, y: Math.floor(i / ds1.width), layer: { kind, index } };
      add(tileIdentity(orientation, c.mainIndex, c.subIndex), use);
      if (orientation === 3) add(tileIdentity(4, c.mainIndex, c.subIndex), use);
    }));
  }
  return keys;
}

export interface AssetUsage {
  path: string;
  source: string | null;
  tiles: Dt1Tile[];
  /** All DS1s that load/reference this library, even if they paint none of its tiles. */
  maps: string[];
  usedKeys: Set<string>;
  unusedIndices: number[];
  bytes?: Uint8Array;
  protected?: boolean;
  error?: string;
}
export interface UsageScan { assets: AssetUsage[]; mapsScanned: number; errors: string[]; warnings: string[] }

/** Conservative: one unreadable DS1 makes cleanup unavailable, rather than labelling unknown use as unused. */
export async function scanAssetUsage(
  gd: GameData,
  current: { path: string; ds1: Ds1; paths: string[] } | null,
  progress: (done: number, total: number, phase: string) => void = () => {},
  signal?: AbortSignal,
): Promise<UsageScan> {
  const check = () => { if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError'); };
  const errors: string[] = [];
  const warnings: string[] = [];
  const protectedLibraries = new Set<string>();
  const maps = new Map(gd.fs.list(p => p.endsWith('.ds1')).map(p => [normalizePath(p), p]));
  const paths = new Set(gd.fs.list(p => p.endsWith('.dt1')).map(normalizePath));
  const references = new Map<string, Set<string>>();
  const uses = new Map<string, Set<string>>();
  const prestBytes = await gd.fs.read('data/global/excel/LvlPrest.txt');
  const levelsBytes = await gd.fs.read('data/global/excel/Levels.txt');
  const prest = prestBytes ? parseTxt(prestBytes).rows : [];
  const levels = levelsBytes ? parseTxt(levelsBytes).rows : [];
  const types = new Map(gd.lvlTypes.map(t => [t.id, t]));
  const levelTypes = new Map(levels.map(r => [Number(r.Id), Number(r.LevelType)]));
  const tablePaths = new Map<string, Set<string>>();
  for (const row of prest) {
    const type = types.get(levelTypes.get(Number(row.LevelId)) ?? -1);
    for (let i = 1; i <= 6; i++) {
      const name = row['File' + i];
      if (!name || name === '0') continue;
      const path = normalizePath('data/global/tiles/' + name);
      maps.set(path, path);
      if (type) {
        const set = tablePaths.get(path) ?? new Set<string>();
        GameData.dt1sFor(type, Number(row.Dt1Mask) >>> 0).forEach(p => set.add(normalizePath(p)));
        tablePaths.set(path, set);
      }
    }
  }
  if (current) maps.set(normalizePath(current.path), current.path);
  let done = 0;
  for (const [key, path] of maps) {
    check();
    progress(done++, maps.size, 'Reading maps');
    try {
      const active = current && normalizePath(current.path) === key;
      // Check shadowed maps and the last saved map too. Unsaved removal of a tile must not free its library on disk.
      const versions: Ds1[] = active ? [current.ds1] : [];
      for (const source of gd.fs.sources) {
        if (!source.has(path)) continue;
        const bytes = await source.read(path);
        if (bytes) versions.push(parseDs1(bytes));
      }
      if (!versions.length) versions.push(parseDs1(await gd.fs.readOrThrow(path)));
      for (const ds1 of versions) {
      const libs = new Set([
        ...gd.resolveDt1s(path, ds1).paths,
        ...ds1.files.map(ds1FileToDt1Path).filter((p): p is string => !!p),
        ...(tablePaths.get(key) ?? []),
        ...(active ? current.paths : []),
      ].map(normalizePath).filter(p => !p.startsWith('builtin/')));
      const keys = mapTileUses(ds1);
      for (const lib of libs) {
        paths.add(lib);
        const refs = references.get(lib) ?? new Set<string>(); refs.add(path); references.set(lib, refs);
        const used = uses.get(lib) ?? new Set<string>(); keys.forEach((_, k) => used.add(k)); uses.set(lib, used);
      }
      }
    } catch (e) {
      const known = tablePaths.get(key);
      if (known?.size && !gd.fs.locate(path)) {
        // Missing table-only maps are common in mods. Protect every tile in their known libraries.
        for (const lib of known) {
          paths.add(lib); protectedLibraries.add(lib);
          const refs = references.get(lib) ?? new Set<string>(); refs.add(path); references.set(lib, refs);
        }
        warnings.push(path + ': not found; its referenced libraries are protected.');
      } else errors.push(path + ': ' + (e as Error).message);
    }
    if (done % 12 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const assets: AssetUsage[] = [];
  done = 0;
  for (const path of [...paths].sort()) {
    check(); progress(done++, paths.size, 'Checking tile libraries');
    const usedKeys = uses.get(path) ?? new Set<string>();
    const asset: AssetUsage = { path, source: gd.fs.locate(path), tiles: [], maps: [...(references.get(path) ?? [])], usedKeys, unusedIndices: [] };
    try {
      // Parse raw bytes: a stale GameData tile cache must not decide whether destructive cleanup is safe.
      asset.bytes = await gd.fs.readOrThrow(path);
      asset.tiles = parseDt1(asset.bytes).tiles;
      asset.protected = protectedLibraries.has(path);
      asset.unusedIndices = asset.protected ? [] : asset.tiles.flatMap((t, i) => usedKeys.has(tileIdentity(t.orientation, t.mainIndex, t.subIndex)) ? [] : [i]);
    } catch (e) { asset.error = (e as Error).message; }
    assets.push(asset);
    if (done % 12 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return { assets, mapsScanned: maps.size - errors.length - warnings.length, errors, warnings };
}

/** Returns all placements that may reference a library, including shared IDs and animation variants. */
export function usesOfLibrary(ds1: Ds1, tiles: Dt1Tile[]): TileUse[] {
  const uses = mapTileUses(ds1);
  const out = new Map<string, TileUse>();
  for (const tile of tiles) for (const u of uses.get(tileIdentity(tile.orientation, tile.mainIndex, tile.subIndex)) ?? [])
    out.set([u.layer.kind, u.layer.index, u.x, u.y].join(':'), u);
  return [...out.values()];
}

export function splitUnusedTiles(bytes: Uint8Array, indices: readonly number[]): { remaining: Uint8Array | null; removed: Uint8Array } {
  const tiles = parseDt1(bytes).tiles;
  const records = dt1Records(bytes);
  const selected = new Set(indices);
  if (!selected.size || [...selected].some(i => !Number.isInteger(i) || i < 0 || i >= tiles.length)) throw new Error('Select valid tiles to remove.');
  // A frame/variant group must remain intact. A DS1 references the whole identity, never one frame.
  const groups = new Map<string, number[]>();
  tiles.forEach((t, i) => {
    const key = tileIdentity(t.orientation, t.mainIndex, t.subIndex);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const group of groups.values()) if (group.some(i => selected.has(i)) && group.some(i => !selected.has(i)))
    throw new Error('Select every frame/variant of a tile group before removing it.');
  const make = (keep: boolean) => {
    const out = buildDt1(records.filter((_, i) => selected.has(i) === keep));
    out.set(bytes.subarray(8, 268), 8);
    return out;
  };
  return { remaining: selected.size === records.length ? null : make(false), removed: make(true) };
}
