import { describe, expect, it } from 'vitest';
import { decodeCell, withTile, type Ds1 } from '../src/formats/ds1';
import { parseTxtTable, getCell } from '../src/formats/txtTable';
import { MapDocument } from '../src/game/MapDocument';
import { overlapEdits, pasteEdits, type Clipboard } from '../src/game/clipboard';
import { maskFor, mergeMapRows, syncLevelTables, type PackageRow } from '../src/game/levelTables';
import { LayeredFs, LooseSource } from '../src/vfs/vfs';

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const EX = 'data/global/excel/';
const MAP = 'data/global/tiles/Act1/Test/mymap.ds1';
const fileCols = Array.from({ length: 32 }, (_, i) => `File ${i + 1}`);

function tables(opts: { prestMask?: number; typeFiles?: string[]; withPreset?: boolean; extraLevel?: string } = {}) {
  const typeFiles = opts.typeFiles ?? ['Act1/Test/a.dt1', 'Act1/Test/b.dt1'];
  const types = `Name\tId\t${fileCols.join('\t')}\tAct\r\nAct 1 - Test\t1\t${fileCols.map((_, i) => typeFiles[i] ?? '0').join('\t')}\t1\r\n`;
  const levels = `Name\tId\tLevelType\r\nTest Level\t5\t1\r\n${opts.extraLevel ?? ''}`;
  const prest =
    'Name\tDef\tLevelId\tFile1\tFile2\tFile3\tFile4\tFile5\tFile6\tDt1Mask\r\n' +
    (opts.withPreset === false ? '' : `My Map\t10\t5\tAct1/Test/mymap.ds1\t0\t0\t0\t0\t0\t${opts.prestMask ?? 3}\r\n`);
  const files = new Map<string, () => Promise<Uint8Array>>([
    [`${EX}LvlTypes.txt`, async () => enc(types)],
    [`${EX}Levels.txt`, async () => enc(levels)],
    [`${EX}LvlPrest.txt`, async () => enc(prest)],
  ]);
  return new LayeredFs([new LooseSource('test', files)]);
}

const tile = (p: string) => `data/global/tiles/${p}`;

describe('syncLevelTables', () => {
  it('adds a new DT1 to a free LvlTypes slot and turns on its Dt1Mask bit', async () => {
    const fs = tables();
    const writes = await syncLevelTables(fs, MAP, [tile('Act1/Test/a.dt1'), tile('Act1/Test/b.dt1'), tile('Act1/Test/c.dt1')]);
    expect(writes.map((w) => w.table)).toEqual(['LvlTypes.txt', 'LvlPrest.txt']);
    const types = parseTxtTable(writes[0].bytes);
    expect(getCell(types, 0, 'File 3')).toBe('Act1/Test/c.dt1');
    const prest = parseTxtTable(writes[1].bytes);
    expect(getCell(prest, 0, 'Dt1Mask')).toBe('7');
  });

  it('clears the bit of a removed DT1 and changes nothing when already in step', async () => {
    const fs = tables();
    const removed = await syncLevelTables(fs, MAP, [tile('Act1/Test/b.dt1')]);
    expect(removed.map((w) => w.table)).toEqual(['LvlPrest.txt']);
    expect(getCell(parseTxtTable(removed[0].bytes), 0, 'Dt1Mask')).toBe('2');
    expect(await syncLevelTables(fs, MAP, [tile('Act1/Test/a.dt1'), tile('Act1/Test/b.dt1')])).toEqual([]);
  });

  it('refuses maps that are not in LvlPrest.txt', async () => {
    await expect(syncLevelTables(tables({ withPreset: false }), MAP, [tile('Act1/Test/a.dt1')])).rejects.toThrow(/Add to game/);
  });

  it('keeps an already-selected duplicate slot and leaves empty-slot bits alone', () => {
    const types = parseTxtTable(enc(`Name\tId\t${fileCols.join('\t')}\r\nT\t1\t${fileCols.map((_, i) => (i === 0 || i === 3 ? 'x/a.dt1' : '0')).join('\t')}\r\n`));
    // Slot 4 duplicates slot 1 and is the one selected; bit 6 is an empty slot.
    expect(maskFor(types, 0, [tile('x/a.dt1')], (1 << 3) | (1 << 5))).toBe((1 << 3) | (1 << 5));
    expect(maskFor(types, 0, [tile('x/a.dt1')], 0)).toBe(1);
  });
});

