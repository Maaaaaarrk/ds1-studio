import { colIndex, getCell, serializeTxtTable, setCell, type TxtTableDoc } from '../formats/txtTable';
import { setTblStrings, writeTbl, type Tbl } from '../formats/tbl';
import { appendAt } from './addToGame';
import type { TableWrite } from './levelTables';

/**
 * A new item (a copy of a template item, appended to Misc.txt) and a Horadric Cube recipe that makes it.
 *
 * - Items are numbered by their position across Weapons, Armor and Misc (in that order), so a new item is always
 *   appended at the end of Misc.txt; inserting one mid-table renumbers every item after it.
 * - The cube uses the first enabled recipe whose inputs match, so a recipe with the same inputs as an existing one
 *   never runs; such a recipe is refused.
 * - Elixirs are a beta item the retail game never hands out; a copy of one crashed D2Client while drawing its tooltip
 *   (access violation on hover, PD2 1.13c), so they aren't offered as templates.
 * - Items of a type the base game doesn't have (e.g. PD2's maps, type t1m…) are handled by the mod's own code, which
 *   only knows its own item codes: a copy under a new code may do nothing or crash when hovered or used.
 */

const EXCEL = 'data/global/excel/';
/** Marker in the comment columns of rows DS1 Studio adds, so they can be listed and removed later. */
export const DS1_STUDIO_TAG = '(DS1 Studio)';

/** The base game's item types (ItemTypes.txt "Code", 1.13/1.14). */
export const VANILLA_ITEM_TYPES = new Set(
  'shie,tors,gold,bowq,xboq,play,herb,poti,ring,elix,amul,char,boot,glov,book,belt,gem,torc,scro,scep,wand,staf,bow,axe,club,swor,hamm,knif,spea,pole,xbow,mace,helm,tpot,ques,body,key,tkni,taxe,jave,weap,mele,miss,thro,comb,armo,shld,misc,sock,seco,rod,misl,blun,jewl,clas,amaz,barb,necr,pala,sorc,assn,drui,h2h,orb,head,ashd,phlm,pelt,cloa,rune,circ,hpot,mpot,rpot,spot,apot,wpot,scha,mcha,lcha,abow,aspe,ajav,h2h2,mboq,mxbq,gem0,gem1,gem2,gem3,gem4,gema,gemd,geme,gemr,gems,gemt,gemz'.split(','),
);

/** Item types that must not be copied (see above). */
export const BLOCKED_TYPES: Record<string, string> = {
  elix: 'Elixirs are a beta item the retail game never hands out. A copy of one crashed the game when hovered (D2Client access violation while drawing its tooltip). Pick another template.',
};

export type TemplateRisk = { kind: 'blocked' | 'mod-type'; text: string } | null;

export function templateRisk(type: string, type2 = ''): TemplateRisk {
  for (const t of [type, type2].map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (BLOCKED_TYPES[t]) return { kind: 'blocked', text: BLOCKED_TYPES[t] };
  }
  const mod = [type, type2].map((x) => x.trim()).filter((t) => t && !VANILLA_ITEM_TYPES.has(t.toLowerCase()));
  if (mod.length)
    return {
      kind: 'mod-type',
      text: `Its item type (${mod.join(', ')}) isn't one of the base game's: your mod's own code handles it (PD2's map system, for example). That code only knows the mod's own item codes, so a copy under a new code may do nothing, or crash the game when hovered or used. Only go ahead if your mod supports new items of this type.`,
    };
  return null;
}

