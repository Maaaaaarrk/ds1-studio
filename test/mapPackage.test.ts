import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { GameData } from '../src/game/GameData';
import {
  MANIFEST_NAME,
  addTxtRow,
  buildMapPackage,
  collectMapTxtRows,
  isUnsafePath,
  mergeTxtRow,
  missingTablesWarning,
  planImport,
  readMapPackage,
  recipeSuggestion,
  tableCoverage,
  type PackageManifest,
} from '../src/game/mapPackage';
import { openMap } from '../src/game/openMap';
import { parseTxt } from '../src/formats/txt';
import { LayeredFs, LooseSource, MpqSource, normalizePath, type FileSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, MOD_DATA, hasD2, hasMod, walk } from '../tools/testdata';

const MAP = 'data/global/tiles/ACT1/Town/townN1.ds1';
const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const dec = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('mergeTxtRow (synthetic)', () => {
  const table = enc('Name\tId\tVal\r\nfoo\t1\ta\r\nbar\t2\tb\r\n\r\n');

  it('appends before trailing blank lines, keeps CRLF, ignores unknown columns', () => {
    const r = mergeTxtRow(table, ['Val', 'Name', 'Extra'], ['c', 'baz', 'zzz'], 'Name');
    expect(r.action).toBe('appended');
    expect(dec(r.bytes)).toBe('Name\tId\tVal\r\nfoo\t1\ta\r\nbar\t2\tb\r\nbaz\t\tc\r\n\r\n');
  });

  it('replaces by key and keeps cells for columns the row lacks', () => {
    const r = mergeTxtRow(table, ['Id', 'Val'], ['2', 'B'], 'Id');
    expect(r.action).toBe('replaced');
    expect(dec(r.bytes)).toBe('Name\tId\tVal\r\nfoo\t1\ta\r\nbar\t2\tB\r\n\r\n');
  });

  it('handles LF files without a final newline', () => {
    const r = mergeTxtRow(enc('A\tB\nx\t1'), ['A', 'B'], ['y', '2'], 'A');
    expect(dec(r.bytes)).toBe('A\tB\nx\t1\ny\t2');
  });

  it('rejects missing key column and tabs in values', () => {
    expect(() => mergeTxtRow(table, ['Val'], ['q'], 'Name')).toThrow();
    expect(() => mergeTxtRow(table, ['Name', 'Val'], ['q', 'a\tb'], 'Name')).toThrow();
  });
});

