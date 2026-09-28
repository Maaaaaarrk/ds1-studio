import type { LayeredFs } from '../vfs/vfs';
import type { TxtRowEntry } from './mapPackage';

/**
 * The part of a map package for developers who merge by hand: the maker's tables as they are ("full/"), just the
 * map's rows with their header ("rows/"), the names it uses, and a README that says which lines are the map's, where
 * they go, and which numbers link them — no program needed, only a text editor.
 */

/** Folder of the package the guide lives in (DS1 Studio's own import leaves it alone). */
export const DEV_FOLDER = 'for-developers';

const TABLE_ORDER = ['LvlTypes', 'Levels', 'LvlPrest', 'AutoMap', 'LvlWarp', 'LvlMaze', 'Misc', 'CubeMain'];

/** What each table does for the map, where its rows go, and what points at them. */
const HOW: Record<string, { what: string; where: string; links?: string }> = {
  LvlTypes: {
    what: 'the tile libraries (DT1 files) the level loads',
    where:
      "Append at the end. The game reads this table by row position: a level type's Id must equal its row index, counting data rows only (0 for the first row after the header; the \"Expansion\" separator line and blank lines don't count). So set Id to your last Id + 1.",
    links: "If the Id changes, change the Levels.txt LevelType of the map's level to it (and the AutoMap.txt LevelName, when it is this number).",
  },
  Levels: {
    what: "the level itself: size, act, palette, world position (OffsetX/Y), loading-screen image (EntryFile), light, monsters",
    where:
      "Append at the end. The game reads this table by row position: a level's Id must equal its row index, counting data rows only (the \"Expansion\" separator line and blank lines don't count). So set Id to your last Id + 1. Levels from Id 109 on are Act 5 levels.",
    links:
      "If the Id changes, change it everywhere it is named: LvlPrest.txt LevelId (the map's row), LvlMaze.txt Level, other levels' Vis0-Vis7 that lead here, and the map item's len in Misc.txt (the level its portal opens). Also check OffsetX/OffsetY don't overlap a level of yours in the same act.",
  },
  LvlPrest: {
    what: 'makes the game load this map (its File1, Dt1Mask and roof hiding: Pops/PopPad) for its level',
    where:
      "Append at the end. The game reads this table by row position: Def must equal the row's index, counting data rows only. So set Def to your last Def + 1. A level uses the FIRST row whose LevelId is the level, so make sure no row of yours above names the same LevelId.",
    links: "LevelId is the map's level (Levels.txt Id). File1 is the map's path under data/global/tiles/. Dt1Mask picks the LvlTypes File slots it loads: if you moved DT1s to other slots, recompute it.",
  },
  AutoMap: {
    what: "what the in-game automap draws for the level type's tiles",
    where: 'Anywhere, but before other rows with the same LevelName: the game uses the first row that matches a tile.',
    links: 'LevelName names the level type (its LvlTypes Name, or its Id in mods that number them): change it if you renumbered the LvlTypes row.',
  },
  LvlWarp: { what: "the kind of warp the level's exits use", where: 'Append at the end (Id = your last Id + 1 if it is new to you).', links: "Levels.txt Warp0-Warp7 name these Ids." },
  LvlMaze: { what: 'maze settings of the level', where: 'Append at the end.', links: "Level is the level's Id." },
  Misc: {
    what: 'the map item that opens the level through the cube',
    where: 'Append at the end. Never insert items in the middle: characters store items by their row order.',
    links: "len is the level the portal opens (Levels.txt Id). code must be unique in your items; if it clashes, change it here and in CubeMain.txt's output.",
  },
  CubeMain: { what: 'the cube recipe that makes the map item (or opens the portal)', where: 'Append at the end.', links: "output names the Misc.txt code." },
};

const tableOf = (t: string) => t.replace(/\.txt$/i, '').split('/').pop()!;
const decode = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const encode = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const CRLF = '\r\n';

/** The line (index into `lines`) holding `row`, from `from` on: cells compared column by column (trailing spaces ignored). */
function findLine(lines: string[], row: string[], used: Set<number>): number {
  const same = (a: string, b: string) => a === b || a.trimEnd() === b.trimEnd();
  for (let i = 1; i < lines.length; i++) {
    if (used.has(i)) continue;
    const cells = lines[i].split('\t');
    if (row.every((v, c) => same(cells[c] ?? '', v))) return i;
  }
  return -1;
}

/** A short "Id 212 guild3" style label for a row. */
function rowLabel(table: string, r: TxtRowEntry): string {
  const v = (c: string) => (r.row[r.columns.indexOf(c)] ?? '').trim();
  switch (table) {
    case 'Levels':
      return `Id ${v('Id')} "${v('Name')}" (LevelType ${v('LevelType')})`;
    case 'LvlPrest':
      return `Def ${v('Def')} "${v('Name')}", LevelId ${v('LevelId')}, File1 ${v('File1')}`;
    case 'LvlTypes':
      return `Id ${v('Id')} "${v('Name')}"`;
    case 'AutoMap':
      return `${r.row[0]} ${r.row[1]} ${r.row[2]}`;
    case 'Misc':
      return `code ${v('code')} "${v('name')}"`;
    case 'CubeMain':
      return `"${v('description')}"`;
    default:
      return `${r.key} ${v(r.key)}`;
  }
}

export interface DevGuideInput {
  mapPath: string;
  created: Date;
  rows: TxtRowEntry[];
  strings?: Record<string, string>;
  /** Game paths of the map's own files in the package (DS1, DT1s, sprites). */
  files: string[];
}

