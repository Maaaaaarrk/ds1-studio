import { COMPONENTS, drawOrder, parseCof, type Cof } from '../formats/cof';
import { parseDc6, type SpriteFrame } from '../formats/dc6';
import { decodeDccDirection, parseDcc } from '../formats/dcc';
import type { LayeredFs } from '../vfs/vfs';

/**
 * Composes still frames of objects and monsters from their COF + per-component DCC/DC6
 * files, driven by a sprite recipe (Base/Token/Mode/Class + armour type per component; see objectCatalog).
 */

/** What to draw for one object or NPC. */
export interface SpriteSpec {
  /** Folder holding the token, e.g. `Data\Global\Monsters`. */
  base: string;
  /** Two-or-more letter unit code, e.g. `WA`. */
  token: string;
  /** Animation mode, e.g. `NU` or `ON`. */
  mode: string;
  /** Weapon class, e.g. `HTH`. */
  cls: string;
  /** Armour type per component code (HD, TR, ... S8); missing/empty = no layer. */
  parts: Partial<Record<string, string>>;
  /** Default facing, if given. */
  direction?: number;
}

export type Sprite = SpriteFrame;

export interface SpriteLoad {
  sprite: Sprite | null;
  /** Files that were looked for but not found (COF or layer images). */
  missing: string[];
}

function joinPath(...parts: string[]): string {
  return parts.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')).join('/');
}

export function cofPath(spec: SpriteSpec): string {
  return joinPath(spec.base, spec.token, 'COF', `${spec.token}${spec.mode}${spec.cls}.cof`);
}

/** Layer image path without extension: `{Base}/{Token}/{Comp}/{Token}{Comp}{Armor}{Mode}{WeaponClass}`. */
export function layerPath(spec: SpriteSpec, comp: string, armor: string, weaponClass: string): string {
  return joinPath(spec.base, spec.token, comp, `${spec.token}${comp}${armor}${spec.mode}${weaponClass}`);
}

/** Loads one layer's frame: DCC first, then DC6. Direction indices wrap to the file's direction count. */
async function loadLayerFrame(fs: LayeredFs, stem: string, direction: number, frame: number, missing: string[]): Promise<SpriteFrame | null> {
  const dcc = await fs.read(`${stem}.dcc`);
  if (dcc) {
    const file = parseDcc(dcc);
    if (!file.directions) return null;
    const dir = decodeDccDirection(file, direction % file.directions);
    return dir.frames[Math.min(frame, dir.frames.length - 1)]?.image ?? null;
  }
  const dc6 = await fs.read(`${stem}.dc6`);
  if (dc6) {
    const file = parseDc6(dc6);
    if (!file.directions) return null;
    const frames = file.frames[direction % file.directions];
    return frames[Math.min(frame, frames.length - 1)]?.image ?? null;
  }
  missing.push(`${stem}.dcc`);
  return null;
}

/** Pastes layers back to front into one image sized to their union. */
export function composite(layers: SpriteFrame[]): SpriteFrame | null {
  const drawn = layers.filter((l) => l.width > 0 && l.height > 0);
  if (!drawn.length) return null;
  const left = Math.min(...drawn.map((l) => l.offsetX));
  const top = Math.min(...drawn.map((l) => l.offsetY));
  const width = Math.max(...drawn.map((l) => l.offsetX + l.width)) - left;
  const height = Math.max(...drawn.map((l) => l.offsetY + l.height)) - top;
  const pixels = new Uint8Array(width * height);
  for (const l of drawn) {
    const dx = l.offsetX - left;
    const dy = l.offsetY - top;
    for (let y = 0; y < l.height; y++) {
      const row = (dy + y) * width + dx;
      for (let x = 0; x < l.width; x++) {
        const v = l.pixels[y * l.width + x];
        if (v) pixels[row + x] = v;
      }
    }
  }
  return { width, height, offsetX: left, offsetY: top, pixels };
}

/**
 * Loads frame 0 of a unit for a direction (default: the spec's, else 0) and reports missing files.
 * Throws on corrupt data; see `loadObjectSprite` for the non-throwing variant.
 */
export async function loadSpriteDetailed(fs: LayeredFs, spec: SpriteSpec, direction = spec.direction ?? 0, frame = 0): Promise<SpriteLoad> {
  const missing: string[] = [];
  const cofBytes = await fs.read(cofPath(spec));
  if (!cofBytes) return { sprite: null, missing: [cofPath(spec)] };
  const cof: Cof = parseCof(cofBytes);
  if (!cof.directions || !cof.framesPerDir) return { sprite: null, missing };
  const dir = ((direction % cof.directions) + cof.directions) % cof.directions;
  const f = Math.min(frame, cof.framesPerDir - 1);

  const byComponent = new Map(cof.layers.map((l) => [l.component, l]));
  const images: SpriteFrame[] = [];
  for (const comp of drawOrder(cof, dir, f)) {
    const layer = byComponent.get(comp);
    const code = COMPONENTS[comp];
    const armor = code && spec.parts[code];
    if (!layer || !armor) continue;
    const image = await loadLayerFrame(fs, layerPath(spec, code, armor, layer.weaponClass || spec.cls), dir, f, missing);
    if (image) images.push(image);
  }
  return { sprite: composite(images), missing };
}

/** Composes a still frame of a placed object/monster, or null if anything is missing or unreadable. */
export async function loadObjectSprite(fs: LayeredFs, spec: SpriteSpec, direction?: number): Promise<Sprite | null> {
  try {
    return (await loadSpriteDetailed(fs, spec, direction)).sprite;
  } catch {
    return null;
  }
}
