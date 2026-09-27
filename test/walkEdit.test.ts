import { describe, expect, it } from 'vitest';
import { decodeCell, withFields, withTile, type Ds1 } from '../src/formats/ds1';
import { parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1 } from '../src/formats/dt1Write';
import { TileLibrary } from '../src/game/GameData';
import { fileIndex, planWalkEdit, type WalkPaint, type WalkPlan } from '../src/game/walkEdit';
import { buildScene, walkability } from '../src/render/scene';

const FLOOR = 'data/global/tiles/test/floor.dt1';
const WALK = 'data/global/tiles/test/map_walk.dt1';

/** Floor tiles: 1/0 walkable everywhere, 1/1 blocking its middle sub-tile (overlay 12). */
const floorFlags = (blocked: number[]) => new Uint8Array(25).map((_, j) => (blocked.map(fileIndex).includes(j) ? 1 : 0));
const floorDt1 = buildDt1([blockerRecord(1, 0, floorFlags([])), blockerRecord(1, 1, floorFlags([12]))]);

function ds1(): Ds1 {
  const cells = () => Array.from({ length: 4 }, () => decodeCell(0));
  const d: Ds1 = {
    version: 18, width: 4, height: 1, act: 0, actRaw: 0, tagType: 0, files: [],
    walls: [cells().map((c) => ({ ...c, orientation: 0, orientationHigh: 0 }))],
    floors: [cells()], shadows: [cells()], tags: [], objects: [], groups: [], groupsHeader: 0, orphanPaths: [], hasPathSection: true, trailing: 0,
  };
  // Cells: 0 walkable floor, 1 floor blocking its middle, 2 walkable floor marked "unwalkable" in the DS1, 3 no floor.
  d.floors[0][0] = withTile(decodeCell(0), 1, 0, 0xc2);
  d.floors[0][1] = withTile(decodeCell(0), 1, 1, 0xc2);
  d.floors[0][2] = { ...withTile(decodeCell(0), 1, 0, 0xc2), prop3: 0x02 };
  return d;
}

/** The map after a plan, the way the app applies it: new floor layers, the edits, the walkability DT1 loaded. */
function apply(d: Ds1, plan: WalkPlan, walk: Uint8Array | null): { d: Ds1; lib: TileLibrary; walk: Uint8Array | null } {
  while (d.floors.length < plan.floors) d.floors.push(Array.from({ length: d.width * d.height }, () => decodeCell(0)));
  for (const e of plan.edits) (e.layer.kind === 'floor' ? d.floors : d.walls)[e.layer.index][e.y * d.width + e.x] = e.cell as never;
  const next = plan.dt1 ?? walk;
  const lib = new TileLibrary();
  lib.add(FLOOR, parseDt1(floorDt1));
  if (next) lib.add(WALK, parseDt1(next));
  return { d, lib, walk: next };
}

/** Walkability per cell as the overlay (and the game) sees it: sub-tiles with "block walk", in overlay order. */
const blocked = (d: Ds1, lib: TileLibrary, cell: number) => {
  const w = walkability(d, buildScene(d, lib), lib);
  return Array.from({ length: 25 }, (_, k) => k).filter((k) => w[cell * 25 + k] & 1);
};

