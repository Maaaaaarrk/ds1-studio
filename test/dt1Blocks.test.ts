import { describe, expect, it } from 'vitest';
import { decodeTile, parseDt1 } from '../src/formats/dt1';
import { cornerPartner, freeSub, mirrorFlags, mirrorRecord, readBlocks, rebuildRleRecord } from '../src/formats/dt1Blocks';
import { buildDt1, dt1Records, recordInfo } from '../src/formats/dt1Write';
import { readPng, toPaletteIndices, writeIndexedPng } from '../src/formats/png';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

/** The tile drawn into the game's 160-pixel-wide cell (x from 0), rows from its top. */
function inCell(bytes: Uint8Array) {
  const t = parseDt1(bytes).tiles[0];
  const img = decodeTile(t)!;
  const rows = img.height;
  const out = new Uint8Array(160 * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < img.width; x++) out[y * 160 + img.offsetX + x] = img.pixels[y * img.width + x];
  return { out, rows, top: img.offsetY };
}
const flip = (a: Uint8Array, rows: number) => {
  const o = new Uint8Array(a.length);
  for (let y = 0; y < rows; y++) for (let x = 0; x < 160; x++) o[y * 160 + 159 - x] = a[y * 160 + x];
  return o;
};

describe('sub-tile flags', () => {
  it('mirror by transposing the grid, and twice gives them back', () => {
    const f = new Uint8Array(25).map((_, i) => i + 1);
    expect(mirrorFlags(mirrorFlags(f))).toEqual(f);
    expect(mirrorFlags(f)).not.toEqual(f);
    // The diagonal stays.
    const m = mirrorFlags(f);
    for (const d of [0, 6, 12, 18, 24]) expect(m[(4 - Math.floor(d / 5)) * 5 + (d % 5)]).toBe(f[(4 - Math.floor(d / 5)) * 5 + (d % 5)]);
  });
});

describe('PNG', () => {
  it('writes an indexed PNG and reads the same indices back', () => {
    const pal = new Uint8Array(1024).map((_, i) => (i * 37) & 255);
    const px = new Uint8Array(40 * 7).map((_, i) => (i * 13) % 256);
    const png = readPng(writeIndexedPng(40, 7, px, pal));
    expect([png.width, png.height]).toEqual([40, 7]);
    expect(png.indices).toEqual(px);
    // Index 0 is transparent; the rest keep their index.
    expect(toPaletteIndices(png, pal).pixels).toEqual(px);
  });
});

describe.runIf(hasD2)("game tiles", async () => {
  const fs = hasD2 ? new LayeredFs(await Promise.all(['d2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))) : null!;
  const fence = hasD2 ? dt1Records(await fs.readOrThrow('data/global/tiles/act1/town/fence.dt1')) : [];
  const floor = hasD2 ? dt1Records(await fs.readOrThrow('data/global/tiles/act1/town/floor.dt1')) : [];
  const leftWall = fence.find((r) => recordInfo(r).orientation === 1)!;
  const aFloor = floor.find((r) => recordInfo(r).orientation === 0 && readBlocks(r).length === 25)!;

  it('mirrors a wall: pixels flipped in the cell, now facing right, and back again byte for byte', () => {
    const m = mirrorRecord(leftWall);
    expect(recordInfo(m).orientation).toBe(2);
    const a = inCell(buildDt1([leftWall])), b = inCell(buildDt1([m]));
    expect(b.top).toBe(a.top);
    expect(b.out).toEqual(flip(a.out, a.rows));
    const back = mirrorRecord(m);
    expect(buildDt1([back])).toEqual(buildDt1([leftWall]));
  });

  it('mirrors a floor diamond the same way, its grid transposed', () => {
    const m = mirrorRecord(aFloor);
    const a = inCell(buildDt1([aFloor])), b = inCell(buildDt1([m]));
    expect(b.out).toEqual(flip(a.out, a.rows));
    expect(buildDt1([mirrorRecord(m)])).toEqual(buildDt1([aFloor]));
  });

  it('finds a free sub index, for both halves of a corner', () => {
    const corner = fence.find((r) => recordInfo(r).orientation === 3)!;
    const { main } = recordInfo(corner);
    const s = freeSub(fence, 3, main);
    expect(fence.some((r) => { const i = recordInfo(r); return (i.orientation === 3 || i.orientation === 4) && i.main === main && i.sub === s; })).toBe(false);
    expect(cornerPartner(3)).toBe(4);
  });

  it('rebuilds a wall from its own picture unchanged, and from a moved one with new blocks', () => {
    const t = parseDt1(buildDt1([leftWall])).tiles[0];
    const img = decodeTile(t)!;
    const same = rebuildRleRecord(leftWall, img);
    expect(decodeTile(parseDt1(buildDt1([same])).tiles[0])!.pixels).toEqual(img.pixels);
    // Shift the picture 40 pixels right inside a wider canvas: every pixel is kept.
    const w = img.width + 64;
    const moved = new Uint8Array(w * img.height);
    for (let y = 0; y < img.height; y++) moved.set(img.pixels.subarray(y * img.width, (y + 1) * img.width), y * w + 40);
    const rebuilt = decodeTile(parseDt1(buildDt1([rebuildRleRecord(leftWall, { ...img, width: w, pixels: moved })])).tiles[0])!;
    expect(rebuilt.pixels.filter(Boolean).length).toBe(img.pixels.filter(Boolean).length);
  });
});
