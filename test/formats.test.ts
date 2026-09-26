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

  it('round-trips every loose v18 DS1 byte-for-byte', async () => {
    const { writeDs1 } = await import('../src/formats/ds1');
    const diffs: string[] = [];
    for (const f of walk(`${MOD_DATA}/global/tiles`, '.ds1')) {
      const bytes = new Uint8Array(readFileSync(f));
      if (new DataView(bytes.buffer, bytes.byteOffset).getInt32(0, true) !== 18) continue;
      const ds1 = parseDs1(bytes);
      const out = writeDs1(ds1);
      if (out.length !== bytes.length || out.some((b, i) => b !== bytes[i])) diffs.push(f);
    }
    expect(diffs.slice(0, 10)).toEqual([]);
  }, 120_000);
});

describe.runIf(hasD2)('DS1 writer', async () => {
  const { writeDs1 } = await import('../src/formats/ds1');
  const mpq = hasD2 ? await MpqArchive.open('d2data.mpq', new NodeFileAccess(`${D2_DIR}/d2data.mpq`)) : null!;
  const files = hasD2 ? new TextDecoder().decode((await mpq.read('(listfile)'))!).split(/\r?\n/).filter((f) => /\.ds1$/i.test(f)) : [];

  it('round-trips every v18 DS1 byte-for-byte', async () => {
    const diffs: string[] = [];
    let n = 0;
    for (const f of files) {
      const bytes = (await mpq.read(f))!;
      if (new DataView(bytes.buffer).getInt32(0, true) !== 18) continue;
      n++;
      const out = writeDs1(parseDs1(bytes));
      if (out.length !== bytes.length || out.some((b, i) => b !== bytes[i])) {
        const at = out.findIndex((b, i) => b !== bytes[i]);
        diffs.push(`${f}: len ${bytes.length} -> ${out.length}, first diff @${at}`);
      }
    }
    expect(n).toBeGreaterThan(1000);
    expect(diffs.slice(0, 10)).toEqual([]);
  }, 120_000);

  it('upgrades older versions to v18 without losing content', async () => {
    const bad: string[] = [];
    for (const f of files) {
      const a = parseDs1((await mpq.read(f))!);
      if (a.version === 18) continue;
      const b = parseDs1(writeDs1(a));
      const strip = (d: typeof a) => ({ ...d, version: 0, trailing: 0, tags: d.tagType === 1 || d.tagType === 2 ? d.tags : [], walls: d.walls.map((l) => l.map((c) => ({ ...c, orientationHigh: 0 }))) });
      try {
        expect(strip(b)).toEqual(strip(a));
      } catch {
        bad.push(`${f} (v${a.version})`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  }, 120_000);
});
