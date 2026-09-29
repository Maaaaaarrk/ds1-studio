import { parseDt1 } from '../formats/dt1';
import { buildDt1, changedRecord, dt1Records } from '../formats/dt1Write';
import { planCustomDt1 } from './customDt1';
import { TileLibrary } from './GameData';
import type { FloorChoice } from './floorReroll';

/** Give chosen static variants distinct IDs; retain all frames when any frame of an animation is chosen. */
export function prepareFloorLibrary(choices: FloorChoice[], sources: Map<string, Uint8Array>, taken: Set<string>) {
  const unique = new Map<string, Uint8Array>();
  const picks: { dt1: string; index: number }[] = [];
  for (const choice of choices) {
    const bytes = sources.get(choice.path);
    if (!bytes) throw new Error('The floor source was not found.');
    const records = dt1Records(bytes), tiles = parseDt1(bytes).tiles, tile = tiles[choice.index];
    if (!tile || tile.orientation !== 0 || tile.mainIndex !== choice.tile.mainIndex || tile.subIndex !== choice.tile.subIndex || tile.rarity !== choice.tile.rarity || tile.animated !== choice.tile.animated)
      throw new Error('A selected floor changed. Reopen the floor picker.');
    const group = tiles.flatMap((t, i) => t.orientation === 0 && t.mainIndex === tile.mainIndex && t.subIndex === tile.subIndex ? [i] : []);
    const animated = TileLibrary.isAnimation(group.map(i => tiles[i]));
    const key = choice.path + '#' + (animated ? 'animation-' + tile.mainIndex + '-' + tile.subIndex : choice.index);
    if (unique.has(key)) continue;
    const selected = animated ? group.map(i => records[i]) : [records[choice.index]];
    // Static rarity 0 means "never choose" alongside weighted records: independent IDs each need a usable weight.
    const copies = selected.map(r => {
      const copy = changedRecord(r, {});
      if (!animated) { copy.header[7] = 0; new DataView(copy.header.buffer).setInt32(32, 1, true); }
      return copy;
    });
    unique.set(key, buildDt1(copies));
    picks.push({ dt1: key, index: 0 });
  }
  return planCustomDt1(picks, unique, taken);
}
