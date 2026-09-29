import { describe, expect, it } from 'vitest';
import { parseTxtTable } from '../src/formats/txtTable';
import { findMapRecipes, loadMapRecipes, type RecipeTables } from '../src/game/mapRecipes';
import { LayeredFs } from '../src/vfs/vfs';

const table = (text: string) => parseTxtTable(new TextEncoder().encode(text));
function tables(): RecipeTables {
  return {
    prest: table('Name\tLevelId\tFile1\tFile2\nfirst\t193\tGuild\\test.ds1\tguild/variant.ds1\nother\t194\tother/test.ds1\n'),
    levels: table('Id\tDrlgType\n193\t2\n194\t2\n'),
    misc: table('name\tcode\ttype\tpSpell\tlen\nGuild Map\tgm01\tt1m\t12\t193\nOther Map\tom01\tt1m\t12\t194\nKey\tkey\tkey\t0\t0\n'),
    cube: table('description\tenabled\tinput 1\tinput 2\toutput\toutput b\nGuild\t1\t"key,qty=3"\ttbk\t"gm01,nor"\nOther [map:test]\t1\tkey\t\tom01\nDisabled\t0\tkey\t\tgm01\nSecond\t1\tkey\t\tuseitem\tgm01\n'),
  };
}
describe('map recipe lookup', () => {
  it('finds enabled recipes by full path and output item, including secondary outputs', () => {
    const recipes = findMapRecipes(tables(), 'DATA/GLOBAL/TILES/GUILD/TEST.DS1');
    expect(recipes.map((r) => r.description)).toEqual(['Guild', 'Second']);
    expect(recipes[0].inputs[0]).toEqual({ name: 'Key', code: 'key', quantity: 3, modifiers: [] });
    expect(recipes[0].outputs[0]).toEqual({ name: 'Guild Map', code: 'gm01', quantity: 1, modifiers: ['nor'] });
  });
  it('supports alternate preset files and never confuses matching basenames', () => {
    expect(findMapRecipes(tables(), 'guild/variant.ds1')).toHaveLength(2);
    expect(findMapRecipes(tables(), 'other/test.ds1').map((r) => r.description)).toEqual(['Other [map:test]']);
    expect(findMapRecipes(tables(), 'unregistered/test.ds1')).toEqual([]);
  });
  it('does not claim an overridden preset row or a non-map item is an access recipe', () => {
    const t = tables();
    t.prest.rows.unshift(['override', '193', 'guild/replacement.ds1']);
    expect(findMapRecipes(t, 'guild/test.ds1')).toEqual([]);
    t.prest.rows.shift();
    t.misc.rows[0][2] = 'key';
    expect(findMapRecipes(t, 'guild/test.ds1')).toEqual([]);
  });
  it('keeps recipe requirements and quantities instead of silently showing generic ingredients', () => {
    const t = tables();
    t.cube = table('description\tenabled\tinput 1\toutput\tladder\tclass\top\tparam\tvalue\nrestricted\t1\trin,mag,qty=2\tgm01\t1\tama\t18\t12\t3\n');
    const [r] = findMapRecipes(t, 'guild/test.ds1');
    expect(r.inputs[0]).toEqual({ name: 'rin', code: 'rin', quantity: 2, modifiers: ['mag'] });
    expect(r.conditions).toEqual(['Ladder only', 'Class: ama', 'Additional game condition: 18 / 12 / 3']);
  });
  it('reports unavailable tables as a loading error, not as no recipe', async () => {
    await expect(loadMapRecipes(new LayeredFs([]), 'guild/test.ds1')).rejects.toThrow('unavailable');
  });
});
