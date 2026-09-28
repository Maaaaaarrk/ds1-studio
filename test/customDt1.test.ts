import { describe, expect, it } from 'vitest';
import { Orientation, parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1, dt1Records, recordInfo, type Dt1Record } from '../src/formats/dt1Write';
import { parseAutomap } from '../src/game/automap';
import { customAutomapEdits, customNameProblem, maxCustomNameLength, planCustomDt1 } from '../src/game/customDt1';
import { parseTxtTable } from '../src/formats/txtTable';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

/** A tile record with this number; `animated` marks an animation frame (its rarity = frame). */
const tile = (orientation: number, main: number, sub: number, opts: { animated?: boolean; frame?: number; flag?: number } = {}): Dt1Record => {
  const r = blockerRecord(main, sub, new Uint8Array(25).fill(opts.flag ?? 0));
  const h = new DataView(r.header.buffer);
  h.setInt32(20, orientation, true);
  h.setInt32(32, opts.frame ?? 0, true);
  if (opts.animated) r.header[7] = 1;
  return r;
};
const file = (...records: Dt1Record[]) => buildDt1(records);

describe('custom DT1 from picked tiles', () => {
  const a = file(tile(0, 1, 0, { flag: 1 }), tile(Orientation.RightPartOfNorthCornerWall, 2, 0), tile(Orientation.LeftPartOfNorthCornerWall, 2, 0), tile(10, 0, 0));
  const b = file(tile(0, 1, 0, { flag: 4 }), tile(0, 5, 3, { animated: true, frame: 0 }), tile(0, 5, 3, { animated: true, frame: 1 }), tile(0, 5, 3, { animated: true, frame: 2 }));
  const sources = new Map([
    ['data/global/tiles/a.dt1', a],
    ['data/global/tiles/b.dt1', b],
  ]);

  it('copies picked tiles byte for byte, with their corner half and animation frames, and skips markers', () => {
    const plan = planCustomDt1(
      [
        { dt1: 'data/global/tiles/a.dt1', index: 1 },
        { dt1: 'data/global/tiles/a.dt1', index: 3 },
        { dt1: 'data/global/tiles/b.dt1', index: 2 },
      ],
      sources,
      new Set(),
    );
    expect(plan.skipped).toEqual(['a.dt1 #3: a special tile (a marker the game uses, not a picture)']);
    expect(plan.tiles.map((t) => [t.orientation, t.newMain, t.newSub, t.partner])).toEqual([
      [3, 2, 0, false],
      [4, 2, 0, true],
      [0, 5, 3, false],
      [0, 5, 3, true],
      [0, 5, 3, true],
    ]);
    // Unchanged tiles are the very same bytes; the file reads back.
    expect(plan.records[0]).toEqual(dt1Records(a)[1]);
    expect(parseDt1(buildDt1(plan.records)).tiles).toHaveLength(5);
  });

  it('gives a tile a free number when the level already loads one with its number, or another pick has it', () => {
    const plan = planCustomDt1(
      [
        { dt1: 'data/global/tiles/a.dt1', index: 0 },
        { dt1: 'data/global/tiles/b.dt1', index: 0 },
        { dt1: 'data/global/tiles/a.dt1', index: 2 },
      ],
      sources,
      new Set(['0|1|0', '3|0|0', '4|1|0']),
    );
    // a's floor 1/0 is taken by the level: first free main with the same sub is 0. b's floor 1/0 then clashes with
    // nothing left at 0 → 2. The corner 2/0 is free for both halves.
    expect(plan.tiles.map((t) => `${t.orientation}:${t.newMain}/${t.newSub}`)).toEqual(['0:0/0', '0:2/0', '4:2/0', '3:2/0']);
    expect(plan.renumbered).toEqual(['a.dt1 1/0 → 0/0', 'b.dt1 1/0 → 2/0']);
    // The walkability flags came along with the renumbered tiles.
    const built = parseDt1(buildDt1(plan.records));
    expect(built.tiles.map((t) => [t.mainIndex, t.subTileFlags[0]])).toEqual([
      [0, 1],
      [2, 4],
      [2, 0],
      [2, 0],
    ]);
    expect(recordInfo(plan.records[1]).main).toBe(2);
  });

  it('allows only short, plain names that fit the game’s tile paths', () => {
    expect(maxCustomNameLength('PD2assets/custom')).toBe(20);
    expect(customNameProblem('Guild_Tiles2', 'PD2assets/custom')).toBeNull();
    expect(customNameProblem('my tiles', 'PD2assets/custom')).toMatch(/only letters, digits and _/);
    expect(customNameProblem('tiles-1', 'PD2assets/custom')).toMatch(/only letters/);
    expect(customNameProblem('Ümlaut', 'PD2assets/custom')).toMatch(/only letters/);
    expect(customNameProblem('CON', 'PD2assets/custom')).toMatch(/reserves/);
    expect(customNameProblem('abcdefghijklmnopqrstu', 'PD2assets/custom')).toMatch(/At most 20/);
    expect(customNameProblem('', 'PD2assets/custom')).toMatch(/name/);
  });

  it("copies each tile's automap pieces under its new number", () => {
    const table = parseAutomap(parseTxtTable(new TextEncoder().encode('LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\tType2\tCel2\n1 Town\tfl\t1\t0\t0\t\t12\t\t-1\n1 Town\twtlr\t2\t0\t0\t\t40\t\t41\n')));
    const plan = planCustomDt1([{ dt1: 'data/global/tiles/a.dt1', index: 0 }, { dt1: 'data/global/tiles/a.dt1', index: 1 }], sources, new Set(['0|1|0']));
    expect(customAutomapEdits(plan, table, () => ['1 Town'])).toEqual([
      { orientation: 0, style: 0, sub: 0, cels: [12] },
      { orientation: 3, style: 2, sub: 0, cels: [40, 41] },
    ]);
  });
});

describe.runIf(hasD2)("custom DT1 from the game's own tiles", async () => {
  const fs = hasD2 ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))) : null!;

  it('builds a library from tiles of two acts that reads back tile for tile, pixels and walkability included', async () => {
    const huts = 'data/global/tiles/act3/kurast/huts.dt1';
    const floor = 'data/global/tiles/act1/town/floor.dt1';
    const sources = new Map([
      [huts, (await fs.read(huts))!],
      [floor, (await fs.read(floor))!],
    ]);
    const picks = [0, 20, 40].map((index) => ({ dt1: huts, index })).concat([{ dt1: floor, index: 3 }]);
    const plan = planCustomDt1(picks, sources, new Set());
    const built = parseDt1(buildDt1(plan.records));
    expect(built.tiles.length).toBe(plan.tiles.length);
    built.tiles.forEach((t, i) => {
      const from = plan.tiles[i].from;
      const orig = parseDt1(sources.get(from.dt1)!).tiles[from.index];
      expect({ ...t, mainIndex: 0, subIndex: 0, blocks: t.blocks.length }).toEqual({ ...orig, mainIndex: 0, subIndex: 0, blocks: orig.blocks.length });
      t.blocks.forEach((blk, j) => expect(Buffer.from(blk.data).equals(Buffer.from(orig.blocks[j].data))).toBe(true));
    });
    // No two tiles of different origin share a number.
    const owner = new Map<string, string>();
    plan.tiles.forEach((t) => {
      const k = `${t.orientation}|${t.newMain}|${t.newSub}`;
      const o = `${t.from.dt1}|${t.main}|${t.sub}`;
      expect(owner.get(k) ?? o).toBe(o);
      owner.set(k, o);
    });
  });
});
