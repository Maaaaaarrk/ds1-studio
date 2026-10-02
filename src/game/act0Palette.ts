import { palettePath, parsePalette, type Palette } from '../formats/palette';
import type { LayeredFs } from '../vfs/vfs';
import { hueRemap, recolorDt1 } from '../formats/dt1Edit';
import { decodeTile, parseDt1 } from '../formats/dt1';

/**
 * The "Act 0" palette: only the colours that look the same in every act, so tiles drawn with it don't shift colour
 * between acts. Gimli's act0.act (github.com/D2R-Gimli/Diablo2_act0_color_palette) is the reference: the Act 1
 * palette with every act-specific slot set to magenta. Its repository has no licence, so DS1 Studio doesn't ship the
 * file: it downloads it from GitHub the first time and keeps it on this computer. Offline (or if that fails) the same
 * palette is derived from the game's own five act palettes.
 */
export const ACT0_URL = 'https://raw.githubusercontent.com/D2R-Gimli/Diablo2_act0_color_palette/main/act0_palette/act0.act';
export const ACT0_SOURCE_PAGE = 'https://github.com/D2R-Gimli/Diablo2_act0_color_palette';

export interface Act0Palette {
  /** 256 × RGBA. Unusable slots are magenta (as in Gimli's file), so pixels using them stand out. */
  palette: Palette;
  /** Slots that look the same in every act (index 0, transparency, excluded). */
  usable: boolean[];
  source: 'gimli' | 'derived';
}

const CACHE_KEY = 'ds1studio.act0.act';
let loading: Promise<Act0Palette> | null = null;

function fromAct(bytes: Uint8Array): Act0Palette {
  const palette = new Uint8Array(256 * 4);
  const usable: boolean[] = [];
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = [bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]];
    // Slot 0 is transparency (image editors show it as cyan): black, like the game's palettes.
    palette.set(i === 0 ? [0, 0, 0, 255] : [r, g, b, 255], i * 4);
    usable.push(i !== 0 && !(r === 255 && g === 0 && b === 255));
  }
  return { palette, usable, source: 'gimli' };
}

async function derive(fs: LayeredFs): Promise<Act0Palette> {
  const acts: Palette[] = [];
  for (let a = 0; a < 5; a++) {
    const b = await fs.read(palettePath(a));
    if (b) acts.push(parsePalette(b));
  }
  if (!acts.length) throw new Error('No act palettes found');
  const palette = new Uint8Array(256 * 4);
  const usable: boolean[] = [];
  for (let i = 0; i < 256; i++) {
    const same = acts.every((p) => p[i * 4] === acts[0][i * 4] && p[i * 4 + 1] === acts[0][i * 4 + 1] && p[i * 4 + 2] === acts[0][i * 4 + 2]);
    const ok = i !== 0 && same;
    usable.push(ok);
    palette.set(ok || i === 0 ? [acts[0][i * 4], acts[0][i * 4 + 1], acts[0][i * 4 + 2], 255] : [255, 0, 255, 255], i * 4);
  }
  return { palette, usable, source: 'derived' };
}

/** The Act 0 palette (cached after the first call). */
export function loadAct0Palette(fs: LayeredFs): Promise<Act0Palette> {
  if (!loading) {
    loading = (async () => {
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const bytes = Uint8Array.from(atob(cached), (c) => c.charCodeAt(0));
          if (bytes.length >= 768) return fromAct(bytes);
        }
      } catch {
        // no cache
      }
      try {
        const res = await fetch(ACT0_URL, { cache: 'no-store' });
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.length >= 768) {
            try {
              localStorage.setItem(CACHE_KEY, btoa(String.fromCharCode(...bytes.subarray(0, 768))));
            } catch {
              // keep working without the cache
            }
            return fromAct(bytes);
          }
        }
      } catch {
        // offline: fall through
      }
      return derive(fs);
    })();
  }
  return loading;
}

/**
 * The Act 0 conversion of a DT1 drawn for the act whose palette is `home`: every colour snapped to the nearest Act 0
 * colour by plain RGB distance (ties to the lowest index). This reproduces the community's act-0 DT1 sets exactly
 * wherever they weren't dithered or retouched (checked against a full converted set: 90.6% of every changed pixel,
 * the rest error-diffusion dithering and hand edits).
 */
export function act0Remap(home: Palette, usable: ArrayLike<boolean>): Uint8Array {
  return hueRemap(home, { allowed: usable, metric: 'rgb' });
}

/**
 * The act a tile library was drawn for, from its folder: ACT1-ACT4, expansion = Act 5. null when the folder doesn't
 * say: then look at the art (openMap's guessDrawnAct with drawnPalettes), never just at the level's act, which bakes
 * that act's wrong colours into the Act 0 file. Blizzard's unused Guild tiles are not Act 1 art (as once assumed here):
 * they were drawn with d2data.mpq's classic Act 5 palette, which the art test recognises.
 */
export function dt1Act(path: string): number | null {
  const m = /^data\/global\/tiles\/(?:act(\d)|(expansion))\//i.exec(path);
  if (!m) return null;
  return m[2] ? 4 : Math.min(4, Math.max(0, Number(m[1]) - 1));
}

/**
 * A DT1 converted to the Act 0 colours (see act0Remap), judged by `home`, the palette of the act it was drawn for.
 * null when it already uses only Act 0 colours (or isn't a DT1 the game reads).
 */
export function act0Convert(bytes: Uint8Array, home: Palette, usable: ArrayLike<boolean>): { bytes: Uint8Array; pixels: number } | null {
  let pixels = 0;
  try {
    for (const t of parseDt1(bytes).tiles) {
      const img = decodeTile(t);
      if (img) for (const p of img.pixels) if (p && !usable[p]) pixels++;
    }
  } catch {
    return null;
  }
  return pixels ? { bytes: recolorDt1(bytes, act0Remap(home, usable)), pixels } : null;
}

/**
 * The Act 0 palette for showing tiles: act-safe colours as they are, the rest either in `home`'s colours (how the tile
 * looks in its own act) or magenta to highlight them.
 */
export function act0Display(a: Act0Palette, home: Palette | null, highlight: boolean): Palette {
  if (highlight || !home) return a.palette;
  const out = a.palette.slice();
  for (let i = 1; i < 256; i++) if (!a.usable[i]) out.set(home.subarray(i * 4, i * 4 + 4), i * 4);
  return out;
}