describe('AutoMap rows and the tables a map needs (synthetic)', () => {
  const automap = enc('LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tCel1\r\n1 Town\tfl\t0\t-1\t-1\t1\r\n');
  const cols = ['LevelName', 'TileName', 'Style', 'StartSequence', 'EndSequence', 'Cel1'];

  it('adds an AutoMap row unless the same one is there (a level type has many rows, no key of its own)', () => {
    expect(addTxtRow(automap, cols, ['1 Town', 'fl', '0', '-1', '-1', '1']).action).toBe('unchanged');
    const added = addTxtRow(automap, cols, ['Guild', 'wl', '3', '0', '9', '81']);
    expect(added.action).toBe('appended');
    expect(dec(added.bytes)).toBe(dec(automap) + 'Guild\twl\t3\t0\t9\t81\r\n');
    // Columns the package doesn't have stay empty; ones the table doesn't have are ignored.
    expect(dec(addTxtRow(automap, ['LevelName', 'TileName', 'Extra'], ['Guild', 'co', 'x']).bytes).split('\r\n')[2]).toBe('Guild\tco\t\t\t\t');
  });

  it("says which tables a map comes without, and warns that the importer's own may not match", () => {
    const row = (table: string) => ({ table, key: 'Name', columns: ['Name'], row: ['x'] });
    const cov = tableCoverage([row('LvlPrest'), row('Levels'), row('Levels'), row('LvlTypes'), row('data/global/excel/AutoMap.txt')]);
    expect(cov.map((c) => [c.table, c.rows])).toEqual([['LvlPrest', 1], ['Levels', 2], ['LvlTypes', 1], ['CubeMain', 0], ['AutoMap', 1]]);
    // No cube recipe isn't a risk: the import makes a new one for the importer's tables.
    expect(missingTablesWarning(cov)).toBe('');
    const noAutomap = tableCoverage(['LvlPrest', 'Levels', 'LvlTypes'].map(row));
    expect(missingTablesWarning(noAutomap)).toMatch(/^No AutoMap rows came with this map, so your own table is used as it is\..*can crash/);
    expect(missingTablesWarning(tableCoverage([]))).toMatch(/^No LvlPrest, Levels, LvlTypes, AutoMap rows came/);
  });

  it("takes the package's cube recipe as a suggestion (its ingredients and item name) instead of merging it", async () => {
    const cube = { table: 'CubeMain', key: 'description', columns: ['description', 'input 1', 'input 2', 'input 3', 'output'], row: ['guild3 Map [map:guild3] (DS1 Studio)', 'tbk', '"gem4,qty=3"', '', '"gu01,nor"'] };
    const misc = { table: 'Misc', key: 'code', columns: ['name', 'code', 'len'], row: ['guild3 Map', 'gu01', '212'] };
    expect(recipeSuggestion([cube, misc])).toEqual({ inputs: ['tbk', 'gem4,qty=3'], itemName: 'guild3 Map' });
    expect(recipeSuggestion([misc])).toBeNull();
    // Importing leaves CubeMain.txt and Misc.txt alone (their codes and level numbers are the maker's).
    const tables = new Map([
      ['data/global/excel/CubeMain.txt', async () => enc('description\tinput 1\toutput\r\nold\tx\ty\r\n')],
      ['data/global/excel/Misc.txt', async () => enc('name\tcode\tlen\r\nsomething\tgu01\t7\r\n')],
    ]);
    const pkg = { manifest: { format: 'ds1studio-package', version: 1, created: '', map: 'data/global/tiles/x.ds1', files: [], txtRows: [cube, misc] } as unknown as PackageManifest, files: [] };
    const plan = await planImport(pkg, new LayeredFs([new LooseSource('mod', tables)]));
    expect(plan.txtWrites).toEqual([]);
    expect(plan.txtMerges).toEqual([]);
    expect(plan.recipe).toEqual({ inputs: ['tbk', 'gem4,qty=3'], itemName: 'guild3 Map' });
  });
});

describe('readMapPackage validation', () => {
  const manifest: PackageManifest = {
    format: 'ds1studio-package',
    version: 1,
    created: new Date(0).toISOString(),
    map: 'data/global/tiles/x.ds1',
    files: [{ path: 'data/global/tiles/x.ds1', size: 3, from: 'mod' }],
    txtRows: [],
  };
  const good = { [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), 'data/global/tiles/x.ds1': new Uint8Array(3) };

  it('accepts a well-formed package', () => {
    expect(readMapPackage(zipSync(good)).files.map((f) => f.path)).toEqual(['data/global/tiles/x.ds1']);
  });

  it.each(['../evil.txt', 'data/../../evil.txt', '/etc/passwd', 'C:/Windows/evil.dll', 'data\\..\\evil.txt'])('rejects zip entry %s', (bad) => {
    expect(() => readMapPackage(zipSync({ ...good, [bad]: new Uint8Array(1) }))).toThrow(/unsafe/);
  });

  it('rejects traversal inside the manifest', () => {
    const m = { ...manifest, files: [...manifest.files, { path: '../x.dt1', size: 1, from: 'mod', omitted: true }] };
    expect(() => readMapPackage(zipSync({ ...good, [MANIFEST_NAME]: strToU8(JSON.stringify(m)) }))).toThrow(/unsafe/);
    const m2 = { ...manifest, map: '../x.ds1' };
    expect(() => readMapPackage(zipSync({ ...good, [MANIFEST_NAME]: strToU8(JSON.stringify(m2)) }))).toThrow();
  });

  it('rejects bad manifests', () => {
    expect(() => readMapPackage(zipSync({ 'data/global/tiles/x.ds1': new Uint8Array(3) }))).toThrow(/no ds1studio/);
    const wrong = { ...manifest, format: 'other' };
    expect(() => readMapPackage(zipSync({ ...good, [MANIFEST_NAME]: strToU8(JSON.stringify(wrong)) }))).toThrow(/format/);
    const listedMissing = { ...manifest, files: [...manifest.files, { path: 'data/a.dt1', size: 1, from: 'mod' }] };
    expect(() => readMapPackage(zipSync({ ...good, [MANIFEST_NAME]: strToU8(JSON.stringify(listedMissing)) }))).toThrow(/not in the zip/);
  });

  it('isUnsafePath', () => {
    expect(isUnsafePath('data/global/tiles/a.dt1')).toBe(false);
    expect(isUnsafePath('data/..foo/a.dt1')).toBe(false);
    expect(isUnsafePath('')).toBe(true);
    expect(isUnsafePath('\\\\server\\share')).toBe(true);
  });
});

