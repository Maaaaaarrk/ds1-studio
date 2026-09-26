import { Orientation, type Dt1, type Dt1Tile } from '../formats/dt1';

/**
 * Special tiles (orientations 10 and 11) are invisible in the game: they mark warps, entry points and the like. DS1
 * Studio draws its own labelled markers for them (see MapView), so no editor graphics file is needed.
 *
 * Main index 0-7 is a level link: the warp to the level named in this level's `Vis0`..`Vis7` column of Levels.txt.
 * A few fixed codes mark where players arrive.
 */
const NAMED: Record<string, { label: string; help: string }> = {
  '30/0': { label: 'Town entry 1', help: 'Where players appear when arriving in town (first spot).' },
  '31/0': { label: 'Town entry 2', help: 'Where players appear when arriving in town (second spot).' },
  '30/11': { label: 'Map entry', help: 'Where players appear when entering this map.' },
  '32/0': { label: 'Corpse location', help: 'Where a player’s corpse is placed in town.' },
  '33/0': { label: 'Town portal location', help: 'Where town portals open in town.' },
};

export function specialTileInfo(main: number, sub: number): { label: string; help: string } {
  const named = NAMED[`${main}/${sub}`];
  if (named) return named;
  if (main >= 0 && main <= 7) {
    return {
      label: `Warp · Vis ${main}`,
      help: `Level link: the warp to the level in this level's Vis${main} column (Levels.txt). Sub-index ${sub}.`,
    };
  }
  return { label: `Special ${main}/${sub}`, help: `Special tile ${main}/${sub}: a marker the game uses internally (not drawn in game).` };
}

/** Virtual path of the built-in special tiles (not a real DT1: nothing to load, save or add to a level). */
export const BUILTIN_SPECIALS_PATH = 'builtin/special tiles';

/** True for tile sources that aren't real DT1 files. */
export const isBuiltinPath = (path: string) => path.startsWith('builtin/');

const stub = (orientation: number, mainIndex: number, subIndex: number): Dt1Tile => ({
  direction: 0,
  roofHeight: 0,
  soundIndex: 0,
  animated: false,
  height: -80,
  width: 160,
  orientation,
  mainIndex,
  subIndex,
  rarity: 1,
  subTileFlags: new Uint8Array(25),
  blocks: [],
});

/**
 * Invisible stand-ins for the common special tiles, so they can be placed in maps whose DT1s don't include them (the
 * game doesn't need a graphic for them either). The map shows them with DS1 Studio's own markers.
 */
export function builtinSpecialTiles(): Dt1 {
  const tiles: Dt1Tile[] = [];
  for (const o of [Orientation.SpecialTile1, Orientation.SpecialTile2]) for (let main = 0; main <= 7; main++) tiles.push(stub(o, main, 0));
  for (const key of Object.keys(NAMED)) {
    const [main, sub] = key.split('/').map(Number);
    tiles.push(stub(Orientation.SpecialTile1, main, sub));
  }
  return { version: [7, 6], tiles };
}
