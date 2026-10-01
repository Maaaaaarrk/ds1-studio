import { describe, expect, it } from 'vitest';
import { getCell, parseTxtTable } from '../src/formats/txtTable';
import { loadLevelTables, planCombine, planFreeSlots, SlotsFullError, syncLevelTables, typeSlotUse } from '../src/game/levelTables';
import { LayeredFs, LooseSource } from '../src/vfs/vfs';

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const EX = 'data/global/excel/';
const MAP = 'data/global/tiles/Act1/Test/mymap.ds1';
const cols = Array.from({ length: 32 }, (_, i) => `File ${i + 1}`);
const lib = (i: number) => `Act1/Test/t${i + 1}.dt1`;
const tile = (p: string) => `data/global/tiles/${p}`;
const bits = (slots: number[]) => slots.reduce((m, s) => m | (1 << (s - 1)), 0) >>> 0;

/**
 * Level type 1 has all 32 slots used. "My Map" (level 1) selects slots 1–10, "Other" (level 2, same type) slots
 * 9–12; slots 13–32 nobody selects. `drlg` is the second level's DrlgType.
 */
function tables(drlg = 2, shared = false) {
  const types = `Name\tId\t${cols.join('\t')}\r\nTest\t1\t${cols.map((_, i) => lib(i)).join('\t')}\r\n`;
  const levels = `Name\tId\tLevelType\tDrlgType\tLevelName\r\nNull\t0\t0\t0\t\r\nMine\t1\t1\t2\tMine\r\nOther\t2\t1\t${drlg}\tOther\r\n`;
  const prest =
    'Name\tDef\tLevelId\tFile1\tFile2\tFile3\tFile4\tFile5\tFile6\tDt1Mask\r\n' +
    `My Map\t10\t1\tAct1/Test/mymap.ds1\t0\t0\t0\t0\t0\t${bits([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])}\r\n` +
    `Other\t11\t2\tAct1/Test/other.ds1\t0\t0\t0\t0\t0\t${bits([9, 10, 11, 12])}\r\n`;
  void shared;
  return new LayeredFs([
    new LooseSource(
      'test',
      new Map([
        [`${EX}LvlTypes.txt`, async () => enc(types)],
        [`${EX}Levels.txt`, async () => enc(levels)],
        [`${EX}LvlPrest.txt`, async () => enc(prest)],
      ]),
    ),
  ]);
}
const mine = Array.from({ length: 10 }, (_, i) => tile(lib(i)));
const slotsOf = (bytes: Uint8Array) => cols.map((c) => getCell(parseTxtTable(bytes), 0, c));

describe('a full level type', () => {
  it('says so with SlotsFullError, and what uses each slot', async () => {
    const fs = tables();
    // Shared with "Other", but "Other" is a level of its own: a new DT1 for this map gets the level a type of its own.
    const own = await syncLevelTables(fs, MAP, [...mine, tile('Act1/Test/new.dt1')]);
    expect(own.map((w) => w.table)).toContain('Levels.txt');
    const use = typeSlotUse(await loadLevelTables(fs), MAP)!;
    expect(use).toMatchObject({ typeId: 1, free: 0, allPreset: true });
    expect(use.slots[0]).toMatchObject({ mine: true, users: [] });
    expect(use.slots[9]).toMatchObject({ mine: true, users: ['Other'] });
    expect(use.slots[20]).toMatchObject({ mine: false, users: [] });
  });

  it('throws SlotsFullError when the type is only this level’s', async () => {
    const fs = tables(2);
    const t = await loadLevelTables(fs);
    // Make "Other" another type so the type is the map's alone.
    const levels = parseTxtTable(enc(`Name\tId\tLevelType\tDrlgType\tLevelName\r\nNull\t0\t0\t0\t\r\nMine\t1\t1\t2\tMine\r\nOther\t2\t2\t2\tOther\r\n`));
    const { syncTablesIn } = await import('../src/game/levelTables');
    expect(() => syncTablesIn({ ...t, levels }, MAP, [...mine, tile('Act1/Test/new.dt1')])).toThrow(SlotsFullError);
  });

  it('frees unused slots without gaps and renumbers every row’s Dt1Mask', async () => {
    const fs = tables();
    const t = await loadLevelTables(fs);
    // Remove slots 13 and 14; then the map gets a new DT1 in the freed space.
    const writes = planFreeSlots(t, MAP, [...mine, tile('Act1/Test/new.dt1')], new Set([13, 14]));
    const types = slotsOf(writes.find((w) => w.table === 'LvlTypes.txt')!.bytes);
    expect(types.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, i) => lib(i)));
    expect(types[12]).toBe(lib(14)); // moved up from File 15
    expect(types.filter((v) => v === '0')).toHaveLength(1);
    expect(types[30]).toBe('Act1/Test/new.dt1');
    const prest = parseTxtTable(writes.find((w) => w.table === 'LvlPrest.txt')!.bytes);
    expect(Number(getCell(prest, 0, 'Dt1Mask'))).toBe(bits([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 31]));
    expect(Number(getCell(prest, 1, 'Dt1Mask'))).toBe(bits([9, 10, 11, 12]));
  });

  it('refuses to free a slot something uses, or a type maze/outdoor levels use', async () => {
    const t = await loadLevelTables(tables());
    expect(() => planFreeSlots(t, MAP, mine, new Set([11]))).toThrow(/still used/);
    const maze = await loadLevelTables(tables(3));
    expect(() => planFreeSlots(maze, MAP, mine, new Set([20]))).toThrow(/maze or outdoor/);
  });

  it('combines DT1s into one, freeing the slots only this map used', async () => {
    const t = await loadLevelTables(tables());
    const combined = tile('Act1/Test/mymap_combined.dt1');
    // t1..t3 are only this map's; t10 is shared with "Other", so its slot stays.
    const plan = planCombine(t, MAP, mine, [mine[0], mine[1], mine[2], mine[9]], combined);
    expect(plan.dt1s).toEqual([combined, ...mine.slice(3, 9)]);
    const types = slotsOf(plan.writes.find((w) => w.table === 'LvlTypes.txt')!.bytes);
    expect(types).not.toContain(lib(0));
    expect(types).toContain(lib(9));
    expect(types).toContain('Act1/Test/mymap_combined.dt1');
    const prest = parseTxtTable(plan.writes.find((w) => w.table === 'LvlPrest.txt')!.bytes);
    const at = (p: string) => types.indexOf(p) + 1;
    expect(Number(getCell(prest, 0, 'Dt1Mask'))).toBe(bits([at('Act1/Test/mymap_combined.dt1'), ...[3, 4, 5, 6, 7, 8].map((i) => at(lib(i)))]));
    // "Other" keeps t10, t11, t12 (renumbered).
    expect(Number(getCell(prest, 1, 'Dt1Mask'))).toBe(bits([9, 10, 11, 12].map((i) => at(lib(i - 1)))));
  });
});
