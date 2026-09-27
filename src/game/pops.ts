import { DEFAULT_PROP1, EMPTY_CELL, withTile, type Ds1, type WallCell } from '../formats/ds1';
import { Orientation } from '../formats/dt1';

/**
 * "Pops": how the game hides roofs (or any wall-layer tiles) while a player is inside a building. Worked out from the
 * game's code (D2Common DRLGPRESET, as reimplemented by D2MOO) and checked against the vanilla presets:
 *
 * - A pop marker is a special tile (orientation 10 or 11) on any wall layer with main index 8-29.
 * - Markers pair up by main index: the first one in the file (wall layer by layer, then row by row) is one corner and
 *   the last one the other, so a third marker with the same main index stretches the same rectangle.
 * - The first marker's sub index is the *main index of the tiles that hide*: every wall-layer tile with that main index
 *   inside the rectangle grown by one cell on each side fades out while a player stands in the rectangle.
 * - The trigger area is the rectangle, grown by LvlPrest.txt's PopPad (in sub-tiles, 5 per cell) to the south/east.
 * - Markers 8-11, 12-15, 16-19, 20-23, 24-27 and 28-29 are groups: the areas of one group hide together.
 * - Nothing happens unless LvlPrest.txt's Pops is set, and the game keeps room for only Pops areas: more distinct
 *   markers than that overrun its memory.
 */

export const POP_MIN = 8;
export const POP_MAX = 29;

export const isPopMarker = (c: WallCell) =>
  c.prop1 !== 0 && (c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) && c.mainIndex >= POP_MIN && c.mainIndex <= POP_MAX;

/** The group a marker's main index belongs to (areas of one group hide together). */
export const popGroup = (main: number) => Math.floor(main / 4) - 1;
/** Marker main indices of a group. */
export const groupMains = (g: number) => [0, 1, 2, 3].map((k) => (g + 1) * 4 + k).filter((m) => m >= POP_MIN && m <= POP_MAX);
export const POP_GROUPS = [1, 2, 3, 4, 5, 6];

export interface PopMarker {
  x: number;
  y: number;
  layer: number;
  sub: number;
}

