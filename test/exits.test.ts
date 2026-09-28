import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { Orientation } from '../src/formats/dt1';
import { exitProblems, warpTiles } from '../src/game/exits';

const map = (...warps: { x: number; y: number; main: number }[]) => {
  const ds1 = newDs1({ width: 8, height: 8, act: 4, floorLayers: 1, wallLayers: 2, tagType: 0, files: [] });
  for (const w of warps) Object.assign(ds1.walls[1][w.y * 8 + w.x], { prop1: 1, orientation: Orientation.SpecialTile1, mainIndex: w.main, subIndex: 0 });
  // A Map entry marker (30/11) is not a warp.
  Object.assign(ds1.walls[1][0], { prop1: 1, orientation: Orientation.SpecialTile1, mainIndex: 30, subIndex: 11 });
  return ds1;
};
const opts = { hasWaypoint: false, onlyPreset: true, isTown: false, levelName: (id: number) => (id === 109 ? 'Harrogath' : `Level ${id}`) };

describe('ways out of a level', () => {
  it('finds warp tiles by link number', () => {
    expect([...warpTiles(map({ x: 2, y: 3, main: 1 }, { x: 3, y: 3, main: 1 })).entries()]).toEqual([[1, [{ x: 2, y: 3 }, { x: 3, y: 3 }]]]);
  });

  it('offers an exit warp when nothing leads out', () => {
    const [p] = exitProblems(map(), {}, opts);
    expect(p.title).toBe('No way out of this level except a town portal');
    expect(p.fix).toMatchObject({ vis: 0, edit: true, place: true });
    // A link used in the table takes the next free one.
    expect(exitProblems(map(), { Vis0: '0', Vis1: '' }, opts)[0].fix?.vis).toBe(0);
  });

  it('asks where an unlinked warp tile leads, and to place the tile when only the table has the link', () => {
    const problems = exitProblems(map({ x: 4, y: 4, main: 2 }), {}, opts);
    expect(problems.map((p) => p.title)).toEqual(['A warp tile for link 2 leads nowhere', 'No way out of this level except a town portal']);
    expect(problems[0]).toMatchObject({ cells: [{ x: 4, y: 4 }], fix: { vis: 2, edit: true, place: false } });
    expect(problems[1].fix).toBeNull();
    const [p] = exitProblems(map(), { Vis3: '109' }, opts);
    expect(p.fix).toMatchObject({ vis: 3, edit: false, place: true, label: 'Place the warp tile for link 3 (to Harrogath)' });
  });

  it('is quiet when a warp leads somewhere, there is a waypoint, other maps may hold the exit, or it is a town', () => {
    expect(exitProblems(map({ x: 4, y: 4, main: 0 }), { Vis0: '109' }, opts)).toEqual([]);
    expect(exitProblems(map(), {}, { ...opts, hasWaypoint: true })).toEqual([]);
    expect(exitProblems(map(), {}, { ...opts, onlyPreset: false })).toEqual([]);
    expect(exitProblems(map(), {}, { ...opts, isTown: true })).toEqual([]);
  });
});
