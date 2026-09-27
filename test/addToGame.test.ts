import { describe, expect, it } from 'vitest';
import { parseDs1 } from '../src/formats/ds1';
import { getCell, parseTxtTable, serializeTxtTable, type TxtTableDoc } from '../src/formats/txtTable';
import { dataRows, planAddToGame, rowOfRecord, verifyInGame, type AddToGamePlan } from '../src/game/addToGame';
import { GameData } from '../src/game/GameData';
import { LayeredFs, MpqSource, normalizePath } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('Add to game, checked against the vanilla tables', async () => {
  const fs = hasD2
    ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))))
    : null!;
  const load = async (n: string) => parseTxtTable((await fs.read(`data/global/excel/${n}`))!);
  const tables = hasD2 ? { prest: await load('LvlPrest.txt'), levels: await load('Levels.txt'), types: await load('LvlTypes.txt') } : null!;
  const gd = hasD2 ? await GameData.load(fs) : null!;
  const ds1Of = async (rel: string) => parseDs1((await fs.read(`data/global/tiles/${rel}`))!);
  const num = (s: string) => Number(s) || 0;
  /** The DT1s a map loads in game: its level type's File slots selected by its preset's Dt1Mask. */
  const dt1sOf = (rel: string) => {
    const r = dataRows(tables.prest).find((x) => [1, 2, 3, 4, 5, 6].some((i) => normalizePath(getCell(tables.prest, x, `File${i}`)) === normalizePath(rel)))!;
    const level = rowOfRecord(tables.levels, num(getCell(tables.prest, r, 'LevelId')));
    const type = gd.lvlType(num(getCell(tables.levels, level, 'LevelType')))!;
    return GameData.dt1sFor(type, num(getCell(tables.prest, r, 'Dt1Mask')) >>> 0);
  };
  const apply = (plan: AddToGamePlan) => {
    const next = { ...tables };
    for (const w of plan.writes) {
      const doc = parseTxtTable(w.bytes);
      if (w.table === 'LvlPrest.txt') next.prest = doc;
      if (w.table === 'Levels.txt') next.levels = doc;
      if (w.table === 'LvlTypes.txt') next.types = doc;
    }
    return next;
  };
  const same = (a: TxtTableDoc, b: TxtTableDoc, except: number[]) => a.rows.every((r, i) => except.includes(i) || r.join('\t') === b.rows[i]?.join('\t'));

  it('the rules hold for every preset level of the game (no false alarms)', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const lr of dataRows(tables.levels)) {
      if (getCell(tables.levels, lr, 'DrlgType') !== '2') continue;
      const id = num(getCell(tables.levels, lr, 'Id'));
      const pr = dataRows(tables.prest).find((r) => num(getCell(tables.prest, r, 'LevelId')) === id)!;
      const rel = getCell(tables.prest, pr, 'File1');
      if (!rel || rel === '0') continue; // Lut Gholein picks its map in code
      const ds1 = await ds1Of(rel);
      checked++;
      for (const p of verifyInGame(tables, rel, ds1)) if (p.severity !== 'info') problems.push(`${id} ${rel}: ${p.title}`);
    }
    expect(checked).toBeGreaterThan(30);
    expect(problems).toEqual([]);
  });

  it('catches what the old Add to game wrote (row inserted mid-table, size = DS1 size, Act 1 row in Act 5)', async () => {
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const ds1 = await ds1Of(rel);
    const { cloneRow, setCell, appendRow } = await import('../src/formats/txtTable');
    const tpl = rowOfRecord(tables.levels, 38);
    let levels = cloneRow(tables.levels, tpl);
    levels = setCell(levels, tpl + 1, 'Id', '137');
    levels = setCell(levels, tpl + 1, 'SizeX', String(ds1.width));
    const prest = appendRow(tables.prest, { Name: 'x', Def: String(dataRows(tables.prest).length), LevelId: '137', Files: '1', File1: rel, Dt1Mask: '1' });
    // Inserted after its template: every later level shifts (the game would read record 137 as the old level 136).
    expect(verifyInGame({ ...tables, levels, prest }, rel, ds1).map((p) => p.title).join(' | ')).toMatch(/Levels\.txt: row 39 has Id 137/);
    // Appended correctly but copied as-is: DS1 size and the template's Act 1 values.
    const values = Object.fromEntries(tables.levels.columns.map((c, i) => [c, tables.levels.rows[tpl][i] ?? '']));
    let appended = appendRow(tables.levels, { ...values, Id: '137', SizeX: String(ds1.width), 'SizeX(N)': String(ds1.width), 'SizeX(H)': String(ds1.width) });
    appended = setCell(appended, appended.rows.length - 1, 'Pal', '4');
    const titles = verifyInGame({ ...tables, levels: appended, prest }, rel, ds1).map((p) => p.title).join(' | ');
    expect(titles).toMatch(/size .* doesn't match/);
    expect(titles).toMatch(/says Act 1, but the game treats it as Act 5/);
    expect(titles).toMatch(/Act 5 palette but its tiles are Act 1 tiles/);
    expect(titles).toMatch(/overlaps level 136 "Act 5 - Pandemonium Finale"/);
  });

  it('offers to put a table back in order when a row was inserted mid-table, without changing any Id', async () => {
    const { cloneRow, setCell, appendRow } = await import('../src/formats/txtTable');
    const { recordOrderFix, appendAt } = await import('../src/game/addToGame');
    const tpl = rowOfRecord(tables.levels, 38);
    // What the old Add to game did: a copy of level 38, numbered 137, inserted right after it.
    const broken = setCell(cloneRow(tables.levels, tpl), tpl + 1, 'Id', '137');
    // What it should have done: the same row at the end.
    const values = Object.fromEntries(tables.levels.columns.map((c, i) => [c, tables.levels.rows[tpl][i] ?? '']));
    const right = appendAt(tables.levels, { ...values, Id: '137' }).doc;
    const fix = recordOrderFix('Levels.txt', broken, 'Id');
    if (!fix || typeof fix === 'string') throw new Error(String(fix));
    const fixed = parseTxtTable(fix.writes[0].bytes);
    expect(fixed.rows.map((r) => r.join('\t'))).toEqual(right.rows.map((r) => r.join('\t')));
    expect(dataRows(fixed).every((r, i) => getCell(fixed, r, 'Id') === String(i))).toBe(true);
    expect(fix.label).toMatch(/99 rows move, no Id changes/);
    // The verifier offers it.
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    expect(verifyInGame({ ...tables, levels: broken }, rel, await ds1Of(rel))[0].fix?.label).toBe(fix.label);
    // Duplicated or missing Ids can't be fixed by moving rows: explained instead.
    expect(recordOrderFix('Levels.txt', setCell(tables.levels, rowOfRecord(tables.levels, 5), 'Id', '4'), 'Id')).toMatch(/used twice: 4.*missing: 5/);
    expect(recordOrderFix('Levels.txt', tables.levels, 'Id')).toBeNull();
  });

  it('offers fixes for a wrong level size and a preset pointing at a level that does not exist', async () => {
    const { setCell } = await import('../src/formats/txtTable');
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const ds1 = await ds1Of(rel);
    const L = rowOfRecord(tables.levels, 38);
    const levels = setCell(tables.levels, L, 'SizeX', '44');
    const size = verifyInGame({ ...tables, levels }, rel, ds1).find((i) => /size/.test(i.title))!;
    const fixedLevels = parseTxtTable(size.fix!.writes[0].bytes);
    expect(['', '(N)', '(H)'].map((s) => `${getCell(fixedLevels, L, `SizeX${s}`)}x${getCell(fixedLevels, L, `SizeY${s}`)}`)).toEqual(['43x48', '43x48', '43x48']);
    // A preset named like a level but pointing past the end of Levels.txt.
    const P = dataRows(tables.prest).find((r) => getCell(tables.prest, r, 'LevelId') === '38')!;
    let prest = setCell(tables.prest, P, 'LevelId', '999');
    prest = setCell(prest, P, 'Name', 'Act 1 - Tristram');
    const missing = verifyInGame({ ...tables, prest }, rel, ds1).find((i) => /doesn't have/.test(i.title))!;
    expect(missing.fix?.label).toBe('Point it at level 38 "Act 1 - Tristram"');
    expect(getCell(parseTxtTable(missing.fix!.writes[0].bytes), P, 'LevelId')).toBe('38');
  });

  it('flags AutoMap 1 on a level that is not a town (it crashes the game on entry), with a fix', async () => {
    const { setCell } = await import('../src/formats/txtTable');
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const P = dataRows(tables.prest).find((r) => getCell(tables.prest, r, 'LevelId') === '38')!;
    const issue = verifyInGame({ ...tables, prest: setCell(tables.prest, P, 'AutoMap', '1') }, rel, await ds1Of(rel)).find((i) => /AutoMap/.test(i.title))!;
    expect(issue.severity).toBe('error');
    expect(getCell(parseTxtTable(issue.fix!.writes[0].bytes), P, 'AutoMap')).toBe('0');
    // Towns keep theirs.
    const town = dataRows(tables.prest).find((r) => getCell(tables.prest, r, 'LevelId') === '1')!;
    expect(getCell(tables.prest, town, 'AutoMap')).toBe('1');
  });

  it('a new level: appended as the next record, every field set, and it passes the checks', async () => {
    const rel = 'Expansion/Town/townWest.ds1';
    const ds1 = await ds1Of(rel);
    const levelCount = dataRows(tables.levels).length;
    const prestCount = dataRows(tables.prest).length;
    const plan = planAddToGame(tables, { mode: 'new', levelId: 109, name: 'My Town', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf(rel), popCount: 0 });
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.newLevelId).toBe(levelCount);
    const next = apply(plan);
    // Nothing else moved: every old row is unchanged, the new ones are the next records.
    expect(same(tables.levels, next.levels, [])).toBe(true);
    expect(same(tables.prest, next.prest, [])).toBe(true);
    expect(dataRows(next.levels)).toHaveLength(levelCount + 1);
    expect(dataRows(next.prest)).toHaveLength(prestCount + 1);
    const L = rowOfRecord(next.levels, levelCount);
    const cell = (c: string) => getCell(next.levels, L, c);
    expect(cell('Id')).toBe(String(levelCount));
    expect(cell('Name')).toBe('My Town');
    expect(cell('Act')).toBe('4');
    expect(cell('Pal')).toBe('4');
    expect(cell('DrlgType')).toBe('2');
    expect(cell('LevelType')).toBe(getCell(tables.levels, rowOfRecord(tables.levels, 109), 'LevelType'));
    for (const s of ['', '(N)', '(H)']) expect([cell(`SizeX${s}`), cell(`SizeY${s}`)]).toEqual(['40', '40']);
    expect(cell('Waypoint')).toBe('255');
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => cell(`Vis${i}`))).toEqual(Array(8).fill('0'));
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => cell(`Warp${i}`))).toEqual(Array(8).fill('-1'));
    expect(cell('QuestFlag')).toBe('');
    expect(cell('Depend')).toBe('0');
    expect(Number(cell('Layer'))).toBeGreaterThan(Math.max(...dataRows(tables.levels).map((r) => num(getCell(tables.levels, r, 'Layer')))));
    expect([cell('LevelName'), cell('LevelWarp'), cell('EntryFile')]).toEqual(['My Town', 'My Town', 'My Town']);
    const P = rowOfRecord(next.prest, prestCount);
    const pc = (c: string) => getCell(next.prest, P, c);
    expect([pc('Def'), pc('LevelId'), pc('File1'), pc('Files'), pc('FillBlanks'), pc('Scan'), pc('AutoMap'), pc('SizeX'), pc('SizeY'), pc('Expansion')]).toEqual([
      String(prestCount),
      String(levelCount),
      rel,
      '1',
      '1',
      '1',
      '0',
      '0',
      '0',
      '1',
    ]);
    // Flags come from the template level's preset (Harrogath's).
    const town = dataRows(tables.prest).find((r) => getCell(tables.prest, r, 'LevelId') === '109')!;
    for (const c of ['Populate', 'Logicals', 'Outdoors', 'Animate', 'KillEdge']) expect(pc(c)).toBe(getCell(tables.prest, town, c));
    expect(pc('Dt1Mask')).toBe(getCell(tables.prest, town, 'Dt1Mask'));
    // The game would load it: the checks find nothing.
    expect(verifyInGame(next, rel, ds1).filter((p) => p.severity !== 'info')).toEqual([]);
    // Every change is listed for the dialog.
    expect(plan.changes.some((c) => c.table === 'Levels.txt' && c.column === 'OffsetX')).toBe(true);
  });

  it('a new level with another act\'s tiles keeps their palette (like the game\'s Uber Tristram)', async () => {
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const ds1 = await ds1Of(rel);
    const plan = planAddToGame(tables, { mode: 'new', levelId: 38, name: 'Old Tristram', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf(rel), popCount: 0 });
    if (typeof plan === 'string') throw new Error(plan);
    const next = apply(plan);
    const L = rowOfRecord(next.levels, plan.newLevelId!);
    expect([getCell(next.levels, L, 'Act'), getCell(next.levels, L, 'Pal')]).toEqual(['4', '0']);
    expect(plan.warnings.join(' ')).toMatch(/Act 1 palette/);
    expect(verifyInGame(next, rel, ds1).filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('a new tile library goes into a free LvlTypes slot and the Dt1Mask', async () => {
    const rel = 'Expansion/Town/townWest.ds1';
    const ds1 = await ds1Of(rel);
    const extra = 'data/global/tiles/PD2assets/mine/floor.dt1';
    const plan = planAddToGame(tables, { mode: 'new', levelId: 109, name: 'X', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: [...dt1sOf(rel), extra], popCount: 2 });
    if (typeof plan === 'string') throw new Error(plan);
    const next = apply(plan);
    const T = rowOfRecord(next.types, num(getCell(next.levels, rowOfRecord(next.levels, 109), 'LevelType')));
    const slot = Array.from({ length: 32 }, (_, i) => i + 1).find((i) => getCell(next.types, T, `File ${i}`) === 'PD2assets/mine/floor.dt1')!;
    expect(slot).toBeGreaterThan(0);
    const P = rowOfRecord(next.prest, dataRows(tables.prest).length);
    expect((Number(getCell(next.prest, P, 'Dt1Mask')) >>> 0) & (1 << (slot - 1))).not.toBe(0);
    expect([getCell(next.prest, P, 'Pops'), getCell(next.prest, P, 'PopPad')]).toEqual(['2', '-4']);
    // Only that row of LvlTypes changed.
    expect(same(tables.types, next.types, [T])).toBe(true);
  });

  it('refuses paths the game cannot hold, and random levels for "existing"', async () => {
    const long = 'PD2assets/a-rather-long-folder-name/my_map.ds1';
    expect(planAddToGame(tables, { mode: 'new', levelId: 109, name: 'X', mapRel: long, width: 10, height: 10, usedDt1s: [], popCount: 0 })).toMatch(/at most 41/);
    expect(planAddToGame(tables, { mode: 'existing', levelId: 2, name: 'X', mapRel: 'Act1/Tristram/Tri_Town4.ds1', width: 44, height: 49, usedDt1s: [], popCount: 0 })).toMatch(/built at random/);
  });

  it('an existing preset level: its own (first) preset row points at the map', async () => {
    const rel = 'Expansion/Town/townWest.ds1';
    const ds1 = await ds1Of(rel);
    const plan = planAddToGame(tables, { mode: 'existing', levelId: 38, name: 'Tristram', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf('Act1/Tristram/Tri_Town4.ds1'), popCount: 0 });
    if (typeof plan === 'string') throw new Error(plan);
    const next = apply(plan);
    const first = dataRows(next.prest).find((r) => getCell(next.prest, r, 'LevelId') === '38')!;
    expect([getCell(next.prest, first, 'File1'), getCell(next.prest, first, 'Files')]).toEqual([rel, '1']);
    expect(dataRows(next.prest)).toHaveLength(dataRows(tables.prest).length); // no row added
    expect(plan.warnings.join(' ')).toMatch(/instead of/);
    const L = rowOfRecord(next.levels, 38);
    expect([getCell(next.levels, L, 'SizeX'), getCell(next.levels, L, 'SizeY')]).toEqual(['40', '40']);
    // Unchanged tables serialize to the same bytes.
    expect(serializeTxtTable(tables.types)).toEqual(serializeTxtTable(parseTxtTable(serializeTxtTable(tables.types))));
  });
});
