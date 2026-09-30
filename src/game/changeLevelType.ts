import { getCell, serializeTxtTable, setCell, type TxtTableDoc } from '../formats/txtTable';
import { normalizePath } from '../vfs/vfs';
import { appendAt, appendOwnType, dataRows, levelAct, levelsOfType, rowOfRecord, tilePathProblem, type FieldChange } from './addToGame';
import { automapLevelFor, GAME_AUTOMAP_LEVELS, parseAutomap, readsLevelNumbers } from './automap';
import { ensureTypeSlots, maskOf, presetRowsFor, type TableWrite } from './levelTables';

/**
 * Changing the level type of a map's level (Levels.txt LevelType), with everything the game needs to load it.
 *
 * The rules come from the game's own code (D2MOO, D2Common/src/Drlg):
 * - A preset level (DrlgType 2) is built from the FIRST LvlPrest row whose LevelId is the level. Its rooms load
 *   LvlTypes[level.LevelType]."File N" for every bit N-1 set in that row's Dt1Mask (DrlgRoomTile.cpp), so every set bit
 *   must name a filled slot, and the map's tiles must be in those DT1s.
 * - Maze (1) and outdoor (3) levels pick their generator pieces and filler masks by level-type number (DrlgMaze.cpp,
 *   DrlgOutdoors.cpp): changing their type is not safe, so it is refused.
 * - A level can use a level type of another act: the game's own Pandemonium levels (Act 5) use Act 1 and 2 types, and
 *   PD2's Act 5 map levels use types of every act. A copy keeps the Act of the type it copies.
 * - A type other levels use keeps its tile list for them. Its free slots are only filled when nothing else could load
 *   them: every other level of the type is a preset level whose mask doesn't reach those slots, and no LevelId-0 or
 *   LvlSub row does either. Otherwise the level gets a copy of the type of its own.
 * - Slots are filled from File 1 without gaps (the server's tile preload stops at the first empty slot).
 * - AutoMap.txt rows are matched to the level type: by number in mods that read numbers (PD2), else by the game's own
 *   36 names, so a new type (number 36 and up) has no automap in the unmodded game.
 */

export interface ChangeTypeInput {
  /** The map, relative to data/global/tiles. */
  mapRel: string;
  /** The level, when the map belongs to several (else the only one it belongs to). */
  levelId?: number;
  targetTypeId: number;
  /** 'use': the level uses that type. 'copy': a new type of its own, a copy of it (with just the map's tile libraries). */
  mode: 'use' | 'copy';
  /** Full paths of the DT1s the map's tiles come from. */
  usedDt1s: string[];
  /** Name for a copied type (default: the level's name). */
  copyName?: string;
  /** AutoMap.txt, to carry the automap pieces over (null: not changed). */
  automap?: TxtTableDoc | null;
  /** The automap tile kinds the map uses ("code|style"), to carry over from the old type where the new one has none. */
  automapUsed?: Set<string>;
}

export interface ChangeTypePlan {
  writes: TableWrite[];
  changes: FieldChange[];
  warnings: string[];
  /** The level type the level ends up with. */
  typeId: number;
  levelId: number;
  /** Whether a copy was made (asked for, or needed). */
  copied: boolean;
}

export interface LevelTypeChoice {
  id: number;
  name: string;
  act: number;
  files: number;
  /** Levels using it (other than this one). */
  users: number;
  /** Why it can only be used as a copy (null: it can be used as it is). */
  copyOnly: string | null;
}

