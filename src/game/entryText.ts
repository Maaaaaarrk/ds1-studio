import { parseDc6, writeDc6, type SpriteFrame } from '../formats/dc6';

/**
 * The "Entering …" text image a level shows as it is entered (Levels.txt EntryFile → data/local/ui/<lang>/expansion/
 * <EntryFile>.dc6), for players who don't use PD2's digital text. It is the line of text drawn with one of the game's
 * fonts (data/local/font/latin/fontNN.dc6 + .tbl), glyph after glyph by each one's advance width, cut into frames at
 * most 256 pixels wide: what the community's txt2dc6 made (PD2's own, e.g. U5L1.dc6, match it pixel for pixel, font42).
 */

export const ENTRY_FONTS = [
  { id: 'font42', label: 'Large (font42, as PD2’s own)' },
  { id: 'font30', label: 'Medium (font30)' },
  { id: 'font24', label: 'Small (font24)' },
] as const;
export type EntryFont = (typeof ENTRY_FONTS)[number]['id'];

export const FRAME_WIDTH = 256;

export interface EntryImage {
  width: number;
  height: number;
  /** Palette indices, 0 = transparent, top row first. */
  pixels: Uint8Array;
  /** Characters the font has no glyph for (drawn as nothing). */
  missing: string[];
}

/** The font's glyphs: .tbl entries are 14 bytes (code u16, pad, advance width, height, …, DC6 frame u16, …). */
export function loadFont(dc6: Uint8Array, tbl: Uint8Array): { glyph: (code: number) => { advance: number; image: SpriteFrame } | null; height: number } {
  if (String.fromCharCode(...tbl.subarray(0, 4)) !== 'Woo!') throw new Error('Not a Diablo II font table (.tbl).');
  const frames = parseDc6(dc6).frames.flat();
  const count = Math.floor((tbl.length - 12) / 14);
  const byCode = new Map<number, { advance: number; frame: number }>();
  for (let i = 0; i < count; i++) {
    const o = 12 + i * 14;
    byCode.set(tbl[o] | (tbl[o + 1] << 8), { advance: tbl[o + 3], frame: tbl[o + 8] | (tbl[o + 9] << 8) });
  }
  return {
    height: frames[0]?.image.height ?? 0,
    glyph: (code) => {
      const g = byCode.get(code);
      const image = g ? frames[g.frame]?.image : undefined;
      return g && image ? { advance: g.advance, image } : null;
    },
  };
}

/** The line of text as one image. */
export function renderEntryText(font: ReturnType<typeof loadFont>, text: string): EntryImage {
  const missing = new Set<string>();
  const glyphs = [...text].map((ch) => {
    const g = font.glyph(ch.charCodeAt(0));
    if (!g) missing.add(ch);
    return g;
  });
  const width = Math.max(1, glyphs.reduce((w, g) => w + (g?.advance ?? 0), 0));
  const height = font.height;
  const pixels = new Uint8Array(width * height);
  let x = 0;
  for (const g of glyphs) {
    if (!g) continue;
    const im = g.image;
    for (let y = 0; y < Math.min(im.height, height); y++)
      for (let gx = 0; gx < im.width && x + gx < width; gx++) {
        const c = im.pixels[y * im.width + gx];
        if (c) pixels[y * width + x + gx] = c;
      }
    x += g.advance;
  }
  return { width, height, pixels, missing: [...missing] };
}

/** The image as a DC6: frames of 256 pixels across, left to right (the last one narrower). */
export function entryDc6(img: EntryImage): Uint8Array {
  const frames = [];
  for (let x0 = 0; x0 < img.width; x0 += FRAME_WIDTH) {
    const w = Math.min(FRAME_WIDTH, img.width - x0);
    const pixels = new Uint8Array(w * img.height);
    for (let y = 0; y < img.height; y++) pixels.set(img.pixels.subarray(y * img.width + x0, y * img.width + x0 + w), y * w);
    frames.push({ width: w, height: img.height, pixels });
  }
  return writeDc6(frames);
}

/** A suggested EntryFile name: short, letters and digits (the game builds the path from it). */
export function suggestEntryName(levelName: string, taken: (name: string) => boolean): string {
  const base = (levelName.replace(/[^A-Za-z0-9]+/g, '').slice(0, 10) || 'Entry').toLowerCase();
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base}${n}`;
  return name;
}
