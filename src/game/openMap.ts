import { parseDs1, type Ds1 } from '../formats/ds1';
import { decodeTile, type Dt1Tile } from '../formats/dt1';
import { ACT0_PALETTE, OLD_ACT5_PALETTE, type Palette } from '../formats/palette';
import { act0Display, loadAct0Palette } from './act0Palette';
import { BUILTIN_SPECIALS_PATH, builtinSpecialTiles } from './specialTiles';

const SPECIALS = builtinSpecialTiles();
import { TileLibrary, type Dt1Resolution, type GameData } from './GameData';

export type PaletteSource = 'level' | 'tiles' | 'ds1' | 'manual';

export interface OpenMap {
  path: string;
  ds1: Ds1;
  /** 0-based act whose palette the map is drawn with, and how it was chosen. */
  paletteAct: number;
  paletteSource: PaletteSource;
  /** The act the map would be drawn in without Act 0: its colours fill Act 0's act-specific slots. */
  homeAct?: number;
  resolution: Dt1Resolution;
  lib: TileLibrary;
  palette: Palette;
}

/** Replaces the automatic DT1 resolution (e.g. when the user picks a level type). */
export type MapOverride = Pick<Dt1Resolution, 'source' | 'lvlType' | 'paths'>;

/** Loads a DS1 and its tile libraries. Pass `ds1` to re-resolve tiles for an already-open (possibly edited) map. */
export async function openMap(gd: GameData, path: string, override?: MapOverride, existing?: Ds1): Promise<OpenMap> {
  const ds1 = existing ?? parseDs1(await gd.fs.readOrThrow(path));
  const auto = gd.resolveDt1s(path, ds1);
  const resolution: Dt1Resolution = override ? { ...auto, ...override } : auto;
  const lib = new TileLibrary();
  const dt1s = await Promise.all(resolution.paths.map((p) => gd.dt1(p).catch(() => null)));
  resolution.paths.forEach((p, i) => lib.add(p, dt1s[i]));
  lib.addFallback(BUILTIN_SPECIALS_PATH, SPECIALS);
  const chosen = chosenPalette(path);
  const [homeAct, autoSource] = await choosePaletteAct(gd, ds1, resolution, lib);
  const [paletteAct, paletteSource] = chosen !== null ? [chosen, 'manual' as const] : viewPrefs.act0 ? [ACT0_PALETTE, autoSource] : [homeAct, autoSource];
  const palette = await mapPalette(gd, paletteAct, homeAct);
  return { path, ds1, resolution, lib, palette, paletteAct, paletteSource, homeAct };
}

/** How maps are shown (Preferences): in the Act 0 colours by default, and whether act-specific colours show magenta. */
const viewPrefs = { act0: true, magenta: false };
export function setViewPalette(p: { act0: boolean; magenta: boolean }): void {
  Object.assign(viewPrefs, p);
}
export const viewPalette = (): Readonly<typeof viewPrefs> => viewPrefs;

/**
 * A palette choice's colours: an act's, or Act 0 — the colours that look the same in every act, with the others in
 * `homeAct`'s colours (how those pixels look in the map's own act) or magenta when that preference is on.
 */
export async function mapPalette(gd: GameData, act: number, homeAct?: number): Promise<Palette> {
  if (act !== ACT0_PALETTE) return gd.palette(act);
  const a0 = await loadAct0Palette(gd.fs);
  return act0Display(a0, viewPrefs.magenta || homeAct === undefined ? null : await gd.palette(homeAct), viewPrefs.magenta);
}

/** The open map redrawn after the view preferences changed (a palette picked by hand is kept). */
export async function refreshPalette(gd: GameData, map: OpenMap): Promise<OpenMap> {
  const home = map.homeAct ?? (map.paletteAct === ACT0_PALETTE ? Math.min(4, map.ds1.act) : map.paletteAct);
  const act = map.paletteSource === 'manual' ? map.paletteAct : viewPrefs.act0 ? ACT0_PALETTE : home;
  return { ...map, paletteAct: act, homeAct: home, palette: await mapPalette(gd, act, home) };
}

/** Palettes picked by hand, per map, remembered on this computer so the map opens in them again. */
const PALETTE_KEY = 'ds1studio.mapPalettes';
function chosenPalettes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(PALETTE_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}
function chosenPalette(path: string): number | null {
  const v = chosenPalettes()[path.toLowerCase()];
  return typeof v === 'number' ? v : null;
}
export function rememberPalette(path: string, act: number): void {
  try {
    localStorage.setItem(PALETTE_KEY, JSON.stringify({ ...chosenPalettes(), [path.toLowerCase()]: act }));
  } catch {
    // per-computer convenience only
  }
}

/** Palette slots whose colour differs between the acts (the rest of the palette is shared). */
function actSpecificSlots(palettes: Palette[]): Uint8Array {
  const slots = new Uint8Array(256);
  for (let i = 1; i < 256; i++)
    for (const p of palettes)
      for (let c = 0; c < 3; c++) if (Math.abs(p[i * 4 + c] - palettes[0][i * 4 + c]) > 8) slots[i] = 1;
  return slots;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

/**
 * How much the act-specific pixels of some tiles stand out under each palette: their colour distance to the nearest
 * ordinary (shared-colour) pixels around them, looking up to 3 pixels out so clusters are measured too. Art drawn for
 * a palette blends in; shown with another act's palette, those pixels become off-colour specks and blotches.
 */
function speckScores(tiles: Dt1Tile[], palettes: Palette[]): { scores: number[]; samples: number } {
  const slots = actSpecificSlots(palettes);
  const scores = palettes.map(() => 0);
  let samples = 0;
  for (const tile of tiles) {
    const img = decodeTile(tile);
    if (!img) continue;
    const { width, height, pixels } = img;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = pixels[y * width + x];
        if (!i || !slots[i]) continue;
        const around: number[] = [];
        for (const [dx, dy] of DIRS) {
          for (let r = 1; r <= 3; r++) {
            const nx = x + dx * r;
            const ny = y + dy * r;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) break;
            const n = pixels[ny * width + nx];
            if (!n) break;
            if (!slots[n]) {
              around.push(n);
              break;
            }
          }
        }
        if (around.length < 3) continue;
        samples++;
        palettes.forEach((p, k) => {
          for (let c = 0; c < 3; c++) {
            const mean = around.reduce((sum, n) => sum + p[n * 4 + c], 0) / around.length;
            scores[k] += Math.abs(p[i * 4 + c] - mean);
          }
        });
      }
  }
  return { scores: scores.map((v) => (samples ? v / samples : 0)), samples };
}