const num = (s: string) => Number(s) || 0;
const EXCEL = 'data/global/excel/';
const rel = (p: string) => p.replace(/\\/g, '/').replace(/^\/?data\/global\/tiles\//i, '');

/** The level the map belongs to, or why its type can't be changed here. */
export function mapLevel(tables: { prest: TxtTableDoc; levels: TxtTableDoc }, mapRel: string, wantLevel?: number): { pRow: number; lRow: number; levelId: number; typeId: number } | string {
  const { prest, levels } = tables;
  const rows = presetRowsFor(prest, `data/global/tiles/${mapRel}`);
  if (!rows.length) return 'This map is not in the game yet (no LvlPrest.txt row lists it). Use Game → Add to game first.';
  // A map file can belong to several levels (the same DS1 in several LvlPrest rows): the one asked for, else the only one.
  const ids = [...new Set(rows.map((r) => num(getCell(prest, r, 'LevelId'))))];
  let pRow = rows[0];
  if (wantLevel !== undefined) {
    const r = rows.find((x) => num(getCell(prest, x, 'LevelId')) === wantLevel);
    if (r === undefined) return `No LvlPrest.txt row lists this map for level ${wantLevel}.`;
    pRow = r;
  } else if (ids.length > 1) return `This map belongs to ${ids.length} levels (${ids.join(', ')}): choose which one.`;
  const levelId = num(getCell(prest, pRow, 'LevelId'));
  if (!levelId) return 'This map is a shared preset (LvlPrest LevelId 0): the game places it inside other levels, which use their own level type. Change the level type of those levels instead.';
  const lRow = rowOfRecord(levels, levelId);
  if (lRow < 0) return `Levels.txt has no level ${levelId}.`;
  const drlg = num(getCell(levels, lRow, 'DrlgType'));
  if (drlg !== 2)
    return `Level ${levelId} "${getCell(levels, lRow, 'Name')}" is ${drlg === 1 ? 'a maze level' : drlg === 3 ? 'an outdoor level' : `DrlgType ${drlg}`}: the game picks its building pieces by level-type number, so changing its type is not safe.`;
  const first = dataRows(prest).find((r) => num(getCell(prest, r, 'LevelId')) === levelId);
  if (first !== pRow) return `The game builds level ${levelId} from the first LvlPrest row claiming it (${getCell(prest, first ?? -1, 'Name')}), not from this map.`;
  return { pRow, lRow, levelId, typeId: num(getCell(levels, lRow, 'LevelType')) };
}

/**
 * The tile libraries the level's preset row must load: the open map's, plus, when the row lists several maps (the game
 * picks one of them, like the towns' variants), every library it loads now, which those other maps may need.
 */
function requiredDt1s(tables: { prest: TxtTableDoc; types: TxtTableDoc }, lvl: { pRow: number; typeId: number }, used: string[]): { dt1s: string[]; others: number } {
  const { prest, types } = tables;
  const files = [1, 2, 3, 4, 5, 6].filter((f) => {
    const v = getCell(prest, lvl.pRow, `File${f}`);
    return v && v !== '0';
  }).length;
  const out = new Map(used.map((p) => [normalizePath(p), p]));
  if (files > 1) {
    const tRow = rowOfRecord(types, lvl.typeId);
    const mask = num(getCell(prest, lvl.pRow, 'Dt1Mask')) >>> 0;
    if (tRow >= 0)
      for (let i = 1; i <= 32; i++) {
        const v = getCell(types, tRow, `File ${i}`);
        if ((mask >>> (i - 1)) & 1 && v && v !== '0') {
          const full = `data/global/tiles/${v.split('\\').join('/')}`;
          if (!out.has(normalizePath(full))) out.set(normalizePath(full), full);
        }
      }
  }
  return { dt1s: [...out.values()], others: files - 1 };
}

/** Slots (1-32) of a LvlTypes row that hold a file. */
function filledSlots(types: TxtTableDoc, row: number): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i <= 32; i++) {
    const v = getCell(types, row, `File ${i}`);
    if (v && v !== '0') out.add(i);
  }
  return out;
}

/**
 * Whether filling these slots of a type could make any other level load them: another level of the type that isn't a
 * preset level, a preset level of the type whose mask has one of those bits, or any LevelId-0 / LvlSub row that does.
 */
