import { describe, expect, it } from 'vitest';
import { decodeTile, parseDt1, type TileImage } from '../src/formats/dt1';
import { recolorDt1 } from '../src/formats/dt1Edit';
import { buildDt1, dt1Records } from '../src/formats/dt1Write';
import { mixedVersions, sameTileRecoloured } from '../src/game/duplicateDt1s';
import { TileLibrary } from '../src/game/GameData';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

const img = (pixels: number[]): TileImage => ({ width: pixels.length, height: 1, pixels: new Uint8Array(pixels) }) as unknown as TileImage;

describe('one tile in two colourings', () => {
  it('is the same shape with most pixels the same, but not all', () => {
    expect(sameTileRecoloured(img([0, 5, 5, 5, 5, 7]), img([0, 5, 5, 5, 5, 9]))).toBe(true);
    expect(sameTileRecoloured(img([0, 5, 5, 5, 5, 7]), img([0, 5, 5, 5, 5, 7]))).toBe(false); // identical
    expect(sameTileRecoloured(img([0, 5, 5, 5, 5, 7]), img([4, 5, 5, 5, 5, 7]))).toBe(false); // another shape
    expect(sameTileRecoloured(img([0, 5, 5, 6, 6, 7]), img([0, 5, 1, 2, 3, 9]))).toBe(false); // another picture
  });
});

describe.runIf(hasD2)("DS1 Studio's DT1s holding two colourings of a tile", async () => {
  const fs = hasD2 ? new LayeredFs(await Promise.all(['d2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))) : null!;
  const bytes = hasD2 ? await fs.readOrThrow('data/global/tiles/act1/town/fence.dt1') : null!;
  const records = hasD2 ? dt1Records(bytes) : [];
  const tiles = hasD2 ? parseDt1(bytes).tiles : [];
  // A wall tile, and a copy of it with its least used colours changed (as from a copy converted to other colours).
  const i = hasD2 ? tiles.findIndex((t) => t.orientation > 0 && (decodeTile(t)?.pixels.filter(Boolean).length ?? 0) > 500) : -1;
  const recoloured = () => {
    const px = decodeTile(tiles[i])!.pixels;
    const count = new Map<number, number>();
    for (const p of px) if (p) count.set(p, (count.get(p) ?? 0) + 1);
    const remap = new Uint8Array(256).map((_, c) => c);
    const total = [...count.values()].reduce((a, b) => a + b, 0);
    let changed = 0;
    for (const [c, n] of [...count].sort((a, b) => a[1] - b[1])) {
      if (changed + n > total * 0.15) break;
      remap[c] = c === 255 ? 254 : c + 1;
      changed += n;
    }
    return dt1Records(recolorDt1(buildDt1([records[i]]), remap))[0];
  };
  const libOf = (path: string, recs: typeof records) => {
    const lib = new TileLibrary();
    lib.add(path, parseDt1(buildDt1(recs)));
    return lib;
  };

  it('finds them in a studio DT1, with exact copies of either version', () => {
    const lib = libOf('data/global/tiles/studio/a1.dt1', [records[i], recoloured(), records[i]]);
    const found = mixedVersions(lib);
    expect(found).toHaveLength(1);
    expect(found[0].indices).toEqual([0, 1, 2]);
  });

  it('leaves other DT1s, and real variants, alone', () => {
    expect(mixedVersions(libOf('data/global/tiles/act1/town/x.dt1', [records[i], recoloured()]))).toEqual([]);
    expect(mixedVersions(libOf('data/global/tiles/studio/a2.dt1', [records[i], records[i]]))).toEqual([]);
  });
});
