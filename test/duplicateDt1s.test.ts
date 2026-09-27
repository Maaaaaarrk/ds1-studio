import { describe, expect, it } from 'vitest';
import type { Dt1 } from '../src/formats/dt1';
import { clashingDt1s } from '../src/game/duplicateDt1s';
import { TileLibrary } from '../src/game/GameData';

/** A fake DT1 with floor tiles (orientation 0) of the given main/sub numbers. */
const dt1 = (keys: [number, number][]) => ({ tiles: keys.map(([mainIndex, subIndex]) => ({ orientation: 0, mainIndex, subIndex, rarity: 1 })) }) as unknown as Dt1;
/** A 1-row map whose floor cells use these main/sub numbers. */
const map = (keys: [number, number][]) => ({
  width: keys.length,
  height: 1,
  floors: [keys.map(([mainIndex, subIndex]) => ({ prop1: 1, mainIndex, subIndex, orientation: 0 }))],
  walls: [],
}) as never;

describe('clashing DT1s (two libraries reusing the same tile numbers)', () => {
  // Like the Guild's house1 and house2: house1's tiles the map uses are all in house2 (or cliff) too.
  const lib = new TileLibrary();
  lib.add('data/global/tiles/guild/house1/int.dt1', dt1([[1, 0], [1, 1], [2, 0]]));
  lib.add('data/global/tiles/guild/house2/int.dt1', dt1([[1, 0], [1, 1], [3, 0]]));
  lib.add('data/global/tiles/guild/outdoors/cliff.dt1', dt1([[2, 0], [4, 0]]));
  lib.add('data/global/tiles/act1/outdoors/floor.dt1', dt1([[1, 0], [5, 0]])); // the game's own: variants on purpose

  it('finds the cells, the pairs, and the DT1 that can go', () => {
    const r = clashingDt1s(lib, map([[1, 0], [1, 1], [2, 0], [3, 0], [4, 0], [9, 9]]), (p) => p.includes('/act1/'))!;
    expect(r.cells.map((c) => c.x)).toEqual([0, 1, 2]);
    expect(Object.fromEntries(r.pairs)).toEqual({
      'data/global/tiles/guild/house1/int.dt1|data/global/tiles/guild/house2/int.dt1': 2,
      'data/global/tiles/guild/house1/int.dt1|data/global/tiles/guild/outdoors/cliff.dt1': 1,
    });
    expect(r.removable).toEqual(['data/global/tiles/guild/house1/int.dt1']);
  });

  it('keeps a DT1 that has tiles only it provides, and says nothing when no placed tile clashes', () => {
    const r = clashingDt1s(lib, map([[1, 0], [2, 0], [3, 0], [4, 0], [1, 1]]), (p) => p.includes('/act1/'))!;
    expect(r.removable).toEqual(['data/global/tiles/guild/house1/int.dt1']);
    // Two DT1s that each also have a tile of their own: neither can go.
    const lib2 = new TileLibrary();
    lib2.add('data/global/tiles/a.dt1', dt1([[1, 0], [7, 0]]));
    lib2.add('data/global/tiles/b.dt1', dt1([[1, 0], [8, 0]]));
    const both = clashingDt1s(lib2, map([[1, 0], [7, 0], [8, 0]]), () => false)!;
    expect(both.cells).toHaveLength(1);
    expect(both.removable).toEqual([]); // each has a tile only it provides
    expect(clashingDt1s(lib2, map([[7, 0], [8, 0]]), () => false)).toBeNull();
  });
});
