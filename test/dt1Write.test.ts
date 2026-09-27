import { describe, expect, it } from 'vitest';
import { parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1, changedRecord, dt1Records, recordInfo } from '../src/formats/dt1Write';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('writing DT1s from tile records', async () => {
  const fs = hasD2 ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))) : null!;

  it("rebuilds every one of the game's DT1s with the same tiles, block for block", async () => {
    let files = 0;
    for (const p of fs.list((p) => p.endsWith('.dt1'))) {
      const bytes = (await fs.read(p))!;
      let before;
      try {
        before = parseDt1(bytes);
      } catch {
        continue; // a few old-format (4.1) files the game doesn't load either
      }
      const after = parseDt1(buildDt1(dt1Records(bytes)));
      expect(after.tiles.length, p).toBe(before.tiles.length);
      after.tiles.forEach((t, i) => {
        const b = before.tiles[i];
        expect({ ...t, blocks: t.blocks.length }, p).toEqual({ ...b, blocks: b.blocks.length });
        t.blocks.forEach((blk, j) => expect(Buffer.from(blk.data).equals(Buffer.from(b.blocks[j].data)), `${p} tile ${i} block ${j}`).toBe(true));
      });
      files++;
    }
    expect(files).toBeGreaterThan(200);
  });

  it("copies a tile with a new sub index and flags, and writes blockers like Tal Rasha's tomb's", async () => {
    const bytes = (await fs.read('data/global/tiles/ACT1/Town/floor.dt1'))!;
    const [first] = dt1Records(bytes);
    const flags = new Uint8Array(25).fill(0);
    flags[12] = 1;
    const copy = changedRecord(first, { sub: 200, flags });
    const blocker = blockerRecord(63, 7, new Uint8Array(25).fill(1));
    const out = parseDt1(buildDt1([copy, blocker]));
    const orig = parseDt1(bytes).tiles[0];
    expect(out.tiles[0]).toMatchObject({ orientation: orig.orientation, mainIndex: orig.mainIndex, subIndex: 200, width: orig.width, height: orig.height });
    expect([...out.tiles[0].subTileFlags]).toEqual([...flags]);
    expect(out.tiles[0].blocks.map((b) => b.data.length)).toEqual(orig.blocks.map((b) => b.data.length));
    expect(out.tiles[1]).toMatchObject({ orientation: 0, mainIndex: 63, subIndex: 7, direction: 3, width: 160, height: -128, rarity: 0, blocks: [] });
    expect(recordInfo(blocker)).toMatchObject({ orientation: 0, main: 63, sub: 7 });
    // The game's own blockers: same header apart from their key and block pointer.
    const tomb = dt1Records((await fs.read('data/global/tiles/ACT2/Tomb/TalRasha.dt1'))!).find((r) => !r.blocks.length && recordInfo(r).orientation === 0)!;
    const mine = blockerRecord(recordInfo(tomb).main, recordInfo(tomb).sub, recordInfo(tomb).flags);
    const strip = (h: Uint8Array) => [...h.slice(0, 72), ...h.slice(80)];
    expect(strip(mine.header)).toEqual(strip(tomb.header));
  });
});
