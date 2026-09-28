import type { SpriteFrame } from '../formats/dc6';
import { decodeTile, type Dt1Tile } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import { AUTOMAP_CODES, automapCellOrigin, averageColor } from './automap';

/**
 * How DS1 Studio draws the automap over a map and in the automap editor. The game draws its thin pieces in the act's
 * palette, which is hard to see over a map; here each category of tile — walls, walkable floors, water, roofs,
 * objects, shadows — has its own colour and opacity and can be shown or not, pieces can be thicker, over a map dimmed
 * as much as wanted.
 */

export type AutomapKind = 'walls' | 'floors' | 'water' | 'roofs' | 'objects' | 'shadows';

export const AUTOMAP_KIND_LIST: { id: AutomapKind; label: string; hint: string }[] = [
  { id: 'walls', label: 'Walls', hint: 'left and right walls, corners, doors, wall ends and lower walls' },
  { id: 'floors', label: 'Walkable floors', hint: 'floor tiles players walk on (the game leaves most of them off the automap)' },
  { id: 'water', label: 'Water', hint: 'floors nobody can walk on that are dark or bluish: rivers, lakes' },
  { id: 'roofs', label: 'Roofs', hint: 'roof tiles' },
  { id: 'objects', label: 'Objects & trees', hint: 'columns, props, trees and other objects built from tiles' },
  { id: 'shadows', label: 'Shadows', hint: 'shadow tiles' },
];

/** The category of an AutoMap.txt tile code (TileName); floors are water or walkable depending on the tile. */
export function kindOfCode(code: string, water = false): AutomapKind {
  if (code === 'fl') return water ? 'water' : 'floors';
  if (code === 'co' || code === 'tr') return 'objects';
  if (code === 'rf') return 'roofs';
  if (code === 'sh') return 'shadows';
  return 'walls';
}

export interface AutomapStyle {
  /** Pieces in the game's own colours, or in each category's colour. */
  colours: 'kind' | 'game';
  kinds: Record<AutomapKind, { show: boolean; colour: string; opacity: number }>;
  /** Extra automap pixels around each piece pixel: 0 = as in game. */
  thickness: number;
  /** How dark the map under the automap is, 0-0.95. */
  dim: number;
  /** Outline walls that have no AutoMap.txt entry. */
  missing: boolean;
  missingColour: string;
}

export const DEFAULT_AUTOMAP_STYLE: AutomapStyle = {
  colours: 'kind',
  kinds: {
    walls: { show: true, colour: '#ffd24a', opacity: 1 },
    floors: { show: true, colour: '#b8c4d0', opacity: 0.8 },
    water: { show: true, colour: '#3d8bff', opacity: 1 },
    roofs: { show: true, colour: '#e0664f', opacity: 1 },
    objects: { show: true, colour: '#7ee081', opacity: 1 },
    shadows: { show: true, colour: '#9a8fc0', opacity: 0.7 },
  },
  thickness: 1,
  dim: 0.72,
  missing: true,
  missingColour: '#ff5ac8',
};

