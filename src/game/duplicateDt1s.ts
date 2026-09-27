import { TileLibrary } from './GameData';
import { isBuiltinPath } from './specialTiles';

export interface DuplicateDt1 {
  /** Loaded first / later (the order of the map's tile libraries). */
  earlier: string;
  later: string;
  /** Tile numbers (orientation, main, sub) both provide. */
  shared: Set<number>;
}

/**
 * Pairs of the map's DT1s that provide (mostly) the same tiles, like a DT1 and an imported or edited copy of it. Where
 * a tile number has random variants, the game picks among the variants of *every* loaded DT1, so the map shows a
 * random mix of the two copies (in game too).
 */
export function duplicateDt1s(lib: TileLibrary): DuplicateDt1[] {
  const libs = lib.loaded
    .filter((l) => l.found && !isBuiltinPath(l.path))
    .map((l) => ({ path: l.path, keys: new Set(lib.tilesOf(l.path).map((t) => TileLibrary.key(t.orientation, t.mainIndex, t.subIndex))) }))
    .filter((l) => l.keys.size > 0);
  const out: DuplicateDt1[] = [];
  for (let i = 0; i < libs.length; i++)
    for (let j = i + 1; j < libs.length; j++) {
      const [a, b] = [libs[i], libs[j]];
      const shared = new Set([...a.keys].filter((k) => b.keys.has(k)));
      // Most of the smaller file's tiles: a copy, not two libraries that happen to reuse a few numbers.
      if (shared.size >= 4 && shared.size >= 0.8 * Math.min(a.keys.size, b.keys.size)) out.push({ earlier: a.path, later: b.path, shared });
    }
  return out;
}
