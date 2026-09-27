import { colIndex, getCell, serializeTxtTable, setCell, type TxtTableDoc } from '../formats/txtTable';
import { normalizePath } from '../vfs/vfs';
import { ensureTypeSlots, maskFor, maskOf, type TableWrite } from './levelTables';

/**
 * "Add to game": the table rows that make the game load a map. The rules come from the game's own table loaders and
 * level builder (D2Common, as reimplemented by D2MOO) and are checked against the vanilla tables (test/addToGame.test):
 *
 * - Levels.txt, LvlPrest.txt and LvlTypes.txt are read by row position: a level's Id, a preset's Def and a level
 *   type's Id must equal the row's index, counting data rows only (the "Expansion" separator row and blank lines are
 *   skipped). So rows are only ever appended, never inserted.
 * - A preset level (Levels DrlgType 2) uses the FIRST LvlPrest row whose LevelId is the level; a second row is ignored.
 *   The game then loads that preset by its Def.
 * - The act comes from the level Id, not the Act column: from 109 on it is Act 5. New levels go at the end, so they
 *   are Act 5 levels (Act = 4). Pal picks the palette, so tiles drawn for another act keep their colours (the game's
 *   own Act 5 levels 133-136 reuse Act 1, 2 and 4 tiles with Pal 0, 1 and 3).
 * - The level's size is Levels SizeX/SizeY (per difficulty) = the DS1's size minus one; LvlPrest SizeX/SizeY stay 0 so
 *   the preset fills the level. OffsetX/OffsetY place it in the act's world and must not overlap other levels.
 * - LvlPrest / LvlTypes file paths are copied with DATA\GLOBAL\TILES\ in front into a 60-byte buffer: at most 41
 *   characters (the game's longest is 40).
 */

const EXCEL = 'data/global/excel/';
export const MAX_TILE_PATH = 41;
export const MAX_LEVEL_STRING = 39;

const num = (s: string) => Number(s) || 0;
const has = (doc: TxtTableDoc, col: string) => colIndex(doc, col) >= 0;

/** Rows the game compiles into records: not blank and not the "Expansion" separator. */
export function dataRows(doc: TxtTableDoc): number[] {
  return doc.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.some((c) => c.trim() !== '') && (r[0] ?? '').trim().toLowerCase() !== 'expansion').map(({ i }) => i);
}

/** Row index (in doc.rows) of the record with the given index, or -1. */
export const rowOfRecord = (doc: TxtTableDoc, record: number) => dataRows(doc)[record] ?? -1;

/** Appends a record: before trailing blank lines, so it stays a record (its index = the old record count). */
export function appendAt(doc: TxtTableDoc, values: Record<string, string>): { doc: TxtTableDoc; row: number } {
  let at = doc.rows.length;
  while (at > 0 && !doc.rows[at - 1].some((c) => c.trim() !== '')) at--;
  const row = new Array<string>(doc.columns.length).fill('');
  for (const [k, v] of Object.entries(values)) {
    const c = colIndex(doc, k);
    if (c >= 0) row[c] = v;
  }
  const rows = doc.rows.slice();
  rows.splice(at, 0, row);
  return { doc: { ...doc, rows }, row: at };
}

/** A tile path the game can hold (see MAX_TILE_PATH); null when fine. */
export function tilePathProblem(rel: string): string | null {
  return rel.length > MAX_TILE_PATH
    ? `"${rel}" is ${rel.length} characters. The game copies tile paths into a 60-byte buffer after DATA\\GLOBAL\\TILES\\, so it holds at most ${MAX_TILE_PATH}: a longer one can crash the game or fail to load. Use shorter folder or file names.`
    : null;
}

export const levelAct = (id: number) => (id >= 109 ? 4 : id >= 103 ? 3 : id >= 75 ? 2 : id >= 40 ? 1 : 0);

export interface FieldChange {
  table: string;
  /** Row label, e.g. `Level 137 "My Map"`. */
  row: string;
  column: string;
  from: string;
  to: string;
  why?: string;
}

export interface AddToGameInput {
  mode: 'new' | 'existing';
  /** new: the level to copy settings from; existing: the preset level that should use this map. */
  levelId: number;
  name: string;
  /** Map path relative to data/global/tiles, with its own capitals. */
  mapRel: string;
  /** DS1 size as DS1 Studio reads it (the file stores one less). */
  width: number;
  height: number;
  /** Full paths (data/global/tiles/...) of the DT1s the map's tiles come from. */
  usedDt1s: string[];
  /** Roof hide areas in the map. */
  popCount: number;
  /** new: the act whose palette the level uses (0-4); default: the act of the template's tiles. */
  palAct?: number;
}

