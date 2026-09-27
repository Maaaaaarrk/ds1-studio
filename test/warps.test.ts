import { beforeAll, describe, expect, it } from 'vitest';
import { getCell, parseTxtTable } from '../src/formats/txtTable';
import { levelLinks, linkWrite, loadWarpTables, type WarpTables } from '../src/game/warps';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('warp links', () => {
  let t: WarpTables;
  let fs: LayeredFs;
  beforeAll(async () => {
    fs = new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))));
    t = (await loadWarpTables(fs))!;
  });

  it('reads where a level’s links lead', () => {
    const blood = levelLinks(t, 2, fs)!;
    expect(blood.level.name).toBe('Blood Moor');
    expect(blood.links[3]?.target.name).toBe('Den of Evil');
    expect(blood.links[3]?.warp?.name).toMatch(/Cave/);
    const cellar = levelLinks(t, 21, fs)!;
    expect(cellar.links[0]?.target.maps.length).toBeGreaterThan(0); // the Forgotten Tower has a preset map
    expect(levelLinks(t, 99999)).toBeNull();
  });

  it('changes a link and adds the way back', () => {
    const r = linkWrite(t, { levelId: 33, vis: 1, targetId: 1, warpId: 15, back: { warpId: 15 } });
    if (typeof r === 'string') throw new Error(r);
    const levels = parseTxtTable(r.write.bytes);
    const row = (id: number) => levels.rows.findIndex((x) => x[levels.columns.indexOf('Id')] === String(id));
    expect(getCell(levels, row(33), 'Vis1')).toBe('1');
    expect(getCell(levels, row(33), 'Warp1')).toBe('15');
    expect(r.backVis).not.toBeNull();
    expect(getCell(levels, row(1), `Vis${r.backVis}`)).toBe('33');
    // Removing clears the link.
    const off = linkWrite(t, { levelId: 33, vis: 1, targetId: 0, warpId: -1 });
    if (typeof off === 'string') throw new Error(off);
    const l2 = parseTxtTable(off.write.bytes);
    expect(getCell(l2, l2.rows.findIndex((x) => x[l2.columns.indexOf('Id')] === '33'), 'Vis1')).toBe('0');
  });
});
