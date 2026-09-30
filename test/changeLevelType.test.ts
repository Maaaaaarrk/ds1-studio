import { describe, expect, it } from 'vitest';
import { parseDs1 } from '../src/formats/ds1';
import { getCell, parseTxtTable, type TxtTableDoc } from '../src/formats/txtTable';
import { dataRows, ENTRY_IMAGE_DIR, planAddToGame, rowOfRecord, verifyInGame } from '../src/game/addToGame';
import { levelTypeChoices, planChangeLevelType, type ChangeTypePlan } from '../src/game/changeLevelType';
import { GameData } from '../src/game/GameData';
import { LayeredFs, MpqSource, normalizePath } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

type Tables = { prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc; automap?: TxtTableDoc };

describe.runIf(hasD2)('changing a map level’s level type, checked against the vanilla tables', async () => {
  const fs = hasD2 ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))) : null!;
  const load = async (n: string) => parseTxtTable((await fs.read(`data/global/excel/${n}`))!);
  const base: Tables = hasD2 ? { prest: await load('LvlPrest.txt'), levels: await load('Levels.txt'), types: await load('LvlTypes.txt'), automap: await load('AutoMap.txt') } : null!;
  const num = (s: string) => Number(s) || 0;
  const apply = (t: Tables, writes: { table: string; bytes: Uint8Array }[]): Tables => {
    const next = { ...t };
    for (const w of writes) {
      const doc = parseTxtTable(w.bytes);
      if (w.table === 'LvlPrest.txt') next.prest = doc;
      if (w.table === 'Levels.txt') next.levels = doc;
      if (w.table === 'LvlTypes.txt') next.types = doc;
      if (w.table === 'AutoMap.txt') next.automap = doc;
    }
    return next;
  };
  /** The DT1s the game loads for a map: its level's LevelType row, "File N" for every bit of its preset's Dt1Mask. */
  const loadedDt1s = (t: Tables, rel: string) => {
    const r = dataRows(t.prest).find((x) => [1, 2, 3, 4, 5, 6].some((i) => normalizePath(getCell(t.prest, x, `File${i}`)) === normalizePath(rel)))!;
    const lRow = rowOfRecord(t.levels, num(getCell(t.prest, r, 'LevelId')));
    const tRow = rowOfRecord(t.types, num(getCell(t.levels, lRow, 'LevelType')));
    const mask = num(getCell(t.prest, r, 'Dt1Mask')) >>> 0;
    const out: string[] = [];
    for (let i = 1; i <= 32; i++)
      if ((mask >>> (i - 1)) & 1) {
        const f = getCell(t.types, tRow, `File ${i}`);
        expect(f && f !== '0', `mask bit for File ${i} names a file`).toBeTruthy();
        out.push(normalizePath(`data/global/tiles/${f}`));
      }
    return out.sort();
  };
  const errorsOf = (t: Tables, rel: string, ds1: { width: number; height: number }) =>
    verifyInGame(t, rel, ds1 as never, { entryImageExists: (n) => !!fs.locate(normalizePath(`${ENTRY_IMAGE_DIR}${n}.dc6`)) }).filter((i) => i.severity === 'error').map((i) => i.title);
  const rowsEqual = (a: TxtTableDoc, b: TxtTableDoc, except: number[]) => a.rows.every((r, i) => except.includes(i) || r.join('\t') === b.rows[i]?.join('\t'));

  // A map made a level of its own: Old Tristram's town, added as a new level copied from level 38 (Tristram).
  const rel = 'Act1/Tristram/Tri_Town4.ds1';
  const ds1 = hasD2 ? parseDs1((await fs.read(`data/global/tiles/${rel}`))!) : null!;
  const gd = hasD2 ? await GameData.load(fs) : null!;
  const tristType = hasD2 ? gd.lvlType(num(getCell(base.levels, rowOfRecord(base.levels, 38), 'LevelType')))! : null!;
  const used = hasD2 ? GameData.dt1sFor(tristType, num(getCell(base.prest, dataRows(base.prest).find((r) => normalizePath(getCell(base.prest, r, 'File1')) === normalizePath(rel))!, 'Dt1Mask')) >>> 0) : [];
  const added = hasD2 ? (() => {
    const p = planAddToGame(base, { mode: 'new', levelId: 38, name: 'Old Town', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: used, popCount: 0 });
    if (typeof p === 'string') throw new Error(p);
    return { tables: apply(base, p.writes), levelId: p.newLevelId! };
  })() : null!;

  it('refuses levels whose type the game builds from (maze, outdoor) and shared presets', () => {
    const t = base;
    // A level the game doesn't build from one map (maze or outdoor) that still claims a map of its own.
    const otherRow = dataRows(t.prest).find((r) => {
      const id = num(getCell(t.prest, r, 'LevelId'));
      const f = getCell(t.prest, r, 'File1');
      return id > 0 && f && f !== '0' && num(getCell(t.levels, rowOfRecord(t.levels, id), 'DrlgType')) !== 2;
    });
    if (otherRow !== undefined) {
      const other = planChangeLevelType(t, { mapRel: getCell(t.prest, otherRow, 'File1'), levelId: num(getCell(t.prest, otherRow, 'LevelId')), targetTypeId: 1, mode: 'use', usedDt1s: used });
      expect(other, String(other)).toMatch(/maze level|outdoor level|DrlgType|first LvlPrest row/);
    }
    const sharedRow = dataRows(t.prest).find((r) => !num(getCell(t.prest, r, 'LevelId')) && getCell(t.prest, r, 'File1') !== '0')!;
    const shared = planChangeLevelType(t, { mapRel: getCell(t.prest, sharedRow, 'File1'), targetTypeId: 1, mode: 'use', usedDt1s: used });
    expect(shared, String(shared)).toMatch(/shared preset|belongs to/);
    const notIn = planChangeLevelType(t, { mapRel: 'expansion/Map/nothere.ds1', targetTypeId: 1, mode: 'use', usedDt1s: used });
    expect(typeof notIn === 'string' && /not in the game/.test(notIn)).toBe(true);
  });

  it('a type other levels use, lacking the map’s libraries: the level gets a copy with exactly its libraries', () => {
    const t = added.tables;
    const barracks = 7; // Act 1 - Barracks, used by several levels, has none of Tristram's files
    const choices = levelTypeChoices(t, rel, used, added.levelId);
    expect(typeof choices).not.toBe('string');
    expect((choices as { id: number; copyOnly: string | null }[]).find((c) => c.id === barracks)!.copyOnly).toMatch(/other level/);
    const plan = planChangeLevelType(t, { mapRel: rel, levelId: added.levelId, targetTypeId: barracks, mode: 'use', usedDt1s: used, automap: t.automap }) as ChangeTypePlan;
    expect(typeof plan).not.toBe('string');
    expect(plan.copied).toBe(true);
    const next = apply(t, plan.writes);
    const lRow = rowOfRecord(next.levels, added.levelId);
    expect(num(getCell(next.levels, lRow, 'LevelType'))).toBe(plan.typeId);
    expect(plan.typeId).toBe(dataRows(t.types).length); // appended as the next record
    // The game loads exactly the map's tile libraries, from filled slots.
    expect(loadedDt1s(next, rel)).toEqual([...used].map(normalizePath).sort());
    // Nothing else changed: every other level and preset row, and every existing type row.
    expect(rowsEqual(t.levels, next.levels, [lRow])).toBe(true);
    expect(rowsEqual(t.types, next.types, [])).toBe(true);
    expect(errorsOf(next, rel, ds1)).toEqual([]);
    // Vanilla AutoMap.txt only knows the game's 36 types: said, and nothing written there.
    expect(plan.warnings.join(' ')).toMatch(/no automap/);
  });

  it('a type that already has every library: used as it is, with the mask pointing at its slots', () => {
    // First give the level its own copy, then change back to Tristram's type (which has all of its files).
    const first = planChangeLevelType(added.tables, { mapRel: rel, levelId: added.levelId, targetTypeId: tristType.id, mode: 'copy', usedDt1s: used }) as ChangeTypePlan;
    expect(typeof first).not.toBe('string');
    const own = apply(added.tables, first.writes);
    const back = planChangeLevelType(own, { mapRel: rel, levelId: added.levelId, targetTypeId: tristType.id, mode: 'use', usedDt1s: used, automap: own.automap }) as ChangeTypePlan;
    expect(typeof back).not.toBe('string');
    expect(back.copied).toBe(false);
    expect(back.typeId).toBe(tristType.id);
    const next = apply(own, back.writes);
    expect(back.writes.some((w) => w.table === 'LvlTypes.txt')).toBe(false); // the shared type is untouched
    expect(loadedDt1s(next, rel)).toEqual([...used].map(normalizePath).sort());
    expect(errorsOf(next, rel, ds1)).toEqual([]);
    // Choosing the type it already uses is refused.
    expect(planChangeLevelType(next, { mapRel: rel, levelId: added.levelId, targetTypeId: tristType.id, mode: 'use', usedDt1s: used })).toMatch(/already uses/);
  });

  it('a type of another act is allowed (the game’s own Pandemonium and PD2’s map levels do this)', () => {
    const act2Town = 12; // Act 2 - Town
    const plan = planChangeLevelType(added.tables, { mapRel: rel, levelId: added.levelId, targetTypeId: act2Town, mode: 'copy', usedDt1s: used }) as ChangeTypePlan;
    expect(typeof plan).not.toBe('string');
    const next = apply(added.tables, plan.writes);
    const tRow = rowOfRecord(next.types, plan.typeId);
    expect(getCell(next.types, tRow, 'Act')).toBe(getCell(next.types, rowOfRecord(next.types, act2Town), 'Act'));
    expect(loadedDt1s(next, rel)).toEqual([...used].map(normalizePath).sort());
    expect(errorsOf(next, rel, ds1)).toEqual([]);
  });

  it('carries automap rows over under a mod’s level-type numbers (PD2 style)', () => {
    // A PD2-style AutoMap.txt: the Tristram rows under the type's number.
    const auto = base.automap!;
    const tristName = tristType.name;
    const pd2: TxtTableDoc = { ...auto, rows: auto.rows.map((r) => (/^1 Tristram$/i.test((r[0] ?? '').trim()) ? [String(tristType.id), ...r.slice(1)] : r)) };
    const withPd2 = { ...added.tables, automap: pd2 };
    const plan = planChangeLevelType(withPd2, { mapRel: rel, levelId: added.levelId, targetTypeId: tristType.id, mode: 'copy', usedDt1s: used, automap: pd2 }) as ChangeTypePlan;
    expect(typeof plan).not.toBe('string');
    const next = apply(withPd2, plan.writes);
    const count = (d: TxtTableDoc, key: string) => d.rows.filter((r) => (r[0] ?? '').trim() === key).length;
    expect(count(next.automap!, String(plan.typeId))).toBe(count(pd2, String(tristType.id)));
    expect(count(next.automap!, String(plan.typeId))).toBeGreaterThan(0);
    expect(tristName).toBeTruthy();
  });

  it('a preset row with several maps (the town’s variants) keeps every library it loads for the others', () => {
    const townRel = getCell(base.prest, dataRows(base.prest).find((r) => num(getCell(base.prest, r, 'LevelId')) === 1)!, 'File1');
    const townRow = dataRows(base.prest).find((r) => num(getCell(base.prest, r, 'LevelId')) === 1)!;
    expect([2, 3, 4].some((f) => (getCell(base.prest, townRow, `File${f}`) || '0') !== '0')).toBe(true);
    const before = loadedDt1s(base, townRel);
    // The open map uses only some of them.
    const plan = planChangeLevelType(base, { mapRel: townRel, levelId: 1, targetTypeId: 7, mode: 'use', usedDt1s: before.slice(0, 3) }) as ChangeTypePlan;
    expect(typeof plan).not.toBe('string');
    expect(plan.copied).toBe(true);
    expect(plan.warnings.join(' ')).toMatch(/other map/);
    const next = apply(base, plan.writes);
    expect(loadedDt1s(next, townRel)).toEqual(before);
  });
});