function slotsReachedByOthers(tables: { prest: TxtTableDoc; levels: TxtTableDoc; lvlSub?: TxtTableDoc | null }, typeId: number, exceptLevel: number, slots: number[]): string | null {
  if (!slots.length) return null;
  const bits = slots.reduce((m, s) => m | (1 << (s - 1)), 0) >>> 0;
  const { prest, levels, lvlSub } = tables;
  for (const lr of levelsOfType(levels, typeId, exceptLevel)) {
    const id = num(getCell(levels, lr, 'Id'));
    if (num(getCell(levels, lr, 'DrlgType')) !== 2) return `level ${id} "${getCell(levels, lr, 'Name')}" uses it and isn't a preset level`;
    for (const r of dataRows(prest))
      if (num(getCell(prest, r, 'LevelId')) === id && ((num(getCell(prest, r, 'Dt1Mask')) >>> 0) & bits)) return `level ${id} "${getCell(levels, lr, 'Name')}" would load the new slots`;
  }
  for (const r of dataRows(prest))
    if (!num(getCell(prest, r, 'LevelId')) && ((num(getCell(prest, r, 'Dt1Mask')) >>> 0) & bits)) return `shared preset "${getCell(prest, r, 'Name')}" would load the new slots wherever it is placed`;
  if (lvlSub) for (const r of dataRows(lvlSub)) if ((num(getCell(lvlSub, r, 'Dt1Mask')) >>> 0) & bits) return `LvlSub "${getCell(lvlSub, r, 'Name')}" would load the new slots`;
  return null;
}

/** The level types the map's level could change to, and which only as a copy. */
export function levelTypeChoices(tables: { prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc; lvlSub?: TxtTableDoc | null }, mapRel: string, usedDt1s: string[], levelId?: number): LevelTypeChoice[] | string {
  const lvl = mapLevel(tables, mapRel, levelId);
  if (typeof lvl === 'string') return lvl;
  const { types, levels } = tables;
  const want = [...new Set(requiredDt1s(tables, lvl, usedDt1s).dt1s.map(normalizePath))];
  return dataRows(types)
    .map((r) => {
      const id = num(getCell(types, r, 'Id'));
      const tAct = num(getCell(types, r, 'Act'));
      const filled = filledSlots(types, r);
      const has = new Set([...filled].map((s) => normalizePath(`data/global/tiles/${getCell(types, r, `File ${s}`)}`)));
      const missing = want.filter((p) => !has.has(p));
      const users = levelsOfType(levels, id, lvl.levelId).length;
      let copyOnly: string | null = null;
      if (missing.length && users) copyOnly = `it lacks ${missing.length} of the map's tile libraries and ${users} other level${users === 1 ? ' uses' : 's use'} it (their tile list stays as it is)`;
      else if (missing.length) {
        const free: number[] = [];
        for (let i = 1; i <= 32 && free.length < missing.length; i++) if (!filled.has(i)) free.push(i);
        if (free.length < missing.length) copyOnly = `no room for ${missing.length} more tile libraries`;
        else {
          const why = slotsReachedByOthers(tables, id, lvl.levelId, free);
          if (why) copyOnly = `it lacks ${missing.length} of the map's tile libraries and ${why}`;
        }
      }
      return { id, name: getCell(types, r, 'Name'), act: tAct, files: filled.size, users, copyOnly };
    })
    .filter((c) => c.name && c.name.toLowerCase() !== 'expansion');
}

