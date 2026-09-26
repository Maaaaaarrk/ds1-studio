import type { Palette } from './palette';

/**
 * Pure DT1 recolouring engine. Operates on raw DT1 v7.6 bytes and returns a new buffer with the
 * same size and structure; only palette-index pixel bytes of the chosen tiles' blocks change.
 *
 * Layout (mirrors parseDt1 in dt1.ts):
 *   file header: i32 7, i32 6, 260 bytes padding, i32 tileCount, i32 tileHeaderPtr
 *   tile header (96 bytes each): ... +72 i32 blockHeaderPtr, +76 i32 blockDataLength, +80 i32 blockCount ...
 *   block header (20 bytes each, at blockHeaderPtr): i16 x, i16 y, 2 pad, u8 gridX, u8 gridY,
 *     i16 format, i32 length, 2 pad, i32 offset  -- offset is relative to the tile's blockHeaderPtr
 *   block data: format 1 = isometric (256 index bytes, 15-row diamond); otherwise RLE:
 *     (skip, count) pairs, then `count` index bytes; (0, 0) ends a row.
 */

const TILE_HEADER_SIZE = 96;
const BLOCK_HEADER_SIZE = 20;
const ISO_BLOCK_PIXELS = 256;

function i32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0;
}
function i16(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
}

/** Absolute location of one block's data in a DT1 file. */
export interface Dt1BlockSpan {
  tile: number;
  block: number;
  format: number;
  start: number;
  length: number;
}

/** Lists every block's absolute data range, computed exactly as parseDt1 does (blockHeaderPtr + offset). */
export function dt1BlockSpans(bytes: Uint8Array): Dt1BlockSpan[] {
  if (bytes.length < 276 || i32(bytes, 0) !== 7 || i32(bytes, 4) !== 6) {
    throw new Error('unsupported DT1 (expected version 7.6)');
  }
  const count = i32(bytes, 268);
  const headerPtr = i32(bytes, 272);
  const spans: Dt1BlockSpan[] = [];
  for (let t = 0; t < count; t++) {
    const th = headerPtr + t * TILE_HEADER_SIZE;
    const blockPtr = i32(bytes, th + 72);
    const blockCount = i32(bytes, th + 80);
    if (blockCount <= 0 || blockPtr <= 0) continue;
    for (let b = 0; b < blockCount; b++) {
      const bh = blockPtr + b * BLOCK_HEADER_SIZE;
      const format = i16(bytes, bh + 8);
      const length = i32(bytes, bh + 10);
      const offset = i32(bytes, bh + 16);
      const start = blockPtr + offset;
      const end = Math.min(bytes.length, start + Math.max(0, length));
      spans.push({ tile: t, block: b, format, start, length: Math.max(0, end - start) });
    }
  }
  return spans;
}

/** Remaps pixel bytes of one block in place. Control bytes of RLE blocks are left alone. */
function remapBlock(out: Uint8Array, start: number, length: number, format: number, remap: Uint8Array): void {
  const end = start + length;
  const map = (p: number) => {
    const v = out[p];
    if (v !== 0) out[p] = remap[v];
  };
  if (format === 1) {
    const n = Math.min(length, ISO_BLOCK_PIXELS);
    for (let p = start; p < start + n; p++) map(p);
    return;
  }
  // RLE: same walk as decodeTile, but continues to the end of the data (never reinterprets pixels as control).
  let p = start;
  while (p + 1 < end) {
    const skip = out[p++];
    const n = out[p++];
    if (skip === 0 && n === 0) continue;
    const stop = Math.min(end, p + n);
    for (; p < stop; p++) map(p);
  }
}

/**
 * Returns a copy of a DT1 with every pixel byte of the chosen tiles replaced by remap[byte].
 * Index 0 (transparent) always stays 0, and a non-zero index is never mapped to 0 (remap results of
 * 0 are ignored). `tiles` are tile indices in file order; undefined = all tiles.
 * Blocks whose data range is shared with an unselected tile are recoloured anyway only if every
 * owner is selected; otherwise they are skipped so unselected tiles never change.
 */
