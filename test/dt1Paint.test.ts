import { describe, expect, it } from 'vitest';
import { decodeTile, parseDt1, type Dt1Tile, type TileImage } from '../src/formats/dt1';
import {
  decodeRleBlock,
  droppedPixelCount,
  encodeRleBlock,
  paintableMask,
  setManyTilePixels,
  setTilePixels,
} from '../src/formats/dt1Paint';
import { MpqArchive } from '../src/formats/mpq/MpqArchive';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

function headerOf(t: Dt1Tile) {
  return {
    direction: t.direction, roofHeight: t.roofHeight, soundIndex: t.soundIndex, animated: t.animated,
    height: t.height, width: t.width, orientation: t.orientation, mainIndex: t.mainIndex,
    subIndex: t.subIndex, rarity: t.rarity, subTileFlags: Array.from(t.subTileFlags),
    blocks: t.blocks.map((b) => ({ x: b.x, y: b.y, gridX: b.gridX, gridY: b.gridY, format: b.format })),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
}

function sameImage(a: TileImage | null, b: TileImage | null): boolean {
  if (!a || !b) return a === b;
  return a.width === b.width && a.height === b.height && a.offsetX === b.offsetX && a.offsetY === b.offsetY && sameBytes(a.pixels, b.pixels);
}

/** Tile header fields of the raw file that are not block data: everything except +72 (ptr) and +76 (data length). */
function rawTileHeaders(bytes: Uint8Array): Uint8Array[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const count = dv.getInt32(268, true);
  const ptr = dv.getInt32(272, true);
  const out: Uint8Array[] = [];
  for (let t = 0; t < count; t++) {
    const h = bytes.slice(ptr + t * 96, ptr + t * 96 + 96);
    h.fill(0, 72, 80);
    out.push(h);
  }
  return out;
}

/** Checks `out` parses, keeps all headers, and every tile decodes like `src` except tiles in `expected`. */
function checkFile(src: Uint8Array, out: Uint8Array, expected: Map<number, TileImage> = new Map()) {
  const a = parseDt1(src);
  const b = parseDt1(out);
  expect(b.version).toEqual(a.version);
  expect(b.tiles.length).toBe(a.tiles.length);
  expect(sameBytes(out.subarray(0, 276), src.subarray(0, 276))).toBe(true);
  const ha = rawTileHeaders(src);
  const hb = rawTileHeaders(out);
  for (let t = 0; t < a.tiles.length; t++) {
    if (!sameBytes(ha[t], hb[t])) throw new Error(`tile ${t} raw header changed`);
    expect(headerOf(b.tiles[t])).toEqual(headerOf(a.tiles[t]));
    const want = expected.get(t) ?? decodeTile(a.tiles[t]);
    if (!sameImage(decodeTile(b.tiles[t]), want)) throw new Error(`tile ${t} decodes wrongly`);
  }
  // Block headers keep their non-layout bytes; data length field stays consistent.
  const dv = new DataView(out.buffer, out.byteOffset, out.length);
  const ptr = dv.getInt32(272, true);
  for (let t = 0; t < b.tiles.length; t++) {
    const th = ptr + t * 96;
    const n = dv.getInt32(th + 80, true);
    if (n <= 0) continue;
    const sum = b.tiles[t].blocks.reduce((s, bl) => s + bl.data.length, 0);
    expect(dv.getInt32(th + 76, true)).toBe(20 * n + sum);
  }
}

describe.runIf(hasD2)('DT1 pixel painting on vanilla data', async () => {
  const mpq = hasD2 ? await MpqArchive.open('d2data.mpq', new NodeFileAccess(`${D2_DIR}/d2data.mpq`)) : null!;
  const listfile = hasD2 ? new TextDecoder().decode((await mpq.read('(listfile)'))!).split(/\r?\n/) : [];

  const dt1s: { name: string; bytes: Uint8Array }[] = [];
  if (hasD2) {
    for (const f of listfile.filter((n) => /\.dt1$/i.test(n))) {
      const bytes = await mpq.read(f);
      if (bytes && bytes[0] === 7) dt1s.push({ name: f, bytes });
    }
  }
  const byName = (n: string) => dt1s.find((d) => d.name.toLowerCase().replace(/\//g, '\\') === n.toLowerCase())!;
  const floor = () => byName('data\\global\\tiles\\ACT1\\Town\\floor.dt1');
  const hasRle = (bytes: Uint8Array) => parseDt1(bytes).tiles.some((t) => t.blocks.some((b) => b.format !== 1));
  const walls = () => dt1s.filter((d) => /act1[\\/]town/i.test(d.name) && hasRle(d.bytes));

  it('finds test files', () => {
    expect(floor()).toBeTruthy();
    expect(walls().length).toBeGreaterThan(0);
  });

  it('RLE encoder reproduces every vanilla RLE block byte for byte', () => {
    let blocks = 0;
    for (const d of dt1s) {
      for (const t of parseDt1(d.bytes).tiles) {
        for (const b of t.blocks) {
          if (b.format === 1) continue;
          const { pixels, rows } = decodeRleBlock(b.data);
          if (!sameBytes(encodeRleBlock(pixels, rows), b.data)) throw new Error(`${d.name}: block differs`);
          blocks++;
        }
      }
    }
    expect(blocks).toBeGreaterThan(1000);
  }, 60_000);

  it('round-trips every tile of floor and town wall DT1s', () => {
    let reencodedIdentical = 0;
    let reencodedFiles = 0;
    for (const d of [floor(), ...walls()]) {
      const tiles = parseDt1(d.bytes).tiles;
      const edits = tiles.flatMap((t, i) => {
        const image = decodeTile(t);
        return image ? [{ tileIndex: i, image }] : [];
      });
      // Default: nothing changed -> byte-identical copy.
      for (const e of edits) {
        const out = setTilePixels(d.bytes, e.tileIndex, e.image);
        if (out === d.bytes || !sameBytes(out, d.bytes)) throw new Error(`${d.name} tile ${e.tileIndex} not identical`);
      }
      // Forced re-encode of every block of every tile.
      const out = setManyTilePixels(d.bytes, edits, { reencodeAll: true });
      checkFile(d.bytes, out);
      reencodedFiles++;
      if (sameBytes(out, d.bytes)) reencodedIdentical++;
      // Per-tile forced re-encode for a few tiles.
      for (const e of [edits[0], edits[edits.length >> 1], edits[edits.length - 1]]) {
        if (!sameBytes(setTilePixels(d.bytes, e.tileIndex, e.image, { reencodeAll: true }), d.bytes)) {
          throw new Error(`${d.name} tile ${e.tileIndex} re-encode not byte-identical`);
        }
      }
    }
    console.log(`forced re-encode byte-identical: ${reencodedIdentical}/${reencodedFiles} files`);
    expect(reencodedIdentical).toBe(reencodedFiles);
  }, 60_000);

  function pickWallTile() {
    for (const d of walls()) {
      const tiles = parseDt1(d.bytes).tiles;
      for (let i = 0; i < tiles.length - 1; i++) {
        const t = tiles[i];
        if (t.blocks.length < 4 || t.blocks.some((b) => b.format === 1)) continue;
        const im = decodeTile(t)!;
        const mask = paintableMask(t);
        let transparent = 0;
        let opaque = 0;
        for (let p = 0; p < mask.length; p++) if (mask[p]) im.pixels[p] ? opaque++ : transparent++;
        if (transparent > 50 && opaque > 50) return { d, tileIndex: i, tile: t };
      }
    }
    throw new Error('no suitable wall tile');
  }

  it('paints pixels of an RLE wall tile', () => {
    const { d, tileIndex, tile } = pickWallTile();
    const src = decodeTile(tile)!;
    const mask = paintableMask(tile);
    expect(mask.length).toBe(src.pixels.length);
    const pixels = src.pixels.slice();
    let madeOpaque = 0;
    let madeTransparent = 0;
    let recoloured = 0;
    for (let p = 0; p < pixels.length; p++) {
      if (!mask[p] || p % 7 !== 0) continue;
      if (pixels[p] === 0) {
        pixels[p] = 200;
        madeOpaque++;
      } else if (p % 14 === 0) {
        pixels[p] = 0;
        madeTransparent++;
      } else {
        pixels[p] = (pixels[p] % 254) + 1;
        recoloured++;
      }
    }
    expect(madeOpaque).toBeGreaterThan(0);
    expect(madeTransparent).toBeGreaterThan(0);
    expect(recoloured).toBeGreaterThan(0);
    const image = { ...src, pixels };
    expect(droppedPixelCount(tile, image)).toBe(0);
    const out = setTilePixels(d.bytes, tileIndex, image);
    console.log(`painted ${d.name} tile ${tileIndex}: file ${d.bytes.length} -> ${out.length} bytes`);
    checkFile(d.bytes, out, new Map([[tileIndex, image]]));
    // Painting back the original restores the original file exactly.
    expect(sameBytes(setTilePixels(out, tileIndex, src), d.bytes)).toBe(true);
  });

  it('paints an isometric floor tile, including index 0', () => {
    const d = floor();
    const tiles = parseDt1(d.bytes).tiles;
    const ti = tiles.findIndex((t) => t.blocks.length > 0 && t.blocks.every((b) => b.format === 1));
    const tile = tiles[ti];
    const src = decodeTile(tile)!;
    const mask = paintableMask(tile);
    const pixels = src.pixels.slice();
    for (let p = 0; p < pixels.length; p++) if (mask[p] && p % 5 === 0) pixels[p] = p % 10 === 0 ? 0 : 77;
    const image = { ...src, pixels };
    const out = setTilePixels(d.bytes, ti, image);
    expect(out.length).toBe(d.bytes.length);
    checkFile(d.bytes, out, new Map([[ti, image]]));
  });

  it('paints several tiles at once', () => {
    const d = walls()[0];
    const tiles = parseDt1(d.bytes).tiles;
    const expected = new Map<number, TileImage>();
    for (let i = 0; i < tiles.length; i += 3) {
      const src = decodeTile(tiles[i]);
      if (!src) continue;
      const mask = paintableMask(tiles[i]);
      const pixels = src.pixels.slice();
      for (let p = 0; p < pixels.length; p++) if (mask[p] && (p + i) % 11 === 0) pixels[p] = pixels[p] ? 0 : 33;
      expected.set(i, { ...src, pixels });
    }
    const out = setManyTilePixels(d.bytes, [...expected].map(([tileIndex, image]) => ({ tileIndex, image })));
    checkFile(d.bytes, out, expected);
  });

  it('drops pixels painted outside the paintable mask', () => {
    const { d, tileIndex, tile } = pickWallTile();
    // Prefer a tile whose bounding box has uncovered pixels.
    let target = { d, tileIndex, tile };
    outer: for (const w of walls()) {
      const tiles = parseDt1(w.bytes).tiles;
      for (let i = 0; i < tiles.length; i++) {
        const m = paintableMask(tiles[i]);
        if (m.length && m.some((v) => v === 0)) {
          target = { d: w, tileIndex: i, tile: tiles[i] };
          break outer;
        }
      }
    }
    const src = decodeTile(target.tile)!;
    const mask = paintableMask(target.tile);
    const pixels = src.pixels.slice();
    let outside = 0;
    for (let p = 0; p < pixels.length; p++) {
      if (!mask[p]) {
        pixels[p] = 55;
        outside++;
      }
    }
    expect(outside).toBeGreaterThan(0);
    const image = { ...src, pixels };
    expect(droppedPixelCount(target.tile, image)).toBe(outside);
    const out = setTilePixels(target.d.bytes, target.tileIndex, image);
    expect(sameBytes(out, target.d.bytes)).toBe(true);
    checkFile(target.d.bytes, out);
  });

  it('rejects mismatched geometry', () => {
    const { d, tileIndex, tile } = pickWallTile();
    const src = decodeTile(tile)!;
    expect(() => setTilePixels(d.bytes, tileIndex, { ...src, offsetX: src.offsetX + 1 })).toThrow();
    expect(() => setTilePixels(d.bytes, tileIndex, { ...src, pixels: src.pixels.subarray(1) })).toThrow();
    expect(() => setTilePixels(d.bytes, 1e6, src)).toThrow();
  });

  it('re-encodes the first and last tile of every DT1 in d2data.mpq losslessly', () => {
    let identical = 0;
    let files = 0;
    for (const d of dt1s) {
      const tiles = parseDt1(d.bytes).tiles;
      const edits = [0, tiles.length - 1]
        .filter((v, i, a) => v >= 0 && a.indexOf(v) === i)
        .flatMap((i) => {
          const image = decodeTile(tiles[i]);
          return image ? [{ tileIndex: i, image }] : [];
        });
      if (edits.length === 0) continue;
      const out = setManyTilePixels(d.bytes, edits, { reencodeAll: true });
      checkFile(d.bytes, out);
      files++;
      if (sameBytes(out, d.bytes)) identical++;
    }
    console.log(`first/last tile re-encode byte-identical: ${identical}/${files} files`);
    expect(identical).toBe(files);
  }, 120_000);
});