describe('mergeMapRows (import)', () => {
  const pkgRows = (levelId: string, typeName: string): PackageRow[] => [
    { table: 'LvlTypes', key: 'Id', columns: ['Name', 'Id', 'File 1'], row: [typeName, '1', 'Act1/Test/z.dt1'] },
    { table: 'Levels', key: 'Id', columns: ['Name', 'Id', 'LevelType'], row: ['Imported Level', levelId, '1'] },
    { table: 'LvlPrest', key: 'Name', columns: ['Name', 'Def', 'LevelId', 'File1', 'Dt1Mask'], row: ['Imported', '10', levelId, 'Act1/Test/new.ds1', '1'] },
  ];

  it('gives clashing ids new ones and computes the mask against the local slots', async () => {
    const fs = tables();
    const { writes, levelIds } = await mergeMapRows(fs, 'data/global/tiles/Act1/Test/new.ds1', pkgRows('5', 'Imported Type'), [tile('Act1/Test/b.dt1'), tile('Act1/Test/z.dt1')]);
    const byTable = Object.fromEntries(writes.map((w) => [w.table, parseTxtTable(w.bytes)]));
    const types = byTable['LvlTypes.txt'];
    expect(getCell(types, 1, 'Name')).toBe('Imported Type');
    expect(getCell(types, 1, 'Id')).toBe('2'); // 1 was taken
    expect(getCell(types, 1, 'File 1')).toBe('Act1/Test/z.dt1');
    expect(getCell(types, 1, 'File 2')).toBe('Act1/Test/b.dt1');
    const levels = byTable['Levels.txt'];
    expect(getCell(levels, 1, 'Id')).toBe('6'); // 5 was taken
    expect(getCell(levels, 1, 'LevelType')).toBe('2');
    expect(levelIds.get('5')).toBe('6');
    const prest = byTable['LvlPrest.txt'];
    expect(getCell(prest, 1, 'Def')).toBe('11');
    expect(getCell(prest, 1, 'LevelId')).toBe('6');
    expect(getCell(prest, 1, 'Dt1Mask')).toBe('3');
  });

  it('reuses same-named rows, so importing again changes nothing', async () => {
    const fs = tables();
    const rows: PackageRow[] = [
      { table: 'LvlTypes', key: 'Id', columns: ['Name', 'Id'], row: ['Act 1 - Test', '1'] },
      { table: 'Levels', key: 'Id', columns: ['Name', 'Id', 'LevelType'], row: ['Test Level', '5', '1'] },
      { table: 'LvlPrest', key: 'Name', columns: ['Name', 'Def', 'LevelId', 'File1', 'Dt1Mask'], row: ['My Map', '10', '5', 'Act1/Test/mymap.ds1', '3'] },
    ];
    const { writes } = await mergeMapRows(fs, MAP, rows, [tile('Act1/Test/a.dt1'), tile('Act1/Test/b.dt1')]);
    expect(writes).toEqual([]);
  });
});

function ds1(w: number, h: number): Ds1 {
  const cells = () => Array.from({ length: w * h }, () => decodeCell(0));
  return {
    version: 18, width: w, height: h, act: 0, actRaw: 0, tagType: 0, files: [],
    walls: [cells().map((c) => ({ ...c, orientation: 0, orientationHigh: 0 }))],
    floors: [cells()], shadows: [cells()], tags: [], objects: [], groups: [], groupsHeader: 0, orphanPaths: [], hasPathSection: true, trailing: 0,
  };
}