describe.runIf(hasD2)('map packages over the real game data', async () => {
  const mpqs: FileSource[] = hasD2
    ? await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq', 'd2char.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))
    : [];
  const mod: FileSource[] = [];
  if (hasD2 && hasMod) {
    const files = new Map<string, () => Promise<Uint8Array>>();
    for (const ext of ['.ds1', '.dt1', '.txt', '.cof', '.dcc', '.dc6']) {
      for (const abs of walk(MOD_DATA, ext)) {
        const rel = `data/${relative(MOD_DATA, abs).replace(/\\/g, '/')}`;
        files.set(rel, async () => new Uint8Array(readFileSync(abs)));
      }
    }
    mod.push(new LooseSource('ProjectD2/data', files));
  }
  const fs = new LayeredFs([...mod, ...mpqs]);
  const vanilla = new LayeredFs(mpqs);

  for (const [name, layered] of [
    ['vanilla', vanilla],
    ['vanilla + mod folder', fs],
  ] as const) {
    it(`${name}: packages ${MAP} with its DT1s and round-trips`, async () => {
      if (name !== 'vanilla' && !hasMod) return;
      const gd = await GameData.load(layered);
      const map = await openMap(gd, MAP);
      const dt1Paths = map.resolution.paths;
      expect(dt1Paths.length).toBeGreaterThan(0);
      const ds1Bytes = (await layered.read(MAP))!;
      const txtRows = await collectMapTxtRows(layered, MAP);
      expect(txtRows.map((r) => r.table)).toEqual(expect.arrayContaining(['LvlPrest', 'Levels', 'LvlTypes', 'AutoMap']));
      // The town's automap pieces: the game's AutoMap.txt names "Act 1 - Town" as "1 Town".
      const am = txtRows.filter((r) => r.table === 'AutoMap');
      expect(am.length).toBeGreaterThan(20);
      expect(new Set(am.map((r) => r.row[r.columns.indexOf('LevelName')]))).toEqual(new Set(['1 Town']));

      const built = await buildMapPackage(layered, { path: MAP, ds1: map.ds1, dt1Paths }, { ds1Bytes, txtRows, notes: 'hello' });
      expect(built.missing).toEqual([]);
      expect(built.manifest.files).toHaveLength(1 + new Set(dt1Paths.map(normalizePath)).size);
      expect(built.manifest.files.every((f) => f.sha1 && /^[0-9a-f]{40}$/.test(f.sha1))).toBe(true);
      if (name === 'vanilla') expect(built.manifest.files.filter((f) => f.path !== MAP).every((f) => f.from === 'base-game')).toBe(true);

      const pkg = readMapPackage(built.zip);
      expect(pkg.manifest.map).toBe(MAP);
      expect(pkg.manifest.notes).toBe('hello');
      expect(pkg.manifest.txtRows).toEqual(txtRows);
      const byPath = new Map(pkg.files.map((f) => [normalizePath(f.path), f.bytes]));
      expect(Buffer.from(byPath.get(normalizePath(MAP))!).equals(Buffer.from(ds1Bytes))).toBe(true);
      for (const p of dt1Paths) {
        const bytes = byPath.get(normalizePath(p));
        expect(bytes, p).toBeDefined();
        expect(Buffer.from(bytes!).equals(Buffer.from((await layered.read(p))!))).toBe(true);
      }

      const plan = await planImport(pkg, layered);
      expect(plan.coverage.filter((c) => !c.rows).map((c) => c.table)).toEqual(['CubeMain']); // no cube recipe for the town
      expect(plan.writes).toHaveLength(pkg.files.length);
      expect(plan.writes.every((w) => w.action === 'identical')).toBe(true);
      expect(plan.txtMerges.every((m) => m.exists && m.action === 'unchanged')).toBe(true);
      expect(plan.txtWrites).toEqual([]);

      // Against an empty fs everything is new and the tables are missing.
      const empty = await planImport(pkg, new LayeredFs([]));
      expect(empty.writes.every((w) => w.action === 'new')).toBe(true);
      expect(empty.txtMerges.every((m) => m.action === 'missing-table')).toBe(true);
    }, 120_000);
  }

  it('collects the warp and maze rows of a maze level', async () => {
    if (!hasD2) return;
    // Cave Level 1 presets: a maze level with warps.
    const prest = parseTxt((await vanilla.read('data/global/excel/LvlPrest.txt'))!);
    const maze = parseTxt((await vanilla.read('data/global/excel/LvlMaze.txt'))!);
    const mazeLevels = new Set(maze.rows.map((r) => r['Level']?.trim()));
    const row = prest.rows.find((r) => Number(r['LevelId']) > 0 && mazeLevels.has(String(Number(r['LevelId']))) && r['File1'] && r['File1'] !== '0');
    expect(row).toBeDefined();
    const rows = await collectMapTxtRows(vanilla, `data/global/tiles/${row!['File1']}`);
    const tables = new Set(rows.map((r) => r.table));
    expect([...tables]).toEqual(expect.arrayContaining(['LvlPrest', 'Levels', 'LvlTypes', 'LvlMaze', 'LvlWarp']));
    expect(rows.find((r) => r.table === 'LvlMaze')!.row[rows.find((r) => r.table === 'LvlMaze')!.columns.indexOf('Level')]).toBe(String(Number(row!['LevelId'])));
  });

  it("carries the names the map's rows use, and adds only the ones the importer lacks to patchstring.tbl", async () => {
    const { collectMapStrings, STRING_TABLES } = await import('../src/game/mapPackage');
    const { tblLookup, parseTbl } = await import('../src/formats/tbl');
    const gd = await GameData.load(vanilla);
    const map = await openMap(gd, MAP);
    const txtRows = await collectMapTxtRows(vanilla, MAP);
    const strings = await collectMapStrings(vanilla, txtRows);
    // The town's level names ("Rogue Encampment", "To The Rogue Encampment") come with it.
    expect(Object.values(strings)).toEqual(expect.arrayContaining(['Rogue Encampment']));
    const built = await buildMapPackage(vanilla, { path: MAP, ds1: map.ds1, dt1Paths: map.resolution.paths }, { ds1Bytes: (await vanilla.read(MAP))!, txtRows, strings: { ...strings, ds1s_lvl_999: 'Guild Hall' } });
    const pkg = readMapPackage(built.zip);
    expect(pkg.manifest.strings!.ds1s_lvl_999).toBe('Guild Hall');
    const plan = await planImport(pkg, vanilla);
    const write = plan.txtWrites.find((w) => w.path === STRING_TABLES[0])!;
    expect(tblLookup(write.bytes, 'ds1s_lvl_999')).toBe('Guild Hall');
    // Only the missing name: the patch table grows by one, and the game's own names aren't copied into it.
    const before = parseTbl((await vanilla.read(STRING_TABLES[0]))!).entries.length;
    expect(parseTbl(write.bytes).entries.length).toBe(before + 1);
    expect(plan.txtMerges.find((m) => m.table === 'patchstring.tbl')?.note).toMatch(/1 name added: "Guild Hall"/);
    // Without new names, nothing is written.
    const same = await planImport(readMapPackage((await buildMapPackage(vanilla, { path: MAP, ds1: map.ds1, dt1Paths: map.resolution.paths }, { ds1Bytes: (await vanilla.read(MAP))!, txtRows, strings })).zip), vanilla);
    expect(same.txtWrites.some((w) => w.path === STRING_TABLES[0])).toBe(false);
  });

  it('adds notes for developers: the tables as they are, the map rows with their line numbers, and a README', async () => {
    const { unzipSync, strFromU8 } = await import('fflate');
    const { collectMapStrings } = await import('../src/game/mapPackage');
    const gd = await GameData.load(vanilla);
    const map = await openMap(gd, MAP);
    const txtRows = await collectMapTxtRows(vanilla, MAP);
    const strings = await collectMapStrings(vanilla, txtRows);
    const built = await buildMapPackage(vanilla, { path: MAP, ds1: map.ds1, dt1Paths: map.resolution.paths }, { ds1Bytes: (await vanilla.read(MAP))!, txtRows, strings });
    const zip = unzipSync(built.zip);
    const readme = strFromU8(zip['for-developers/README.txt'], true);
    // The town's Levels row is line Id + 2 (the header, then Id 0 on line 2), and its rows file has the header and it.
    const levels = txtRows.find((r) => r.table === 'Levels')!;
    const id = Number(levels.row[levels.columns.indexOf('Id')]);
    const fullLevels = strFromU8(zip['for-developers/full/Levels.txt'], true).split(/\r?\n/);
    const line = fullLevels.findIndex((l) => l.split('\t')[levels.columns.indexOf('Id')] === String(id) && l.startsWith(levels.row[0])) + 1;
    expect(readme).toContain('== Levels.txt - 1 row');
    expect(readme).toContain(`In full/Levels.txt the map's rows are line ${line}.`);
    expect(readme).toMatch(/Where: Append at the end\. The game reads this table by row position/);
    const rows = strFromU8(zip['for-developers/rows/Levels.txt'], true).split('\r\n');
    expect(rows[0]).toBe(fullLevels[0]);
    expect(rows[1]).toBe(fullLevels[line - 1]);
    expect(zip['for-developers/rows/LvlPrest.txt']).toBeDefined();
    expect(strFromU8(zip['for-developers/strings.txt'], true)).toContain('Rogue Encampment');
    // DS1 Studio's own import leaves the folder alone.
    expect(readMapPackage(built.zip).files.some((f) => f.path.startsWith('for-developers'))).toBe(false);
  });

  it('can leave base-game DT1s out of the zip but lists them', async () => {
    const gd = await GameData.load(vanilla);
    const map = await openMap(gd, MAP);
    const ds1Bytes = (await vanilla.read(MAP))!;
    const built = await buildMapPackage(vanilla, { path: MAP, ds1: map.ds1, dt1Paths: [...map.resolution.paths, 'data/global/tiles/nope/nope.dt1'] }, { ds1Bytes, includeBaseGameDt1s: false });
    expect(built.missing).toEqual(['data/global/tiles/nope/nope.dt1']);
    expect(built.manifest.files.filter((f) => f.omitted)).toHaveLength(map.resolution.paths.length);
    const pkg = readMapPackage(built.zip);
    expect(pkg.files.map((f) => f.path)).toEqual([MAP]);
  });

  it.runIf(hasMod)('includes object sprite files only from loose mod folders', async () => {
    const modSpec = { base: 'data/global/monsters', token: '!3', mode: 'NU', cls: 'HTH', parts: { TR: 'LIT' } };
    const baseSpec = { base: 'data/global/monsters', token: 'WA', mode: 'NU', cls: 'HTH', parts: { TR: 'LIT' } };
    const ghost = { base: 'data/global/monsters', token: 'NOPE', mode: 'NU', cls: 'HTH', parts: {} };
    const modCof = 'data/global/monsters/!3/COF/!3NUHTH.cof';
    const baseCof = 'data/global/monsters/WA/COF/WANUHTH.cof';
    expect(fs.locate(modCof)).toBe('ProjectD2/data');
    const baseIsVanilla = fs.locate(baseCof)?.endsWith('.mpq') ?? false;

    const gd = await GameData.load(fs);
    const map = await openMap(gd, MAP);
    const built = await buildMapPackage(
      fs,
      { path: MAP, ds1: map.ds1, dt1Paths: [] },
      { ds1Bytes: (await fs.read(MAP))!, objectSpecs: [modSpec, baseSpec, ghost] },
    );
    const paths = built.manifest.files.map((f) => normalizePath(f.path));
    expect(paths).toContain(normalizePath(modCof));
    expect(paths).toContain('data/global/monsters/!3/tr/!3trlitnuhth.dcc');
    expect(built.manifest.files.filter((f) => f.path !== MAP).every((f) => f.from === 'mod')).toBe(true);
    if (baseIsVanilla) expect(paths.some((p) => p.startsWith('data/global/monsters/wa/'))).toBe(false);
    expect(built.missing).toEqual(['data/global/monsters/NOPE/COF/NOPENUHTH.cof']);
    readMapPackage(built.zip);
  }, 120_000);

  it('merges rows into the real LvlPrest.txt', async () => {
    const bytes = (await vanilla.read('data/global/excel/LvlPrest.txt'))!.slice();
    const { columns, rows } = parseTxt(bytes);
    const text = dec(bytes);

    // Identical row -> unchanged, same bytes.
    const town = rows.find((r) => r['Name'] === 'Act 1 - Town 1')!;
    expect(town).toBeDefined();
    const same = mergeTxtRow(bytes, columns, columns.map((c) => town[c]), 'Name');
    expect(same.action).toBe('unchanged');
    expect(same.bytes).toBe(bytes);

    // New row -> appended; everything before stays byte-identical, trailing blank lines kept after it.
    const fresh = columns.map((c) => (c === 'Name' ? 'My Custom Map' : c === 'Def' ? '9999' : c === 'File1' ? 'Act1/Custom/mine.ds1' : (town[c] ?? '')));
    const added = mergeTxtRow(bytes, columns, fresh, 'Name');
    expect(added.action).toBe('appended');
    const out = dec(added.bytes);
    const body = text.replace(/(\r?\n)*$/, '');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    expect(out.startsWith(body + eol + fresh.join('\t'))).toBe(true);
    expect(out.slice(body.length + eol.length + fresh.join('\t').length)).toBe(text.slice(body.length) || '');
    const reparsed = parseTxt(added.bytes);
    expect(reparsed.rows).toHaveLength(rows.length + 1);
    expect(reparsed.rows.at(-1)!['File1']).toBe('Act1/Custom/mine.ds1');

    // Existing row -> replaced; only that line changes.
    const changed = columns.map((c) => (c === 'SizeX' ? '99' : town[c]));
    const rep = mergeTxtRow(bytes, columns, changed, 'Name');
    expect(rep.action).toBe('replaced');
    const before = text.split('\n');
    const after = dec(rep.bytes).split('\n');
    expect(after).toHaveLength(before.length);
    const diff = before.map((l, i) => (l === after[i] ? -1 : i)).filter((i) => i >= 0);
    expect(diff).toHaveLength(1);
    expect(parseTxt(rep.bytes).rows.find((r) => r['Name'] === 'Act 1 - Town 1')!['SizeX']).toBe('99');

    // Only a subset of columns, plus an unknown one: no column is added.
    const partial = mergeTxtRow(bytes, ['Name', 'SizeX', 'NotAColumn'], ['Act 1 - Town 1', '98', 'x'], 'Name');
    expect(partial.action).toBe('replaced');
    const p = parseTxt(partial.bytes);
    expect(p.columns).toEqual(columns);
    const row = p.rows.find((r) => r['Name'] === 'Act 1 - Town 1')!;
    expect(row['SizeX']).toBe('98');
    expect(row['File1']).toBe(town['File1']);
  });
});


describe('desktop import diagnostics', () => {
  it('keeps native string rejections and the affected path in the error', async () => {
    const pkg = { manifest: {} as PackageManifest, files: [{path: 'data/global/tiles/map.ds1',bytes:new Uint8Array([1])}] };
    const fs = new LayeredFs([{
      label:'desktop',list:()=>[],has:()=>true,
      read:async()=>{throw 'The system cannot find the file specified (os error 2)';},
    }]);
    await expect(planImport(pkg,fs)).rejects.toThrow('Could not read the existing data/global/tiles/map.ds1: The system cannot find the file specified (os error 2)');
  });
});