/**
 * The game draws a level with the palette its Levels.txt Pal names (the DS1 header's act is not used for that).
 * For maps LvlPrest places in a level, use that (else the level type's act). Otherwise (custom maps) keep the header's act unless
 * the map's tiles look clearly cleaner under another act's palette, i.e. they were drawn for that palette.
 */
async function choosePaletteAct(gd: GameData, ds1: Ds1, r: Dt1Resolution, lib: TileLibrary): Promise<[number, PaletteSource]> {
  // Only trust the level type when LvlPrest names a level; presets shared by many levels (LevelId 0) get a guessed type.
  const levelId = r.preset?.levelId ?? 0;
  if (r.source === 'lvlprest' && levelId > 0) {
    const pal = gd.levelPal(levelId);
    if (pal !== null) return [pal, 'level'];
    if (r.lvlType?.act) return [r.lvlType.act - 1, 'level'];
  }
  // Sample the tiles this map actually uses.
  const used = new Set<Dt1Tile>();
  const sample = (orientation: number, main: number, sub: number) => {
    const t = lib.pick(orientation, main, sub, 0);
    if (t) used.add(t);
  };
  for (const layer of ds1.floors) for (const c of layer) if (c.prop1) sample(0, c.mainIndex, c.subIndex);
  for (const layer of ds1.walls) for (const c of layer) if (c.prop1 && c.orientation !== 10 && c.orientation !== 11) sample(c.orientation, c.mainIndex, c.subIndex);
  const tiles = [...used];
  const step = Math.max(1, Math.floor(tiles.length / 48));
  const picked = tiles.filter((_, i) => i % step === 0);
  if (!picked.length) return [ds1.act, 'ds1'];
  const palettes = await Promise.all([0, 1, 2, 3, 4, OLD_ACT5_PALETTE].map((a) => gd.palette(a)));
  const { scores, samples } = speckScores(picked, palettes);
  const best = scores.indexOf(Math.min(...scores));
  // Vanilla art mostly avoids the act-specific colours; switch only on clear evidence.
  const clear = samples >= 200 && scores[ds1.act] - scores[best] > 12 && scores[best] < scores[ds1.act] * 0.6;
  return clear ? [best, 'tiles'] : [ds1.act, 'ds1'];
}

/**
 * The act a tile library's art was drawn for, from the art itself (see speckScores): the act palette under which its
 * act-specific pixels blend in with their neighbours best. null when it has too few of them to tell. `palettes` are
 * the five act palettes, Act 1 first, optionally followed by the classic Act 5 one (drawnPalettes): then the answer
 * can be OLD_ACT5_PALETTE.
 */
export function guessDrawnAct(tiles: Dt1Tile[], palettes: Palette[]): number | null {
  const r = drawnActScores(tiles, palettes);
  return r && pickDrawnAct(r);
}

/**
 * The palettes art can have been drawn for, as guessDrawnAct takes them: the five acts', then d2data.mpq's classic
 * Act 5 palette (index OLD_ACT5_PALETTE), which Blizzard's unused guild tiles were drawn with.
 */
export function drawnPalettes(gd: GameData): Promise<Palette[]> {
  return Promise.all([0, 1, 2, 3, 4, OLD_ACT5_PALETTE].map((a) => gd.palette(a)));
}

/** How badly the tiles' act-specific pixels clash under each palette (lower = drawn for it); null: too few to tell. */
export function drawnActScores(tiles: Dt1Tile[], palettes: Palette[]): number[] | null {
  const step = Math.max(1, Math.floor(tiles.length / 48));
  const { scores, samples } = speckScores(tiles.filter((_, i) => i % step === 0), palettes);
  return samples < 100 ? null : scores;
}

/**
 * The act a set of scores (drawnActScores) points to. A sixth score, for d2data.mpq's classic Act 5 palette
 * (OLD_ACT5_PALETTE), wins only by a clear margin: that palette is close to Act 1's, so Act 1 art often scores a
 * little better under it, while art really drawn for it (Blizzard's unused guild tiles) clashes far less there than
 * under any palette the game uses.
 */
export function pickDrawnAct(scores: number[]): number {
  const real = scores.slice(0, 5);
  const best = real.indexOf(Math.min(...real));
  return scores.length > 5 && scores[5] < real[best] * CLASSIC_MARGIN ? OLD_ACT5_PALETTE : best;
}
/** Measured: the 241 vanilla DT1s score at least 0.80 of their best real palette under the classic one; the 12 guild DT1s 0.44-0.76. */
export const CLASSIC_MARGIN = 0.78;

/** Redraws an open map with another act's palette. */
export async function withPalette(gd: GameData, map: OpenMap, act: number): Promise<OpenMap> {
  rememberPalette(map.path, act);
  return { ...map, paletteAct: act, paletteSource: 'manual', palette: await mapPalette(gd, act, map.homeAct) };
}
