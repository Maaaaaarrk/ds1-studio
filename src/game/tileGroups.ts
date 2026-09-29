import type { Dt1Tile } from '../formats/dt1';

/** DS1 cells identify a group, so frames and random variants share one paint choice. */
export function groupPaintTiles(tiles: Dt1Tile[]) {
  const groups = new Map<string, { orientation: number; main: number; sub: number; tiles: Dt1Tile[] }>();
  for (const tile of tiles) {
    const key = tile.orientation + '|' + tile.mainIndex + '|' + tile.subIndex;
    let group = groups.get(key);
    if (!group) {
      group = { orientation: tile.orientation, main: tile.mainIndex, sub: tile.subIndex, tiles: [] };
      groups.set(key, group);
    }
    group.tiles.push(tile);
  }
  return [...groups.values()];
}
