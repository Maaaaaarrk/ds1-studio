import type { Dt1 } from '../formats/dt1';
import { TileLibrary } from './GameData';
import { isBuiltinPath } from './specialTiles';

export interface DuplicateDt1 {
  /** Loaded first / later (the order of the map's tile libraries). */
  earlier: string;
  later: string;
  /** Tile numbers (orientation, main, sub) both provide. */
  shared: Set<number>;
}

/** The tile numbers (orientation, main, sub) a DT1 provides. */
export function tileKeys(dt1: Pick<Dt1, 'tiles'>): Set<number> {
  return new Set(dt1.tiles.map((t) => TileLibrary.key(t.orientation, t.mainIndex, t.subIndex)));
}

/** Tile numbers two DT1s share when one is a copy of the other (most of the smaller file's tiles), else null. */
export function sharedTiles(a: Set<number>, b: Set<number>): Set<number> | null {
  const shared = new Set([...a].filter((k) => b.has(k)));
  // A copy, not two libraries that happen to reuse a few numbers.
  return shared.size >= 4 && shared.size >= 0.8 * Math.min(a.size, b.size) ? shared : null;
}

/**
 * Pairs of the map's DT1s that provide (mostly) the same tiles, like a DT1 and an imported or edited copy of it. Where
 * a tile number has random variants, the game picks among the variants of *every* loaded DT1, so the map shows a
 * random mix of the two copies (in game too).
 */
export function duplicateDt1s(lib: TileLibrary): DuplicateDt1[] {
  const libs = lib.loaded
    .filter((l) => l.found && !isBuiltinPath(l.path))
    .map((l) => ({ path: l.path, keys: tileKeys({ tiles: lib.tilesOf(l.path) }) }))
    .filter((l) => l.keys.size > 0);
  const out: DuplicateDt1[] = [];
  for (let i = 0; i < libs.length; i++)
    for (let j = i + 1; j < libs.length; j++) {
      const shared = sharedTiles(libs[i].keys, libs[j].keys);
      if (shared) out.push({ earlier: libs[i].path, later: libs[j].path, shared });
    }
  return out;
}
