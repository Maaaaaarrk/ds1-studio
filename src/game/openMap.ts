import { parseDs1, type Ds1 } from '../formats/ds1';
import type { Palette } from '../formats/palette';
import { TileLibrary, type Dt1Resolution, type GameData } from './GameData';

export interface OpenMap {
  path: string;
  ds1: Ds1;
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
  if (gd.specialTiles) lib.addFallback('winds1/ds1edit.dt1 (special tiles)', gd.specialTiles);
  const palette = await gd.palette(ds1.act);
  return { path, ds1, resolution, lib, palette };
}