/** A cube input as the game compares it: lower case, no quotes or spaces, parameters sorted. */
export function normalizeInput(s: string): string {
  const [code, ...params] = s.replace(/"/g, '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return [code, ...params.sort()].join(',');
}

/** An enabled recipe with exactly these inputs (in any order), if any: the cube would use that one instead. */
export function sameRecipe(cube: TxtTableDoc, inputs: string[]): string | null {
  const want = inputs.map(normalizeInput).sort().join('|');
  const inputCols = Array.from({ length: 7 }, (_, i) => `input ${i + 1}`).filter((c) => colIndex(cube, c) >= 0);
  for (let r = 0; r < cube.rows.length; r++) {
    if (getCell(cube, r, 'enabled').trim() !== '1') continue;
    const have = inputCols.map((c) => getCell(cube, r, c)).filter((v) => v.trim()).map(normalizeInput).sort().join('|');
    if (have && have === want) return getCell(cube, r, 'description') || `row ${r + 1}`;
  }
  return null;
}

/**
 * The level a map item opens, when the template is one: a mod item type with a use action (pSpell) whose `len` is a
 * level number. That's how PD2's maps work (pSpell 12, len = the Levels.txt Id: "Halls of Torture Map" len 193 →
 * level 193), including maps modders add themselves.
 */
export function mapItemLevel(misc: TxtTableDoc, row: number, levels: TxtTableDoc | null): number | null {
  const type = getCell(misc, row, 'type').trim().toLowerCase();
  if (!type || VANILLA_ITEM_TYPES.has(type) || !getCell(misc, row, 'pSpell').trim()) return null;
  const len = getCell(misc, row, 'len').trim();
  if (!/^\d+$/.test(len) || !levels) return null;
  const id = Number(len);
  const exists = levels.rows.some((_, r) => getCell(levels, r, 'Id').trim() === len && getCell(levels, r, 'DrlgType').trim() !== '' && getCell(levels, r, 'DrlgType').trim() !== '0');
  return exists ? id : null;
}

/** Where the mod's own strings go (the game reads string.tbl, expansionstring.tbl, then patchstring.tbl). */
export const PATCH_STRINGS = 'data/local/lng/eng/patchstring.tbl';

export interface MapTarget {
  /** Levels.txt Id of the open map's level. */
  levelId: number;
  /** Name shown in game for the level (entering it, the automap); empty = leave the level's names as they are. */
  levelTitle?: string;
}

export interface CubeItemInput {
  /** Row of the template item in Misc.txt. */
  templateRow: number;
  name: string;
  code: string;
  /** Cube inputs as CubeMain writes them (e.g. `tbk`, `gem4,qty=3`). */
  inputs: string[];
  /** Total number of items in the cube (quantities included). */
  numinputs: number;
  /** Text that ties the recipe to the map, for the description. */
  mapName: string;
  /** The user accepted a template of a mod-specific type. */
  acceptModType?: boolean;
  /** For a map-item template: the level the new item opens (the open map's). */
  map?: MapTarget;
}

export interface CubeTables {
  misc: TxtTableDoc;
  cube: TxtTableDoc;
  levels?: TxtTableDoc | null;
  /** The mod's patchstring.tbl (or the game's, to extend). */
  strings?: Tbl | null;
}

export function planCubeItem(tables: CubeTables, input: CubeItemInput): TableWrite[] | string {
  const { misc, cube } = tables;
  const t = input.templateRow;
  const risk = templateRisk(getCell(misc, t, 'type'), getCell(misc, t, 'type2'));
  if (risk?.kind === 'blocked') return risk.text;
  const opens = mapItemLevel(misc, t, tables.levels ?? null);
  if (opens !== null) {
    // A map item: it will open the open map's level, which must be in the game.
    if (!input.map) return 'This map isn’t a level in the game yet, so a map item can’t open it. Use Data → Add to game first, then come back.';
    if (!tables.strings) return 'patchstring.tbl (the mod’s strings) could not be read.';
  } else if (risk?.kind === 'mod-type' && !input.acceptModType) return 'Tick the box under the template to confirm your mod supports new items of its type.';
  if (!input.inputs.length) return 'Add at least one ingredient.';
  if (input.inputs.length > 7) return 'The cube holds at most 7 kinds of ingredient.';
  const clash = sameRecipe(cube, input.inputs);
  if (clash) return `Another recipe already uses exactly these ingredients ("${clash}"). The cube only runs the first one, so this one would never work. Change the ingredients.`;

  // The item: a copy of the template, appended; its own code everywhere the template named itself.
  const tCode = getCell(misc, t, 'code');
  const values = Object.fromEntries(misc.columns.map((c, i) => [c, misc.rows[t][i] ?? ''])) as Record<string, string>;
  values.name = input.name;
  if (colIndex(misc, '*name') >= 0) values['*name'] = `${input.name} ${DS1_STUDIO_TAG}`;
  values.code = input.code;
  for (const c of ['normcode', 'ubercode', 'ultracode']) if (values[c] !== undefined && values[c].trim() === tCode) values[c] = input.code;
  if (values.spawnable !== undefined) values.spawnable = '0'; // never a random drop
  const itemNotes: string[] = [];
  const strings: Record<string, string> = {};
  let levels = tables.levels ?? null;
  const levelNotes: string[] = [];
  if (opens !== null && input.map) {
    // The map item opens the open map's level, and shows its own name.
    values.len = String(input.map.levelId);
    const key = `ds1s_${input.code}`;
    values.namestr = key;
    strings[key] = input.name;
    itemNotes.push(`opens level ${input.map.levelId} (len ${getCell(misc, t, 'len')} → ${input.map.levelId})`, `its name "${input.name}" in ${PATCH_STRINGS.split('/').pop()} (${key})`);
    if (input.map.levelTitle?.trim() && levels) {
      const lr = levels.rows.findIndex((_, r) => getCell(levels!, r, 'Id').trim() === String(input.map!.levelId));
      if (lr >= 0) {
        const lk = `ds1s_lvl_${input.map.levelId}`;
        strings[lk] = input.map.levelTitle.trim();
        for (const col of ['LevelName', 'LevelWarp'])
          if (colIndex(levels, col) >= 0 && getCell(levels, lr, col) !== lk) {
            levelNotes.push(`${col} ${getCell(levels, lr, col) || '(empty)'} → ${lk}`);
            levels = setCell(levels, lr, col, lk);
          }
        levelNotes.push(`shown in game as "${input.map.levelTitle.trim()}"`);
      }
    }
  }
  const m = appendAt(misc, values).doc;

  const recipe: Record<string, string> = {
    description: `${input.name} [map:${input.mapName.toLowerCase()}] ${DS1_STUDIO_TAG}`,
    enabled: '1',
    version: '100',
    numinputs: String(input.numinputs),
    output: input.code,
  };
  // A map item comes out the way the mod's own map recipes make theirs (e.g. PD2: "pwl,nor", lvl 99, ilvl 100).
  if (opens !== null) {
    // Prefer a recipe that makes a map of the template's own type (PD2: a t1m map for a t1m template), else any map.
    const maps = misc.rows.map((_, r) => r).filter((r) => mapItemLevel(misc, r, tables.levels ?? null) !== null);
    const sameType = new Set(maps.filter((r) => getCell(misc, r, 'type') === getCell(misc, t, 'type')).map((r) => getCell(misc, r, 'code')));
    const anyMap = new Set(maps.map((r) => getCell(misc, r, 'code')));
    const makes = (codes: Set<string>) => cube.rows.findIndex((_, r) => getCell(cube, r, 'enabled') === '1' && codes.has(getCell(cube, r, 'output').split(',')[0].trim()));
    const model = makes(sameType) >= 0 ? makes(sameType) : makes(anyMap);
    if (model >= 0) {
      const suffix = getCell(cube, model, 'output').split(',').slice(1).join(',');
      if (suffix) recipe.output = `${input.code},${suffix}`;
      for (const col of ['lvl', 'plvl', 'ilvl']) if (getCell(cube, model, col)) recipe[col] = getCell(cube, model, col);
    }
  }
  input.inputs.forEach((p, i) => (recipe[`input ${i + 1}`] = p.replace(/^"|"$/g, '')));
  for (const k of Object.keys(recipe)) if (colIndex(cube, k) < 0) delete recipe[k];
  const c = appendAt(cube, recipe).doc;
  const writes: TableWrite[] = [
    {
      table: 'Misc.txt',
      path: `${EXCEL}Misc.txt`,
      bytes: serializeTxtTable(m),
      summary: [`New item “${input.name}” (code ${input.code}), a copy of “${getCell(misc, t, 'name')}”, added at the end (never drops at random)`, ...itemNotes],
    },
    { table: 'CubeMain.txt', path: `${EXCEL}CubeMain.txt`, bytes: serializeTxtTable(c), summary: [`New recipe → ${input.name} (output ${recipe.output})`] },
  ];
  if (levels && levelNotes.length) writes.push({ table: 'Levels.txt', path: `${EXCEL}Levels.txt`, bytes: serializeTxtTable(levels), summary: [`Level ${input.map!.levelId}: ${levelNotes.join('; ')}`] });
  if (Object.keys(strings).length && tables.strings)
    writes.push({
      table: 'patchstring.tbl',
      path: PATCH_STRINGS,
      bytes: writeTbl(setTblStrings(tables.strings, strings)),
      summary: Object.entries(strings).map(([k, v]) => `String ${k} = "${v}"`),
    });
  return writes;
}

export interface StudioRecipe {
  row: number;
  description: string;
  output: string;
}

/** Recipes DS1 Studio added (tagged in their description). */
export function studioRecipes(cube: TxtTableDoc): StudioRecipe[] {
  const out: StudioRecipe[] = [];
  for (let r = 0; r < cube.rows.length; r++) {
    const d = getCell(cube, r, 'description');
    if (d.includes(DS1_STUDIO_TAG)) out.push({ row: r, description: d, output: getCell(cube, r, 'output') });
  }
  return out;
}

/** Items DS1 Studio added (tagged in *name). */
export function studioItems(misc: TxtTableDoc): { row: number; name: string; code: string }[] {
  const out: { row: number; name: string; code: string }[] = [];
  for (let r = 0; r < misc.rows.length; r++) if (getCell(misc, r, '*name').includes(DS1_STUDIO_TAG)) out.push({ row: r, name: getCell(misc, r, 'name'), code: getCell(misc, r, 'code') });
  return out;
}

/** Removes rows (recipes or items) by index. Removing items: only when no character holds them. */
export function removeRows(table: 'Misc.txt' | 'CubeMain.txt', doc: TxtTableDoc, rows: number[], label: (r: number) => string): TableWrite {
  const drop = new Set(rows);
  const summary = rows.map((r) => `Removed ${label(r)}`);
  return { table, path: `${EXCEL}${table}`, bytes: serializeTxtTable({ ...doc, rows: doc.rows.filter((_, i) => !drop.has(i)) }), summary };
}

