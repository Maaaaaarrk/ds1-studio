import { BinaryReader } from '../util/BinaryReader';

/**
 * COF = animation composition: which components (layers) a unit mode is built from,
 * how many frames/directions it has, and per-frame layer draw order.
 */

/** Component codes by COF component index. */
export const COMPONENTS = ['HD', 'TR', 'LG', 'RA', 'LA', 'RH', 'LH', 'SH', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'] as const;
export type ComponentCode = (typeof COMPONENTS)[number];

export interface CofLayer {
  /** Component index into COMPONENTS. */
  component: number;
  /** The layer also casts a shadow. */
  shadow: boolean;
  selectable: boolean;
  /** The layer is drawn translucent (per `drawEffect`). */
  transparent: boolean;
  /** Blend mode: 0-2 = transparency levels, 3 = luminance, 4 = additive, 5 = multiply, 6 = alpha-black. */
  drawEffect: number;
  /** Weapon class of this layer's DCC (e.g. "HTH", "1HS"). */
  weaponClass: string;
}

export interface Cof {
  directions: number;
  framesPerDir: number;
  animationRate: number;
  box: { xMin: number; xMax: number; yMin: number; yMax: number };
  layers: CofLayer[];
  /** Per-frame event keys (attack, sound, ...), `framesPerDir` long. */
  frameKeys: Uint8Array;
  /** Draw order: component indices, `layers.length` per (direction, frame). */
  priority: Uint8Array;
}

export function parseCof(bytes: Uint8Array): Cof {
  const r = new BinaryReader(bytes);
  const numLayers = r.u8();
  const framesPerDir = r.u8();
  const directions = r.u8();
  r.skip(5); // version (20) + unknown
  const box = { xMin: r.i32(), xMax: r.i32(), yMin: r.i32(), yMax: r.i32() };
  const animationRate = r.i16();
  r.skip(2);
  const layers: CofLayer[] = [];
  for (let i = 0; i < numLayers; i++) {
    const component = r.u8();
    const shadow = r.u8() !== 0;
    const selectable = r.u8() !== 0;
    const transparent = r.u8() !== 0;
    const drawEffect = r.u8();
    const wc = r.bytesView(4);
    let weaponClass = '';
    for (let j = 0; j < 4 && wc[j]; j++) weaponClass += String.fromCharCode(wc[j]);
    layers.push({ component, shadow, selectable, transparent, drawEffect, weaponClass: weaponClass.trim() });
  }
  const frameKeys = r.bytesView(framesPerDir);
  const priority = r.bytesView(directions * framesPerDir * numLayers);
  return { directions, framesPerDir, animationRate, box, layers, frameKeys, priority };
}

/** Component indices in draw order (back to front) for a direction and frame. */
export function drawOrder(cof: Cof, direction: number, frame: number): number[] {
  const n = cof.layers.length;
  const base = (direction * cof.framesPerDir + frame) * n;
  return [...cof.priority.subarray(base, base + n)];
}