describe('overlapEdits (Alt while placing)', () => {
  const tree = { ...withTile(decodeCell(0), 3, 7, 0x81), orientation: 13, orientationHigh: 0 };
  const clip: Clipboard = { width: 1, height: 1, layers: [{ layer: { kind: 'wall', index: 0 }, cells: [tree] }] };

  it('puts a wall into the next free layer instead of replacing', () => {
    const doc = new MapDocument('x.ds1', ds1(2, 2));
    doc.ds1.walls[0][0] = { ...withTile(decodeCell(0), 1, 1, 0x81), orientation: 13, orientationHigh: 0 };
    expect(pasteEdits(doc, clip, 0, 0)[0].layer).toEqual({ kind: 'wall', index: 0 });
    const o = overlapEdits(doc, clip, 0, 0);
    expect(o.edits[0].layer).toEqual({ kind: 'wall', index: 1 });
    expect(o.walls).toBe(2);
    expect(o.replaced).toBe(0);
    // An empty cell stays in its own layer.
    expect(overlapEdits(doc, clip, 1, 1).edits[0].layer).toEqual({ kind: 'wall', index: 0 });
  });

  it('replaces when all four wall layers are taken', () => {
    const d = ds1(1, 1);
    d.walls = [0, 1, 2, 3].map(() => [{ ...withTile(decodeCell(0), 1, 1, 0x81), orientation: 13, orientationHigh: 0 }]);
    const o = overlapEdits(new MapDocument('x.ds1', d), clip, 0, 0);
    expect(o.edits[0].layer).toEqual({ kind: 'wall', index: 0 });
    expect(o.replaced).toBe(1);
  });
});

import { parseTxtTable as ptt } from '../src/formats/txtTable';
import { findRule, parseAutomap, setAutomapCel } from '../src/game/automap';

describe('automap rules', () => {
  const doc = ptt(enc('LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\tType2\tCel2\tType2\tCel3\tType4\tCel4\r\n' +
    '1 Town\tfl\t0\t-1\t-1\tA\t5\tB\t6\t\t-1\t\t-1\r\n1 Town\twl\t2\t0\t3\tW\t9\t\t-1\t\t-1\t\t-1\r\n'));
  it('looks tiles up by code, style and sequence', () => {
    const t = parseAutomap(doc);
    expect(findRule(t, '1 Town', 0, 0, 17)!.cels.map((c) => c.cel)).toEqual([5, 6]);
    expect(findRule(t, '1 Town', 1, 2, 3)!.cels[0].cel).toBe(9);
    expect(findRule(t, '1 Town', 1, 2, 4)).toBeNull();
  });
  it('adds a specific row in front of broader ones, or updates an exact one', () => {
    const a = setAutomapCel(doc, '1 Town', 0, 0, 4, 77, 'seq');
    expect(a.doc.rows[0].slice(0, 7)).toEqual(['1 Town', 'fl', '0', '4', '4', 'DS1 Studio', '77']);
    expect(findRule(parseAutomap(a.doc), '1 Town', 0, 0, 4)!.cels[0].cel).toBe(77);
    expect(findRule(parseAutomap(a.doc), '1 Town', 0, 0, 5)!.cels[0].cel).toBe(5);
    const b = setAutomapCel(doc, '1 Town', 0, 0, 4, 42, 'style');
    expect(b.doc.rows.length).toBe(doc.rows.length);
    expect(findRule(parseAutomap(b.doc), '1 Town', 0, 0, 9)!.cels.map((c) => c.cel)).toEqual([42]);
  });
});

import { automapLevelFor } from '../src/game/automap';

