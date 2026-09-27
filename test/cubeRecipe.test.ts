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