export interface AddToGamePlan {
  writes: TableWrite[];
  changes: FieldChange[];
  warnings: string[];
  newLevelId?: number;
}

/** The act (0-4) a level type's tiles belong to (LvlTypes Act is 1-5). */
export function typeAct(types: TxtTableDoc, typeId: number): number | null {
  const row = rowOfRecord(types, typeId);
  const act = row >= 0 ? num(getCell(types, row, 'Act')) : 0;
  return act >= 1 && act <= 5 ? act - 1 : null;
}

/** Suggested world position for a new level in an act: past every level there, like the game's Act 5 extras (4000+). */
export function freeOffset(levels: TxtTableDoc, act: number): { x: number; y: number } {
  let right = 1000;
  for (const r of dataRows(levels)) {
    const id = num(getCell(levels, r, 'Id'));
    if (levelAct(id) !== act) continue;
    const x = num(getCell(levels, r, 'OffsetX'));
    if (x < 0 || num(getCell(levels, r, 'Depend'))) continue;
    const w = Math.max(...['SizeX', 'SizeX(N)', 'SizeX(H)'].map((c) => num(getCell(levels, r, c))));
    right = Math.max(right, x + Math.max(0, w));
  }
  return { x: Math.ceil((right + 100) / 500) * 500, y: 1000 };
}

