import { unzlibSync, zlibSync } from 'fflate';

/**
 * Minimal PNG reading and writing for tile pictures: writes 8-bit indexed PNGs (the palette in PLTE, index 0
 * transparent via tRNS), as GIMP and other editors keep them; reads indexed (1/2/4/8-bit), greyscale, RGB and RGBA
 * 8-bit PNGs (non-interlaced).
 */

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An indexed PNG: `pixels` are palette indices (0 = transparent), `palette` 256 RGBA entries (4 bytes each). */
export function writeIndexedPng(width: number, height: number, pixels: Uint8Array, palette: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const plte = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) plte.set([palette[i * 4], palette[i * 4 + 1], palette[i * 4 + 2]], i * 3);
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const parts = [Uint8Array.from(SIG), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', Uint8Array.of(0)), chunk('IDAT', zlibSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

export interface PngImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  rgba: Uint8Array;
  /** For indexed PNGs: the indices and the PNG's palette (RGB), to keep indices as they are. */
  indices?: Uint8Array;
  plte?: Uint8Array;
}

export function readPng(bytes: Uint8Array): PngImage {
  if (!SIG.every((b, i) => bytes[i] === b)) throw new Error('Not a PNG file.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let plte: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (p + 8 <= bytes.length) {
    const len = v.getUint32(p);
    const t = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const d = bytes.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') {
      width = v.getUint32(p + 8);
      height = v.getUint32(p + 12);
      depth = d[8];
      type = d[9];
      interlace = d[12];
    } else if (t === 'PLTE') plte = d.slice();
    else if (t === 'tRNS') trns = d.slice();
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('Interlaced PNGs are not supported: save it without interlacing.');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0 | 2 | 3 | 4 | 6];
  if (!channels || (type !== 3 && depth !== 8) || (type === 3 && ![1, 2, 4, 8].includes(depth))) throw new Error(`PNG colour type ${type} at ${depth} bits is not supported: save it as indexed or 8-bit RGB(A).`);
  const all = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) (all.set(c, o), (o += c.length));
  const raw = unzlibSync(all);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  const lines = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y ? lines.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let val = src[x];
      if (f === 1) val += a;
      else if (f === 2) val += b;
      else if (f === 3) val += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        val += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = val & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  let indices: Uint8Array | undefined;
  if (type === 3) {
    if (!plte) throw new Error('Indexed PNG without a palette.');
    indices = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bit = x * depth;
        const byte = lines[y * stride + (bit >> 3)];
        const idx = depth === 8 ? byte : (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        indices[y * width + x] = idx;
        rgba.set([plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2], trns && idx < trns.length ? trns[idx] : 255], (y * width + x) * 4);
      }
  } else {
    for (let i = 0; i < width * height; i++) {
      const s = lines.subarray(i * channels, i * channels + channels);
      const [r, g, b, a] = type === 0 ? [s[0], s[0], s[0], 255] : type === 4 ? [s[0], s[0], s[0], s[1]] : type === 2 ? [s[0], s[1], s[2], 255] : [s[0], s[1], s[2], s[3]];
      rgba.set([r, g, b, a], i * 4);
    }
  }
  return { width, height, rgba, indices, plte };
}

/**
 * The picture as palette indices: an indexed PNG keeps its indices where its colours match this palette's; other
 * pixels (and RGB PNGs) take the nearest colour (among `allowed` when given); transparent pixels become 0.
 */
export function toPaletteIndices(img: PngImage, palette: Uint8Array, allowed?: boolean[] | null): { pixels: Uint8Array; remapped: number } {
  const out = new Uint8Array(img.width * img.height);
  const cache = new Map<number, number>();
  let remapped = 0;
  const nearest = (r: number, g: number, b: number) => {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 1, bd = Infinity;
    for (let i = 1; i < 256; i++) {
      if (allowed && !allowed[i]) continue;
      const dr = palette[i * 4] - r, dg = palette[i * 4 + 1] - g, db = palette[i * 4 + 2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bd) (bd = d), (best = i);
    }
    cache.set(key, best);
    return best;
  };
  for (let i = 0; i < out.length; i++) {
    const [r, g, b, a] = img.rgba.subarray(i * 4, i * 4 + 4);
    if (a < 128) continue;
    const idx = img.indices?.[i];
    if (idx !== undefined && idx > 0 && palette[idx * 4] === r && palette[idx * 4 + 1] === g && palette[idx * 4 + 2] === b && (!allowed || allowed[idx])) out[i] = idx;
    else {
      out[i] = nearest(r, g, b);
      remapped++;
    }
  }
  return { pixels: out, remapped };
}
