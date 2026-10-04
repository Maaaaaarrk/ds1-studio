import { isEmptyCell, type Ds1 } from '../formats/ds1';
import { SubTileFlag } from '../render/scene';
import type { GameData } from './GameData';
import type { OpenMap } from './openMap';
import { presetRooms, roomRegions } from './spawnRegions';

/**
 * Colour-coded overviews of a map, sub-tile by sub-tile (5×5 per cell, indexed like `walkability`):
 *
 * - walkable: where players can walk, from the sub-tile flags of every floor and wall tile in a cell OR'd together
 *   (hidden tiles included, shadows not), the DS1's whole-cell "unwalkable" bit and cells without a floor
 *   (see `walkability`). 0x01 blocks everyone; 0x08 blocks players only.
 * - spawn: where the game can place random monsters. D2Game's PopulateRoom places them on sub-tiles free of collision
 *   mask 0x3C01 (D2MOO MonsterRegion.cpp / MonsterSpawn.cpp): of those, only 0x01 comes from the map's tiles (the rest
 *   are units and objects). It skips rooms with a level warp, and regions that are nodes (LvlPrest Logicals=1; see
 *   spawnRegions); LvlPrest Populate=0, or Levels.txt MonDen 0 / no monsters listed, means none in the whole level.
 */

export type OverlayKind = 'walkable' | 'spawn';

export const OVERLAY_NAMES: Record<OverlayKind, string> = { walkable: 'Walkable', spawn: 'Monster spawns' };

export interface OverlayClass {
  key: string;
  label: string;
  /** Fill colour (red, green, blue, alpha 0-1). */
  rgba: [number, number, number, number];
}

export interface MapOverlay {
  kind: OverlayKind;
  title: string;
  classes: OverlayClass[];
  /** Per sub-tile: 0 = not coloured, else 1 + an index into `classes`. Index (cy * width + cx) * 25 + sy * 5 + sx. */
  sub: Uint8Array;
  /** Sub-tiles of each class. */
  counts: number[];
  /** What the overlay assumed or found about the level, for the legend. */
  notes: string[];
}

const noFloor = (ds1: Ds1, i: number) => ds1.floors.every((l) => isEmptyCell(l[i]));

function finish(kind: OverlayKind, title: string, classes: OverlayClass[], sub: Uint8Array, notes: string[]): MapOverlay {
  const counts = classes.map(() => 0);
  for (let i = 0; i < sub.length; i++) if (sub[i]) counts[sub[i] - 1]++;
  return { kind, title, classes, sub, counts, notes };
}

export const WALK_CLASSES: OverlayClass[] = [
  { key: 'walk', label: 'Walkable', rgba: [60, 210, 90, 0.4] },
  { key: 'players', label: 'Monsters only (blocks players)', rgba: [255, 200, 40, 0.5] },
  { key: 'blocked', label: 'Blocked', rgba: [235, 50, 50, 0.45] },
];

/** Where players can walk. `flags` = walkability(ds1, scene, lib). Cells with no floor are left uncoloured. */
export function walkableOverlay(ds1: Ds1, flags: Uint8Array): MapOverlay {
  const sub = new Uint8Array(flags.length);
  for (let i = 0; i < ds1.width * ds1.height; i++) {
    if (noFloor(ds1, i)) continue;
    for (let k = 0; k < 25; k++) {
      const f = flags[i * 25 + k];
      sub[i * 25 + k] = f & SubTileFlag.BlockWalk ? 3 : f & SubTileFlag.BlockPlayerWalk ? 2 : 1;
    }
  }
  return finish('walkable', OVERLAY_NAMES.walkable, WALK_CLASSES, sub, ['Cells without a floor are not coloured.']);
}

/** The level's settings that decide random monsters. Unknown (undefined) ones are taken to allow them. */
export interface SpawnLevel {
  /** LvlPrest Populate. */
  populate?: boolean;
  /** LvlPrest Logicals: rooms split into regions, where nodes spawn nothing. */
  logicals?: boolean;
  /** Levels.txt row, when the preset belongs to one level. */
  level?: { name: string; monDen: [number, number, number]; monsters: [number, number] };
  /** No LvlPrest row was found for the map. */
  noPreset?: boolean;
}