/** The guide's files, as package paths → bytes. */
export async function buildDevGuide(fs: LayeredFs, input: DevGuideInput): Promise<{ path: string; bytes: Uint8Array }[]> {
  const out: { path: string; bytes: Uint8Array }[] = [];
  const byTable = new Map<string, TxtRowEntry[]>();
  for (const r of input.rows) (byTable.get(tableOf(r.table)) ?? byTable.set(tableOf(r.table), []).get(tableOf(r.table))!).push(r);
  const tables = [...byTable.keys()].sort((a, b) => (TABLE_ORDER.indexOf(a) + 99) % 99 - (TABLE_ORDER.indexOf(b) + 99) % 99 || a.localeCompare(b));

  const mapName = input.mapPath.split('/').pop()!;
  const text: string[] = [
    `DS1 Studio map package: ${mapName} - notes for developers`,
    `Made ${input.created.toISOString().slice(0, 10)}. Everything here can be done with a text editor.`,
    '',
    'WHAT IS IN THIS FOLDER',
    '  full/     the map maker\'s tables exactly as they are in their mod, for reference (or to compare with yours)',
    "  rows/     just this map's rows of each table, under the table's header line, ready to paste",
    ...(input.strings && Object.keys(input.strings).length ? ['  strings.txt  the names the map uses (level names, the map item) and their text'] : []),
    '',
    "THE MAP'S FILES",
    '  Copy these from this zip into your mod, keeping their paths (under your mod\'s data folder):',
    ...input.files.map((f) => `    ${f}`),
    '',
    'GENERAL',
    '  - The tables are tab-separated text: keep the tabs, and save them as plain ANSI (Windows-1252) text.',
    "  - Line numbers below count the header as line 1, as a text editor shows them.",
    "  - If your table's columns differ from the header in rows/, copy each value into the column of the same name.",
    '  - If your mod ships compiled .bin tables, rebuild them afterwards (start the game once with -direct -txt).',
    '',
  ];

  for (const table of tables) {
    const rows = byTable.get(table)!;
    const how = HOW[table];
    const full = await fs.read(`data/global/excel/${table}.txt`);
    const lines = full ? decode(full).split(/\r?\n/) : [];
    const used = new Set<number>();
    const found = rows.map((r) => {
      const at = lines.length ? findLine(lines, r.row, used) : -1;
      if (at >= 0) used.add(at);
      return { r, at };
    });
    if (full) out.push({ path: `${DEV_FOLDER}/full/${table}.txt`, bytes: full });
    const header = lines[0] ?? rows[0].columns.join('\t');
    const body = found.map(({ r, at }) => (at >= 0 ? lines[at] : r.row.join('\t')));
    out.push({ path: `${DEV_FOLDER}/rows/${table}.txt`, bytes: encode([header, ...body].join(CRLF) + CRLF) });

    text.push(`== ${table}.txt - ${rows.length} row${rows.length === 1 ? '' : 's'}${how ? `: ${how.what}` : ''} ==`);
    const located = found.filter((f) => f.at >= 0).map((f) => f.at + 1);
    text.push(
      located.length
        ? `  In full/${table}.txt the map's rows are line${located.length === 1 ? '' : 's'} ${ranges(located)}.`
        : `  (${table}.txt wasn't found in the maker's files: the rows come from the package itself.)`,
    );
    // Row by row for a few; a long list (AutoMap's pieces) is just its line ranges above.
    if (found.length <= 12) for (const { r, at } of found) text.push(`    ${at >= 0 ? `line ${String(at + 1).padStart(4)}` : '         '}  ${rowLabel(table, r)}`);
    if (how) {
      text.push(...wrap(`Where: ${how.where}`, '  '));
      if (how.links) text.push(...wrap(`Numbers that link: ${how.links}`, '  '));
    }
    text.push('');
  }

  if (input.strings && Object.keys(input.strings).length) {
    out.push({
      path: `${DEV_FOLDER}/strings.txt`,
      bytes: encode(['Key\tText', ...Object.entries(input.strings).map(([k, v]) => `${k}\t${v}`)].join(CRLF) + CRLF),
    });
    text.push(
      '== Names (strings.txt) ==',
      ...wrap(
        "Levels.txt LevelName/LevelWarp and the map item's name are string keys: the game shows their text from the .tbl string tables. Add each key with its text to your patchstring.tbl (a .tbl editor is needed for that), or leave them out and the game shows the keys themselves.",
        '  ',
      ),
      ...Object.entries(input.strings).map(([k, v]) => `    ${k} = ${v}`),
      '',
    );
  }
  text.push('Tip: DS1 Studio (github.com/RoofooEvazan/ds1-studio) does all of this for you: Home > File > Import > Map... on this zip.');
  out.unshift({ path: `${DEV_FOLDER}/README.txt`, bytes: encode(text.join(CRLF) + CRLF) });
  return out;
}

/** "3, 7-9, 12" for sorted line numbers. */
function ranges(ns: number[]): string {
  const s = [...ns].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/** Text wrapped at 110 characters with an indent. */
function wrap(s: string, indent: string): string[] {
  const words = s.split(' ');
  const out: string[] = [];
  let line = indent;
  for (const w of words) {
    if (line.length + w.length + 1 > 110 && line.trim()) {
      out.push(line.trimEnd());
      line = `${indent}  `;
    }
    line += (line.trim() ? ' ' : '') + w;
  }
  if (line.trim()) out.push(line.trimEnd());
  return out;
}