describe('automap level names', () => {
  const t = parseAutomap(ptt(enc('LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\r\n1 Town\tfl\t0\t-1\t-1\tA\t1\r\n5 Ice\tfl\t0\t-1\t-1\tA\t1\r\n47\tfl\t0\t-1\t-1\tA\t1\r\n')));
  it('matches vanilla short names, prefixes and mod level type ids', () => {
    expect(automapLevelFor(t, 'Act 1 - Town')).toBe('1 Town');
    expect(automapLevelFor(t, 'Act 5 - Ice Caves')).toBe('5 Ice');
    expect(automapLevelFor(t, 'Dark Temple', 5, 47)).toBe('47');
  });
});

import { applyAutomapSuggestions, suggestAutomap, type AutomapPiece } from '../src/game/automap';

describe('automap suggestions', () => {
  const doc = ptt(enc('LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\tType2\tCel2\tType2\tCel3\tType4\tCel4\r\n' +
    '1 Town\twl\t0\t0\t3\tW\t21\t\t-1\t\t-1\t\t-1\r\n1 Town\twl\t1\t0\t3\tW\t21\t\t-1\t\t-1\t\t-1\r\n1 Town\twr\t0\t-1\t-1\tR\t20\t\t-1\t\t-1\t\t-1\r\n2 Town\tfl\t0\t-1\t-1\tF\t3\t\t-1\t\t-1\t\t-1\r\n'));
  const t = parseAutomap(doc);
  const piece = (orientation: number, main: number, sub: number, layer: 'floor' | 'wall'): AutomapPiece => ({ cellX: 0, cellY: 0, orientation, main, sub, rule: null, cel: null, layer });
  it("suggests the level's usual piece per code, grouping sequences by style", () => {
    const s = suggestAutomap(t, '1 Town', [piece(1, 5, 2, 'wall'), piece(1, 5, 3, 'wall'), piece(1, 5, 7, 'wall'), piece(0, 9, 0, 'floor')], { floors: true });
    // Act 1 never puts floors on the automap in this table, so none is borrowed from Act 2.
    expect(s).toEqual([{ code: 'wl', orientation: 1, style: 5, seqs: [2, 3, 7], count: 3, cel: 21 }]);
    // A mod's numbered level type has no act: it may use any level's pieces (walls; floors are never guessed blind).
    expect(suggestAutomap(t, '47', [piece(2, 0, 3, 'wall')], { floors: true })).toEqual([{ code: 'wr', orientation: 2, style: 0, seqs: [3], count: 1, cel: 20 }]);
    expect(suggestAutomap(t, '47', [piece(0, 9, 0, 'floor')], { floors: true })).toEqual([]);
    expect(suggestAutomap(t, '1 Town', [piece(0, 9, 0, 'floor')], { floors: false })).toEqual([]);
  });
  it('writes one row per run of sequences, in front of the level', () => {
    const s = suggestAutomap(t, '1 Town', [piece(1, 5, 2, 'wall'), piece(1, 5, 3, 'wall'), piece(1, 5, 7, 'wall')], { floors: false });
    const { doc: out, rows } = applyAutomapSuggestions(doc, '1 Town', s);
    expect(rows).toBe(2);
    expect(out.rows.slice(0, 2).map((r) => r.slice(0, 7))).toEqual([
      ['1 Town', 'wl', '5', '2', '3', 'DS1 Studio', '21'],
      ['1 Town', 'wl', '5', '7', '7', 'DS1 Studio', '21'],
    ]);
    expect(findRule(parseAutomap(out), '1 Town', 1, 5, 7)!.cels[0].cel).toBe(21);
  });
});

import { applyAutomapEdits, effectiveCels } from '../src/game/automap';

