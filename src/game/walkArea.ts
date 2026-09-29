import type { Ds1 } from '../formats/ds1';
import { SubTileFlag, walkability, type Scene } from '../render/scene';
import type { TileLibrary } from './GameData';

/**
 * The map's walkable area in tiles²: sub-tiles a player can stand on (as the Walkability view shows them: floor, no
 * blocking flag from any tile there, no "unwalkable" cell mark), 25 to a tile.
 */
export function walkableArea(ds1: Ds1, scene: Scene, lib?: TileLibrary): number {
  const w = walkability(ds1, scene, lib);
  let n = 0;
  for (let i = 0; i < w.length; i++) if (!(w[i] & SubTileFlag.BlockWalk)) n++;
  return n / 25;
}

type Rgb = [number, number, number];
const GREY: Rgb = [128, 132, 140];
const GREEN: Rgb = [60, 200, 90];
const ORANGE: Rgb = [255, 150, 40];
const RED_ORANGE: Rgb = [255, 80, 40];
const DEEP_RED: Rgb = [200, 20, 20];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t)))) as Rgb;

/** The size bands, for the tooltip and legend. */
export const AREA_BANDS = { min: 3300, green: 3800, orange: 4300, deep: 5300 };

/**
 * The colour for a walkable area: grey below 3,300 tiles²; green from 3,300 blending to orange at 3,800; orange
 * blending to red by 4,300; then redder and redder (deep red by 5,300).
 */
export function areaColour(area: number): { rgb: Rgb; band: 'small' | 'green' | 'orange' | 'red' } {
  const { min, green, orange, deep } = AREA_BANDS;
  if (area < min) return { rgb: GREY, band: 'small' };
  if (area < green) return { rgb: mix(GREEN, ORANGE, (area - min) / (green - min)), band: 'green' };
  if (area < orange) return { rgb: mix(ORANGE, RED_ORANGE, (area - green) / (orange - green)), band: 'orange' };
  return { rgb: mix(RED_ORANGE, DEEP_RED, (area - orange) / (deep - orange)), band: 'red' };
}
