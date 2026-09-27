import type { AutomapPiece } from './automap';
import { Orientation } from '../formats/dt1';
import { parseTxt, type TxtTable } from '../formats/txt';
import { SubTileFlag, walkability, type Scene } from '../render/scene';
import { normalizePath } from '../vfs/vfs';
import { GameData, TileLibrary } from './GameData';
import type { OpenMap } from './openMap';
import { isBuiltinPath } from './specialTiles';
import { clashingDt1s, duplicateDt1s } from './duplicateDt1s';
import { findPops, popProblems } from './pops';
import { ENTRY_IMAGE_DIR, TOWNS, verifyInGame } from './addToGame';
import { loadTable } from './levelTables';

export type Severity = 'error' | 'warning' | 'info' | 'ok';

export interface CheckResult {
  severity: Severity;
  area: 'Tiles' | 'Tables' | 'Level' | 'Objects' | 'Map';
  title: string;
  detail?: string;
  /** Cells or sub-tiles to show on the map. */
  cells?: { x: number; y: number }[];
  /** Table columns the result is about (the UI explains them). */
  columns?: { table: string; col: string }[];
  /** One-click fixes the UI offers for this result, best first. */
  fixes?: Fix[];
}

/** A fix the check can suggest; the app carries it out (and it can be undone like any edit). */
export type Fix = { label: string } & (
  | { kind: 'open-table'; table: string; key?: string }
  | { kind: 'add-dt1s'; paths: string[] }
  | { kind: 'remove-dt1s'; paths: string[] }
  | { kind: 'table-write'; writes: { table: string; path: string; bytes: Uint8Array; summary: string[] }[] }
  | { kind: 'clear-cells'; cells: { layer: 'floor' | 'wall' | 'shadow'; index: number; x: number; y: number }[] }
  /** Changes wall-layer special tiles (orientation 10/11) to another main/sub number, in place. */
  | { kind: 'set-special'; cells: { index: number; x: number; y: number; main: number; sub: number }[] }
  | { kind: 'sync-tables' }
  | { kind: 'register' }
  | { kind: 'move-objects'; moves: { index: number; x: number; y: number }[] }
  | { kind: 'delete-objects'; indices: number[] }
  | { kind: 'place-object'; type: number; id: number }
  | { kind: 'set-act'; act: number }
  | { kind: 'automap-editor' }
);

/**
 * DT1s (other than the loaded ones) that contain the given tile keys ("orientation|main|sub"): the map's own folders
 * first, then every DT1. Returns the fewest files that cover the most keys.
 */
async function dt1sContaining(gd: GameData, keys: Set<string>, loaded: Set<string>, preferred: string[]): Promise<{ paths: string[]; covered: number }> {
  const all = gd.fs.list((p) => p.endsWith('.dt1') && p.startsWith('data/global/tiles/')).filter((p) => !loaded.has(normalizePath(p)));
  const folderOf = (p: string) => normalizePath(p).replace(/[^/]+$/, '');
  const pref = new Set(preferred.map(folderOf));
  const ordered = [...all.filter((p) => pref.has(folderOf(p))), ...all.filter((p) => !pref.has(folderOf(p)))];
  const has = new Map<string, Set<string>>();
  for (const p of ordered) {
    const dt1 = await gd.dt1(p).catch(() => null);
    if (!dt1) continue;
    const hit = new Set(dt1.tiles.map((t) => `${t.orientation}|${t.mainIndex}|${t.subIndex}`).filter((k) => keys.has(k)));
    if (hit.size) has.set(p, hit);
    // The map's folders usually hold them; stop early once everything is found there.
    if (pref.has(folderOf(p)) && [...keys].every((k) => [...has.values()].some((h) => h.has(k)))) break;
  }
  // Greedy cover: fewest DT1s for the most tiles.
  const left = new Set(keys);
  const paths: string[] = [];
  while (left.size) {
    let best: string | null = null;
    let bestN = 0;
    for (const [p, h] of has) {
      const n = [...h].filter((k) => left.has(k)).length;
      if (n > bestN) [best, bestN] = [p, n];
    }
    if (!best) break;
    paths.push(best);
    for (const k of has.get(best)!) left.delete(k);
  }
  return { paths, covered: keys.size - left.size };
}

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

