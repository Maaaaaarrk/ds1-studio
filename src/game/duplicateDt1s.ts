import type { Ds1 } from '../formats/ds1';
import { decodeTile, Orientation, type Dt1, type TileImage } from '../formats/dt1';
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

export interface ClashingDt1s {
  /** Cells whose floor or wall tile number more than one of the DT1s provides. */
  cells: { x: number; y: number }[];
  /** "a|b" → how many placed tiles both provide. */
  pairs: Map<string, number>;
  /** DT1s that can go: every tile number the map uses from them is in another loaded DT1 too. */
  removable: string[];
}

/**
 * Tile numbers the map places that two different (not copied) mod DT1s both provide, like one mod's house1 and house2
 * reusing the same numbers. The game picks among all of them at random for each cell, so those cells show a mix of the
 * two libraries (the map looks jumbled in game and differently in the editor). The game's own DT1s (`fromGame`) are
 * left out: they use shared numbers on purpose, as random variants. Copies are reported by duplicateDt1s instead.
 */
export function clashingDt1s(lib: TileLibrary, ds1: Pick<Ds1, 'width' | 'height' | 'floors' | 'walls'>, fromGame: (path: string) => boolean): ClashingDt1s | null {
  const libs = lib.loaded
    .filter((l) => l.found && !isBuiltinPath(l.path) && !fromGame(l.path))
    .map((l) => ({ path: l.path, keys: tileKeys({ tiles: lib.tilesOf(l.path) }) }));
  const copies = new Set(duplicateDt1s(lib).map((d) => `${d.earlier}|${d.later}`));
  const owners = (k: number, among: typeof libs) => among.filter((l) => l.keys.has(k)).map((l) => l.path);
  const placed = new Map<number, number[]>();
  for (let i = 0; i < ds1.width * ds1.height; i++) {
    const keys = [
      ...ds1.floors.filter((l) => l[i].prop1 !== 0).map((l) => TileLibrary.key(Orientation.Floor, l[i].mainIndex, l[i].subIndex)),
      ...ds1.walls.filter((l) => l[i].prop1 !== 0 && l[i].orientation !== 10 && l[i].orientation !== 11).map((l) => TileLibrary.key(l[i].orientation, l[i].mainIndex, l[i].subIndex)),
    ];
    for (const k of keys) placed.set(k, [...(placed.get(k) ?? []), i]);
  }
  const pairs = new Map<string, number>();
  const cellSet = new Set<number>();
  for (const [k, at] of placed) {
    const o = owners(k, libs);
    for (let a = 0; a < o.length; a++)
      for (let b = a + 1; b < o.length; b++) {
        if (copies.has(`${o[a]}|${o[b]}`) || copies.has(`${o[b]}|${o[a]}`)) continue;
        pairs.set(`${o[a]}|${o[b]}`, (pairs.get(`${o[a]}|${o[b]}`) ?? 0) + at.length);
        at.forEach((i) => cellSet.add(i));
      }
  }
  if (!pairs.size) return null;
  // Drop, one at a time, a DT1 that clashes and supplies nothing the others don't: the one clashing on most cells.
  let keep = libs.slice();
  const removable: string[] = [];
  for (;;) {
    const candidates = keep
      .map((l) => {
        const mine = [...placed].filter(([k]) => l.keys.has(k));
        const exclusive = mine.some(([k]) => owners(k, keep).length === 1);
        const clashCells = mine.filter(([k]) => owners(k, keep).length > 1).reduce((s, [, at]) => s + at.length, 0);
        return { l, exclusive, clashCells };
      })
      .filter((c) => !c.exclusive && c.clashCells > 0)
      .sort((a, b) => b.clashCells - a.clashCells);
    if (!candidates.length) break;
    removable.push(candidates[0].l.path);
    keep = keep.filter((l) => l !== candidates[0].l);
  }
  const cells = [...cellSet].sort((a, b) => a - b).map((i) => ({ x: i % ds1.width, y: Math.floor(i / ds1.width) }));
  return { cells, pairs, removable };
}

export interface MixedVersions {
  /** A DT1 DS1 Studio made by copying tiles (data/global/tiles/studio). */
  path: string;
  /** The tile number (orientation, main, sub). */
  key: number;
  /** The versions: tile indices in the file, in file order. */
  indices: number[];
}

/** The two pictures have the same shape and mostly the same pixels, but not all: one picture in two colourings. */
export function sameTileRecoloured(a: TileImage, b: TileImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  let both = 0, same = 0;
  for (let i = 0; i < a.pixels.length; i++) {
    const x = a.pixels[i], y = b.pixels[i];
    if (!x !== !y) return false;
    if (x) { both++; if (x === y) same++; }
  }
  return both > 0 && same < both && same >= 0.75 * both;
}

/**
 * Tile numbers in DS1 Studio's own DT1s (custom DT1s and automap edits copy every version of a tile) whose versions are
 * one picture in different colours. They come from a map that loaded two copies of a library (one converted to other
 * colours) when the tiles were copied: the game picks a version at random for every cell, so some cells show the wrong
 * colours, in game too. Both versions can use only colours every act shares, so the act-safe check doesn't see it.
 */
export function mixedVersions(lib: TileLibrary): MixedVersions[] {
  const out: MixedVersions[] = [];
  for (const l of lib.loaded) {
    if (!l.found || !/(^|\/)tiles\/studio\//i.test(l.path)) continue;
    const groups = new Map<number, number[]>();
    lib.tilesOf(l.path).forEach((t, i) => {
      const k = TileLibrary.key(t.orientation, t.mainIndex, t.subIndex);
      groups.set(k, [...(groups.get(k) ?? []), i]);
    });
    for (const [key, ids] of groups) {
      if (ids.length < 2) continue;
      const imgs = ids.map((i) => decodeTile(lib.tilesOf(l.path)[i]));
      const mixed = new Set<number>();
      for (let a = 0; a < ids.length; a++)
        for (let b = a + 1; b < ids.length; b++) {
          const A = imgs[a], B = imgs[b];
          if (A && B && sameTileRecoloured(A, B)) mixed.add(ids[a]).add(ids[b]);
        }
      if (mixed.size) {
        // Exact duplicates of a mixed version are versions too (removing only one would leave the other).
        const pix = (i: number) => imgs[ids.indexOf(i)]?.pixels.join(',');
        const shown = new Set([...mixed].map(pix));
        out.push({ path: l.path, key, indices: ids.filter((i) => mixed.has(i) || shown.has(pix(i))) });
      }
    }
  }
  return out;
}
