import type { Brush } from '../game/MapDocument';

/**
 * Small per-computer conveniences kept in localStorage: recently used and pinned tiles (per tile set, since the same
 * numbers mean different tiles in another act) and recently opened maps. Nothing here is needed to open or save maps,
 * so every access tolerates a missing or blocked storage.
 */

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // per-viewer convenience only
  }
}

const same = (a: Brush, b: Brush) => a.orientation === b.orientation && a.main === b.main && a.sub === b.sub;
const trim = (b: Brush): Brush => ({ orientation: b.orientation, main: b.main, sub: b.sub });

const RECENT_TILES = 'ds1studio.recentTiles';
const PINNED_TILES = 'ds1studio.pinnedTiles';
const MAX_RECENT_TILES = 16;

export function recentTiles(set: string): Brush[] {
  return read<Record<string, Brush[]>>(RECENT_TILES, {})[set] ?? [];
}

/** Moves `b` to the front of the tile set's recent list; returns the new list. */
export function noteTileUse(set: string, b: Brush): Brush[] {
  const all = read<Record<string, Brush[]>>(RECENT_TILES, {});
  const list = [trim(b), ...(all[set] ?? []).filter((x) => !same(x, b))].slice(0, MAX_RECENT_TILES);
  all[set] = list;
  write(RECENT_TILES, all);
  return list;
}

export function pinnedTiles(set: string): Brush[] {
  return read<Record<string, Brush[]>>(PINNED_TILES, {})[set] ?? [];
}

/** Pins or unpins `b`; returns the new list. */
export function togglePinned(set: string, b: Brush): Brush[] {
  const all = read<Record<string, Brush[]>>(PINNED_TILES, {});
  const cur = all[set] ?? [];
  const list = cur.some((x) => same(x, b)) ? cur.filter((x) => !same(x, b)) : [...cur, trim(b)];
  all[set] = list;
  write(PINNED_TILES, all);
  return list;
}

export interface RecentMap {
  path: string;
  time: number;
}

const RECENT_MAPS = 'ds1studio.recentMaps';
const REOPEN_LAST = 'ds1studio.reopenLast';
const MAX_RECENT_MAPS = 12;

export function recentMaps(): RecentMap[] {
  return read<RecentMap[]>(RECENT_MAPS, []);
}

export function addRecentMap(path: string, max = MAX_RECENT_MAPS): RecentMap[] {
  const list = [{ path, time: Date.now() }, ...recentMaps().filter((m) => m.path.toLowerCase() !== path.toLowerCase())].slice(0, Math.max(1, max));
  write(RECENT_MAPS, list);
  return list;
}

export function clearRecentMaps(): void {
  write(RECENT_MAPS, []);
}

export function reopenLast(): boolean {
  return read<boolean>(REOPEN_LAST, false);
}

export function setReopenLast(on: boolean): void {
  write(REOPEN_LAST, on);
}