export interface PopArea {
  /** The markers' main index (8-29). */
  main: number;
  /** Main index of the tiles that hide (the first marker's sub index). */
  target: number;
  group: number;
  /** In the order the game reads them. */
  markers: PopMarker[];
  /** The trigger rectangle, in cells (inclusive). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function findPops(ds1: Ds1): PopArea[] {
  const byMain = new Map<number, PopArea>();
  ds1.walls.forEach((layer, li) => {
    for (let y = 0; y < ds1.height; y++)
      for (let x = 0; x < ds1.width; x++) {
        const c = layer[y * ds1.width + x];
        if (!isPopMarker(c)) continue;
        const a = byMain.get(c.mainIndex);
        if (a) a.markers.push({ x, y, layer: li, sub: c.subIndex });
        else byMain.set(c.mainIndex, { main: c.mainIndex, target: c.subIndex, group: popGroup(c.mainIndex), markers: [{ x, y, layer: li, sub: c.subIndex }], x0: 0, y0: 0, x1: 0, y1: 0 });
      }
  });
  const out = [...byMain.values()];
  for (const a of out) {
    // First and last marker are the corners.
    const [p, q] = [a.markers[0], a.markers[a.markers.length - 1]];
    [a.x0, a.x1, a.y0, a.y1] = [Math.min(p.x, q.x), Math.max(p.x, q.x), Math.min(p.y, q.y), Math.max(p.y, q.y)];
  }
  return out;
}

/** The cells whose tiles can hide: the rectangle grown by one cell on each side. */
export const hideRect = (a: Pick<PopArea, 'x0' | 'y0' | 'x1' | 'y1'>) => ({ x0: a.x0 - 1, y0: a.y0 - 1, x1: a.x1 + 1, y1: a.y1 + 1 });

/** The trigger area in cells (fractional: PopPad is in sub-tiles and grows the south/east edges). */
export const triggerRect = (a: Pick<PopArea, 'x0' | 'y0' | 'x1' | 'y1'>, popPad: number) => ({
  x: a.x0,
  y: a.y0,
  w: Math.max(0, a.x1 - a.x0 + 1 + popPad / 5),
  h: Math.max(0, a.y1 - a.y0 + 1 + popPad / 5),
});

export interface HiddenTile {
  layer: number;
  x: number;
  y: number;
}

/** Wall-layer tiles with main index `target` inside a hide rectangle (pop markers themselves excluded). */
export function tilesToHide(ds1: Ds1, rect: { x0: number; y0: number; x1: number; y1: number }, target: number): HiddenTile[] {
  const out: HiddenTile[] = [];
  ds1.walls.forEach((layer, li) => {
    for (let y = Math.max(0, rect.y0); y <= Math.min(ds1.height - 1, rect.y1); y++)
      for (let x = Math.max(0, rect.x0); x <= Math.min(ds1.width - 1, rect.x1); x++) {
        const c = layer[y * ds1.width + x];
        if (c.prop1 === 0 || c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) continue;
        if (c.mainIndex === target) out.push({ layer: li, x, y });
      }
  });
  return out;
}

export const popTargets = (ds1: Ds1, a: PopArea) => tilesToHide(ds1, hideRect(a), a.target);

/**
 * The game builds a preset map as rooms of 8×8 cells (D2Common DRLGPRESET_BuildArea), and brings hidden tiles back only
 * in the rooms next to the player's room (DRLGPRESET_UpdatePops walks ppRoomsNear), after which it forgets the area was
 * hidden. So when a player leaves a hide area into a room that isn't next to every room its tiles are in, the far part
 * of the roof stays hidden until they go back in and out another way.
 */
export const ROOM_CELLS = 8;

export interface PopReach {
  /** Cells just outside the trigger area from which some of its hidden tiles are out of reach. */
  exits: { x: number; y: number }[];
  /** The trigger rectangle that keeps every tile in reach (still hiding all of them), or null when none does. */
  fix: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** Whether leaving a hide area anywhere brings its whole roof back (see ROOM_CELLS); null when it does. */
export function popReach(ds1: Ds1, a: PopArea, popPad = 0): PopReach | null {
  const tiles = popTargets(ds1, a);
  if (!tiles.length) return null;
  const room = (v: number) => Math.floor(v / ROOM_CELLS);
  // PopPad (sub-tiles) moves the south and east edges of the trigger area.
  const grow = Math.ceil(popPad / 5);
  const ring = (r: { x0: number; y0: number; x1: number; y1: number }) => {
    const out: { x: number; y: number }[] = [];
    const [ex, ey] = [r.x1 + grow + 1, r.y1 + grow + 1];
    for (let x = r.x0 - 1; x <= ex; x++) for (let y = r.y0 - 1; y <= ey; y++) if (x < r.x0 || x >= ex || y < r.y0 || y >= ey) out.push({ x, y });
    return out;
  };
  const far = (c: { x: number; y: number }) => tiles.some((t) => Math.abs(room(t.x) - room(c.x)) > 1 || Math.abs(room(t.y) - room(c.y)) > 1);
  const exits = ring(a).filter(far);
  if (!exits.length) return null;
  // Every tile's room must be next to every exit's room: exits within one room of the tiles' outermost rooms.
  const [tx0, tx1, ty0, ty1] = [Math.min(...tiles.map((t) => t.x)), Math.max(...tiles.map((t) => t.x)), Math.min(...tiles.map((t) => t.y)), Math.max(...tiles.map((t) => t.y))];
  const x0 = Math.max(a.x0, (room(tx1) - 1) * ROOM_CELLS + 1);
  const y0 = Math.max(a.y0, (room(ty1) - 1) * ROOM_CELLS + 1);
  const x1 = Math.min(a.x1, (room(tx0) + 2) * ROOM_CELLS - 2 - grow);
  const y1 = Math.min(a.y1, (room(ty0) + 2) * ROOM_CELLS - 2 - grow);
  // The hidden tiles are the rectangle grown by one cell: it must still cover them all.
  const ok = x0 <= x1 && y0 <= y1 && x0 - 1 <= tx0 && y0 - 1 <= ty0 && x1 + 1 >= tx1 && y1 + 1 >= ty1 && !ring({ x0, y0, x1, y1 }).some(far);
  return { exits, fix: ok ? { x0, y0, x1, y1 } : null };
}

/** Where an area's two corner markers go for a new rectangle (the first stays the corner it was, and so on). */
export function movedCorners(a: PopArea, r: { x0: number; y0: number; x1: number; y1: number }): { from: PopMarker; x: number; y: number }[] {
  return a.markers.map((m) => ({ from: m, x: m.x === a.x0 ? r.x0 : r.x1, y: m.y === a.y0 ? r.y0 : r.y1 })).filter((m) => m.x !== m.from.x || m.y !== m.from.y);
}

export interface PopProblem {
  severity: 'error' | 'warning' | 'info';
  text: string;
  area?: PopArea;
  /** Corner markers to move so leaving the area anywhere brings the whole roof back. */
  moves?: { from: PopMarker; x: number; y: number }[];
}

/**
 * What would stop a map's pops working in game. `pops` = LvlPrest.txt's Pops for the map (null = no row), `popPad` its
 * PopPad.
 */
export function popProblems(ds1: Ds1, areas: PopArea[], pops: number | null, popPad = 0): PopProblem[] {
  const out: PopProblem[] = [];
  if (!areas.length) return out;
  if (pops !== null && pops === 0)
    out.push({ severity: 'error', text: `LvlPrest.txt's Pops is 0 for this map, so the game ignores its ${areas.length} hide area${areas.length === 1 ? '' : 's'}: roofs never disappear.` });
  else if (pops !== null && pops < areas.length)
    out.push({
      severity: 'error',
      text: `The map has ${areas.length} hide areas but LvlPrest.txt's Pops is ${pops}. The game only makes room for ${pops}, so the extra markers overrun its memory (crashes or odd behaviour).`,
    });
  for (const a of areas) {
    const name = `Hide area ${a.main} (hides tiles #${a.target})`;
    if (a.markers.length === 1) out.push({ severity: 'warning', area: a, text: `${name} has only one corner marker, so its trigger area is a single cell. Place a second ${a.main}/${a.target} marker at the opposite corner.` });
    if (a.markers.length > 2)
      out.push({
        severity: 'warning',
        area: a,
        text: `${name} has ${a.markers.length} markers. The game pairs markers by main index and uses only the first and last as corners, so this is one rectangle (${a.x1 - a.x0 + 1}×${a.y1 - a.y0 + 1} cells) across all of them. Give each building its own main index.`,
      });
    if (a.markers.some((m) => m.sub !== a.target))
      out.push({ severity: 'warning', area: a, text: `${name}: its markers have different sub indices; the game uses the first one's (${a.target}).` });
    if (!popTargets(ds1, a).length) out.push({ severity: 'warning', area: a, text: `${name}: no wall-layer tile with main index ${a.target} is in its area, so nothing disappears.` });
    const reach = a.markers.length === 2 ? popReach(ds1, a, popPad) : null;
    if (reach) {
      const moves = reach.fix ? movedCorners(a, reach.fix) : [];
      const side = [...new Set(reach.exits.map((e) => (e.y > a.y1 ? 'south' : e.y < a.y0 ? 'north' : e.x > a.x1 ? 'east' : 'west')))].join('/');
      out.push({
        severity: 'warning',
        area: a,
        text: `${name} is too big for the game's 8×8-cell rooms: leaving it on the ${side} side, part of the roof stays hidden until you go back in and out another way. The game brings tiles back only in the rooms next to the player's.${
          moves.length ? ` Moving ${moves.map((m) => `(${m.from.x},${m.from.y}) to (${m.x},${m.y})`).join(' and ')} keeps it all in reach (it still hides every tile).` : ' Split the building into smaller hide areas.'
        }`,
        moves: moves.length ? moves : undefined,
      });
    }
  }
  return out;
}

export interface PopPlan {
  /** Marker main index for each target main index. */
  markers: { main: number; target: number }[];
  /** Wall layer of each marker pair (same order). */
  layers: number[];
  /** Wall layers the map needs (adds layers when the corners have no free layer). */
  wallLayers: number;
  error?: string;
}

/**
 * Where to put the markers for a new hide area over `rect` (the trigger rectangle) hiding tiles with the given main
 * indices: one marker pair per target, all in one unused group so they hide together, each pair on a wall layer that
 * is free at both corners (adding layers up to 4).
 */
export function planPops(ds1: Ds1, rect: { x0: number; y0: number; x1: number; y1: number }, targets: number[], maxWallLayers = 4): PopPlan {
  const used = new Set(findPops(ds1).map((a) => a.main));
  const group = POP_GROUPS.find((g) => groupMains(g).filter((m) => !used.has(m)).length >= targets.length && groupMains(g).every((m) => !used.has(m)));
  const fallback = POP_GROUPS.find((g) => groupMains(g).filter((m) => !used.has(m)).length >= targets.length);
  const g = group ?? fallback;
  if (g === undefined) return { markers: [], layers: [], wallLayers: ds1.walls.length, error: `No free marker numbers left for ${targets.length} more target${targets.length === 1 ? '' : 's'} (8-29 are all used).` };
  const free = groupMains(g).filter((m) => !used.has(m));
  const markers = targets.map((target, i) => ({ main: free[i], target }));
  const corners = [
    [rect.x0, rect.y0],
    [rect.x1, rect.y1],
  ];
  const isFree = (li: number) => li >= ds1.walls.length || corners.every(([x, y]) => ds1.walls[li][y * ds1.width + x].prop1 === 0);
  const layers: number[] = [];
  for (let li = 0; li < maxWallLayers && layers.length < markers.length; li++) if (isFree(li)) layers.push(li);
  if (layers.length < markers.length)
    return { markers, layers, wallLayers: ds1.walls.length, error: `The corner cells have no free wall layer for ${markers.length} marker pair${markers.length === 1 ? '' : 's'} (a map has at most ${maxWallLayers}). Hide fewer kinds of tiles, or move the corners.` };
  return { markers, layers, wallLayers: Math.max(ds1.walls.length, Math.max(...layers) + 1) };
}

/** Applies a plan to a DS1 (in place): adds wall layers as needed and places the marker pairs. */
export function applyPopPlan(ds1: Ds1, rect: { x0: number; y0: number; x1: number; y1: number }, plan: PopPlan): void {
  const cells = ds1.width * ds1.height;
  while (ds1.walls.length < plan.wallLayers) ds1.walls.push(Array.from({ length: cells }, () => ({ ...EMPTY_CELL, orientation: 0, orientationHigh: 0 })));
  plan.markers.forEach((m, i) => {
    const layer = ds1.walls[plan.layers[i]];
    for (const [x, y] of [
      [rect.x0, rect.y0],
      [rect.x1, rect.y1],
    ]) {
      const idx = y * ds1.width + x;
      layer[idx] = { ...withTile(layer[idx], m.main, m.target, DEFAULT_PROP1.wall), orientation: Orientation.SpecialTile1, orientationHigh: 0 };
    }
  });
}

/** Removes every marker of the given areas. */
export function removePops(ds1: Ds1, areas: PopArea[]): void {
  for (const a of areas) for (const m of a.markers) ds1.walls[m.layer][m.y * ds1.width + m.x] = { ...EMPTY_CELL, orientation: 0, orientationHigh: 0 };
}