/** The spawn settings of an open map: its LvlPrest row and that row's level. */
export function spawnLevelOf(gd: GameData, map: Pick<OpenMap, 'resolution'>): SpawnLevel {
  const p = map.resolution.preset;
  if (!p) return { noPreset: true };
  const l = p.levelId > 0 ? gd.levelSpawn(p.levelId) : null;
  return { populate: p.populate, logicals: p.logicals, level: l ? { name: l.name, monDen: l.monDen, monsters: l.monsters } : undefined };
}

/** Why the level gets no random monsters at all, or null when it can. */
export function levelNoSpawn(level: SpawnLevel): string | null {
  if (level.populate === false) return 'LvlPrest Populate is 0: no random monsters in this preset';
  const l = level.level;
  if (l && l.monDen.every((d) => d <= 0)) return `${l.name} has MonDen 0 (Levels.txt): no random monsters`;
  if (l && l.monsters[0] + l.monsters[1] === 0) return `${l.name} lists no monsters (Levels.txt mon/nmon): no random monsters`;
  return null;
}

export const SPAWN_CLASSES: OverlayClass[] = [
  { key: 'spawn', label: 'Monsters can spawn', rgba: [60, 210, 90, 0.42] },
  { key: 'blocked', label: 'Blocked (collision 0x01)', rgba: [235, 50, 50, 0.4] },
  { key: 'node', label: 'Node region (seed floor hidden or main 30)', rgba: [70, 150, 255, 0.45] },
  { key: 'warp', label: 'Room with a level warp', rgba: [190, 90, 255, 0.45] },
  { key: 'off', label: 'Open, but the level spawns none', rgba: [150, 150, 160, 0.45] },
  { key: 'edge', label: 'Last row/column (in no game room)', rgba: [255, 150, 40, 0.35] },
];
const [SPAWN, BLOCKED, NODE, WARP, OFF, EDGE] = [1, 2, 3, 4, 5, 6];

/**
 * Where random monsters can be placed, as PopulateRoom picks spots: on floored sub-tiles without the walk-blocking
 * flag, in a region of an 8×8 room that isn't a node, in a room without a level warp, in a level that populates.
 * Blocked sub-tiles show as blocked everywhere; the other reasons colour the free ones (warp rooms and nodes first, so
 * they show in a level that spawns nothing too).
 */
export function spawnOverlay(ds1: Ds1, flags: Uint8Array, level: SpawnLevel): MapOverlay {
  const { width, height } = ds1;
  const sub = new Uint8Array(flags.length);
  // Per cell: what its region or room says (0 = spawns).
  const why = new Uint8Array(width * height).fill(EDGE);
  const off = levelNoSpawn(level);
  for (const room of presetRooms(width, height)) {
    const rr = roomRegions(ds1, room);
    for (const r of rr.regions) {
      // Warp rooms and nodes are shown even in a level that spawns nothing, so the map's own rules stay visible.
      const reason = rr.warp ? WARP : r.node && level.logicals !== false ? NODE : off ? OFF : SPAWN;
      for (const c of r.cells) why[c.y * width + c.x] = reason;
    }
  }
  for (let i = 0; i < width * height; i++) {
    if (noFloor(ds1, i)) continue;
    for (let k = 0; k < 25; k++) sub[i * 25 + k] = flags[i * 25 + k] & SubTileFlag.BlockWalk ? BLOCKED : why[i];
  }
  const notes: string[] = [];
  if (off) notes.push(off + '.');
  if (level.noPreset) notes.push('No LvlPrest row found for this map: Populate and Logicals taken as 1.');
  if (level.logicals === false) notes.push('LvlPrest Logicals is 0: rooms are not split into regions, so nodes do nothing.');
  if (level.level && !off) {
    const zero = (['Normal', 'Nightmare', 'Hell'] as const).filter((_, d) => level.level!.monDen[d] <= 0);
    if (zero.length) notes.push(`${level.level.name}: MonDen 0 on ${zero.join(', ')}.`);
  }
  notes.push('Objects and units block spawns too (not shown); cells without a floor are not coloured.');
  return finish('spawn', OVERLAY_NAMES.spawn, SPAWN_CLASSES, sub, notes);
}
