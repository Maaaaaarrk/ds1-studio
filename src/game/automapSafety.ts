import { parseTxtTable, type TxtTableDoc } from '../formats/txtTable';

/** AutoMap's loader asserts that every rule has at least one cel before the -1 terminator. */
export function invalidAutomapRows(doc: TxtTableDoc): number[] {
  const col = (name: string) => doc.columns.findIndex(c => c.trim().toLowerCase() === name.toLowerCase());
  const level = col('LevelName'), tile = col('TileName'), cel = col('Cel1');
  if (level < 0 || tile < 0 || cel < 0) throw new Error('AutoMap.txt needs LevelName, TileName and Cel1 columns.');
  return doc.rows.flatMap((r, i) => {
    if (!(r[level] ?? '').trim() || !(r[tile] ?? '').trim()) return [];
    const raw = (r[cel] ?? '').trim();
    const value = raw ? Number(raw) : 0; // Empty numeric columns compile as zero.
    return !Number.isInteger(value) || value < 0 ? [i] : [];
  });
}

export function validateAutomapSave(path: string, bytes: Uint8Array): void {
  if (path.replace(/\\/g, '/').toLowerCase() !== 'data/global/excel/automap.txt') return;
  const rows = invalidAutomapRows(parseTxtTable(bytes));
  if (rows.length) throw new Error(`AutoMap.txt contains ${rows.length} invalid rule(s), on line(s) ${rows.slice(0, 12).map(i => i + 2).join(', ')}. Cel1 must be a valid picture number: -1 here crashes the game while loading. Clear a piece by removing its matching rule, not by setting all cels to -1. The file was not saved.`);
}
