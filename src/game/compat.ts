import { automapLevelFor, GAME_AUTOMAP_LEVELS, parseAutomap, unknownAutomapLevels, type AutomapPiece } from './automap';
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
import { ACT_TOWNS, exitProblems } from './exits';
import { loadTable } from './levelTables';
import { blankObjectNames, nameStringsWrite, readStringTables } from './objectStrings';

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
  /** Moves wall-layer markers (special tiles) to other cells, onto the same wall layer when it is free there. */
  | { kind: 'move-special'; moves: { index: number; x: number; y: number; toX: number; toY: number }[] }
  | { kind: 'sync-tables' }
  | { kind: 'register' }
  | { kind: 'move-objects'; moves: { index: number; x: number; y: number }[] }
  | { kind: 'delete-objects'; indices: number[] }
  | { kind: 'place-object'; type: number; id: number }
  | { kind: 'set-act'; act: number }
  /** Crop the map: negative deltas remove cells from each edge. */
  | { kind: 'resize'; delta: { left: number; top: number; right: number; bottom: number } }
  | { kind: 'automap-editor' }
  /** Sets up warp link `vis` (Levels.txt VisN, in the link editor) and/or arms the brush with its warp tile. */
  | { kind: 'warp-link'; vis: number; edit: boolean; place: boolean; toTown?: number }
  /** Answers a check's question with "keep it as it is": remembered, so it isn't asked again. */
  | { kind: 'keep'; key: string }
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
export async function checkMap(gd: GameData, map: OpenMap, scene: Scene, automap?: { pieces: AutomapPiece[] }, kept?: (key: string) => boolean): Promise<CheckResult[]> {
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

  // --- Arrival: where the game puts players who come in without a warp (a map item's portal) ----------------------
  // D2Common's spawn search for a level (ordinal 10816) takes, in order: a waypoint object, a room with a warp tile,
  // the room at the level's centre, any room; then the nearest free ground around that room's middle, and stops the
  // game (line 568) when there is none. A map whose tiles are all off-centre (a big new map) has nothing there.
  {
    const hasWaypoint = ds1.objects.some((o) => o.type === 2 && /waypoint/i.test(gd.objectName(ds1.act, o.type, o.id)));
    const hasWarp = ds1.walls.some((l) => l.some((c) => (c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) && c.mainIndex <= 7));
    if (!hasWaypoint && !hasWarp) {
      const lw = ds1.width - 1;
      const lh = ds1.height - 1;
      const rx = Math.floor((Math.floor(lw / 2) - 2) / 8) * 8;
      const ry = Math.floor((Math.floor(lh / 2) - 2) / 8) * 8;
      const floorAt = (x: number, y: number) => ds1.floors.some((l) => !!l[y * ds1.width + x]?.prop1);
      let ground = 0;
      for (let y = ry; y < Math.min(ry + 8, ds1.height); y++) for (let x = rx; x < Math.min(rx + 8, ds1.width); x++) if (floorAt(x, y)) ground++;
      if (!ground) {
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
        const delta = maxX < 0 ? null : { left: -Math.max(0, minX - m), top: -Math.max(0, minY - m), right: -Math.max(0, ds1.width - 1 - maxX - m), bottom: -Math.max(0, ds1.height - 1 - maxY - m) };
        const trimmed = delta ? { w: ds1.width + delta.left + delta.right, h: ds1.height + delta.top + delta.bottom } : null;
        out.push({
          severity: 'error',
          area: 'Level',
          title: 'Players arriving by portal (a map item) land in the empty middle of the map, and the game stops',
          detail: `With no waypoint and no warp tile, the game puts players arriving without a warp (a map item's portal) in the room at the level's centre, cells ${rx}-${rx + 7} × ${ry}-${ry + 7} here, and looks for free ground around its middle. There is no floor there, so it finds none and stops (D2Common, line 568). Put the map's floor there, add a waypoint, or crop the map to what's painted${trimmed ? ` (${trimmed.w}×${trimmed.h})` : ''} so its centre is on the map's floor; then save (the level's size in Levels.txt follows).`,
          cells: [{ x: rx + 4, y: ry + 4 }],
          fixes: delta && (delta.left || delta.top || delta.right || delta.bottom) ? [{ kind: 'resize', label: `Crop the map to what's painted (${trimmed!.w}×${trimmed!.h}, 2 cells around)`, delta }] : [],
        });
      }
    }
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
        kept,
      }))
        out.push({
          severity: issue.severity,
          title: issue.title,
          detail: issue.detail,
          columns: issue.columns,
          area: issue.columns?.[0]?.table === 'Levels' ? 'Level' : 'Tables',
          fixes: [
            ...(issue.keep ? [{ kind: 'keep' as const, label: issue.keep.label, key: issue.keep.key }] : []),
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
        // Ways out: warps that lead somewhere, or a waypoint.
        const hasWaypoint = ds1.objects.some((o) => o.type === 2 && /waypoint/i.test(gd.objectName(ds1.act, 2, o.id)));
        const presets = prest?.rows.filter((r) => Number(r['LevelId']) === levelId).length ?? 0;
        const levelName = (id: number) => {
          const r = levels?.rows.find((x) => Number(x['Id']) === id);
          return r ? r['LevelName'] || r['Name'] || `level ${id}` : `level ${id}`;
        };
        for (const p of exitProblems(ds1, level, { hasWaypoint, onlyPreset: presets <= 1, isTown: TOWNS.has(levelId), levelName }))
          out.push({
            severity: p.severity,
            area: 'Map',
            title: p.title,
            detail: p.detail,
            cells: p.cells,
            columns: [{ table: 'Levels', col: 'Vis0' }],
            fixes: p.fix ? [{ kind: 'warp-link', label: p.fix.label, vis: p.fix.vis, edit: p.fix.edit, place: p.fix.place, toTown: ACT_TOWNS[act] }] : undefined,
          });
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
  for (const p of popProblems(ds1, pops, prestRow ? Number(prestRow['Pops']) || 0 : null, prestRow ? Number(prestRow['PopPad']) || 0 : 0))
    out.push({
      severity: p.severity,
      area: 'Map',
      title: p.text,
      cells: p.area?.markers.map((m) => ({ x: m.x, y: m.y })),
      columns: p.area ? undefined : [{ table: 'LvlPrest', col: 'Pops' }],
      fixes: p.moves
        ? [{ kind: 'move-special', label: `Move the corner marker${p.moves.length === 1 ? '' : 's'}: ${p.moves.map((m) => `(${m.from.x},${m.from.y}) → (${m.x},${m.y})`).join(', ')}`, moves: p.moves.map((m) => ({ index: m.from.layer, x: m.from.x, y: m.from.y, toX: m.x, toY: m.y })) }]
        : p.area
          ? undefined
          : [{ kind: 'open-table', label: 'Open LvlPrest.txt (or use Map → Roof hiding → Set Pops)', table: 'LvlPrest.txt', key: prestRow?.['Name'] }],
    });

  // --- Objects -----------------------------------------------------------------------------------------------------
  const walk = walkability(ds1, scene, lib);
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

  // Names shown on hover: an objects.txt Name whose string is missing or only spaces shows as an empty box in game.
  const nameKeys = ds1.objects.filter((o) => o.type === 2).map((o) => gd.objectNameKey(ds1.act, o.type, o.id)).filter((k): k is string => !!k);
  if (nameKeys.length) {
    const blanks = blankObjectNames(await readStringTables(gd.fs), nameKeys);
    if (blanks.length) {
      const write = await nameStringsWrite(gd.fs, Object.fromEntries(blanks.map((b) => [b.key, b.suggested])));
      out.push({
        severity: 'warning',
        area: 'Objects',
        title: `${blanks.length === 1 ? 'An object shows' : `${blanks.length} kinds of object show`} an empty name box in game: ${blanks.map((b) => `"${b.key}"`).join(', ')}`,
        detail: `Pointing at ${blanks.length === 1 ? 'it' : 'them'} shows a box with no text: the name's string ${blanks.every((b) => b.blank) ? 'is only spaces' : 'is missing or blank'} in the game's string tables (objects.txt Name is looked up in patchstring.tbl, expansionstring.tbl, then string.tbl). The guild objects Blizzard cut (Guild Vault, Steeg Stone) are like this. Adding the names to your mod's patchstring.tbl fixes it; edit the text there afterwards if you want other names.`,
        columns: [{ table: 'objects', col: 'Name' }],
        fixes: write ? [{ kind: 'table-write', label: `Add ${blanks.map((b) => `"${b.suggested}"`).join(', ')} to patchstring.tbl`, writes: [write] }] : undefined,
      });
    }
  }

  // --- Automap ------------------------------------------------------------------------------------------------------
  const automapDoc = await loadTable(gd.fs, 'AutoMap.txt');
  const amTable = automapDoc ? parseAutomap(automapDoc) : null;
  let noEntries = false;
  if (amTable) {
    const unknown = unknownAutomapLevels(amTable);
    if (unknown.length)
      out.push({
        severity: 'warning',
        area: 'Tables',
        title: `AutoMap.txt names level${unknown.length === 1 ? '' : 's'} the game doesn't know: ${unknown.slice(0, 4).map((u) => `"${u}"`).join(', ')}`,
        detail: `The game only accepts its own ${GAME_AUTOMAP_LEVELS.length} automap level names ("1 Town" … "5 Lava"), and mods like PD2 also a level type's number ("47"). An unknown name stops the game with an error at start-up. Rename those rows to the level type's number (Map panel: Level type).`,
        columns: [{ table: 'AutoMap', col: 'LevelName' }],
        fixes: [{ kind: 'open-table', label: 'Open AutoMap.txt', table: 'AutoMap.txt' }],
      });
    const type = map.resolution.lvlType;
    const level = type ? automapLevelFor(amTable, type.name, ds1.act + 1, type.id) : null;
    if (type && level && !amTable.doc.rows.some((r) => (r[0] ?? '').trim() === level)) {
      noEntries = true;
      out.push({
        severity: 'warning',
        area: 'Map',
        title: `This level type (${type.id} "${type.name}") has no automap entries, so the automap stays empty here`,
        detail: `AutoMap.txt gives each tile of a level type the piece the automap draws for it, under the level type's number ("${level}"). This one has none yet. In the automap editor, "Select missing" then "Suggest" picks pieces for every tile from look-alike tiles the game already maps; save to add them.`,
        columns: [{ table: 'AutoMap', col: 'LevelName' }],
        fixes: [{ kind: 'automap-editor', label: 'Open the automap editor (then Suggest)' }],
      });
    } else if (type && !level && type.id >= GAME_AUTOMAP_LEVELS.length)
      out.push({
        severity: 'info',
        area: 'Map',
        title: `The automap can't show this level type (${type.id} "${type.name}")`,
        detail: `The game only knows automap entries for its own ${GAME_AUTOMAP_LEVELS.length} level types. Mods like PD2 read a level type's number too; this install's AutoMap.txt doesn't use numbers, so it probably doesn't.`,
      });
  }
  if (automap && !noEntries) {
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
