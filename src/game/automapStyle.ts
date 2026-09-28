import type { SpriteFrame } from '../formats/dc6';
import type { Palette } from '../formats/palette';
import { AUTOMAP_CODES, automapCellOrigin } from './automap';

/**
 * How DS1 Studio draws the automap over a map and in the automap editor. The game draws its thin pieces in the act's
 * palette, which is hard to see over a map; here they can be coloured by kind (walls, floors, objects, other), made
 * thicker and more or less opaque, each kind shown or not, over a map dimmed as much as wanted.
 */

export type AutomapKind = 'walls' | 'floors' | 'objects' | 'other';

export const AUTOMAP_KIND_LIST: { id: AutomapKind; label: string; hint: string }[] = [
  { id: 'walls', label: 'Walls', hint: 'walls, corners, doors, wall ends and lower walls' },
  { id: 'floors', label: 'Floors', hint: 'floor tiles (the game leaves most of them off the automap)' },
  { id: 'objects', label: 'Objects & trees', hint: 'columns, props, trees and other objects built from tiles' },
  { id: 'other', label: 'Roofs & shadows', hint: 'roofs and shadow tiles' },
];

/** The kind of an AutoMap.txt tile code (TileName). */
export function kindOfCode(code: string): AutomapKind {
  if (code === 'fl') return 'floors';
  if (code === 'co' || code === 'tr') return 'objects';
  if (code === 'rf' || code === 'sh') return 'other';
  return 'walls';
}
export const kindOfOrientation = (orientation: number): AutomapKind => kindOfCode(AUTOMAP_CODES[orientation] ?? '');

export interface AutomapStyle {
  /** Pieces in the game's own colours, or in each kind's colour. */
  colours: 'kind' | 'game';
  kinds: Record<AutomapKind, { show: boolean; colour: string }>;
  /** Of the pieces, 0.1-1. */
  opacity: number;
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
    walls: { show: true, colour: '#ffd24a' },
    floors: { show: true, colour: '#4fc3f7' },
    objects: { show: true, colour: '#7ee081' },
    other: { show: true, colour: '#c792ea' },
  },
  opacity: 1,
  thickness: 1,
  dim: 0.72,
  missing: true,
  missingColour: '#ff5ac8',
};

/** A stored style made whole (missing or bad fields take the defaults). */
export function normalizeAutomapStyle(s: unknown): AutomapStyle {
  const d = DEFAULT_AUTOMAP_STYLE;
  const o = (s && typeof s === 'object' ? s : {}) as Partial<AutomapStyle>;
  const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const colour = (v: unknown, dflt: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : dflt);
  const kinds = {} as AutomapStyle['kinds'];
  for (const k of AUTOMAP_KIND_LIST) {
    const v = (o.kinds as Partial<AutomapStyle['kinds']> | undefined)?.[k.id];
    kinds[k.id] = { show: typeof v?.show === 'boolean' ? v.show : d.kinds[k.id].show, colour: colour(v?.colour, d.kinds[k.id].colour) };
  }
  return {
    colours: o.colours === 'game' ? 'game' : 'kind',
    kinds,
    opacity: num(o.opacity, 0.1, 1, d.opacity),
    thickness: Math.round(num(o.thickness, 0, 3, d.thickness)),
    dim: num(o.dim, 0, 0.95, d.dim),
    missing: typeof o.missing === 'boolean' ? o.missing : d.missing,
    missingColour: colour(o.missingColour, d.missingColour),
  };
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** A piece to draw: the cell it stands on, its tile orientation (for its kind) and its MaxiMap cel. */
export interface DrawPiece {
  cellX: number;
  cellY: number;
  orientation: number;
  cel: number;
}

/** The size of a map's automap image and where cell (0, 0)'s north corner sits in it. */
export function automapFrame(width: number, height: number) {
  return { ox: height * 8 + 16, oy: 40, W: (width + height) * 8 + 32, H: (width + height) * 4 + 56 };
}

/**
 * The automap of a map as RGBA pixels (automap resolution: one pixel per automap pixel), in `style`: kinds hidden
 * left out, pieces coloured by kind or in the game's palette, thickened, at the style's opacity.
 */
export function paintAutomap(width: number, height: number, pieces: DrawPiece[], cels: SpriteFrame[], palette: Palette, style: AutomapStyle): { data: Uint8ClampedArray; W: number; H: number; ox: number; oy: number } {
  const { ox, oy, W, H } = automapFrame(width, height);
  // Per pixel: 0 = empty, else 1 + the colour's index in `colours`.
  const mark = new Uint16Array(W * H);
  const colours: [number, number, number][] = [];
  const kindColour = new Map<AutomapKind, number>();
  for (const k of AUTOMAP_KIND_LIST) {
    colours.push(rgb(style.kinds[k.id].colour));
    kindColour.set(k.id, colours.length);
  }
  const paletteBase = colours.length;
  for (const p of pieces) {
    const kind = kindOfOrientation(p.orientation);
    if (!style.kinds[kind].show) continue;
    const f = cels[p.cel];
    if (!f) continue;
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
        mark[Y * W + X] = style.colours === 'kind' ? kindColour.get(kind)! : paletteBase + 1 + c;
      }
  }
  // Thicker: every piece pixel spreads to its neighbours within `thickness` (the original pixels keep their colour).
  let grown = mark;
  for (let pass = 0; pass < style.thickness; pass++) {
    const next = grown.slice();
    for (let Y = 0; Y < H; Y++)
      for (let X = 0; X < W; X++) {
        const v = grown[Y * W + X];
        if (!v) continue;
        if (X > 0 && !next[Y * W + X - 1]) next[Y * W + X - 1] = v;
        if (X < W - 1 && !next[Y * W + X + 1]) next[Y * W + X + 1] = v;
        if (Y > 0 && !next[(Y - 1) * W + X]) next[(Y - 1) * W + X] = v;
        if (Y < H - 1 && !next[(Y + 1) * W + X]) next[(Y + 1) * W + X] = v;
      }
    grown = next;
  }
  const data = new Uint8ClampedArray(W * H * 4);
  const alpha = Math.round(style.opacity * 255);
  for (let i = 0; i < grown.length; i++) {
    const v = grown[i];
    if (!v) continue;
    if (v > paletteBase) {
      const c = v - paletteBase - 1;
      data[i * 4] = palette[c * 4];
      data[i * 4 + 1] = palette[c * 4 + 1];
      data[i * 4 + 2] = palette[c * 4 + 2];
    } else {
      const [r, g, b] = colours[v - 1];
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
    }
    data[i * 4 + 3] = alpha;
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
