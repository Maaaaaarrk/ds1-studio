/** A D2 act palette (pal.dat): 256 BGR triplets. */
export type Palette = Uint8Array; // 256 * 4 RGBA

export function parsePalette(bytes: Uint8Array): Palette {
  if (bytes.length < 768) throw new Error(`palette too short (${bytes.length} bytes)`);
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    out[i * 4] = bytes[i * 3 + 2];
    out[i * 4 + 1] = bytes[i * 3 + 1];
    out[i * 4 + 2] = bytes[i * 3];
    out[i * 4 + 3] = i === 0 ? 0 : 255; // index 0 is transparent
  }
  return out;
}

/** Palette choices: 0-4 are the game's act palettes; 5 is d2data.mpq's Act 5 palette, which LoD overrides with d2exp's. */
export const PALETTE_NAMES = ['Act 1', 'Act 2', 'Act 3', 'Act 4', 'Act 5', 'Act 5 (old d2data.mpq)'];
export const OLD_ACT5_PALETTE = 5;

export function palettePath(act: number): string {
  return `data/global/palette/ACT${act + 1}/pal.dat`;
}