export function planAddToGame(tables: { prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc }, input: AddToGameInput): AddToGamePlan | string {
  let { prest, levels, types } = tables;
  const changes: FieldChange[] = [];
  const warnings: string[] = [];
  const touched = new Set<string>();
  const set = (table: 'Levels.txt' | 'LvlPrest.txt' | 'LvlTypes.txt', row: number, rowLabel: string, column: string, to: string, why?: string) => {
    const doc = table === 'Levels.txt' ? levels : table === 'LvlPrest.txt' ? prest : types;
    if (!has(doc, column)) return;
    const from = getCell(doc, row, column);
    if (from === to) return;
    const next = setCell(doc, row, column, to);
    if (table === 'Levels.txt') levels = next;
    else if (table === 'LvlPrest.txt') prest = next;
    else types = next;
    changes.push({ table, row: rowLabel, column, from, to, why });
    touched.add(table);
  };

  const name = input.name.trim();
  if (!name) return 'Give the level a name.';
  const pathIssue = tilePathProblem(input.mapRel);
  if (pathIssue) return pathIssue;
  // The tables must already follow the one-record-per-row rule, or every Id we'd write would be off.
  for (const [t, doc, col] of [
    ['Levels.txt', levels, 'Id'],
    ['LvlPrest.txt', prest, 'Def'],
    ['LvlTypes.txt', types, 'Id'],
  ] as const) {
    const bad = dataRows(doc).findIndex((r, i) => getCell(doc, r, col).trim() !== String(i));
    if (bad >= 0) return `${t}: record ${bad} has ${col} ${getCell(doc, dataRows(doc)[bad], col) || '(empty)'}. The game reads these tables by row position, so ${col} must count up 0, 1, 2… Use the fix above to put the rows back in order.`;
  }

  const levelRow = rowOfRecord(levels, input.levelId);
  if (levelRow < 0) return 'Pick a level.';
  const levelName = (id: number) => getCell(levels, rowOfRecord(levels, id), 'Name');
  const typeId = num(getCell(levels, levelRow, 'LevelType'));
  const typeRow = rowOfRecord(types, typeId);
  if (typeRow < 0) return `LvlTypes.txt has no level type ${typeId}.`;
  const typeName = getCell(types, typeRow, 'Name');
  const sizeX = String(input.width - 1);
  const sizeY = String(input.height - 1);

  // Tile libraries: every DT1 the map uses in the level type's File slots (path limit checked).
  for (const p of input.usedDt1s) {
    const rel = p.replace(/^data\/global\/tiles\//i, '');
    const issue = tilePathProblem(rel);
    if (issue) return `LvlTypes: ${issue}`;
  }
  let slots: Map<string, number>;
  try {
    const before = types;
    const r = ensureTypeSlots(types, typeRow, input.usedDt1s);
    types = r.types;
    slots = r.slots;
    for (const a of r.added) {
      const [col, value] = a.split(' = ');
      changes.push({ table: 'LvlTypes.txt', row: `Type ${typeId} "${typeName}"`, column: col, from: getCell(before, typeRow, col), to: value, why: 'a tile library the map uses' });
      touched.add('LvlTypes.txt');
    }
  } catch (e) {
    return (e as Error).message;
  }

  let newLevelId: number | undefined;
  let targetLevel = input.levelId;
  const prestRows = dataRows(prest);

  if (input.mode === 'new') {
    if (num(getCell(levels, levelRow, 'DrlgType')) === 0) return 'Pick a real level to copy from.';
    newLevelId = dataRows(levels).length;
    if (newLevelId >= 1024) return 'Levels.txt already has 1024 levels, the most the game allows.';
    if (newLevelId > 255) warnings.push(`The new level is number ${newLevelId}. Levels.txt's Id column is stored in one byte, so numbers above 255 need a mod that supports them (PD2 does).`);
    // Append a copy of the template, then set everything that makes it its own level.
    const template = levels.rows[levelRow];
    const values = Object.fromEntries(levels.columns.map((c, i) => [c, template[i] ?? ''])) as Record<string, string>;
    const appended = appendAt(levels, values);
    levels = appended.doc;
    const row = appended.row;
    const label = `Level ${newLevelId} "${name}"`;
    changes.push({ table: 'Levels.txt', row: label, column: '(new row)', from: '', to: `copy of ${input.levelId} ${levelName(input.levelId)}, appended as record ${newLevelId}` });
    touched.add('Levels.txt');
    const tilesAct = typeAct(types, typeId) ?? levelAct(input.levelId);
    const pal = input.palAct ?? tilesAct;
    const off = freeOffset(levels, 4);
    const layers = dataRows(levels).map((r) => num(getCell(levels, r, 'Layer')));
    const shorten = (s: string) => s.slice(0, MAX_LEVEL_STRING);
    if (name.length > MAX_LEVEL_STRING) warnings.push(`The name is cut to ${MAX_LEVEL_STRING} characters in LevelName/LevelWarp/EntryFile (the game's limit).`);
    set('Levels.txt', row, label, 'Name', name);
    set('Levels.txt', row, label, 'Id', String(newLevelId), 'its row number: the game reads Levels.txt by row');
    set('Levels.txt', row, label, 'Act', '4', 'levels from 109 on are Act 5 in the game');
    set('Levels.txt', row, label, 'Pal', String(pal), `the palette of the act the tiles were drawn for (${typeName})`);
    set('Levels.txt', row, label, 'QuestFlag', '', 'no quest needed to enter');
    set('Levels.txt', row, label, 'QuestFlagEx', '', 'no quest needed to enter');
    set('Levels.txt', row, label, 'Quest', '');
    set('Levels.txt', row, label, 'Layer', String(Math.max(0, ...layers) + 1), 'its own automap');
    for (const s of ['', '(N)', '(H)']) {
      set('Levels.txt', row, label, `SizeX${s}`, sizeX, 'the map is one cell bigger than the level');
      set('Levels.txt', row, label, `SizeY${s}`, sizeY, 'the map is one cell bigger than the level');
    }
    set('Levels.txt', row, label, 'OffsetX', String(off.x), 'a free spot in Act 5, away from the other levels');
    set('Levels.txt', row, label, 'OffsetY', String(off.y));
    set('Levels.txt', row, label, 'Depend', '0');
    set('Levels.txt', row, label, 'DrlgType', '2', 'a preset level: its map comes from LvlPrest');
    for (let i = 0; i < 8; i++) {
      set('Levels.txt', row, label, `Vis${i}`, '0', i === 0 ? 'no links yet (see Warps)' : undefined);
      set('Levels.txt', row, label, `Warp${i}`, '-1');
    }
    set('Levels.txt', row, label, 'Waypoint', '255', 'no waypoint');
    set('Levels.txt', row, label, 'LevelName', shorten(name));
    set('Levels.txt', row, label, 'LevelWarp', shorten(name));
    set('Levels.txt', row, label, 'EntryFile', shorten(name));
    targetLevel = newLevelId;
    if (pal !== 4) warnings.push(`The level is in Act 5 but uses the ${['Act 1', 'Act 2', 'Act 3', 'Act 4', 'Act 5'][pal]} palette (Pal ${pal}), because ${typeName}'s tiles were drawn for that act.`);
  } else {
    if (num(getCell(levels, levelRow, 'DrlgType')) !== 2)
      return `${levelName(input.levelId)} is built at random (DrlgType ${getCell(levels, levelRow, 'DrlgType')}), not from one map, so it can't use this map. Make a new level instead.`;
    const cur = [num(getCell(levels, levelRow, 'SizeX')), num(getCell(levels, levelRow, 'SizeY'))];
    if (cur[0] !== input.width - 1 || cur[1] !== input.height - 1) {
      const label = `Level ${input.levelId} "${levelName(input.levelId)}"`;
      for (const s of ['', '(N)', '(H)']) {
        set('Levels.txt', levelRow, label, `SizeX${s}`, sizeX, 'the map is one cell bigger than the level');
        set('Levels.txt', levelRow, label, `SizeY${s}`, sizeY);
      }
      warnings.push(`The level's size changes from ${cur[0]}×${cur[1]} to ${sizeX}×${sizeY}. If it grows, check it doesn't overlap a neighbouring level (OffsetX/OffsetY).`);
    }
  }

  // LvlPrest: the level's claiming row (existing) or a new one (new level). Def = record number.
  const claiming = prestRows.find((r) => num(getCell(prest, r, 'LevelId')) === targetLevel && getCell(prest, r, 'Def').trim() !== '');
  let pRow: number;
  let pLabel: string;
  if (input.mode === 'existing' && claiming !== undefined) {
    pRow = claiming;
    pLabel = `Preset ${getCell(prest, pRow, 'Def')} "${getCell(prest, pRow, 'Name')}"`;
    const files = [1, 2, 3, 4, 5, 6].map((i) => getCell(prest, pRow, `File${i}`)).filter((f) => f && f !== '0');
    const listed = files.some((f) => normalizePath(f) === normalizePath(input.mapRel));
    if (!listed) {
      warnings.push(`${levelName(targetLevel)} will use this map instead of ${files.join(', ') || 'its current map'} (that's the preset row the game reads for it).`);
      set('LvlPrest.txt', pRow, pLabel, 'File1', input.mapRel, 'the level now loads this map');
      for (let i = 2; i <= 6; i++) set('LvlPrest.txt', pRow, pLabel, `File${i}`, '0');
      set('LvlPrest.txt', pRow, pLabel, 'Files', '1');
    }
  } else {
    if (input.mode === 'existing') return `No LvlPrest row claims ${levelName(targetLevel)}.`;
    // Flags: from the template level's own preset when it has one, else what the game's whole-level presets use.
    const tpl = prestRows.find((r) => num(getCell(prest, r, 'LevelId')) === input.levelId);
    const flag = (col: string, fallback: string) => (tpl !== undefined ? getCell(prest, tpl, col) || fallback : fallback);
    const def = prestRows.length;
    const outdoors = getCell(levels, levelRow, 'IsInside') === '1' ? '0' : '1';
    const values: Record<string, string> = {
      Name: name,
      Def: String(def),
      LevelId: String(targetLevel),
      Populate: flag('Populate', '1'),
      Logicals: flag('Logicals', '1'),
      Outdoors: flag('Outdoors', outdoors),
      Animate: flag('Animate', '0'),
      KillEdge: flag('KillEdge', '1'),
      FillBlanks: '1',
      SizeX: '0',
      SizeY: '0',
      AutoMap: '0',
      Scan: '1',
      Pops: '0',
      PopPad: '0',
      Files: '1',
      File1: input.mapRel,
      File2: '0',
      File3: '0',
      File4: '0',
      File5: '0',
      File6: '0',
      Dt1Mask: '0',
      Beta: '0',
      Expansion: '1',
    };
    const appended = appendAt(prest, values);
    prest = appended.doc;
    pRow = appended.row;
    pLabel = `Preset ${def} "${name}"`;
    changes.push({ table: 'LvlPrest.txt', row: pLabel, column: '(new row)', from: '', to: `record ${def} for level ${targetLevel}` });
    for (const [k, v] of Object.entries(values))
      if (has(prest, k))
        changes.push({
          table: 'LvlPrest.txt',
          row: pLabel,
          column: k,
          from: '',
          to: v,
          why: {
            Def: 'its row number: the game loads presets by Def',
            LevelId: 'the level it builds',
            FillBlanks: 'as every game preset level',
            SizeX: '0 = fill the level',
            AutoMap: '1 would reveal the whole automap on entry (towns)',
            Scan: 'finds warps and special tiles',
            Files: 'one map',
            Expansion: 'an Act 5 level',
            Populate: tpl !== undefined ? 'as the template level' : 'spawn monsters',
          }[k],
        });
    touched.add('LvlPrest.txt');
  }

  // Dt1Mask and hide areas on the preset row.
  const oldMask = num(getCell(prest, pRow, 'Dt1Mask')) >>> 0;
  const mask = input.mode === 'new' ? maskOf(slots) : maskFor(types, typeRow, input.usedDt1s, oldMask);
  set('LvlPrest.txt', pRow, pLabel, 'Dt1Mask', String(mask >>> 0), `LvlTypes "${typeName}" File slots ${[...slots.values()].sort((a, b) => a - b).join(', ')}`);
  if (input.popCount > num(getCell(prest, pRow, 'Pops'))) {
    set('LvlPrest.txt', pRow, pLabel, 'Pops', String(input.popCount), 'the map\'s roof hide areas');
    if (!getCell(prest, pRow, 'PopPad') || getCell(prest, pRow, 'PopPad') === '0') set('LvlPrest.txt', pRow, pLabel, 'PopPad', '-4', 'as the game\'s houses');
  }

  const writes: TableWrite[] = [];
  for (const [t, doc] of [
    ['LvlPrest.txt', prest],
    ['Levels.txt', levels],
    ['LvlTypes.txt', types],
  ] as const)
    if (touched.has(t))
      writes.push({
        table: t,
        path: `${EXCEL}${t}`,
        bytes: serializeTxtTable(doc),
        summary: changes.filter((c) => c.table === t).map((c) => `${c.row}: ${c.column} ${c.from || '(empty)'} → ${c.to}${c.why ? ` (${c.why})` : ''}`),
      });
  return { writes, changes, warnings, newLevelId };
}

export interface TableIssue {
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail?: string;
  columns?: { table: string; col: string }[];
  /** A safe one-click fix: the table(s) as they should be. */
  fix?: TableFix;
}

export interface TableFix {
  label: string;
  writes: TableWrite[];
}

type TableName = 'Levels.txt' | 'LvlPrest.txt' | 'LvlTypes.txt';

/** A fix that sets cells of one table. */
export function cellFix(table: TableName, doc: TxtTableDoc, label: string, cells: { row: number; col: string; value: string }[]): TableFix {
  let d = doc;
  const summary: string[] = [];
  for (const c of cells) {
    if (!has(d, c.col) || getCell(d, c.row, c.col) === c.value) continue;
    summary.push(`"${getCell(d, c.row, 'Name')}": ${c.col} ${getCell(d, c.row, c.col) || '(empty)'} → ${c.value}`);
    d = setCell(d, c.row, c.col, c.value);
  }
  return { label, writes: [{ table, path: `${EXCEL}${table}`, bytes: serializeTxtTable(d), summary }] };
}

/**
 * Puts a table's rows back in Id/Def order, when that is all that's wrong: every number 0…n-1 is there exactly once, so
 * no Id changes and nothing that refers to one breaks. The "Expansion" line and blank lines stay where they are.
 * null = already in order; a string = why it can't be fixed by reordering.
 */
export function recordOrderFix(table: TableName, doc: TxtTableDoc, col: string): TableFix | string | null {
  const rows = dataRows(doc);
  const ids = rows.map((r) => getCell(doc, r, col).trim());
  if (ids.every((id, i) => id === String(i))) return null;
  const nums = ids.map((id) => (/^\d+$/.test(id) ? Number(id) : NaN));
  const seen = new Set<number>();
  const dupes = nums.filter((n) => !Number.isNaN(n) && (seen.has(n) || !seen.add(n)));
  const missing = rows.map((_, i) => i).filter((i) => !seen.has(i));
  if (nums.some(Number.isNaN) || dupes.length || missing.length)
    return `The ${col}s aren't simply out of order (${[
      nums.some(Number.isNaN) ? 'some are empty or not numbers' : '',
      dupes.length ? `used twice: ${[...new Set(dupes)].slice(0, 5).join(', ')}` : '',
      missing.length ? `missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` : '',
    ]
      .filter(Boolean)
      .join('; ')}), so they can't be fixed by moving rows. Fix them in Data → Data tables.`;
  // Records sorted by id; every other line (the "Expansion" separator, blank lines) stays just before the record that
  // followed it, or at the end.
  const isRecord = new Set(rows);
  const before = new Map<number, string[][]>();
  const tail: string[][] = [];
  let pending: string[][] = [];
  doc.rows.forEach((row, i) => {
    if (!isRecord.has(i)) return void pending.push(row);
    if (pending.length) before.set(Number(getCell(doc, i, col)), pending);
    pending = [];
  });
  tail.push(...pending);
  const byId = new Map(rows.map((r) => [Number(getCell(doc, r, col)), doc.rows[r]]));
  const out: string[][] = [];
  for (let i = 0; i < rows.length; i++) out.push(...(before.get(i) ?? []), byId.get(i)!);
  out.push(...tail);
  const moved = rows.filter((r, i) => getCell(doc, r, col).trim() !== String(i));
  const fixed = { ...doc, rows: out };
  const first = rows.findIndex((r, i) => getCell(doc, r, col).trim() !== String(i));
  return {
    label: `Put ${table}'s rows back in ${col} order (${moved.length} rows move, no ${col} changes)`,
    writes: [
      {
        table,
        path: `${EXCEL}${table}`,
        bytes: serializeTxtTable(fixed),
        summary: [`Rows put back in ${col} order from record ${first} (${moved.length} moved); every ${col} stays the same`],
      },
    ],
  };
}

/**
 * Checks that the game's tables load a map the way Add to game sets it up (the rules at the top of this file). Used by
 * the compatibility check and the tests; `ds1` sizes as DS1 Studio reads them.
 */
export function verifyInGame(tables: { prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc }, mapRel: string, ds1: { width: number; height: number }): TableIssue[] {
  const { prest, levels, types } = tables;
  const out: TableIssue[] = [];
  for (const [t, doc, col] of [
    ['Levels', levels, 'Id'],
    ['LvlPrest', prest, 'Def'],
    ['LvlTypes', types, 'Id'],
  ] as const) {
    const rows = dataRows(doc);
    const bad = rows.findIndex((r, i) => getCell(doc, r, col).trim() !== String(i));
    if (bad >= 0) {
      const fix = recordOrderFix(`${t}.txt`, doc, col);
      out.push({
        severity: 'error',
        title: `${t}.txt: row ${bad} has ${col} ${getCell(doc, rows[bad], col) || '(empty)'}, not ${bad}`,
        detail: `The game reads ${t}.txt by row position (the "Expansion" line and blank lines don't count), so ${col} must count up 0, 1, 2… A row inserted or removed shifts every one after it, so the game uses the wrong row for each of them.${typeof fix === 'string' ? ` ${fix}` : ''}`,
        columns: [{ table: t, col }],
        fix: fix && typeof fix !== 'string' ? fix : undefined,
      });
    }
  }
  // Until the rows are in order, every lookup below would read the wrong row.
  if (out.length) return out;
  const want = normalizePath(mapRel);
  const pRows = dataRows(prest).filter((r) => [1, 2, 3, 4, 5, 6].some((i) => normalizePath(getCell(prest, r, `File${i}`)) === want));
  for (const r of pRows) {
    const label = `Preset ${getCell(prest, r, 'Def')} "${getCell(prest, r, 'Name')}"`;
    for (let i = 1; i <= 6; i++) {
      const f = getCell(prest, r, `File${i}`);
      const p = f && f !== '0' ? tilePathProblem(f) : null;
      if (p) out.push({ severity: 'error', title: `${label}: File${i} path too long`, detail: p, columns: [{ table: 'LvlPrest', col: `File${i}` }] });
    }
    const files = [1, 2, 3, 4, 5, 6].filter((i) => (getCell(prest, r, `File${i}`) || '0') !== '0').length;
    const filesCol = num(getCell(prest, r, 'Files'));
    if (filesCol > files)
      out.push({
        severity: 'error',
        title: `${label}: Files is ${filesCol} but only ${files} File column${files === 1 ? ' is' : 's are'} set`,
        detail: 'The game picks one of the first Files maps at random; an empty one fails to load.',
        columns: [{ table: 'LvlPrest', col: 'Files' }],
        fix: cellFix('LvlPrest.txt', prest, `Set Files to ${files}`, [{ row: r, col: 'Files', value: String(files) }]),
      });
    const levelId = num(getCell(prest, r, 'LevelId'));
    if (!levelId) continue;
    // Every whole-level preset of the game has FillBlanks 1 (fill empty cells); Scan varies (the Monastery has 0).
    const flags = (['FillBlanks'] as const).filter((c) => has(prest, c) && getCell(prest, r, c).trim() !== '1');
    if (flags.length)
      out.push({
        severity: 'warning',
        title: `${label}: ${flags.map((c) => `${c} is ${getCell(prest, r, c).trim() || 'empty'}`).join(', ')}`,
        detail: 'Every preset level of the game has FillBlanks 1 (empty cells of the map are filled in).',
        columns: flags.map((c) => ({ table: 'LvlPrest', col: c })),
        fix: cellFix('LvlPrest.txt', prest, `Set ${flags.join(' and ')} to 1`, flags.map((c) => ({ row: r, col: c, value: '1' }))),
      });
    const lRow = rowOfRecord(levels, levelId);
    if (lRow < 0) {
      // A level with the preset's name is probably the one meant.
      const pName = getCell(prest, r, 'Name').trim().toLowerCase();
      const byName = dataRows(levels).find((x) => [getCell(levels, x, 'Name'), getCell(levels, x, 'LevelName')].some((n) => n.trim().toLowerCase() === pName));
      const id = byName !== undefined ? getCell(levels, byName, 'Id') : null;
      out.push({
        severity: 'error',
        title: `${label} builds level ${levelId}, which Levels.txt doesn't have`,
        detail: `Levels.txt has ${dataRows(levels).length} levels (0-${dataRows(levels).length - 1}).${id !== null ? ` Level ${id} "${getCell(levels, byName!, 'Name')}" has this preset's name.` : ''}`,
        columns: [{ table: 'LvlPrest', col: 'LevelId' }],
        fix: id !== null ? cellFix('LvlPrest.txt', prest, `Point it at level ${id} "${getCell(levels, byName!, 'Name')}"`, [{ row: r, col: 'LevelId', value: id }]) : undefined,
      });
      continue;
    }
    const lName = getCell(levels, lRow, 'Name');
    const drlg = num(getCell(levels, lRow, 'DrlgType'));
    if (drlg !== 2) {
      out.push({
        severity: 'warning',
        title: `${label}: level ${levelId} "${lName}" is built at random (DrlgType ${drlg})`,
        detail: 'Only preset levels (DrlgType 2) load a map from their LvlPrest row; this row is probably not used as a whole level.',
        columns: [{ table: 'Levels', col: 'DrlgType' }],
      });
      continue;
    }
    const first = dataRows(prest).find((x) => num(getCell(prest, x, 'LevelId')) === levelId);
    if (first !== r)
      out.push({
        severity: 'error',
        title: `${label} is ignored: level ${levelId} "${lName}" uses preset ${getCell(prest, first!, 'Def')} "${getCell(prest, first!, 'Name')}"`,
        detail: 'The game builds a preset level from the first LvlPrest row with its LevelId. Point that row at this map, or give this map its own level (Add to game → new level).',
        columns: [{ table: 'LvlPrest', col: 'LevelId' }],
      });
    if (!num(getCell(prest, r, 'SizeX')) || !num(getCell(prest, r, 'SizeY'))) {
      const sizes = ['', '(N)', '(H)'].map((s) => `${num(getCell(levels, lRow, `SizeX${s}`))}×${num(getCell(levels, lRow, `SizeY${s}`))}`);
      const need = `${ds1.width - 1}×${ds1.height - 1}`;
      if (sizes.some((s) => s !== need))
        out.push({
          severity: 'warning',
          title: `Level ${levelId} size ${[...new Set(sizes)].join(' / ')} doesn't match the map (${need})`,
          detail: 'The level size (Levels SizeX/SizeY, per difficulty) is the DS1 size minus one, as in every game preset level. Too small cuts the map off; too big leaves blank space.',
          columns: [{ table: 'Levels', col: 'SizeX' }],
          fix: cellFix(
            'Levels.txt',
            levels,
            `Set the level size to ${need} (all difficulties)`,
            ['', '(N)', '(H)'].flatMap((s) => [
              { row: lRow, col: `SizeX${s}`, value: String(ds1.width - 1) },
              { row: lRow, col: `SizeY${s}`, value: String(ds1.height - 1) },
            ]),
          ),
        });
    }
    const act = num(getCell(levels, lRow, 'Act'));
    if (act !== levelAct(levelId))
      out.push({
        severity: 'warning',
        title: `Level ${levelId} says Act ${act + 1}, but the game treats it as Act ${levelAct(levelId) + 1}`,
        detail: 'The game takes the act from the level number (1-39 Act 1, 40-74 Act 2, 75-102 Act 3, 103-108 Act 4, 109 and up Act 5), not from the Act column.',
        columns: [{ table: 'Levels', col: 'Act' }],
        fix: cellFix('Levels.txt', levels, `Set Act to ${levelAct(levelId)} (Act ${levelAct(levelId) + 1})`, [{ row: lRow, col: 'Act', value: String(levelAct(levelId)) }]),
      });
    const tilesAct = typeAct(types, num(getCell(levels, lRow, 'LevelType')));
    const pal = num(getCell(levels, lRow, 'Pal'));
    if (tilesAct !== null && pal !== tilesAct)
      out.push({
        severity: 'warning',
        title: `Level ${levelId} uses the Act ${pal + 1} palette but its tiles are Act ${tilesAct + 1} tiles`,
        detail: `Pal picks the colours. Tiles drawn for another act show wrong colours (often red or purple). Set Pal to ${tilesAct}, as the game's own Act 5 levels that reuse other acts' tiles do.`,
        columns: [{ table: 'Levels', col: 'Pal' }],
        fix: cellFix('Levels.txt', levels, `Set Pal to ${tilesAct} (Act ${tilesAct + 1} colours)`, [{ row: lRow, col: 'Pal', value: String(tilesAct) }]),
      });
    const quest = getCell(levels, lRow, 'QuestFlag').trim();
    if (quest && quest !== '0')
      out.push({
        severity: 'info',
        title: `Level ${levelId} needs quest flag ${quest} to enter`,
        detail: 'Players can only enter after that quest (a level copied from another one keeps its requirement). Fine if intended.',
        columns: [{ table: 'Levels', col: 'QuestFlag' }],
        fix: cellFix('Levels.txt', levels, 'Remove the quest requirement', [
          { row: lRow, col: 'QuestFlag', value: '' },
          { row: lRow, col: 'QuestFlagEx', value: '' },
        ]),
      });
    for (const c of ['LevelName', 'LevelWarp', 'EntryFile'])
      if (getCell(levels, lRow, c).length > MAX_LEVEL_STRING)
        out.push({ severity: 'warning', title: `Level ${levelId}: ${c} is longer than ${MAX_LEVEL_STRING} characters (the game cuts it)`, columns: [{ table: 'Levels', col: c }] });
    // Overlap with other fixed-position levels of the same act.
    const box = (row: number) => {
      const x = num(getCell(levels, row, 'OffsetX'));
      const y = num(getCell(levels, row, 'OffsetY'));
      const w = Math.max(...['SizeX', 'SizeX(N)', 'SizeX(H)'].map((c) => num(getCell(levels, row, c))));
      const h = Math.max(...['SizeY', 'SizeY(N)', 'SizeY(H)'].map((c) => num(getCell(levels, row, c))));
      return x >= 0 && y >= 0 && !num(getCell(levels, row, 'Depend')) && w > 0 ? { x, y, w, h } : null;
    };
    const me = box(lRow);
    if (me)
      for (const other of dataRows(levels)) {
        const id = num(getCell(levels, other, 'Id'));
        if (other === lRow || levelAct(id) !== levelAct(levelId)) continue;
        const b = box(other);
        if (b && me.x < b.x + b.w && b.x < me.x + me.w && me.y < b.y + b.h && b.y < me.y + me.h) {
          const off = freeOffset(levels, levelAct(levelId));
          out.push({
            severity: 'warning',
            title: `Level ${levelId} overlaps level ${id} "${getCell(levels, other, 'Name')}" in the act's world`,
            detail: 'Levels of one act share one world; OffsetX/OffsetY must keep them apart.',
            columns: [{ table: 'Levels', col: 'OffsetX' }],
            fix: cellFix('Levels.txt', levels, `Move it to a free spot (${off.x}, ${off.y})`, [
              { row: lRow, col: 'OffsetX', value: String(off.x) },
              { row: lRow, col: 'OffsetY', value: String(off.y) },
            ]),
          });
          break;
        }
      }
    // Level type files this preset loads.
    const tRow = rowOfRecord(types, num(getCell(levels, lRow, 'LevelType')));
    const mask = num(getCell(prest, r, 'Dt1Mask')) >>> 0;
    if (tRow >= 0)
      for (let i = 1; i <= 32; i++) {
        const f = getCell(types, tRow, `File ${i}`);
        const p = mask & (1 << (i - 1)) && f && f !== '0' ? tilePathProblem(f) : null;
        if (p) out.push({ severity: 'error', title: `LvlTypes "${getCell(types, tRow, 'Name')}" File ${i} path too long`, detail: p, columns: [{ table: 'LvlTypes', col: `File ${i}` }] });
      }
  }
  return out;
}
