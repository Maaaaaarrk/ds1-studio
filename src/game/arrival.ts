import type { Ds1 } from '../formats/ds1';
import { Orientation } from '../formats/dt1';

/**
 * Where the game puts a player who arrives in a level without a warp (a map item's portal). D2Common's spawn search
 * (ordinal 10816) takes, in order: a waypoint object, a room with a warp tile, the room at the level's centre, any
 * room; then the nearest free ground around that room's middle, and stops the game (line 568) when there is none. The
 * Map entry tile isn't part of it. A big map with its tiles off to one side has nothing at its centre.
 */
export interface ArrivalProblem {
  /** The centre room's cells (the game's rooms are 8×8). */
  room: { x: number; y: number };
  /** Cropping to the painted cells (2 around): negative deltas remove cells from each edge; null when nothing is painted. */
  crop: { left: number; top: number; right: number; bottom: number } | null;
  /** The map's size after cropping. */
  cropped: { w: number; h: number } | null;
}

/** null when portal arrivals are fine (a waypoint, a warp tile, or floor in the centre room). */
export function arrivalProblem(ds1: Ds1, isWaypoint: (type: number, id: number) => boolean): ArrivalProblem | null {
  if (ds1.objects.some((o) => o.type === 2 && isWaypoint(o.type, o.id))) return null;
  if (ds1.walls.some((l) => l.some((c) => (c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) && c.mainIndex <= 7))) return null;
  const rx = Math.floor((Math.floor((ds1.width - 1) / 2) - 2) / 8) * 8;
  const ry = Math.floor((Math.floor((ds1.height - 1) / 2) - 2) / 8) * 8;
  const floorAt = (x: number, y: number) => ds1.floors.some((l) => !!l[y * ds1.width + x]?.prop1);
  for (let y = ry; y < Math.min(ry + 8, ds1.height); y++) for (let x = rx; x < Math.min(rx + 8, ds1.width); x++) if (floorAt(x, y)) return null;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < ds1.height; y++)
    for (let x = 0; x < ds1.width; x++)
      if (floorAt(x, y) || ds1.walls.some((l) => !!l[y * ds1.width + x]?.prop1)) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  const m = 2;
  const crop = maxX < 0 ? null : { left: -Math.max(0, minX - m), top: -Math.max(0, minY - m), right: -Math.max(0, ds1.width - 1 - maxX - m), bottom: -Math.max(0, ds1.height - 1 - maxY - m) };
  const useful = crop && (crop.left || crop.top || crop.right || crop.bottom) ? crop : null;
  return { room: { x: rx, y: ry }, crop: useful, cropped: useful ? { w: ds1.width + useful.left + useful.right, h: ds1.height + useful.top + useful.bottom } : null };
}

export const arrivalText = (p: ArrivalProblem) =>
  `Players arriving by portal (a map item) are put in the room at the level's centre (cells ${p.room.x}-${p.room.x + 7} × ${p.room.y}-${p.room.y + 7}) when there is no waypoint or warp tile, and there is no floor there: using the map item would stop the game. The Map entry tile doesn't change this. Crop the map to what's painted${p.cropped ? ` (${p.cropped.w}×${p.cropped.h})` : ''}, or put floor at its centre.`;
