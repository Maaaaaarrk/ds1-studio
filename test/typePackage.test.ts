import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { GameData } from '../src/game/GameData';
import { loadTable } from '../src/game/levelTables';
import { buildTypePackage, mapsOfType } from '../src/game/typePackage';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('a level type as one package', async () => {
  const fs = hasD2 ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))) : null!;
  it('holds every library once, one file per table with every map’s rows, and the maps when asked', async () => {
    const gd = await GameData.load(fs);
    const [prest, levels] = await Promise.all([loadTable(fs, 'LvlPrest.txt'), loadTable(fs, 'Levels.txt')]);
    const maps = mapsOfType(prest!, levels!, 1);
    expect(maps.map((m) => m.split('/').pop()!.toLowerCase()).sort()).toEqual(['towne1.ds1', 'townn1.ds1', 'towns1.ds1', 'townw1.ds1']);
    const pkg = await buildTypePackage(gd, fs, 1, { includeMaps: true, prest: prest!, levels: levels! });
    const files = unzipSync(pkg.zip);
    const names = Object.keys(files);
    expect(pkg.missing).toEqual([]);
    expect(names.filter((n) => n.endsWith('.dt1'))).toHaveLength(9);
    expect(names.filter((n) => n.endsWith('.ds1'))).toHaveLength(4);
    const lvlTypes = strFromU8(files['txt/LvlTypes.txt']).trim().split('\r\n');
    expect(lvlTypes).toHaveLength(2); // header + the one type, once although four maps use it
    expect(strFromU8(files['txt/LvlPrest.txt'])).toContain('Act 1 - Town 1');
    expect(strFromU8(files['README.txt'])).toContain('Level type 1');
  });
});
