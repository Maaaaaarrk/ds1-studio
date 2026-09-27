import { describe, expect, it } from 'vitest';
import { getCell, parseTxtTable, setCell } from '../src/formats/txtTable';
import { planCubeItem, removeRows, sameRecipe, studioItems, studioRecipes, templateRisk } from '../src/game/cubeRecipe';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('cube recipe items, against the vanilla tables', async () => {
  const fs = hasD2
    ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))))
    : null!;
  const load = async (n: string) => parseTxtTable((await fs.read(`data/global/excel/${n}`))!);
  const misc = hasD2 ? await load('Misc.txt') : null!;
  const cube = hasD2 ? await load('CubeMain.txt') : null!;
  const rowOf = (code: string) => misc.rows.findIndex((_, r) => getCell(misc, r, 'code') === code);
  const records = (d: typeof misc) => d.rows.filter((r) => r.some((c) => c.trim())).length;

  it('appends the item and the recipe at the end, leaving every other row where it was', () => {
    const plan = planCubeItem({ misc, cube }, { templateRow: rowOf('key'), name: 'Guild Key', code: 'gk01', inputs: ['key', 'isc', 'hp1'], numinputs: 3, mapName: 'guild3' });
    if (typeof plan === 'string') throw new Error(plan);
    const m = parseTxtTable(plan[0].bytes);
    const c = parseTxtTable(plan[1].bytes);
    expect(records(m)).toBe(records(misc) + 1);
    expect(records(c)).toBe(records(cube) + 1);
    // Every existing row is unchanged and in place.
    for (let r = 0; r < misc.rows.length; r++) if (misc.rows[r].some((x) => x.trim())) expect(m.rows[r]).toEqual(misc.rows[r]);
    for (let r = 0; r < cube.rows.length; r++) if (cube.rows[r].some((x) => x.trim())) expect(c.rows[r]).toEqual(cube.rows[r]);
    const n = m.rows.findIndex((_, r) => getCell(m, r, 'code') === 'gk01');
    expect(n).toBeGreaterThan(misc.rows.filter((r) => r.some((x) => x.trim())).length - 1);
    expect(getCell(m, n, 'name')).toBe('Guild Key');
    expect(getCell(m, n, 'spawnable')).toBe('0');
    expect(getCell(m, n, 'normcode')).not.toBe('key'); // its own code, not the template's
    expect(getCell(m, n, 'type')).toBe('key');
    const cr = c.rows.findIndex((_, r) => getCell(c, r, 'output') === 'gk01');
    expect([getCell(c, cr, 'input 1'), getCell(c, cr, 'input 2'), getCell(c, cr, 'input 3'), getCell(c, cr, 'numinputs'), getCell(c, cr, 'enabled')]).toEqual(['key', 'isc', 'hp1', '3', '1']);
    // Tagged, so the dialog can list and remove it.
    expect(studioItems(m).map((i) => i.code)).toEqual(['gk01']);
    expect(studioRecipes(c).map((r) => r.output)).toEqual(['gk01']);
    const back = parseTxtTable(removeRows('CubeMain.txt', c, [cr], () => 'x').bytes);
    expect(back.rows.filter((r) => r.some((x) => x.trim()))).toEqual(cube.rows.filter((r) => r.some((x) => x.trim())));
  });

  it('refuses a recipe the cube would never run (same ingredients as an existing one, any order)', () => {
    const r = cube.rows.findIndex((_, i) => getCell(cube, i, 'enabled') === '1' && getCell(cube, i, 'input 2'));
    const inputs = ['input 2', 'input 1', 'input 3', 'input 4'].map((c) => getCell(cube, r, c)).filter(Boolean);
    expect(sameRecipe(cube, inputs)).toBe(getCell(cube, r, 'description'));
    const plan = planCubeItem({ misc, cube }, { templateRow: rowOf('key'), name: 'X', code: 'gk02', inputs, numinputs: inputs.length, mapName: 'x' });
    expect(plan).toMatch(/already uses exactly these ingredients/);
  });

  it('a map item opens the open map\'s level: len, its own name string, the level\'s name, the mod\'s map-recipe style', async () => {
    const { appendRow } = await import('../src/formats/txtTable');
    const { parseTbl, tblLookup } = await import('../src/formats/tbl');
    const { mapItemLevel, PATCH_STRINGS } = await import('../src/game/cubeRecipe');
    const levels = await load('Levels.txt');
    const strings = parseTbl((await fs.read(PATCH_STRINGS))!);
    // A PD2-style map item: a mod type, pSpell 12, len = the level it opens (38, Tristram) — and a recipe making it.
    let m = setCell(misc, rowOf('key'), 'type', 't1m');
    m = setCell(m, rowOf('key'), 'pSpell', '12');
    m = setCell(m, rowOf('key'), 'len', '38');
    const c0 = appendRow(cube, { description: 'ID scroll -> Tristram Map', enabled: '1', version: '100', numinputs: '1', 'input 1': 'isc,qty=1', output: 'key,nor', lvl: '99', ilvl: '100' });
    expect(mapItemLevel(m, rowOf('key'), levels)).toBe(38);
    const plan = planCubeItem(
      { misc: m, cube: c0, levels, strings },
      { templateRow: rowOf('key'), name: 'Guild Hall Map', code: 'gh01', inputs: ['tbk', 'hp1'], numinputs: 2, mapName: 'guild3', map: { levelId: 25, levelTitle: 'Guild Hall' } },
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.map((w) => w.table)).toEqual(['Misc.txt', 'CubeMain.txt', 'Levels.txt', 'patchstring.tbl']);
    const mm = parseTxtTable(plan[0].bytes);
    const n = mm.rows.findIndex((_, r) => getCell(mm, r, 'code') === 'gh01');
    expect([getCell(mm, n, 'len'), getCell(mm, n, 'pSpell'), getCell(mm, n, 'type'), getCell(mm, n, 'namestr')]).toEqual(['25', '12', 't1m', 'ds1s_gh01']);
    const cc = parseTxtTable(plan[1].bytes);
    const r = cc.rows.findIndex((_, i) => getCell(cc, i, 'output').startsWith('gh01'));
    expect([getCell(cc, r, 'output'), getCell(cc, r, 'lvl'), getCell(cc, r, 'ilvl')]).toEqual(['gh01,nor', '99', '100']);
    const ll = parseTxtTable(plan[2].bytes);
    const lr = ll.rows.findIndex((_, i) => getCell(ll, i, 'Id') === '25');
    expect([getCell(ll, lr, 'LevelName'), getCell(ll, lr, 'LevelWarp')]).toEqual(['ds1s_lvl_25', 'ds1s_lvl_25']);
    expect(tblLookup(plan[3].bytes, 'ds1s_gh01')).toBe('Guild Hall Map');
    expect(tblLookup(plan[3].bytes, 'ds1s_lvl_25')).toBe('Guild Hall');
    // Without the map being a level, it asks for Add to game first.
    expect(planCubeItem({ misc: m, cube: c0, levels, strings }, { templateRow: rowOf('key'), name: 'X', code: 'gh02', inputs: ['tbk', 'hp2'], numinputs: 2, mapName: 'x' })).toMatch(/Add to game first/);
  });

  it('never copies an elixir, and asks before copying a mod-specific item type', () => {
    expect(templateRisk('elix')?.kind).toBe('blocked');
    expect(planCubeItem({ misc, cube }, { templateRow: rowOf('elx'), name: 'X', code: 'gk03', inputs: ['key', 'hp2'], numinputs: 2, mapName: 'x' })).toMatch(/Elixirs/);
    expect(templateRisk('t1m')?.kind).toBe('mod-type');
    expect(templateRisk('key')).toBeNull();
    const modded = setCell(misc, rowOf('key'), 'type', 't1m');
    expect(planCubeItem({ misc: modded, cube }, { templateRow: rowOf('key'), name: 'X', code: 'gk04', inputs: ['key', 'hp3'], numinputs: 2, mapName: 'x' })).toMatch(/Tick the box/);
    expect(typeof planCubeItem({ misc: modded, cube }, { templateRow: rowOf('key'), name: 'X', code: 'gk04', inputs: ['key', 'hp3'], numinputs: 2, mapName: 'x', acceptModType: true })).not.toBe('string');
  });
});
