import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeTile, parseDt1 } from '../src/formats/dt1';
import { parseDs1 } from '../src/formats/ds1';
import { MpqArchive } from '../src/formats/mpq/MpqArchive';
import { parsePalette } from '../src/formats/palette';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2, hasMod, MOD_DATA, walk } from '../tools/testdata';

describe.runIf(hasD2)('vanilla MPQ data', async () => {
  const mpq = hasD2 ? await MpqArchive.open('d2data.mpq', new NodeFileAccess(`${D2_DIR}/d2data.mpq`)) : null!;
  const listfile = hasD2 ? new TextDecoder().decode((await mpq.read('(listfile)'))!).split(/\r?\n/) : [];

  it('reads a palette', async () => {
    const pal = parsePalette((await mpq.read('data/global/palette/ACT1/pal.dat'))!);
    expect(pal[3]).toBe(0);
    expect(pal[7]).toBe(255);
  });

  it('parses every DS1 in d2data.mpq exactly', async () => {
    const files = listfile.filter((f) => /\.ds1$/i.test(f));
    expect(files.length).toBeGreaterThan(1000);
    const failures: string[] = [];
    for (const f of files) {
      try {
        const ds1 = parseDs1((await mpq.read(f))!);
        // v12/v13 files carry unread padding the game ignores; anything newer must parse exactly.
        if (ds1.trailing !== 0 && ds1.version >= 14) failures.push(`${f}: ${ds1.trailing} trailing bytes`);
      } catch (e) {
        failures.push(`${f}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('parses and decodes every DT1 in d2data.mpq', async () => {
    const files = listfile.filter((f) => /\.dt1$/i.test(f));
    const failures: string[] = [];
    let tiles = 0;
    for (const f of files) {
      try {
        const bytes = (await mpq.read(f))!;
        if (bytes[0] !== 7) continue; // six unused pre-release v4.1 libraries ship in d2data.mpq
        const dt1 = parseDt1(bytes);
        for (const t of dt1.tiles) {
          decodeTile(t);
          tiles++;
        }
      } catch (e) {
        failures.push(`${f}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    expect(tiles).toBeGreaterThan(1000);
  }, 120_000);
});

describe.runIf(hasMod)('mod folder data', () => {
  it('parses every loose DS1 exactly', () => {
    const failures: string[] = [];
    const versions = new Map<number, number>();
    for (const f of walk(`${MOD_DATA}/global/tiles`, '.ds1')) {
      try {
        const ds1 = parseDs1(new Uint8Array(readFileSync(f)));
        versions.set(ds1.version, (versions.get(ds1.version) ?? 0) + 1);
        // v12/v13 files carry unread padding the game ignores; anything newer must parse exactly.
        if (ds1.trailing !== 0 && ds1.version >= 14) failures.push(`${f}: ${ds1.trailing} trailing bytes`);
      } catch (e) {
        failures.push(`${f}: ${(e as Error).message}`);
      }
    }
    console.log('DS1 versions:', Object.fromEntries(versions));
    expect(failures.slice(0, 20)).toEqual([]);
  }, 120_000);
});
