import { beforeAll, describe, expect, it } from 'vitest';
import { parseDt1 } from '../src/formats/dt1';
import { dt1ToIni, parseDt1Ini, readTileSettings, writeTileSettings } from '../src/formats/dt1Header';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('DT1 tile settings (.ini fields)', () => {
  let bytes: Uint8Array;
  let dt1: ReturnType<typeof parseDt1>;
  beforeAll(async () => {
    const fs = new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))));
    bytes = (await fs.read('data/global/tiles/act1/barracks/exitdn.dt1'))!;
    dt1 = parseDt1(bytes);
  });

  it('reads what the parser reads', () => {
    dt1.tiles.forEach((t, i) => {
      const s = readTileSettings(bytes, i);
      expect([s.direction, s.roofHeight, s.sound, s.animated, s.orientation, s.mainIndex, s.subIndex, s.frame]).toEqual([
        t.direction, t.roofHeight, t.soundIndex, t.animated, t.orientation, t.mainIndex, t.subIndex, t.rarity,
      ]);
      expect([...s.flags]).toEqual([...t.subTileFlags]);
    });
  });

  it('matches DT1 Tools: floor_flag1 is the row furthest back (file bytes 20-24)', () => {
    // Gimli's act0 exitdn.ini, block 0: floor_flag1 = 01 01 01 01 00 ... floor_flag5 = 00 00 00 00 00
    const ini = dt1ToIni(bytes, dt1.tiles.map((t) => ({ width: t.width, height: t.height })));
    expect(ini).toContain('floor_flag1 = 01 01 01 01 00\r\nfloor_flag2 = 01 01 01 01 00\r\nfloor_flag3 = 00 00 01 01 00'.replace(/\\r\\n/g, '\r\n'));
    expect(ini).toContain('main_index  = 00000015');
  });

  it('round-trips through the .ini and writes only headers', () => {
    const ini = dt1ToIni(bytes, dt1.tiles.map((t) => ({ width: t.width, height: t.height })));
    const parsed = parseDt1Ini(ini);
    expect(parsed.count).toBe(dt1.tiles.length);
    const same = writeTileSettings(bytes, new Map(parsed.blocks.map((b) => [b.block, b.settings])));
    expect(Buffer.from(same).equals(Buffer.from(bytes))).toBe(true);
    // Change a few fields and sub-tile flags of tile 2; pixels and other tiles stay.
    const flags = new Uint8Array(25).fill(0x05);
    const changed = writeTileSettings(bytes, new Map([[2, { sound: 7, roofHeight: 12, frame: 3, flags, subIndex: 42 }]]));
    const t = parseDt1(changed).tiles[2];
    expect([t.soundIndex, t.roofHeight, t.rarity, t.subIndex, [...t.subTileFlags].every((f) => f === 5)]).toEqual([7, 12, 3, 42, true]);
    let diff = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== changed[i]) diff++;
    expect(diff).toBeLessThanOrEqual(4 + 25);
  });
});