/** A stored style made whole (missing or bad fields take the defaults; older styles carry over). */
export function normalizeAutomapStyle(s: unknown): AutomapStyle {
  const d = DEFAULT_AUTOMAP_STYLE;
  const o = (s && typeof s === 'object' ? s : {}) as { colours?: unknown; opacity?: unknown; thickness?: unknown; dim?: unknown; missing?: unknown; missingColour?: unknown; kinds?: Record<string, { show?: unknown; colour?: unknown; opacity?: unknown } | undefined> };
  const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const colour = (v: unknown, dflt: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : dflt);
  const kinds = {} as AutomapStyle['kinds'];
  for (const k of AUTOMAP_KIND_LIST) {
    // Earlier versions had one "other" kind for roofs and shadows, and one opacity for everything.
    const v = o.kinds?.[k.id] ?? (k.id === 'roofs' || k.id === 'shadows' ? o.kinds?.other : undefined);
    kinds[k.id] = {
      show: typeof v?.show === 'boolean' ? v.show : d.kinds[k.id].show,
      colour: colour(o.kinds?.[k.id]?.colour, d.kinds[k.id].colour),
      opacity: num(v?.opacity ?? o.opacity, 0.1, 1, d.kinds[k.id].opacity),
    };
  }
  return {
    colours: o.colours === 'game' ? 'game' : 'kind',
    kinds,
    thickness: Math.round(num(o.thickness, 0, 3, d.thickness)),
    dim: num(o.dim, 0, 0.95, d.dim),
    missing: typeof o.missing === 'boolean' ? o.missing : d.missing,
    missingColour: colour(o.missingColour, d.missingColour),
  };
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/**
 * Whether a floor tile looks like water, from its average colour: clearly bluer than it is red (rivers, lakes), or
 * blue-green (Act 3's swamps).
 */
export function looksLikeWater([r, g, b]: [number, number, number]): boolean {
  const blue = b >= r + 12 && b >= g - 6;
  const teal = g >= r + 12 && b >= r + 12 && Math.abs(g - b) <= 25;
  return blue || teal;
}

/**
 * Whether a floor tile is water: nobody can walk on any of it (every sub-tile blocks walking, as rivers and lakes do)
 * and its colour isn't that of ground or lava — the game's water is dark, grey or bluish (Act 1's river averages
 * almost black). Without colours, every unwalkable floor counts.
 */
export function isWaterTile(flags: ArrayLike<number>, rgb: [number, number, number] | null): boolean {
  if (flags.length !== 25 || !Array.from(flags).every((v) => v & 1)) return false;
  if (!rgb) return true;
  const [r, g, b] = rgb;
  return looksLikeWater(rgb) || Math.max(r, g, b) < 28 || b >= r - 2;
}

/**
 * The category of a map's tiles by orientation, main and sub index: floors are water or walkable by their own tile
 * (see isWaterTile), each looked up once.
 */
export function kindClassifier(lib: { pick(orientation: number, main: number, sub: number, seed: number): Dt1Tile | null }, palette: Palette): (orientation: number, main: number, sub: number) => AutomapKind {
  const water = new Map<string, boolean>();
  return (orientation, main, sub) => {
    const code = AUTOMAP_CODES[orientation] ?? '';
    if (code !== 'fl') return kindOfCode(code);
    const k = `${main}|${sub}`;
    let w = water.get(k);
    if (w === undefined) {
      const tile = lib.pick(orientation, main, sub, 0);
      const img = tile ? decodeTile(tile) : null;
      w = !!tile && isWaterTile(tile.subTileFlags, img ? averageColor(img.pixels, palette) : null);
      water.set(k, w);
    }
    return w ? 'water' : 'floors';
  };
}

/** A piece to draw: the cell it stands on, its category and its MaxiMap cel. */
export interface DrawPiece {
  cellX: number;
  cellY: number;
  kind: AutomapKind;
  cel: number;
}

/** The size of a map's automap image and where cell (0, 0)'s north corner sits in it. */
export function automapFrame(width: number, height: number) {
  return { ox: height * 8 + 16, oy: 40, W: (width + height) * 8 + 32, H: (width + height) * 4 + 56 };
}

/**
 * The automap of a map as RGBA pixels (automap resolution: one pixel per automap pixel), in `style`: hidden categories
 * left out, pieces coloured by category or in the game's palette, thickened, each category at its opacity.
 */
export function paintAutomap(width: number, height: number, pieces: DrawPiece[], cels: SpriteFrame[], palette: Palette, style: AutomapStyle): { data: Uint8ClampedArray; W: number; H: number; ox: number; oy: number } {
  const { ox, oy, W, H } = automapFrame(width, height);
  // Per pixel: the category (1 + its index; 0 = empty) and the piece's own palette colour.
  const kindAt = new Uint8Array(W * H);
  const palAt = new Uint8Array(W * H);
  const kinds = AUTOMAP_KIND_LIST.map((k) => k.id);
  for (const p of pieces) {
    if (!style.kinds[p.kind].show) continue;
    const f = cels[p.cel];
    if (!f) continue;
    const ki = kinds.indexOf(p.kind) + 1;
    const [ax, ay] = automapCellOrigin(p.cellX, p.cellY);
    // A cel's origin is the cell's west corner, 8 px below its north corner.
    const x0 = ox + ax - 8 + f.offsetX;
    const y0 = oy + ay + 8 + f.offsetY;
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        const c = f.pixels[y * f.width + x];
        if (!c) continue;
        const X = x0 + x;
        const Y = y0 + y;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        kindAt[Y * W + X] = ki;
        palAt[Y * W + X] = c;
      }
  }
  // Thicker: every piece pixel spreads to its neighbours within `thickness` (the original pixels keep their colour).
  let k = kindAt;
  let pl = palAt;
  for (let pass = 0; pass < style.thickness; pass++) {
    const nk = k.slice();
    const np = pl.slice();
    const spread = (from: number, to: number) => {
      if (!nk[to]) {
        nk[to] = k[from];
        np[to] = pl[from];
      }
    };
    for (let Y = 0; Y < H; Y++)
      for (let X = 0; X < W; X++) {
        const i = Y * W + X;
        if (!k[i]) continue;
        if (X > 0) spread(i, i - 1);
        if (X < W - 1) spread(i, i + 1);
        if (Y > 0) spread(i, i - W);
        if (Y < H - 1) spread(i, i + W);
      }
    k = nk;
    pl = np;
  }
  const colours = kinds.map((id) => rgb(style.kinds[id].colour));
  const alphas = kinds.map((id) => Math.round(style.kinds[id].opacity * 255));
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < k.length; i++) {
    if (!k[i]) continue;
    const ki = k[i] - 1;
    if (style.colours === 'game') {
      const c = pl[i];
      data[i * 4] = palette[c * 4];
      data[i * 4 + 1] = palette[c * 4 + 1];
      data[i * 4 + 2] = palette[c * 4 + 2];
    } else {
      [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]] = colours[ki];
    }
    data[i * 4 + 3] = alphas[ki];
  }
  return { data, W, H, ox, oy };
}

/** The same as a canvas (for drawing scaled up). */
export function automapCanvas(width: number, height: number, pieces: DrawPiece[], cels: SpriteFrame[], palette: Palette, style: AutomapStyle) {
  const p = paintAutomap(width, height, pieces, cels, palette, style);
  const canvas = document.createElement('canvas');
  canvas.width = p.W;
  canvas.height = p.H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(p.W, p.H);
  img.data.set(p.data);
  ctx.putImageData(img, 0, 0);
  return { canvas, ox: p.ox, oy: p.oy, W: p.W, H: p.H };
}
