import { getCell, parseTxtTable, type TxtTableDoc } from '../formats/txtTable';
import { mapItemLevel } from './cubeRecipe';
import { normalizePath, type LayeredFs } from '../vfs/vfs';

export interface RecipeSlot { name: string; code: string; quantity: number; modifiers: string[]; invfile?: string }
export interface MapRecipe {
  row: number;
  description: string;
  inputs: RecipeSlot[];
  outputs: RecipeSlot[];
  conditions: string[];
}
export interface RecipeTables {
  prest: TxtTableDoc;
  levels: TxtTableDoc;
  misc: TxtTableDoc;
  cube: TxtTableDoc;
  weapons?: TxtTableDoc | null;
  armor?: TxtTableDoc | null;
  types?: TxtTableDoc | null;
}

const clean = (s: string) => s.replace(/"/g, '').trim();
const mapKey = (s: string) => normalizePath(clean(s)).replace(/^data\/global\/tiles\//, '');

/** Follow the map's full preset path to its level, then its map items and enabled recipes.
 * Descriptions are not links: matching basenames can belong to entirely different maps.
 */
export function findMapRecipes(t: RecipeTables, mapPath: string): MapRecipe[] {
  const ids = new Set<number>();
  const claimed = new Set<number>();
  t.prest.rows.forEach((_, r) => {
    const id = Number(getCell(t.prest, r, 'LevelId'));
    if (!id || claimed.has(id)) return;
    claimed.add(id);
    if ([1, 2, 3, 4, 5, 6].some((i) => mapKey(getCell(t.prest, r, `File${i}`)) === mapKey(mapPath))) ids.add(id);
  });
  const codes = new Set<string>();
  t.misc.rows.forEach((_, r) => {
    const id = mapItemLevel(t.misc, r, t.levels);
    if (id !== null && ids.has(id)) codes.add(clean(getCell(t.misc, r, 'code')).toLowerCase());
  });
  const names = new Map<string, string>();
  const icons = new Map<string, string>();
  for (const doc of [t.types, t.weapons, t.armor, t.misc]) {
    doc?.rows.forEach((_, r) => {
      const code = clean(getCell(doc, r, 'code')).toLowerCase();
      const name = clean(getCell(doc, r, 'name') || getCell(doc, r, 'ItemType'));
      if (code && name) names.set(code, name);
      const invfile = clean(getCell(doc, r, 'invfile'));
      if (code && invfile) icons.set(code, invfile);
    });
  }
  const slot = (raw: string): RecipeSlot => {
    const [code, ...params] = clean(raw).split(',').map((s) => s.trim());
    const qty = params.find((p) => /^qty=\d+$/i.test(p));
    const invfile = icons.get(code.toLowerCase());
    return { code, name: names.get(code.toLowerCase()) ?? code, quantity: qty ? Number(qty.slice(4)) : 1, modifiers: params.filter((p) => p && p !== qty), ...(invfile ? { invfile } : {}) };
  };
  const recipes: MapRecipe[] = [];
  t.cube.rows.forEach((_, r) => {
    if (getCell(t.cube, r, 'enabled').trim() !== '1') return;
    const outputs = ['output', 'output b', 'output c'].map((c) => getCell(t.cube, r, c)).filter((s) => clean(s)).map(slot);
    if (!outputs.some((s) => codes.has(s.code.toLowerCase()))) return;
    const conditions: string[] = [];
    const difficulty = getCell(t.cube, r, 'diff').trim();
    if (difficulty) conditions.push(`Difficulty: ${['Normal', 'Nightmare', 'Hell'][Number(difficulty)] ?? difficulty}`);
    if (getCell(t.cube, r, 'ladder').trim() === '1') conditions.push('Ladder only');
    if (getCell(t.cube, r, 'class').trim()) conditions.push(`Class: ${getCell(t.cube, r, 'class')}`);
    if (Number(getCell(t.cube, r, 'op'))) conditions.push(`Additional game condition: ${getCell(t.cube, r, 'op')} / ${getCell(t.cube, r, 'param')} / ${getCell(t.cube, r, 'value')}`);
    recipes.push({ row: r, description: getCell(t.cube, r, 'description') || `Recipe ${r + 1}`, inputs: [1, 2, 3, 4, 5, 6, 7].map((i) => getCell(t.cube, r, `input ${i}`)).filter((s) => clean(s)).map(slot), outputs, conditions });
  });
  return recipes;
}

export async function loadMapRecipes(fs: LayeredFs, mapPath: string): Promise<MapRecipe[]> {
  const load = async (name: string, required = true) => {
    const bytes = await fs.read(`data/global/excel/${name}.txt`);
    if (!bytes && required) throw new Error(`${name}.txt is unavailable. Check your game and mod folders.`);
    return bytes ? parseTxtTable(bytes) : null;
  };
  const [prest, levels, misc, cube, weapons, armor, types] = await Promise.all([
    load('LvlPrest'), load('Levels'), load('Misc'), load('CubeMain'), load('Weapons', false), load('Armor', false), load('ItemTypes', false),
  ]);
  return findMapRecipes({ prest: prest!, levels: levels!, misc: misc!, cube: cube!, weapons, armor, types }, mapPath);
}