describe('automap edits', () => {
  const doc = ptt(enc('LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\tType2\tCel2\tType2\tCel3\tType4\tCel4\r\n' +
    '1 Town\twl\t0\t-1\t-1\tW\t21\t\t-1\t\t-1\t\t-1\r\n'));
  it('writes runs in front of the level, hides with -1 rows, and replaces its own earlier rows', () => {
    const first = applyAutomapEdits(doc, '1 Town', [
      { orientation: 1, style: 3, sub: 0, cels: [5, 6] },
      { orientation: 1, style: 3, sub: 1, cels: [5, 6] },
      { orientation: 1, style: 3, sub: 2, cels: [] },
    ]);
    expect(first.rows).toBe(2);
    expect(first.doc.rows[0].slice(0, 9)).toEqual(['1 Town', 'wl', '3', '0', '1', 'DS1 Studio', '5', 'DS1 Studio', '6']);
    expect(first.doc.rows[1].slice(0, 7)).toEqual(['1 Town', 'wl', '3', '2', '2', 'DS1 Studio (hidden)', '-1']);
    const t = parseAutomap(first.doc);
    expect(findRule(t, '1 Town', 1, 3, 1)!.cels.map((c) => c.cel)).toEqual([5, 6]);
    expect(findRule(t, '1 Town', 1, 3, 2)!.cels).toEqual([]); // hidden: a rule with no pieces
    expect(effectiveCels(t, '1 Town', new Map(), 1, 0, 7)).toEqual([21]); // other styles keep the broad rule
    expect(effectiveCels(t, '1 Town', new Map(), 1, 3, 7)).toBeNull(); // style 3 seq 7: no entry
    // Editing the same sequences again replaces the earlier rows instead of adding more.
    const second = applyAutomapEdits(first.doc, '1 Town', [
      { orientation: 1, style: 3, sub: 0, cels: [9] },
      { orientation: 1, style: 3, sub: 1, cels: [9] },
      { orientation: 1, style: 3, sub: 2, cels: [9] },
    ]);
    expect(second.doc.rows.length).toBe(doc.rows.length + 1);
    expect(findRule(parseAutomap(second.doc), '1 Town', 1, 3, 2)!.cels.map((c) => c.cel)).toEqual([9]);
  });
});

describe('automap suggestions match look-alike tiles', () => {
  // A jungle-like level: its floor rows only cover the river (piece 1); ordinary ground has no row (left off).
  const doc = ptt(enc('LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\tType2\tCel2\tType2\tCel3\tType4\tCel4\r\n' +
    '3 Jungle\tfl\t4\t0\t1\tRiver\t1\t\t-1\t\t-1\t\t-1\r\n3 Jungle\twl\t0\t-1\t-1\tWall\t7\t\t-1\t\t-1\t\t-1\r\n'));
  const t = parseAutomap(doc);
  const piece = (main: number, sub: number): AutomapPiece => ({ cellX: 0, cellY: 0, orientation: 0, main, sub, rule: null, cel: null, layer: 'floor' });
  const blue: [number, number, number] = [30, 60, 200];
  const brown: [number, number, number] = [120, 90, 50];
  // The map's library: river tiles 4/0 and 4/1 (blue), ground tiles 5/0..5/2 (brown, no row), plus the new tiles.
  const looks: Record<string, [number, number, number]> = { '4|0': blue, '4|1': blue, '5|0': brown, '5|1': brown, '5|2': brown, '9|0': blue, '9|1': brown };
  const colors = {
    keys: (o: number) => (o === 0 ? Object.keys(looks).map((k) => k.split('|').map(Number) as [number, number]) : []),
    tile: (_o: number, main: number, sub: number) => looks[`${main}|${sub}`] ?? null,
    cel: () => null,
  };
  it('gives water the river piece and leaves ground off, like the level does', () => {
    const out: { leaveOff?: Set<string> } = {};
    const s = suggestAutomap(t, '3 Jungle', [piece(9, 0), piece(9, 1)], { floors: true, colors }, out);
    expect(s).toEqual([{ code: 'fl', orientation: 0, style: 9, seqs: [0], count: 1, cel: 1 }]);
    expect([...(out.leaveOff ?? [])]).toEqual(['0|9|1']);
  });
  it('never guesses a floor piece without look-alikes (that is how land got the river before)', () => {
    expect(suggestAutomap(t, '3 Jungle', [piece(9, 1)], { floors: true })).toEqual([]);
  });
});
