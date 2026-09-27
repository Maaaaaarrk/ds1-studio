import { colIndex, getCell, serializeTxtTable, setCell, type TxtTableDoc } from '../formats/txtTable';
import { normalizePath, type LayeredFs } from '../vfs/vfs';
import { loadTable, type TableWrite } from './levelTables';

/**
 * Where a level's warps lead. A warp special tile with main index N (0-7) is the level's link N: Levels.txt gives
 * the level it goes to in column VisN and the kind of warp (LvlWarp.txt row: cave entrance, stairs…) in WarpN.
 */

export interface LevelRef {
  id: number;
  /** In-game name (LevelName), else the row name. */
  name: string;
  /** Map presets (DS1s) the level is built from (LvlPrest rows with this LevelId). Empty for random levels. */
  maps: string[];
}

export interface WarpLink {
  vis: number;
  target: LevelRef;
  warp: { id: number; name: string } | null;
}

export interface LevelLinks {
  level: LevelRef;
  /** Links 0-7; null when that slot isn't used. */
  links: (WarpLink | null)[];
}

export interface WarpTables {
  levels: TxtTableDoc;
  warps: TxtTableDoc | null;
  prest: TxtTableDoc | null;
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

export async function loadWarpTables(fs: LayeredFs): Promise<WarpTables | null> {
  const [levels, warps, prest] = await Promise.all([loadTable(fs, 'Levels.txt'), loadTable(fs, 'LvlWarp.txt'), loadTable(fs, 'LvlPrest.txt')]);
  return levels ? { levels, warps, prest } : null;
}

function levelRow(t: WarpTables, id: number): number {
  const c = colIndex(t.levels, 'Id');
  return t.levels.rows.findIndex((r) => num(r[c] ?? '') === id);
}

export function levelRef(t: WarpTables, id: number, fs?: LayeredFs): LevelRef {
  const row = levelRow(t, id);
  const name = row < 0 ? `Level ${id}` : getCell(t.levels, row, 'LevelName') || getCell(t.levels, row, 'Name') || `Level ${id}`;
  const maps: string[] = [];
  if (t.prest) {
    const lc = colIndex(t.prest, 'LevelId');
    t.prest.rows.forEach((r, i) => {
      if (num(r[lc] ?? '') !== id) return;
      for (let f = 1; f <= 6; f++) {
        const v = getCell(t.prest!, i, `File${f}`);
        if (!v || v === '0') continue;
        const p = normalizePath(`data/global/tiles/${v}`);
        if (!fs || fs.locate(p)) maps.push(p);
      }
    });
  }
  return { id, name, maps: [...new Set(maps)] };
}

/** Every level with an id, for choosing a link target. */
export function allLevels(t: WarpTables): { id: number; name: string }[] {
  const c = colIndex(t.levels, 'Id');
  return t.levels.rows
    .map((r, i) => ({ id: num(r[c] ?? ''), name: getCell(t.levels, i, 'LevelName') || getCell(t.levels, i, 'Name') }))
    .filter((l) => Number.isInteger(l.id) && l.id > 0);
}

/** The kinds of warp (LvlWarp.txt rows). */
export function allWarps(t: WarpTables): { id: number; name: string }[] {
  if (!t.warps) return [];
  const c = colIndex(t.warps, 'Id');
  return t.warps.rows.map((r, i) => ({ id: num(r[c] ?? ''), name: getCell(t.warps!, i, 'Name') })).filter((w) => Number.isInteger(w.id) && w.id >= 0);
}

export function levelLinks(t: WarpTables, levelId: number, fs?: LayeredFs): LevelLinks | null {
  const row = levelRow(t, levelId);
  if (row < 0) return null;
  const warps = allWarps(t);
  const links = Array.from({ length: 8 }, (_, vis): WarpLink | null => {
    const target = num(getCell(t.levels, row, `Vis${vis}`));
    if (!Number.isInteger(target) || target <= 0) return null;
    const warpId = num(getCell(t.levels, row, `Warp${vis}`));
    const warp = Number.isInteger(warpId) && warpId >= 0 ? (warps.find((w) => w.id === warpId) ?? { id: warpId, name: `LvlWarp ${warpId}` }) : null;
    return { vis, target: levelRef(t, target, fs), warp };
  });
  return { level: levelRef(t, levelId, fs), links };
}

export interface LinkChange {
  levelId: number;
  vis: number;
  /** 0 removes the link. */
  targetId: number;
  warpId: number;
  /** Also link the target level back here (its first free link, or the one already pointing here). */
  back?: { warpId: number } | null;
}

/**
 * The Levels.txt edit for a link change. Returns the write (with a summary) and which link the way back uses, or an
 * explanation when it can't be done.
 */
export function linkWrite(t: WarpTables, c: LinkChange): { write: TableWrite; backVis: number | null } | string {
  let levels = t.levels;
  const row = levelRow(t, c.levelId);
  if (row < 0) return `Levels.txt has no level ${c.levelId}.`;
  const has = (col: string) => colIndex(levels, col) >= 0;
  if (!has(`Vis${c.vis}`) || !has(`Warp${c.vis}`)) return 'Levels.txt has no Vis/Warp columns.';
  const summary: string[] = [];
  const name = (id: number) => levelRef(t, id).name;
  levels = setCell(levels, row, `Vis${c.vis}`, String(c.targetId));
  levels = setCell(levels, row, `Warp${c.vis}`, c.targetId ? String(c.warpId) : '-1');
  summary.push(c.targetId ? `${name(c.levelId)}: link ${c.vis} → ${name(c.targetId)} (level ${c.targetId}), LvlWarp ${c.warpId}` : `${name(c.levelId)}: link ${c.vis} removed`);
  let backVis: number | null = null;
  if (c.back && c.targetId) {
    const tr = levelRow(t, c.targetId);
    if (tr < 0) return `Levels.txt has no level ${c.targetId}.`;
    const slots = Array.from({ length: 8 }, (_, i) => num(getCell(levels, tr, `Vis${i}`)));
    backVis = slots.findIndex((v) => v === c.levelId);
    if (backVis < 0) backVis = slots.findIndex((v) => !Number.isInteger(v) || v <= 0);
    if (backVis < 0) return `${name(c.targetId)} already uses all 8 links; free one first (or leave out the way back).`;
    levels = setCell(levels, tr, `Vis${backVis}`, String(c.levelId));
    levels = setCell(levels, tr, `Warp${backVis}`, String(c.back.warpId));
    summary.push(`${name(c.targetId)}: link ${backVis} → ${name(c.levelId)} (the way back; its map needs a warp tile with main index ${backVis})`);
  }
  return { write: { table: 'Levels.txt', path: 'data/global/excel/Levels.txt', bytes: serializeTxtTable(levels), summary }, backVis };
}