describe('walkability editing (sub-tile by sub-tile, this map only)', () => {
  const mask = (ks: number[]) => ks.reduce((m, k) => m | (1 << k), 0);
  const plan = (d: Ds1, lib: TileLibrary, walk: Uint8Array | null, paint: WalkPaint) =>
    planWalkEdit({ ds1: d, lib, read: async (p) => (p === FLOOR ? floorDt1 : p === WALK ? walk : null), walkPath: WALK, walk, paint });

  it('blocks sub-tiles with a hidden blocker in a new floor layer, then clears them again', async () => {
    let s = apply(ds1(), { floors: 1, edits: [], dt1: null, changed: 0, skipped: [] }, null);
    expect(blocked(s.d, s.lib, 0)).toEqual([]);
    const p1 = await plan(s.d, s.lib, s.walk, { mode: 'block', bits: 1, cells: new Map([[0, mask([0, 1, 2, 3, 4])]]) });
    expect(p1).toMatchObject({ floors: 2, changed: 5, skipped: [] });
    expect(p1.edits).toHaveLength(1);
    expect(p1.edits[0]).toMatchObject({ layer: { kind: 'floor', index: 1 }, x: 0, y: 0 });
    expect(p1.edits[0].cell.hidden).toBe(true);
    s = apply(s.d, p1, s.walk);
    expect(blocked(s.d, s.lib, 0)).toEqual([0, 1, 2, 3, 4]);
    // The blocker's tile: no graphics, a floor main index no other library uses.
    const blocker = parseDt1(s.walk!).tiles[0];
    expect(blocker).toMatchObject({ orientation: 0, blocks: [] });
    expect(blocker.mainIndex).not.toBe(1);
    // Blocking more of the same cell reuses its blocker; clearing all of it removes the blocker (a floor is there).
    const p2 = await plan(s.d, s.lib, s.walk, { mode: 'block', bits: 1, cells: new Map([[0, mask([24])]]) });
    expect(p2.edits.map((e) => e.layer)).toEqual([{ kind: 'floor', index: 1 }]);
    s = apply(s.d, p2, s.walk);
    expect(blocked(s.d, s.lib, 0)).toEqual([0, 1, 2, 3, 4, 24]);
    const p3 = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[0, mask([0, 1, 2, 3, 4, 24])]]) });
    s = apply(s.d, p3, s.walk);
    expect(blocked(s.d, s.lib, 0)).toEqual([]);
    expect(s.d.floors[1][0].prop1).toBe(0);
  });

  it("clears a sub-tile a floor tile blocks by giving this cell a copy of the tile without it (the original stays)", async () => {
    let s = apply(ds1(), { floors: 1, edits: [], dt1: null, changed: 0, skipped: [] }, null);
    expect(blocked(s.d, s.lib, 1)).toEqual([12]);
    const p = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[1, mask([12])]]) });
    expect(p).toMatchObject({ floors: 1, changed: 1, skipped: [] });
    expect(p.edits).toEqual([expect.objectContaining({ layer: { kind: 'floor', index: 0 }, x: 1, y: 0 })]);
    const copySub = p.edits[0].cell.subIndex;
    expect(copySub).not.toBe(1);
    s = apply(s.d, p, s.walk);
    expect(blocked(s.d, s.lib, 1)).toEqual([]);
    // Same graphics key (main index 1), a new sub index; the original 1/1 still blocks its middle wherever it's used.
    expect(s.lib.variants(0, 1, 1)[0].subTileFlags[fileIndex(12)]).toBe(1);
    expect(s.lib.variants(0, 1, copySub)[0].subTileFlags.every((f) => f === 0)).toBe(true);
    // Doing it again elsewhere reuses the copy.
    s.d.floors[0][0] = withTile(decodeCell(0), 1, 1, 0xc2);
    const again = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[0, mask([12])]]) });
    expect(again.dt1).toBeNull();
    expect(again.edits[0].cell.subIndex).toBe(copySub);
  });

  it('clears part of a cell the DS1 marks unwalkable, and part of an empty cell (blocked because it has no floor)', async () => {
    let s = apply(ds1(), { floors: 1, edits: [], dt1: null, changed: 0, skipped: [] }, null);
    expect(blocked(s.d, s.lib, 2)).toHaveLength(25);
    expect(blocked(s.d, s.lib, 3)).toHaveLength(25);
    const p = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[2, mask([12])], [3, mask([6, 7])]]) });
    expect(p.skipped).toEqual([]);
    s = apply(s.d, p, s.walk);
    expect(s.d.floors[0][2].prop3 & 0x02).toBe(0);
    expect(blocked(s.d, s.lib, 2)).toEqual(Array.from({ length: 25 }, (_, k) => k).filter((k) => k !== 12));
    expect(blocked(s.d, s.lib, 3)).toEqual(Array.from({ length: 25 }, (_, k) => k).filter((k) => k !== 6 && k !== 7));
  });

  it('keeps hidden cells hidden when their tile is copied, and says which cells it skipped', async () => {
    const d = ds1();
    d.floors[0][1] = withFields(d.floors[0][1], { hidden: true });
    let s = apply(d, { floors: 1, edits: [], dt1: null, changed: 0, skipped: [] }, null);
    const p = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[1, mask([12])]]) });
    expect(p.edits[0].cell.hidden).toBe(true);
    // Both floor layers taken by real tiles: no room for a blocker.
    s = apply(ds1(), { floors: 2, edits: [{ layer: { kind: 'floor', index: 1 }, x: 0, y: 0, cell: withTile(decodeCell(0), 1, 0, 0xc2) }], dt1: null, changed: 0, skipped: [] }, null);
    const full = await plan(s.d, s.lib, s.walk, { mode: 'block', bits: 1, cells: new Map([[0, mask([0])]]) });
    expect(full.skipped[0]).toMatch(/\(0, 0\): both floor layers are used/);
    expect(full.edits).toEqual([]);
  });
});
