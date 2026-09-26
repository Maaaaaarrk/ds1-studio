import { describe, expect, it } from 'vitest';
import { GameData } from '../src/game/GameData';
import { openMap } from '../src/game/openMap';
import { buildScene } from '../src/render/scene';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('open vanilla maps', async () => {
  const fs = hasD2
    ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))))
    : null!;
  const gd = hasD2 ? await GameData.load(fs) : null!;

  it.each([
    'data/global/tiles/ACT1/Town/townN1.ds1',
    'data/global/tiles/ACT1/BARRACKS/barE.ds1',
    'data/global/tiles/ACT2/Tomb/tombNE.ds1',
    'data/global/tiles/ACT1/BARRACKS/barEforge.ds1',
    'data/global/tiles/Expansion/Town/townWest.ds1',
  ])('%s resolves via LvlPrest with every tile found', async (path) => {
    const map = await openMap(gd, path);
    const scene = buildScene(map.ds1, map.lib);
    expect(map.resolution.source).toBe('lvlprest');
    expect(map.lib.loaded.every((l) => l.found)).toBe(true);
    expect(scene.items.length).toBeGreaterThan(100);
    expect(scene.missing).toEqual([]);
  });

  it('most vanilla presets render with no missing tiles', async () => {
    const all = fs.list((p) => p.endsWith('.ds1') && p.startsWith('data/global/tiles/'));
    const bad: string[] = [];
    for (const p of all) {
      try {
        const m = await openMap(gd, p);
        const missing = buildScene(m.ds1, m.lib).missing.length;
        if (missing) bad.push(`${p}: ${missing} missing (${m.resolution.source})`);
      } catch (e) {
        bad.push(`${p}: ${(e as Error).message}`);
      }
    }
    console.log(`${all.length - bad.length}/${all.length} clean`, bad.slice(0, 15));
    expect(bad.length / all.length).toBeLessThan(0.05);
  }, 300_000);
});
