import { parseDs1, type Ds1 } from '../formats/ds1';
import type { Palette } from '../formats/palette';
import { buildScene, type Scene } from '../render/scene';
import { TileLibrary, type Dt1Resolution, type GameData } from './GameData';

export interface OpenMap {
  path: string;
  /** Which file source provided the DS1 (mod folder, patch_d2.mpq, ...). */
  origin: string | null;
  ds1: Ds1;
  resolution: Dt1Resolution;
  lib: TileLibrary;
  palette: Palette;
  scene: Scene;
}

/** Replaces the automatic DT1 resolution (e.g. when the user picks a level type). */
export type MapOverride = Pick<Dt1Resolution, 'source' | 'lvlType' | 'paths'>;

export async function openMap(gd: GameData, path: string, override?: MapOverride): Promise<OpenMap> {
  const ds1 = parseDs1(await gd.fs.readOrThrow(path));
  const auto = gd.resolveDt1s(path, ds1);
  const resolution: Dt1Resolution = override ? { ...auto, ...override } : auto;
  const lib = new TileLibrary();
  const dt1s = await Promise.all(resolution.paths.map((p) => gd.dt1(p).catch(() => null)));
  resolution.paths.forEach((p, i) => lib.add(p, dt1s[i]));
  const palette = await gd.palette(ds1.act);
  return { path, origin: gd.fs.locate(path), ds1, resolution, lib, palette, scene: buildScene(ds1, lib) };
}
