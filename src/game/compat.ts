import { Orientation } from '../formats/dt1';
import { parseTxt, type TxtTable } from '../formats/txt';
import { SubTileFlag, walkability, type Scene } from '../render/scene';
import { normalizePath } from '../vfs/vfs';
import { GameData } from './GameData';
import type { OpenMap } from './openMap';

export type Severity = 'error' | 'warning' | 'info' | 'ok';

export interface CheckResult {
  severity: Severity;
  area: 'Tiles' | 'Tables' | 'Level' | 'Objects' | 'Map';
  title: string;
  detail?: string;
  /** Cells or sub-tiles to show on the map. */
  cells?: { x: number; y: number }[];
  /** Suggested fix the UI can offer (opens a table at a row, or adds DT1s). */
  fix?: { kind: 'open-table'; table: string; key?: string } | { kind: 'add-dt1s'; paths: string[] };
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
export async function checkMap(gd: GameData, map: OpenMap, scene: Scene): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { ds1, lib } = map;

  // --- Tiles -------------------------------------------------------------------------------------------------------
  const notFound = lib.loaded.filter((l) => !l.found && !l.path.startsWith('winds1/'));
  if (notFound.length)
    out.push({ severity: 'error', area: 'Tiles', title: `${notFound.length} tile librar${notFound.length > 1 ? 'ies' : 'y'} not found`, detail: notFound.map((l) => short(l.path)).join(', ') });
  if (scene.missing.length)
    out.push({
      severity: 'error',
      area: 'Tiles',
      title: `${scene.missing.length} placed tiles have no graphic`,
      detail: 'These cells reference tiles (orientation/main/sub) that no loaded DT1 contains. In game they are invisible and may break walkability.',
      cells: scene.missing.map((m) => ({ x: m.cellX, y: m.cellY })),
    });
  else out.push({ severity: 'ok', area: 'Tiles', title: 'Every placed tile has a graphic' });

  // DT1s the placed tiles actually come from.
  const used = new Map<string, number>();
  for (const it of scene.items) {
    const src = lib.sourceOf(it.tile);
    if (src && !src.path.startsWith('winds1/')) used.set(normalizePath(src.path), (used.get(normalizePath(src.path)) ?? 0) + 1);
  }

  // --- Tables: is the map part of a level? --------------------------------------------------------------------------
  const [prest, levels, types] = await Promise.all([table(gd, 'LvlPrest.txt'), table(gd, 'Levels.txt'), table(gd, 'LvlTypes.txt')]);
  const rel = normalizePath(map.path).replace(/^data\/global\/tiles\//, '');
  const prestRow = prest?.rows.find((r) => [1, 2, 3, 4, 5, 6].some((i) => normalizePath(r[`File${i}`] ?? '') === rel));
  if (!prest) out.push({ severity: 'warning', area: 'Tables', title: 'LvlPrest.txt not found', detail: 'Cannot check how the game loads this map.' });
  else if (!prestRow)
    out.push({
      severity: 'error',
      area: 'Tables',
      title: 'Not referenced by LvlPrest.txt',
      detail: `No LvlPrest row lists "${rel}" in File1–File6, so the game never loads this map. Add a row (Name, Def, LevelId, File1, Dt1Mask).`,
      fix: { kind: 'open-table', table: 'LvlPrest.txt' },
    });
  else {
    out.push({ severity: 'ok', area: 'Tables', title: `LvlPrest: "${prestRow['Name']}" (Def ${prestRow['Def']})` });
    const levelId = Number(prestRow['LevelId']);
    const mask = Number(prestRow['Dt1Mask']) >>> 0;
    if (!levelId) {
      out.push({
        severity: 'info',
        area: 'Level',
        title: 'Shared preset (LevelId 0)',
        detail: 'Placed by a level generator (LvlMaze/LvlSub or another level), not a level on its own. Level checks are skipped.',
      });
    } else {
      const level = levels?.rows.find((r) => Number(r['Id']) === levelId);
      if (!level) out.push({ severity: 'error', area: 'Level', title: `Levels.txt has no level ${levelId}`, fix: { kind: 'open-table', table: 'Levels.txt' } });
      else {
        const typeId = Number(level['LevelType']);
        const typeRow = types?.rows.find((r) => Number(r['Id']) === typeId);
        out.push({ severity: 'ok', area: 'Level', title: `Level ${levelId} "${level['LevelName'] || level['Name']}" (Act ${Number(level['Act']) + 1})` });
        if (!typeRow) out.push({ severity: 'error', area: 'Level', title: `LvlTypes.txt has no type ${typeId}`, fix: { kind: 'open-table', table: 'LvlTypes.txt' } });
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
              fix: { kind: 'open-table', table: 'LvlTypes.txt', key: typeRow['Name'] },
            });
          else out.push({ severity: 'ok', area: 'Level', title: 'Every tile library the map uses is loaded by its level type' });
          for (const f of info?.files.filter(Boolean) ?? []) {
            const p = normalizePath(`data/global/tiles/${f}`);
            if (loaded.has(p) && !gd.fs.locate(p)) out.push({ severity: 'error', area: 'Level', title: `LvlTypes file missing: ${f}` });
          }
        }
        // Palette: the level's act decides it.
        const act = Number(level['Act']);
        if (act !== ds1.act)
          out.push({ severity: 'info', area: 'Level', title: `Level is in Act ${act + 1}, DS1 header says Act ${ds1.act + 1}`, detail: 'The game uses the level’s act (palette, music, town). The header value is not used for that.' });
        if (Number(level['Waypoint']) && Number(level['Waypoint']) !== 255 && !ds1.objects.some((o) => o.type === 2 && /waypoint/i.test(gd.objectName(ds1.act, 2, o.id))))
          out.push({ severity: 'warning', area: 'Level', title: 'Level has a waypoint slot but no waypoint object on this map' });
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

  // --- Objects -----------------------------------------------------------------------------------------------------
  const walk = walkability(ds1, scene);
  const blocked: { x: number; y: number }[] = [];
  const offMap: string[] = [];
  const spots = new Map<string, number>();
  for (const o of ds1.objects) {
    const cx = Math.floor(o.x / 5);
    const cy = Math.floor(o.y / 5);
    if (cx < 0 || cy < 0 || cx >= ds1.width || cy >= ds1.height) {
      offMap.push(gd.objectName(ds1.act, o.type, o.id));
      continue;
    }
    const f = walk[(cy * ds1.width + cx) * 25 + (o.y % 5) * 5 + (o.x % 5)];
    if (o.type === 1 && f & (SubTileFlag.BlockWalk | SubTileFlag.BlockPlayerWalk)) blocked.push({ x: cx, y: cy });
    const k = `${o.x},${o.y}`;
    spots.set(k, (spots.get(k) ?? 0) + 1);
  }
  if (offMap.length) out.push({ severity: 'error', area: 'Objects', title: `${offMap.length} objects outside the map`, detail: offMap.join(', ') });
  if (blocked.length)
    out.push({ severity: 'warning', area: 'Objects', title: `${blocked.length} NPCs/monsters stand on unwalkable ground`, detail: 'They may be stuck or fail to spawn.', cells: blocked });
  const stacked = [...spots.values()].filter((n) => n > 1).length;
  if (stacked) out.push({ severity: 'warning', area: 'Objects', title: `${stacked} spots with several objects on the same sub-tile`, detail: 'NPC paths attached to such spots are dropped by the game and by WinDS1.' });
  if (!offMap.length && !blocked.length && !stacked) out.push({ severity: 'ok', area: 'Objects', title: `${ds1.objects.length} objects placed on valid ground` });

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