export function recolorDt1(bytes: Uint8Array, remap: Uint8Array, tiles?: number[]): Uint8Array {
  if (remap.length < 256) throw new Error('remap must have 256 entries');
  const safe = new Uint8Array(256);
  for (let i = 1; i < 256; i++) safe[i] = remap[i] === 0 ? i : remap[i];

  const out = bytes.slice();
  const spans = dt1BlockSpans(bytes);
  const selected = tiles ? new Set(tiles) : null;
  const isSel = (t: number) => !selected || selected.has(t);

  // Group by data range so shared data is remapped at most once and never behind an unselected tile's back.
  const byRange = new Map<string, Dt1BlockSpan[]>();
  for (const s of spans) {
    const k = `${s.start}:${s.length}:${s.format === 1 ? 1 : 0}`;
    const list = byRange.get(k);
    if (list) list.push(s);
    else byRange.set(k, [s]);
  }
  for (const list of byRange.values()) {
    if (!list.some((s) => isSel(s.tile))) continue;
    if (!list.every((s) => isSel(s.tile))) continue;
    const s = list[0];
    remapBlock(out, s.start, s.length, s.format, safe);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Colour remaps

function nearestIndex(palette: Palette, r: number, g: number, b: number): number {
  // Perceptual "redmean" weighting; an exact colour match always has distance 0, and ties go to
  // the lowest index, so duplicate palette colours resolve to the first equal index.
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < 256; i++) {
    const pr = palette[i * 4];
    const dr = pr - r;
    const dg = palette[i * 4 + 1] - g;
    const db = palette[i * 4 + 2] - b;
    const rm = (pr + r) / 2;
    const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
      if (d === 0) break;
    }
  }
  return best;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface HueRemapOptions {
  /** Hue rotation in degrees (-180..180). */
  hue?: number;
  /** Saturation multiplier (1 = unchanged). */
  saturation?: number;
  /** Brightness (HSV value) multiplier (1 = unchanged). */
  brightness?: number;
  /** Tint colour, RGB 0-255. */
  tint?: [number, number, number];
  /** Tint mix amount 0..1 (0 = none). */
  tintAmount?: number;
}

/**
 * Builds a 256-entry index remap from HSV adjustments (hue rotate, saturation and brightness
 * multipliers) followed by an optional linear tint mix, re-quantised to the nearest palette
 * colour among indices 1..255. remap[0] = 0 and no non-zero index maps to 0.
 * With identity options every index whose colour is unique in 1..255 maps to itself; an index
 * whose colour duplicates an earlier index maps to that first equal index.
 */
export function hueRemap(palette: Palette, opts: HueRemapOptions): Uint8Array {
  const hue = opts.hue ?? 0;
  const sat = opts.saturation ?? 1;
  const bri = opts.brightness ?? 1;
  const tint = opts.tint;
  const amt = tint ? clamp01(opts.tintAmount ?? 0) : 0;
  const hsvIdentity = hue === 0 && sat === 1 && bri === 1;

  const remap = new Uint8Array(256);
  for (let i = 1; i < 256; i++) {
    let r = palette[i * 4];
    let g = palette[i * 4 + 1];
    let b = palette[i * 4 + 2];
    if (!hsvIdentity) {
      const [h, s, v] = rgbToHsv(r, g, b);
      [r, g, b] = hsvToRgb(h + hue, clamp01(s * sat), clamp01(v * bri));
    }
    if (amt > 0 && tint) {
      r = r + (tint[0] - r) * amt;
      g = g + (tint[1] - g) * amt;
      b = b + (tint[2] - b) * amt;
    }
    remap[i] = nearestIndex(palette, clamp255(r), clamp255(g), clamp255(b));
  }
  return remap;
}

/**
 * "Replace colour": indices whose RGB is within `tolerance` (Euclidean RGB distance) of `from`
 * are shifted by (to - from) and re-quantised to the nearest palette colour (1..255); all other
 * indices map to themselves. remap[0] = 0.
 */
export function swapRemap(
  palette: Palette,
  from: [number, number, number],
  to: [number, number, number],
  tolerance: number,
): Uint8Array {
  const remap = new Uint8Array(256);
  const tol2 = tolerance * tolerance;
  const dr = to[0] - from[0];
  const dg = to[1] - from[1];
  const db = to[2] - from[2];
  for (let i = 1; i < 256; i++) {
    const r = palette[i * 4];
    const g = palette[i * 4 + 1];
    const b = palette[i * 4 + 2];
    const d2 = (r - from[0]) ** 2 + (g - from[1]) ** 2 + (b - from[2]) ** 2;
    remap[i] = d2 <= tol2 ? nearestIndex(palette, clamp255(r + dr), clamp255(g + dg), clamp255(b + db)) : i;
  }
  return remap;
}

/** Identity remap (every index to itself). */
export function identityRemap(): Uint8Array {
  const m = new Uint8Array(256);
  for (let i = 0; i < 256; i++) m[i] = i;
  return m;
}
