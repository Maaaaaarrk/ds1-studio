import { type Ds1 } from '../formats/ds1';
import { Orientation } from '../formats/dt1';

/**
 * Ways out of a level: a warp tile (special tile, main index N = 0-7) leads to the level in Levels.txt VisN; a waypoint
 * takes players anywhere they've been. A level with neither can only be left by town portal (players who have no scroll
 * or tome are stuck) or by leaving the game.
 */

/** The town of each act (level ids), where an exit usually leads. */
export const ACT_TOWNS = [1, 40, 75, 103, 109];

export interface ExitProblem {
  severity: 'warning' | 'info';
  title: string;
  detail: string;
  cells?: { x: number; y: number }[];
  /** The link to set up (Levels.txt VisN) and whether a warp tile for it still has to be placed on the map. */
  fix: { vis: number; edit: boolean; place: boolean; label: string } | null;
}

interface ExitOptions {
  /** A waypoint object is on the map. */
  hasWaypoint: boolean;
  /** This map is the level's only preset (else another of its maps may hold the exit). */
  onlyPreset: boolean;
  isTown: boolean;
  levelName: (id: number) => string;
}

/** The warp tiles on a map, by link number. */
export function warpTiles(ds1: Ds1): Map<number, { x: number; y: number }[]> {
  const out = new Map<number, { x: number; y: number }[]>();
  for (const layer of ds1.walls)
    layer.forEach((c, i) => {
      if (!c.prop1 || (c.orientation !== Orientation.SpecialTile1 && c.orientation !== Orientation.SpecialTile2) || c.mainIndex > 7) return;
      const list = out.get(c.mainIndex) ?? [];
      list.push({ x: i % ds1.width, y: Math.floor(i / ds1.width) });
      out.set(c.mainIndex, list);
    });
  return out;
}

/** Warp tiles that lead nowhere, and a level with no way out. `level` is the map's Levels.txt row. */
export function exitProblems(ds1: Ds1, level: Record<string, string>, o: ExitOptions): ExitProblem[] {
  const out: ExitProblem[] = [];
  const vis = (n: number) => {
    const v = Number(level[`Vis${n}`]);
    return Number.isInteger(v) && v > 0 ? v : 0;
  };
  const tiles = warpTiles(ds1);
  for (const [n, cells] of [...tiles].sort((a, b) => a[0] - b[0])) {
    if (vis(n)) continue;
    out.push({
      severity: 'warning',
      title: `${cells.length === 1 ? 'A warp tile' : `${cells.length} warp tiles`} for link ${n} ${cells.length === 1 ? 'leads' : 'lead'} nowhere`,
      detail: `Warp tiles with main index ${n} take players to the level in this level's Vis${n} column (Levels.txt), which is empty, so the game makes no warp there.`,
      cells,
      fix: { vis: n, edit: true, place: false, label: `Choose where link ${n} leads…` },
    });
  }
  const linked = [...tiles.keys()].filter((n) => vis(n));
  if (o.isTown || !o.onlyPreset || linked.length || o.hasWaypoint) return out;

  const tableLink = [0, 1, 2, 3, 4, 5, 6, 7].find((n) => vis(n));
  const unlinked = [...tiles.keys()].sort((a, b) => a - b)[0];
  const free = [0, 1, 2, 3, 4, 5, 6, 7].find((n) => !vis(n)) ?? 0;
  out.push({
    severity: 'warning',
    title: 'No way out of this level except a town portal',
    detail: `The map has no warp that leads anywhere and no waypoint, so players can only leave by town portal (a player without a scroll or tome is stuck) or by leaving the game. ${
      tableLink !== undefined
        ? `Levels.txt already links it to ${o.levelName(vis(tableLink))} (link ${tableLink}), but no warp tile with main index ${tableLink} is on the map: place one where the exit should be.`
        : unlinked !== undefined
          ? `Choose where the warp tile for link ${unlinked} leads (usually the act's town).`
          : `Add an exit: a link in Levels.txt (usually to the act's town) and a warp tile on the map where players click to leave.`
    } If leaving by town portal is intended, ignore this.`,
    fix:
      tableLink !== undefined
        ? { vis: tableLink, edit: false, place: true, label: `Place the warp tile for link ${tableLink} (to ${o.levelName(vis(tableLink))})` }
        : unlinked !== undefined
          ? null // the "leads nowhere" fix above sets it up
          : { vis: free, edit: true, place: true, label: 'Add an exit warp…' },
  });
  return out;
}
