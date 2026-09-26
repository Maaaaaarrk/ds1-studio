import { COMPONENTS, drawOrder, parseCof, type Cof } from '../formats/cof';
import { parseDc6, type SpriteFrame } from '../formats/dc6';
import { decodeDccDirection, parseDcc } from '../formats/dcc';
import type { LayeredFs } from '../vfs/vfs';
import { cofPath, composite, layerPath, type SpriteSpec } from './sprites';

/**
 * Full animations of objects/monsters: every frame of one direction, composited with the
 * COF's per-frame draw order and placed on one shared canvas so playback doesn't jitter.
 */

/**
 * How a sprite layer is drawn, from the COF: -1 = solid, else the layer is translucent with D2's draw effect
 * (0-2 = 75% / 50% / 25% opaque, 3 = luminance (glow), 4 = additive, 5 = multiply, 6 = black is transparent).
 */
export type LayerBlend = number;

export interface SpritePart {
  image: SpriteFrame;
  blend: LayerBlend;
}

export interface SpriteAnimation {
  /** All frames, each `width` x `height`, sharing the same offsets (every layer flattened: for thumbnails). */
  frames: SpriteFrame[];
  /**
   * The same frames as the game draws them: solid layers merged, translucent/blended layers kept separate so the
   * renderer can blend them (fog, glows, magic). Offsets are the parts' own, relative to the feet.
   */
  parts: SpritePart[][];
  /** Playback rate in frames per second (1..25). */
  fps: number;
  /** Direction count of the COF (valid directions are 0..directions-1). */
  directions: number;
  width: number;
  height: number;
  /** Offset of the shared box's top-left corner from the feet (as in `sprites.ts`). */
  offsetX: number;
  offsetY: number;
}

/** D2 runs at 25 game frames per second; an animation rate of 256 advances one frame per tick. */
const GAME_FPS = 25;

/** Converts a COF/objects.txt animation rate (256 = one frame per game tick) to fps, clamped to 1..25. */
export function animationFps(rate: number): number {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 256;
  return Math.min(GAME_FPS, Math.max(1, (r / 256) * GAME_FPS));
}

const cache = new Map<string, Promise<SpriteAnimation | null>>();

function specKey(spec: SpriteSpec, dir: number): string {
  const parts = Object.keys(spec.parts)
    .sort()
    .map((k) => `${k}=${spec.parts[k] ?? ''}`)
    .join(',');
  return `${spec.base}|${spec.token}|${spec.mode}|${spec.cls}|${parts}|${dir}`.toLowerCase();
}

/** Clears the animation cache (e.g. after the file system changes). */
export function clearSpriteAnimationCache(): void {
  cache.clear();
}

/**
 * Loads all frames of one direction (default: the spec's, else 0). Results are cached per
 * spec + direction. Returns null when the COF or every layer is missing, or data is corrupt.
 */
export function loadSpriteAnimation(fs: LayeredFs, spec: SpriteSpec, direction?: number): Promise<SpriteAnimation | null> {
  const requested = Math.trunc(direction ?? spec.direction ?? 0) || 0;
  const key = specKey(spec, requested);
  let p = cache.get(key);
  if (!p) {
    p = build(fs, spec, requested).catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** One layer's frames for the chosen direction (decoded once). */
async function loadLayerFrames(fs: LayeredFs, stem: string, direction: number): Promise<SpriteFrame[] | null> {
  const dcc = await fs.read(`${stem}.dcc`);
  if (dcc) {
    const file = parseDcc(dcc);
    if (!file.directions) return null;
    return decodeDccDirection(file, direction % file.directions).frames.map((f) => f.image);
  }
  const dc6 = await fs.read(`${stem}.dc6`);
  if (dc6) {
    const file = parseDc6(dc6);
    if (!file.directions) return null;
    return (file.frames[direction % file.directions] ?? []).map((f) => f.image);
  }
  return null;
}

async function build(fs: LayeredFs, spec: SpriteSpec, direction: number): Promise<SpriteAnimation | null> {
  const cofBytes = await fs.read(cofPath(spec));
  if (!cofBytes) return null;
  const cof: Cof = parseCof(cofBytes);
  if (!cof.directions || !cof.framesPerDir) return null;
  const dir = ((direction % cof.directions) + cof.directions) % cof.directions;

  // Decode each layer's direction once.
  const layerFrames = new Map<number, SpriteFrame[]>();
  for (const layer of cof.layers) {
    const code = COMPONENTS[layer.component];
    const armor = code && spec.parts[code];
    if (!armor) continue;
    const frames = await loadLayerFrames(fs, layerPath(spec, code, armor, layer.weaponClass || spec.cls), dir);
    if (frames?.length) layerFrames.set(layer.component, frames);
  }
  if (!layerFrames.size) return null;

  // Per-frame layer stacks, back to front, with each layer's blend mode.
  const blendOf = new Map(cof.layers.map((l) => [l.component, l.transparent ? l.drawEffect : -1]));
  const stacks: SpriteFrame[][] = [];
  const blends: LayerBlend[][] = [];
  for (let f = 0; f < cof.framesPerDir; f++) {
    const stack: SpriteFrame[] = [];
    const b: LayerBlend[] = [];
    for (const comp of drawOrder(cof, dir, f)) {
      const frames = layerFrames.get(comp);
      const img = frames?.[Math.min(f, frames.length - 1)];
      if (img && img.width > 0 && img.height > 0) {
        stack.push(img);
        b.push(blendOf.get(comp) ?? -1);
      }
    }
    stacks.push(stack);
    blends.push(b);
  }

  // Shared box: the union of all frames' layers.
  const all = stacks.flat();
  if (!all.length) return null;
  const left = Math.min(...all.map((l) => l.offsetX));
  const top = Math.min(...all.map((l) => l.offsetY));
  const width = Math.max(...all.map((l) => l.offsetX + l.width)) - left;
  const height = Math.max(...all.map((l) => l.offsetY + l.height)) - top;
  if (width <= 0 || height <= 0 || width * height > 4096 * 4096) return null;

  const frames = stacks.map((stack) => {
    const pixels = new Uint8Array(width * height);
    for (const l of stack) {
      const dx = l.offsetX - left;
      const dy = l.offsetY - top;
      for (let y = 0; y < l.height; y++) {
        const row = (dy + y) * width + dx;
        const src = y * l.width;
        for (let x = 0; x < l.width; x++) {
          const v = l.pixels[src + x];
          if (v) pixels[row + x] = v;
        }
      }
    }
    return { width, height, offsetX: left, offsetY: top, pixels };
  });

  // Runs of solid layers merge into one image; each translucent layer stays its own part.
  const parts = stacks.map((stack, f) => {
    const out: SpritePart[] = [];
    let run: SpriteFrame[] = [];
    const flush = () => {
      const img = run.length === 1 ? run[0] : composite(run);
      if (img) out.push({ image: img, blend: -1 });
      run = [];
    };
    stack.forEach((img, i) => {
      if (blends[f][i] < 0) run.push(img);
      else {
        if (run.length) flush();
        out.push({ image: img, blend: blends[f][i] });
      }
    });
    if (run.length) flush();
    return out;
  });

  return { frames, parts, fps: animationFps(cof.animationRate), directions: cof.directions, width, height, offsetX: left, offsetY: top };
}
