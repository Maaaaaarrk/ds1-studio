import { addTxtRow } from './mapPackage';

/**
 * Bringing AutoMap.txt rows from another mod: its LevelName column names a level type by the number (or name) it has
 * in THAT mod, which is usually another level type here (46 is one mod's Guild and another's Poisoned Well). Each
 * source LevelName is mapped to one of this mod's level types before the rows are added.
 */

const decode = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

export interface AutomapSource {
  /** Header cells, by position (AutoMap.txt names a column twice, so not by name). */
  columns: string[];
  rows: string[][];
  /** Each LevelName in the rows, with its row count and a few of its tile codes. */
  levels: { name: string; rows: number; codes: string[] }[];
}

/** Reads AutoMap rows (a whole AutoMap.txt, or the header and some rows). null when it isn't AutoMap data. */
export function readAutomapRows(bytes: Uint8Array): AutomapSource | null {
  const lines = decode(bytes).split(/\r?\n/);
  const columns = (lines[0] ?? '').split('\t');
  const at = columns.indexOf('LevelName');
  const code = columns.indexOf('TileName');
  if (at < 0 || code < 0) return null;
  const rows = lines.slice(1).filter((l) => l.trim()).map((l) => l.split('\t'));
  const levels = new Map<string, { rows: number; codes: Set<string> }>();
  for (const r of rows) {
    const name = (r[at] ?? '').trim();
    const e = levels.get(name) ?? { rows: 0, codes: new Set<string>() };
    e.rows++;
    if (r[code]) e.codes.add(r[code].trim());
    levels.set(name, e);
  }
  return { columns, rows, levels: [...levels].map(([name, e]) => ({ name, rows: e.rows, codes: [...e.codes].slice(0, 8) })) };
}

/** Whether this mod's AutoMap.txt names level types by number (PD2) rather than by name (the game's own). */
export function namesByNumber(target: Uint8Array): boolean {
  const lines = decode(target).split(/\r?\n/);
  const at = (lines[0] ?? '').split('\t').indexOf('LevelName');
  let num = 0, text = 0;
  for (const l of lines.slice(1)) {
    const v = (l.split('\t')[at] ?? '').trim();
    if (!v) continue;
    if (/^\d+$/.test(v)) num++;
    else text++;
  }
  return num > text;
}

/**
 * AutoMap.txt with the source rows added: each source LevelName becomes `mapping[name]` (the value to write, or null
 * to leave those rows out). Rows already there are skipped.
 */
export function mergeAutomapRows(target: Uint8Array, src: AutomapSource, mapping: Record<string, string | null>): { bytes: Uint8Array; added: number; already: number } {
  const at = src.columns.indexOf('LevelName');
  let bytes = target;
  let added = 0;
  let already = 0;
  for (const r of src.rows) {
    const to = mapping[(r[at] ?? '').trim()];
    if (to === null || to === undefined) continue;
    const row = r.slice();
    row[at] = to;
    const res = addTxtRow(bytes, src.columns, row);
    bytes = res.bytes;
    if (res.action === 'appended') added++;
    else already++;
  }
  return { bytes, added, already };
}