async function table(gd: GameData, name: string): Promise<TxtTable | null> {
  const b = await gd.fs.read(`data/global/excel/${name}`);
  return b ? parseTxt(b) : null;
}

/**
 * Checks that a map will load and play in game: every placed tile has a graphic *in the libraries the game loads*,
 * the map is reachable through LvlPrest/Levels/LvlTypes, it has entry/warp markers, and objects stand on walkable
 * ground. Pure read-only analysis; results are ordered errors first.
 */
export async function checkMap(gd: GameData, map: OpenMap, scene: Scene, automap?: { pieces: AutomapPiece[] }): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { ds1, lib } = map;

  // --- Tiles -------------------------------------------------------------------------------------------------------
  const notFound = lib.loaded.filter((l) => !l.found && !isBuiltinPath(l.path));
  if (notFound.length)
    out.push({
      severity: 'error',
      area: 'Tiles',
      title: `${notFound.length} tile librar${notFound.length > 1 ? 'ies' : 'y'} not found`,
      detail: `${notFound.map((l) => short(l.path)).join(', ')}. The game cannot load ${notFound.length > 1 ? 'them' : 'it'} either.`,
      fixes: [{ kind: 'remove-dt1s', label: `Remove ${notFound.length > 1 ? 'them' : 'it'} from the map's libraries`, paths: notFound.map((l) => l.path) }],
    });
  const dups = duplicateDt1s(lib);
  if (dups.length) {
    const shared = new Set(dups.flatMap((d) => [...d.shared]));
    const cells: { x: number; y: number }[] = [];
    for (let i = 0; i < ds1.width * ds1.height; i++) {
      const used =
        ds1.floors.some((l) => l[i].prop1 !== 0 && shared.has(TileLibrary.key(Orientation.Floor, l[i].mainIndex, l[i].subIndex))) ||
        ds1.walls.some((l) => l[i].prop1 !== 0 && shared.has(TileLibrary.key(l[i].orientation, l[i].mainIndex, l[i].subIndex)));
      if (used) cells.push({ x: i % ds1.width, y: Math.floor(i / ds1.width) });
    }
    const earlier = [...new Set(dups.map((d) => d.earlier))];
    const later = [...new Set(dups.map((d) => d.later))];
    out.push({
      severity: 'warning',
      area: 'Tiles',
      title: `${dups.length} tile librar${dups.length > 1 ? 'ies are' : 'y is'} loaded twice`,
      detail: `${dups.map((d) => `${short(d.earlier)} and ${short(d.later)}`).join('; ')} provide the same tiles. Where a tile has random variants, the game picks among both copies, so the map shows a random mix of them (odd colours on some cells, for example) — in game too. Keep one copy of each.`,
      cells,
      fixes: [
        { kind: 'remove-dt1s', label: `Keep the later ones: remove ${earlier.map(short).join(', ')}`, paths: earlier },
        { kind: 'remove-dt1s', label: `Keep the earlier ones: remove ${later.map(short).join(', ')}`, paths: later },
      ],
    });
  }
  const clash = clashingDt1s(lib, ds1, (p) => /\.mpq$/i.test(gd.fs.locate(normalizePath(p)) ?? ''));
  if (clash) {
    const pairs = [...clash.pairs].sort((a, b) => b[1] - a[1]);
    out.push({
      severity: 'warning',
      area: 'Tiles',
      title: `${clash.cells.length} cells use tile numbers that two of the map's DT1s both have`,
      detail: `${pairs
        .slice(0, 4)
        .map(([p, n]) => `${p.split('|').map(short).join(' and ')} (${n})`)
        .join('; ')}. For each such cell the game picks one of them at random, so the map looks jumbled in game (and differently each time, and in the editor). ${
        clash.removable.length ? `Every tile the map uses from ${clash.removable.map(short).join(', ')} is in another loaded DT1 too, so removing ${clash.removable.length > 1 ? 'them' : 'it'} leaves one choice per cell.` : 'Each DT1 has tiles only it provides, so keep them and change the clashing cells instead.'
      }`,
      cells: clash.cells,
      fixes: clash.removable.length ? [{ kind: 'remove-dt1s', label: `Remove ${clash.removable.map(short).join(', ')} from the map's libraries`, paths: clash.removable }] : [],
    });
  }
  if (scene.missing.length) {
    const keys = new Set(scene.missing.map((m) => `${m.orientation}|${m.main}|${m.sub}`));
    const loadedSet = new Set(lib.loaded.map((l) => normalizePath(l.path)));
    const found = await dt1sContaining(gd, keys, loadedSet, lib.loaded.map((l) => l.path));
    const fixes: Fix[] = [];
    if (found.paths.length)
      fixes.push({
        kind: 'add-dt1s',
        label: `Add ${found.paths.map(short).join(', ')} (${found.covered === keys.size ? 'has all' : `has ${found.covered} of ${keys.size}`} of the missing tiles)`,
        paths: found.paths,
      });
    fixes.push({
      kind: 'clear-cells',
      label: `Clear those ${scene.missing.length} tile${scene.missing.length === 1 ? '' : 's'}`,
      cells: scene.missing.map((m) => ({ layer: m.kind === 'floor' ? 'floor' : m.kind === 'shadow' ? 'shadow' : 'wall', index: m.layer, x: m.cellX, y: m.cellY })),
    });
    out.push({
      severity: 'error',
      area: 'Tiles',
      title: `${scene.missing.length} placed tiles have no graphic`,
      detail: `These cells use tiles (orientation/main/sub) that no loaded DT1 contains. In game they are invisible and may break walkability.${found.paths.length ? '' : ' No DT1 in the game or your mod has them.'}`,
      cells: scene.missing.map((m) => ({ x: m.cellX, y: m.cellY })),
      fixes,
    });
  }
  else out.push({ severity: 'ok', area: 'Tiles', title: 'Every placed tile has a graphic' });

  // DT1s the placed tiles actually come from.
  const used = new Map<string, number>();
  for (const it of scene.items) {
    const src = lib.sourceOf(it.tile);
    if (src && !isBuiltinPath(src.path)) used.set(normalizePath(src.path), (used.get(normalizePath(src.path)) ?? 0) + 1);
  }

  // --- Tables: is the map part of a level? --------------------------------------------------------------------------
  const [prest, levels, types] = await Promise.all([table(gd, 'LvlPrest.txt'), table(gd, 'Levels.txt'), table(gd, 'LvlTypes.txt')]);
  const rel = normalizePath(map.path).replace(/^data\/global\/tiles\//, '');
  // A map can be listed by several rows (a shared room and its own level): check the one that builds a level first.
  const listing = prest?.rows.filter((r) => [1, 2, 3, 4, 5, 6].some((i) => normalizePath(r[`File${i}`] ?? '') === rel)) ?? [];
  const prestRow = listing.find((r) => Number(r['LevelId']) > 0) ?? listing[0];
  if (!prest) out.push({ severity: 'warning', area: 'Tables', title: 'LvlPrest.txt not found', detail: 'Cannot check how the game loads this map.' });
  else if (!prestRow)
    out.push({
      severity: 'error',
      area: 'Tables',
      title: 'Not referenced by LvlPrest.txt',
      detail: `No LvlPrest row lists "${rel}" in File1–File6, so the game never loads this map. Add a row (Name, Def, LevelId, File1, Dt1Mask).`,
      columns: [{ table: 'LvlPrest', col: 'File1' }, { table: 'LvlPrest', col: 'LevelId' }, { table: 'LvlPrest', col: 'Dt1Mask' }],
      fixes: [
        { kind: 'register', label: 'Add to game... (creates the LvlPrest / Levels / LvlTypes rows)' },
        { kind: 'open-table', label: 'Open LvlPrest.txt', table: 'LvlPrest.txt' },
      ],
    });
  else {
    out.push({ severity: 'ok', area: 'Tables', title: `LvlPrest: "${prestRow['Name']}" (Def ${prestRow['Def']})` });
    // The rules the game's table loaders and level builder follow (row = record, first claiming row, sizes, act,
    // palette, overlaps, path lengths); see game/addToGame.ts.
    const [p2, l2, t2] = await Promise.all([loadTable(gd.fs, 'LvlPrest.txt'), loadTable(gd.fs, 'Levels.txt'), loadTable(gd.fs, 'LvlTypes.txt')]);
    if (p2 && l2 && t2)
      for (const issue of verifyInGame({ prest: p2, levels: l2, types: t2 }, map.path.replace(/^data\/global\/tiles\//i, ''), ds1, {
        entryImageExists: (name) => !!gd.fs.locate(normalizePath(`${ENTRY_IMAGE_DIR}${name}.dc6`)),
      }))
        out.push({
          severity: issue.severity,
          title: issue.title,
          detail: issue.detail,
          columns: issue.columns,
          area: issue.columns?.[0]?.table === 'Levels' ? 'Level' : 'Tables',
          fixes: [
            ...(issue.fix ? [{ kind: 'table-write' as const, label: issue.fix.label, writes: issue.fix.writes }] : []),
            { kind: 'open-table' as const, label: `Open ${issue.columns?.[0]?.table ?? 'LvlPrest'}.txt`, table: `${issue.columns?.[0]?.table ?? 'LvlPrest'}.txt` },
          ],
        });
    const levelId = Number(prestRow['LevelId']);
    const mask = Number(prestRow['Dt1Mask']) >>> 0;
    if (!levelId) {
      out.push({
        severity: 'info',
        area: 'Level',
        title: 'Shared preset (LevelId 0)',
        columns: [{ table: 'LvlPrest', col: 'LevelId' }],
        detail: 'Placed by a level generator (LvlMaze/LvlSub or another level), not a level on its own. Level checks are skipped.',
      });
    } else {
      const level = levels?.rows.find((r) => Number(r['Id']) === levelId);
      if (!level)
        out.push({
          severity: 'error',
          area: 'Level',
          title: `Levels.txt has no level ${levelId}`,
          fixes: [
            { kind: 'open-table', label: 'Open Levels.txt', table: 'Levels.txt' },
            { kind: 'register', label: 'Add to game... (pick or create the level)' },
          ],
        });
      else {
        const typeId = Number(level['LevelType']);
        const typeRow = types?.rows.find((r) => Number(r['Id']) === typeId);
        out.push({ severity: 'ok', area: 'Level', title: `Level ${levelId} "${level['LevelName'] || level['Name']}" (Act ${Number(level['Act']) + 1})` });
        if (!typeRow) out.push({ severity: 'error', area: 'Level', title: `LvlTypes.txt has no type ${typeId}`, fixes: [{ kind: 'open-table', label: 'Open LvlTypes.txt', table: 'LvlTypes.txt' }] });
        else {
          // Libraries the game loads for this level vs the ones the map's tiles need.
          const info = gd.lvlType(typeId);
          const loaded = new Set(info ? GameData.dt1sFor(info, mask) : []);
          const notLoaded = [...used.keys()].filter((p) => !loaded.has(p));
          if (notLoaded.length)
            out.push({
              severity: 'error',
              area: 'Level',
              title: `${notLoaded.length} tile librar${notLoaded.length > 1 ? 'ies are' : 'y is'} used but not loaded in game`,
              detail: `${notLoaded.map((p) => `${short(p)} (${used.get(p)} tiles)`).join(', ')}. Add ${notLoaded.length > 1 ? 'them' : 'it'} to LvlTypes "${typeRow['Name']}" (File 1–32) and set the matching bits in this preset's Dt1Mask (${mask}).`,
              fixes: [
                { kind: 'sync-tables', label: `Update LvlTypes "${typeRow['Name']}" and the Dt1Mask automatically` },
                { kind: 'open-table', label: 'Open LvlTypes.txt', table: 'LvlTypes.txt', key: typeRow['Name'] },
              ],
              columns: [{ table: 'LvlTypes', col: 'File 1' }, { table: 'LvlPrest', col: 'Dt1Mask' }],
            });
          else out.push({ severity: 'ok', area: 'Level', title: 'Every tile library the map uses is loaded by its level type' });
          for (const f of info?.files.filter(Boolean) ?? []) {
            const p = normalizePath(`data/global/tiles/${f}`);
            if (loaded.has(p) && !gd.fs.locate(p))
              out.push({
                severity: 'error',
                area: 'Level',
                title: `LvlTypes file missing: ${f}`,
                detail: 'The game fails to load this level type. Fix the path or remove it from the row.',
                fixes: [{ kind: 'open-table', label: 'Open LvlTypes.txt', table: 'LvlTypes.txt', key: typeRow['Name'] }],
              });
          }
        }
        // Palette: the level's act decides it.
        const act = Number(level['Act']);
        if (act !== ds1.act)
          out.push({
            severity: 'info',
            area: 'Level',
            title: `Level is in Act ${act + 1}, DS1 header says Act ${ds1.act + 1}`,
            detail: 'The game places the map’s objects and NPCs from the level’s act (by its number), so the object numbers in the DS1 should be that act’s. The colours come from the level’s Pal. Matching the header keeps object names here and in other editors right.',
            columns: [{ table: 'Levels', col: 'Act' }],
            fixes: [{ kind: 'set-act', label: `Set the DS1 header to Act ${act + 1}`, act }],
          });
        if (Number(level['Waypoint']) && Number(level['Waypoint']) !== 255 && !ds1.objects.some((o) => o.type === 2 && /waypoint/i.test(gd.objectName(ds1.act, 2, o.id)))) {
          const wp = gd.objectList(ds1.act).find((o) => o.type === 2 && /waypoint/i.test(o.name));
          out.push({
            severity: 'warning',
            area: 'Level',
            title: 'Level has a waypoint slot but no waypoint object on this map',
            detail: 'Players cannot use the waypoint unless one of the level’s presets has a waypoint object.',
            columns: [{ table: 'Levels', col: 'Waypoint' }],
            fixes: wp ? [{ kind: 'place-object', label: `Place a waypoint (${wp.name})`, type: 2, id: wp.id }] : undefined,
          });
        }
      }
    }
  }

  // --- Entry points ------------------------------------------------------------------------------------------------
  const specials: { x: number; y: number }[] = [];
  ds1.walls.forEach((layer) =>
    layer.forEach((c, i) => {
      if (c.prop1 && (c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2)) specials.push({ x: i % ds1.width, y: Math.floor(i / ds1.width) });
    }),
  );
  if (!specials.length)
    out.push({
      severity: 'warning',
      area: 'Map',
      title: 'No entry or warp markers',
      detail: 'The map has no special tiles (orientation 10/11), which mark where players arrive (town entries, warps, portals). Players entering from another level may be placed at the map edge or not at all.',
    });
  else out.push({ severity: 'ok', area: 'Map', title: `${specials.length} entry/warp marker tiles`, cells: specials });

  // Arriving by portal (red portals, PD2 map items) puts players on the Map entry marker (10/30/11): every level of the
  // game that is reached through a portal has one (Tristram, Nihlathak's Temple, the Worldstone Chamber, Uber Tristram…),
  // and no town does. Town entries (30/0, 31/0) are only used in towns; without a Map entry the game places players
  // wherever it likes.
  const presetLevel = prestRow ? Number(prestRow['LevelId']) || 0 : 0;
  if (presetLevel && !TOWNS.has(presetLevel)) {
    const marks: { index: number; x: number; y: number; main: number; sub: number }[] = [];
    ds1.walls.forEach((layer, index) =>
      layer.forEach((c, i) => {
        if (c.prop1 && (c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) && c.mainIndex >= 30)
          marks.push({ index, x: i % ds1.width, y: Math.floor(i / ds1.width), main: c.mainIndex, sub: c.subIndex });
      }),
    );
    const townEntry = marks.find((m) => m.main === 30 && m.sub === 0) ?? marks.find((m) => m.main === 31 && m.sub === 0);
    if (!marks.some((m) => m.main === 30 && m.sub === 11))
      out.push({
        severity: townEntry ? 'warning' : 'info',
        area: 'Map',
        title: townEntry ? `A town entry marker (${townEntry.main}/${townEntry.sub}) in a level that is not a town` : 'No Map entry marker (10/30/11)',
        detail: `Players arriving by portal (a red portal or a PD2 map item) appear on the Map entry marker, special tile 10/30/11, as in every portal level of the game (Tristram, Nihlathak's Temple, the Worldstone Chamber…). Town entries (30/0, 31/0) only work in towns. Without a Map entry the game puts arriving players wherever it likes.${townEntry ? ` Turning the town entry at (${townEntry.x}, ${townEntry.y}) into a Map entry makes players arrive there.` : ' Place one where players should arrive (Special tiles → Map entry).'}`,
        cells: townEntry ? [{ x: townEntry.x, y: townEntry.y }] : undefined,
        fixes: townEntry ? [{ kind: 'set-special', label: `Make the marker at (${townEntry.x}, ${townEntry.y}) the Map entry (30/11)`, cells: [{ ...townEntry, main: 30, sub: 11 }] }] : [],
      });
  }

  // --- Roof hiding ("pops") -----------------------------------------------------------------------------------------
  const pops = findPops(ds1);
  for (const p of popProblems(ds1, pops, prestRow ? Number(prestRow['Pops']) || 0 : null))
    out.push({
      severity: p.severity,
      area: 'Map',
      title: p.text,
      cells: p.area?.markers.map((m) => ({ x: m.x, y: m.y })),
      columns: p.area ? undefined : [{ table: 'LvlPrest', col: 'Pops' }],
      fixes: p.area ? undefined : [{ kind: 'open-table', label: 'Open LvlPrest.txt (or use Map → Roof hiding → Set Pops)', table: 'LvlPrest.txt', key: prestRow?.['Name'] }],
    });

  // --- Objects -----------------------------------------------------------------------------------------------------
  const walk = walkability(ds1, scene);
  const W = ds1.width * 5;
  const H = ds1.height * 5;
  const walkable = (sx: number, sy: number) =>
    sx >= 0 && sy >= 0 && sx < W && sy < H && !(walk[(Math.floor(sy / 5) * ds1.width + Math.floor(sx / 5)) * 25 + (sy % 5) * 5 + (sx % 5)] & (SubTileFlag.BlockWalk | SubTileFlag.BlockPlayerWalk));
  const taken = new Set(ds1.objects.map((o) => `${o.x},${o.y}`));
  /** Nearest free walkable sub-tile (growing rings), not already used by another object. */
  const nearestFree = (sx: number, sy: number): [number, number] | null => {
    for (let r = 1; r <= 25; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx;
          const y = sy + dy;
          if (walkable(x, y) && !taken.has(`${x},${y}`)) return [x, y];
        }
    return null;
  };
  const blocked: { x: number; y: number }[] = [];
  const blockedMoves: { index: number; x: number; y: number }[] = [];
  const offMap: string[] = [];
  const offMapIdx: number[] = [];
  const spots = new Map<string, number[]>();
  ds1.objects.forEach((o, i) => {
    const cx = Math.floor(o.x / 5);
    const cy = Math.floor(o.y / 5);
    if (cx < 0 || cy < 0 || cx >= ds1.width || cy >= ds1.height) {
      offMap.push(gd.objectName(ds1.act, o.type, o.id));
      offMapIdx.push(i);
      return;
    }
    if (o.type === 1 && !walkable(o.x, o.y)) {
      blocked.push({ x: cx, y: cy });
      const to = nearestFree(o.x, o.y);
      if (to) {
        taken.add(`${to[0]},${to[1]}`);
        blockedMoves.push({ index: i, x: to[0], y: to[1] });
      }
    }
    const k = `${o.x},${o.y}`;
    spots.set(k, [...(spots.get(k) ?? []), i]);
  });
  if (offMap.length)
    out.push({
      severity: 'error',
      area: 'Objects',
      title: `${offMap.length} objects outside the map`,
      detail: offMap.join(', '),
      fixes: [{ kind: 'delete-objects', label: `Delete ${offMap.length > 1 ? 'them' : 'it'}`, indices: offMapIdx }],
    });
  if (blocked.length)
    out.push({
      severity: 'warning',
      area: 'Objects',
      title: `${blocked.length} NPCs/monsters stand on unwalkable ground`,
      detail: 'They may be stuck or fail to spawn.',
      cells: blocked,
      fixes: blockedMoves.length
        ? [{ kind: 'move-objects', label: `Move ${blockedMoves.length === blocked.length ? 'them' : `${blockedMoves.length} of them`} to the nearest walkable spot`, moves: blockedMoves }]
        : undefined,
    });
  const stackedSpots = [...spots.values()].filter((list) => list.length > 1);
  if (stackedSpots.length) {
    const moves: { index: number; x: number; y: number }[] = [];
    for (const list of stackedSpots)
      for (const i of list.slice(1)) {
        const o = ds1.objects[i];
        const to = nearestFree(o.x, o.y);
        if (to) {
          taken.add(`${to[0]},${to[1]}`);
          moves.push({ index: i, x: to[0], y: to[1] });
        }
      }
    out.push({
      severity: 'warning',
      area: 'Objects',
      title: `${stackedSpots.length} spots with several objects on the same sub-tile`,
      detail: 'NPC paths attached to such spots are dropped by the game and by WinDS1.',
      cells: stackedSpots.map((l) => ({ x: Math.floor(ds1.objects[l[0]].x / 5), y: Math.floor(ds1.objects[l[0]].y / 5) })),
      fixes: moves.length ? [{ kind: 'move-objects', label: 'Spread them onto free neighbouring spots', moves }] : undefined,
    });
  }
  const stacked = stackedSpots.length;
  if (!offMap.length && !blocked.length && !stacked) out.push({ severity: 'ok', area: 'Objects', title: `${ds1.objects.length} objects placed on valid ground` });

  // --- Automap ------------------------------------------------------------------------------------------------------
  if (automap) {
    const missingWalls = automap.pieces.filter((p) => p.layer === 'wall' && !p.rule);
    if (missingWalls.length)
      out.push({
        severity: 'info',
        area: 'Map',
        title: `${missingWalls.length} walls have no automap entry`,
        detail: 'They will not show on the in-game automap. Give them pieces, or mark them hidden if they should not show.',
        cells: missingWalls.map((p) => ({ x: p.cellX, y: p.cellY })),
        fixes: [{ kind: 'automap-editor', label: 'Open the automap editor' }],
      });
  }

  // --- Compiled tables ---------------------------------------------------------------------------------------------
  const compiled = ['LvlPrest', 'Levels', 'LvlTypes'].filter((name) => {
    const txt = gd.fs.locate(`data/global/excel/${name}.txt`);
    return txt && txt === gd.fs.locate(`data/global/excel/${name}.bin`);
  });
  if (compiled.length)
    out.push({
      severity: 'info',
      area: 'Tables',
      title: `Compiled .bin files sit next to ${compiled.join(', ')}.txt`,
      detail: 'The game reads the .bin files. After editing the .txt tables, start the game once with -direct -txt (or run your mod’s tool) so the .bin files are rebuilt.',
    });

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2, ok: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