/** Everything that changing the level type writes, checked against the rules above; a string says why it can't. */
export function planChangeLevelType(
  tables: { prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc; lvlSub?: TxtTableDoc | null },
  input: ChangeTypeInput,
): ChangeTypePlan | string {
  const lvl = mapLevel(tables, input.mapRel, input.levelId);
  if (typeof lvl === 'string') return lvl;
  const { prest, levels } = tables;
  let types = tables.types;
  const { pRow, lRow, levelId, typeId: oldTypeId } = lvl;
  const levelName = getCell(levels, lRow, 'Name');
  const levelLabel = `Level ${levelId} "${levelName}"`;
  const tRow = rowOfRecord(types, input.targetTypeId);
  if (tRow < 0) return `LvlTypes.txt has no level type ${input.targetTypeId}.`;
  const targetName = getCell(types, tRow, 'Name');
  const required = requiredDt1s(tables, lvl, input.usedDt1s);
  const dt1s = required.dt1s;
  if (!dt1s.length) return 'The map uses no tile libraries.';
  for (const p of dt1s) {
    const issue = tilePathProblem(rel(p));
    if (issue) return issue;
  }
  const choice = (levelTypeChoices({ ...tables, types }, input.mapRel, input.usedDt1s, levelId) as LevelTypeChoice[]).find((c) => c.id === input.targetTypeId);
  if (!choice) return `Level type ${input.targetTypeId} can't be chosen.`;
  const copy = input.mode === 'copy' || !!choice.copyOnly;
  if (!copy && input.targetTypeId === oldTypeId) return `${levelLabel} already uses level type ${oldTypeId} "${targetName}".`;

  const changes: FieldChange[] = [];
  const warnings: string[] = [];
  if (required.others)
    warnings.push(`The preset row "${getCell(prest, pRow, 'Name')}" also builds ${required.others} other map${required.others === 1 ? '' : 's'} (the game picks one): every tile library it loads now stays loaded, so ${required.others === 1 ? 'that map keeps' : 'those maps keep'} their tiles.`);
  if (input.mode === 'use' && choice.copyOnly) warnings.push(`Type ${input.targetTypeId} "${targetName}" can't be used as it is (${choice.copyOnly}), so the level gets a copy of it of its own.`);

  let typeId: number;
  let slots: Map<string, number>;
  let typeRowNow: number;
  if (copy) {
    const name = (input.copyName ?? levelName).trim() || levelName;
    let own;
    try {
      own = appendOwnType(types, tRow, name, dt1s);
    } catch (e) {
      return (e as Error).message;
    }
    types = own.types;
    typeId = own.typeId;
    typeRowNow = own.typeRow;
    slots = own.slots;
    changes.push({ table: 'LvlTypes.txt', row: `Type ${typeId} "${name}"`, column: '(new row)', from: '', to: `copy of ${input.targetTypeId} "${targetName}" (Act, Expansion), appended as record ${typeId}`, why: 'a level type of its own for this level, with just the map’s tile libraries' });
    for (const [p, s] of [...slots].sort((a, b) => a[1] - b[1])) changes.push({ table: 'LvlTypes.txt', row: `Type ${typeId} "${name}"`, column: `File ${s}`, from: '', to: rel(p) });
  } else {
    typeId = input.targetTypeId;
    typeRowNow = tRow;
    const before = types;
    let r;
    try {
      r = ensureTypeSlots(types, tRow, dt1s);
    } catch (e) {
      return (e as Error).message;
    }
    types = r.types;
    slots = r.slots;
    for (const a of r.added) {
      const [col, value] = a.split(' = ');
      changes.push({ table: 'LvlTypes.txt', row: `Type ${typeId} "${targetName}"`, column: col, from: getCell(before, tRow, col) || '0', to: value, why: 'a tile library the map uses' });
    }
  }

  // The level uses the type; its preset loads exactly the map's libraries.
  const newLevels = setCell(levels, lRow, 'LevelType', String(typeId));
  changes.push({ table: 'Levels.txt', row: levelLabel, column: 'LevelType', from: String(oldTypeId), to: String(typeId), why: copy ? 'its own copy of the chosen type' : `type "${targetName}"` });
  const mask = maskOf(new Map(dt1s.map((p) => [normalizePath(p), slots.get(normalizePath(p))!])));
  const oldMask = num(getCell(prest, pRow, 'Dt1Mask')) >>> 0;
  const newPrest = setCell(prest, pRow, 'Dt1Mask', String(mask));
  if (oldMask !== mask) changes.push({ table: 'LvlPrest.txt', row: `Preset ${getCell(prest, pRow, 'Def')} "${getCell(prest, pRow, 'Name')}"`, column: 'Dt1Mask', from: String(oldMask), to: String(mask), why: `File ${[...new Set(slots.values())].sort((a, b) => a - b).join(', ')} of the new type` });

  // Final check: every mask bit names a filled slot holding one of the map's libraries, with no gap before it.
  const filled = filledSlots(types, typeRowNow);
  for (let i = 1; i <= 32; i++) if ((mask >>> (i - 1)) & 1 && !filled.has(i)) return `Internal check failed: Dt1Mask bit for File ${i}, which is empty.`;
  const maxSlot = Math.max(...filled);
  for (let i = 1; i < maxSlot; i++) if (!filled.has(i)) warnings.push(`LvlTypes "${getCell(types, typeRowNow, 'Name')}" has an empty File ${i} before File ${maxSlot}: the game's tile preload stops there (the level still loads its tiles when its rooms are built).`);

  const writes: TableWrite[] = [];
  if (types !== tables.types) writes.push({ table: 'LvlTypes.txt', path: `${EXCEL}LvlTypes.txt`, bytes: serializeTxtTable(types), summary: changes.filter((c) => c.table === 'LvlTypes.txt').map((c) => `${c.row}: ${c.column} → ${c.to}`) });
  writes.push({ table: 'Levels.txt', path: `${EXCEL}Levels.txt`, bytes: serializeTxtTable(newLevels), summary: [`${levelLabel}: LevelType ${oldTypeId} → ${typeId}`] });
  if (oldMask !== mask) writes.push({ table: 'LvlPrest.txt', path: `${EXCEL}LvlPrest.txt`, bytes: serializeTxtTable(newPrest), summary: [`"${getCell(prest, pRow, 'Name')}": Dt1Mask ${oldMask} → ${mask}`] });

  // Automap pieces follow the level type.
  if (input.automap) {
    const t = parseAutomap(input.automap);
    const numbers = readsLevelNumbers(t);
    const oldKey = automapLevelFor(t, getCell(tables.types, rowOfRecord(tables.types, oldTypeId), 'Name'), levelAct(levelId) + 1, oldTypeId);
    const srcKey = automapLevelFor(t, targetName, levelAct(levelId) + 1, input.targetTypeId);
    const newKey = copy ? (numbers ? String(typeId) : typeId < GAME_AUTOMAP_LEVELS.length ? GAME_AUTOMAP_LEVELS[typeId] : null) : srcKey;
    if (!newKey) warnings.push(`AutoMap.txt names level types by the game's 36 names only, so new type ${typeId} has no automap in game (a mod that reads level-type numbers, like PD2, would).`);
    else {
      let doc = input.automap;
      const rowsOf = (key: string | null) => (key ? doc.rows.filter((r) => (r[0] ?? '').trim().toLowerCase() === key.toLowerCase()) : []);
      const has = new Set(rowsOf(newKey).map((r) => `${(r[1] ?? '').trim().toLowerCase()}|${num(r[2] ?? '')}`));
      const added: string[][] = [];
      // A copied type: the chosen type's pieces under the new number.
      if (copy && srcKey) for (const r of rowsOf(srcKey)) added.push([newKey, ...r.slice(1)]);
      for (const r of added) has.add(`${(r[1] ?? '').trim().toLowerCase()}|${num(r[2] ?? '')}`);
      // Tile kinds the map uses that the new type has no piece for: the old type's pieces for them.
      let carried = 0;
      if (oldKey && oldKey.toLowerCase() !== newKey.toLowerCase())
        for (const r of rowsOf(oldKey)) {
          const k = `${(r[1] ?? '').trim().toLowerCase()}|${num(r[2] ?? '')}`;
          if (has.has(k) || (input.automapUsed && !input.automapUsed.has(k))) continue;
          added.push([newKey, ...r.slice(1)]);
          carried++;
        }
      if (added.length) {
        for (const r of added) doc = appendAt(doc, Object.fromEntries(doc.columns.map((c, i) => [c, r[i] ?? '']))).doc;
        writes.push({ table: 'AutoMap.txt', path: `${EXCEL}AutoMap.txt`, bytes: serializeTxtTable(doc), summary: [`${added.length} rows under "${newKey}"`] });
        if (copy && srcKey) changes.push({ table: 'AutoMap.txt', row: `"${newKey}"`, column: '(rows)', from: '', to: `the ${added.length - carried} rows of "${srcKey}"`, why: 'the copied type draws the same automap' });
        if (carried) changes.push({ table: 'AutoMap.txt', row: `"${newKey}"`, column: '(rows)', from: '', to: `${carried} rows from "${oldKey}"`, why: "tile kinds this map uses that the new type had no piece for" });
      }
      if (!copy && !srcKey) warnings.push(`AutoMap.txt has no rows for type ${typeId} "${targetName}": the level shows no automap until pieces are added (Automap editor).`);
    }
  }
  return { writes, changes, warnings, typeId, levelId, copied: copy };
}
