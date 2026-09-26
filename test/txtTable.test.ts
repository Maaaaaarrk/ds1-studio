import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendRow,
  cloneRow,
  colIndex,
  deleteRow,
  findRows,
  getCell,
  parseTxtTable,
  serializeTxtTable,
  setCell,
} from '../src/formats/txtTable';
import { MOD_DATA } from '../tools/testdata';

const EXCEL = join(MOD_DATA, 'global/excel');
const hasExcel = existsSync(EXCEL);

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const dec = (b: Uint8Array) => String.fromCharCode(...b);

describe.runIf(hasExcel)('real excel tables', () => {
  const files = hasExcel ? readdirSync(EXCEL).filter((f) => /\.txt$/i.test(f)) : [];

  it('round-trips every .txt byte-exactly', () => {
    expect(files.length).toBeGreaterThan(10);
    const failures: string[] = [];
    for (const f of files) {
      const bytes = new Uint8Array(readFileSync(join(EXCEL, f)));
      const out = serializeTxtTable(parseTxtTable(bytes));
      if (out.length !== bytes.length || !out.every((b, i) => b === bytes[i])) failures.push(f);
    }
    expect(failures).toEqual([]);
  });

  it('reads LvlPrest columns and rows', () => {
    const doc = parseTxtTable(new Uint8Array(readFileSync(join(EXCEL, 'LvlPrest.txt'))));
    expect(doc.lineEnding).toBe('\r\n');
    expect(doc.finalNewline).toBe(true);
    expect(colIndex(doc, 'name')).toBe(0);
    expect(colIndex(doc, 'DEF')).toBeGreaterThanOrEqual(0);
    expect(doc.rows.length).toBeGreaterThan(1000);
  });

  it('edits then round-trips only the edited bytes', () => {
    const bytes = new Uint8Array(readFileSync(join(EXCEL, 'Levels.txt')));
    const doc = parseTxtTable(bytes);
    const col = colIndex(doc, 'Name');
    const edited = setCell(doc, 0, col, 'Changed');
    const reparsed = parseTxtTable(serializeTxtTable(edited));
    expect(getCell(reparsed, 0, 'name')).toBe('Changed');
    expect(reparsed.rows.slice(1)).toEqual(doc.rows.slice(1));
    expect(serializeTxtTable(doc)).toEqual(bytes); // original untouched
  });
});

describe('txtTable model', () => {
  const sample = () => parseTxtTable(enc('Name\tId\tName\t\r\nfoo\t1\tx\t\r\nbar\t2\r\n\r\nExpansion\r\n'));

  it('keeps duplicate/empty columns, ragged rows and blank lines', () => {
    const doc = sample();
    expect(doc.columns).toEqual(['Name', 'Id', 'Name', '']);
    expect(doc.rows).toEqual([['foo', '1', 'x', ''], ['bar', '2'], [''], ['Expansion']]);
    expect(doc.lineEnding).toBe('\r\n');
    expect(doc.finalNewline).toBe(true);
    expect(dec(serializeTxtTable(doc))).toBe('Name\tId\tName\t\r\nfoo\t1\tx\t\r\nbar\t2\r\n\r\nExpansion\r\n');
  });

  it('handles LF, no final newline, mixed endings and latin1', () => {
    for (const s of ['a\tb\n1\t2', 'a\n1\n', 'a\r\n1\n2\r\n', 'h\n\r\n', '', '\r\n', 'xéÿ\u0080\u009f\n']) {
      expect(dec(serializeTxtTable(parseTxtTable(enc(s))))).toBe(s);
    }
    const lf = parseTxtTable(enc('a\tb\n1\t2'));
    expect(lf.lineEnding).toBe('\n');
    expect(lf.finalNewline).toBe(false);
  });

  it('colIndex / getCell / findRows', () => {
    const doc = sample();
    expect(colIndex(doc, 'name')).toBe(0);
    expect(colIndex(doc, 'ID')).toBe(1);
    expect(colIndex(doc, 'nope')).toBe(-1);
    expect(getCell(doc, 1, 'Id')).toBe('2');
    expect(getCell(doc, 1, 2)).toBe('');
    expect(getCell(doc, 99, 0)).toBe('');
    expect(findRows(doc, 'name', 'bar')).toEqual([1]);
    expect(findRows(doc, 3, '')).toEqual([0, 1, 2, 3]);
    expect(findRows(doc, 'nope', 'x')).toEqual([]);
  });

  it('setCell is immutable and pads short rows only as far as needed', () => {
    const doc = sample();
    const next = setCell(doc, 1, 2, 'y');
    expect(next).not.toBe(doc);
    expect(doc.rows[1]).toEqual(['bar', '2']);
    expect(next.rows[1]).toEqual(['bar', '2', 'y']);
    expect(next.rows[0]).toBe(doc.rows[0]);
    expect(setCell(doc, 0, 'id', '1')).toBe(doc);
    expect(setCell(doc, 2, 'Id', '').rows[2]).toEqual(['', '']);
    expect(() => setCell(doc, 0, 'nope', 'x')).toThrow();
  });

  it('appendRow adds a full-width row at the end, after an Expansion row', () => {
    const doc = sample();
    const next = appendRow(doc, { name: 'baz', ID: '3' });
    expect(next.rows.length).toBe(doc.rows.length + 1);
    expect(next.rows[3]).toEqual(['Expansion']);
    expect(next.rows[4]).toEqual(['baz', '3', '', '']);
    expect(doc.rows.length).toBe(4);
    expect(appendRow(doc).rows[4]).toEqual(['', '', '', '']);
    expect(() => appendRow(doc, { nope: '1' })).toThrow();
    expect(dec(serializeTxtTable(next)).endsWith('Expansion\r\nbaz\t3\t\t\r\n')).toBe(true);
  });

  it('cloneRow inserts an independent copy after the source', () => {
    const doc = sample();
    const next = cloneRow(doc, 0);
    expect(next.rows.map((r) => r[0])).toEqual(['foo', 'foo', 'bar', '', 'Expansion']);
    expect(next.rows[1]).toEqual(doc.rows[0]);
    expect(next.rows[1]).not.toBe(doc.rows[0]);
    expect(doc.rows.length).toBe(4);
    const cloneRagged = cloneRow(doc, 1);
    expect(cloneRagged.rows[2]).toEqual(['bar', '2']);
  });

  it('deleteRow removes one row without touching the input', () => {
    const doc = sample();
    const next = deleteRow(doc, 1);
    expect(next.rows.map((r) => r[0])).toEqual(['foo', '', 'Expansion']);
    expect(doc.rows.length).toBe(4);
    expect(() => deleteRow(doc, 4)).toThrow();
  });
});
