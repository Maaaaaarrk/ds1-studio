import { describe, expect, it } from 'vitest';
import { decodeTile, parseDt1, type Dt1Tile } from '../src/formats/dt1';
import { dt1BlockSpans, hueRemap, identityRemap, recolorDt1, swapRemap } from '../src/formats/dt1Edit';
import { MpqArchive } from '../src/formats/mpq/MpqArchive';
import { parsePalette } from '../src/formats/palette';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

function headerOf(t: Dt1Tile) {
  return {
    direction: t.direction, roofHeight: t.roofHeight, soundIndex: t.soundIndex, animated: t.animated,
    height: t.height, width: t.width, orientation: t.orientation, mainIndex: t.mainIndex,
    subIndex: t.subIndex, rarity: t.rarity, subTileFlags: Array.from(t.subTileFlags),
    blocks: t.blocks.map((b) => ({ x: b.x, y: b.y, gridX: b.gridX, gridY: b.gridY, format: b.format, len: b.data.length })),
  };
}

const modRemap = (() => {
  const m = new Uint8Array(256);
  for (let i = 1; i < 256; i++) m[i] = (i % 254) + 1;
  return m;
})();

/** Checks that `out` is `src` with the given tiles' pixels mapped through `remap` and nothing else changed. */
function checkRecolor(src: Uint8Array, out: Uint8Array, remap: Uint8Array, selected: Set<number> | null) {
  expect(out.length).toBe(src.length);
  const a = parseDt1(src);
  const b = parseDt1(out);
  expect(b.tiles.length).toBe(a.tiles.length);
  for (let t = 0; t < a.tiles.length; t++) {
    expect(headerOf(b.tiles[t])).toEqual(headerOf(a.tiles[t]));
    const da = decodeTile(a.tiles[t]);
    const db = decodeTile(b.tiles[t]);
    if (!da || !db) {
      expect(db).toEqual(da);
      continue;
    }
    const sel = !selected || selected.has(t);
    const expected = sel ? da.pixels.map((v) => (v === 0 ? 0 : remap[v])) : da.pixels;
    if (!Buffer.from(db.pixels).equals(Buffer.from(expected))) {
      throw new Error(`tile ${t} (${sel ? 'selected' : 'unselected'}) decodes wrongly`);
    }
  }
  // Every changed byte lies inside a selected tile's block data.
  const mask = new Uint8Array(src.length);
  for (const s of dt1BlockSpans(src)) {
    if (!selected || selected.has(s.tile)) mask.fill(1, s.start, s.start + s.length);
  }
  for (let i = 0; i < src.length; i++) {
    if (src[i] === out[i]) continue;
    if (!mask[i]) throw new Error(`byte ${i} changed outside selected block data`);
    if (out[i] !== remap[src[i]]) throw new Error(`byte ${i} not remapped`);
  }
}

describe.runIf(hasD2)('DT1 recolouring on vanilla data', async () => {
  const mpq = hasD2 ? await MpqArchive.open('d2data.mpq', new NodeFileAccess(`${D2_DIR}/d2data.mpq`)) : null!;
  const listfile = hasD2 ? new TextDecoder().decode((await mpq.read('(listfile)'))!).split(/\r?\n/) : [];
  const palette = hasD2 ? parsePalette((await mpq.read('data/global/palette/ACT1/pal.dat'))!) : null!;

  const dt1s: { name: string; bytes: Uint8Array }[] = [];
  if (hasD2) {
    for (const f of listfile.filter((n) => /\.dt1$/i.test(n))) {
      const bytes = await mpq.read(f);
      if (bytes && bytes[0] === 7) dt1s.push({ name: f, bytes });
    }
  }
  const byName = (n: string) => dt1s.find((d) => d.name.toLowerCase() === n.toLowerCase())!;
  const floor = () => byName('data\\global\\tiles\\ACT1\\Town\\floor.dt1') ?? byName('data/global/tiles/ACT1/Town/floor.dt1');
  const hasRle = (bytes: Uint8Array) => dt1BlockSpans(bytes).some((s) => s.format !== 1);
  const walls = () => dt1s.filter((d) => /act1[\\/]town/i.test(d.name) && hasRle(d.bytes));

  it('finds test files', () => {
    expect(floor()).toBeTruthy();
    expect(walls().length).toBeGreaterThan(0);
  });

  it('identity remap is byte-identical for every DT1', () => {
    const id = identityRemap();
    for (const d of dt1s) {
      const out = recolorDt1(d.bytes, id);
      if (out === d.bytes) throw new Error("recolorDt1 must return a new array");
      if (!Buffer.from(out).equals(Buffer.from(d.bytes))) throw new Error(`${d.name} changed`);
    }
  }, 120_000);

  it('recolours only pixel bytes of all tiles (floor + RLE walls)', () => {
    for (const d of [floor(), ...walls()]) {
      checkRecolor(d.bytes, recolorDt1(d.bytes, modRemap), modRemap, null);
    }
  }, 60_000);

  it('recolours only the selected tiles', () => {
    for (const d of [floor(), ...walls().slice(0, 4)]) {
      const n = parseDt1(d.bytes).tiles.length;
      const pick = [0, Math.floor(n / 2), n - 1].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);
      checkRecolor(d.bytes, recolorDt1(d.bytes, modRemap, pick), modRemap, new Set(pick));
    }
  }, 60_000);

  it('recolours every DT1 in d2data.mpq correctly', () => {
    for (const d of dt1s) checkRecolor(d.bytes, recolorDt1(d.bytes, modRemap), modRemap, null);
  }, 300_000);

  it('hueRemap identity maps each unique colour to itself', () => {
    const m = hueRemap(palette, {});
    const m2 = hueRemap(palette, { hue: 0, saturation: 1, brightness: 1, tint: [255, 0, 0], tintAmount: 0 });
    expect(m[0]).toBe(0);
    for (let i = 1; i < 256; i++) {
      let first = i;
      for (let j = 1; j < i; j++) {
        if (palette[j * 4] === palette[i * 4] && palette[j * 4 + 1] === palette[i * 4 + 1] && palette[j * 4 + 2] === palette[i * 4 + 2]) {
          first = j;
          break;
        }
      }
      expect(m[i]).toBe(first);
      expect(m2[i]).toBe(first);
    }
  });

  it('hueRemap with a hue shift changes colours and never produces 0', () => {
    const m = hueRemap(palette, { hue: 120 });
    expect(m[0]).toBe(0);
    let changed = 0;
    for (let i = 1; i < 256; i++) {
      expect(m[i]).not.toBe(0);
      if (m[i] !== i) changed++;
    }
    expect(changed).toBeGreaterThan(50);
    const tinted = hueRemap(palette, { tint: [255, 0, 0], tintAmount: 0.5, saturation: 1.5, brightness: 0.8 });
    for (let i = 1; i < 256; i++) expect(tinted[i]).not.toBe(0);
  });

  it('swapRemap only touches colours near `from`', () => {
    const i0 = 100;
    const from: [number, number, number] = [palette[i0 * 4], palette[i0 * 4 + 1], palette[i0 * 4 + 2]];
    const m = swapRemap(palette, from, [255, 0, 0], 0);
    expect(m[0]).toBe(0);
    for (let i = 1; i < 256; i++) {
      const same = palette[i * 4] === from[0] && palette[i * 4 + 1] === from[1] && palette[i * 4 + 2] === from[2];
      if (!same) expect(m[i]).toBe(i);
      expect(m[i]).not.toBe(0);
    }
    const r = m[i0];
    expect(palette[r * 4]).toBeGreaterThan(palette[r * 4 + 1]);
  });
});
