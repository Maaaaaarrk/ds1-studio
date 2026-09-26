/**
 * Lossless model of a D2 tab-separated "excel" .txt table.
 *
 * Unlike `txt.ts` (which maps rows to objects and drops blank lines), this keeps every line and
 * every cell exactly as written so an unmodified table serializes back to the identical bytes:
 * duplicate / empty column names, ragged rows, blank lines and comment lines are all preserved.
 *
 * Mutating helpers are pure: they return a new doc that shares untouched rows with the input.
 */
export interface TxtTableDoc {
  /** Header cells, verbatim (may contain duplicates or empty names). */
  columns: string[];
  /** Data lines split on tabs. Rows may be shorter or longer than `columns`. A blank line is `['']`. */
  rows: string[][];
  /** Line separator, detected from the first line break ('\r\n' if the first break is CRLF). */
  lineEnding: '\r\n' | '\n';
  /** Whether the file ends with a line separator. */
  finalNewline: boolean;
}

/** Byte-per-char latin1 decode (not TextDecoder, whose 'latin1' is really windows-1252 and not reversible). */
function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

/** Inverse of decodeLatin1. Characters outside latin1 (e.g. typed by the user) become '?'. */
function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i] = c > 0xff ? 0x3f : c;
  }
  return out;
}

export function parseTxtTable(bytes: Uint8Array): TxtTableDoc {
  const text = decodeLatin1(bytes);
  const firstLf = text.indexOf('\n');
  const lineEnding: '\r\n' | '\n' = firstLf > 0 && text.charCodeAt(firstLf - 1) === 13 ? '\r\n' : '\n';
  // Splitting on the detected separator only keeps mixed files lossless: stray '\r' or '\n'
  // characters simply stay inside their cell.
  const lines = text.split(lineEnding);
  let finalNewline = false;
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
    finalNewline = true;
  }
  const columns = lines[0].split('\t');
  const rows = new Array<string[]>(lines.length - 1);
  for (let i = 1; i < lines.length; i++) rows[i - 1] = lines[i].split('\t');
  return { columns, rows, lineEnding, finalNewline };
}

export function serializeTxtTable(doc: TxtTableDoc): Uint8Array {
  const parts = new Array<string>(doc.rows.length + 1);
  parts[0] = doc.columns.join('\t');
  for (let i = 0; i < doc.rows.length; i++) parts[i + 1] = doc.rows[i].join('\t');
  let text = parts.join(doc.lineEnding);
  if (doc.finalNewline) text += doc.lineEnding;
  return encodeLatin1(text);
}

/** Index of the first column whose name matches case-insensitively, or -1. */
export function colIndex(doc: TxtTableDoc, name: string): number {
  const want = name.toLowerCase();
  for (let i = 0; i < doc.columns.length; i++) if (doc.columns[i].toLowerCase() === want) return i;
  return -1;
}

function resolveCol(doc: TxtTableDoc, column: number | string): number {
  const idx = typeof column === 'number' ? column : colIndex(doc, column);
  if (idx < 0) throw new Error(`Unknown column: ${String(column)}`);
  return idx;
}

/** Cell text, or '' when the row is short or the column is unknown. */
export function getCell(doc: TxtTableDoc, row: number, column: number | string): string {
  const idx = typeof column === 'number' ? column : colIndex(doc, column);
  if (idx < 0) return '';
  return doc.rows[row]?.[idx] ?? '';
}

/**
 * Returns a new doc with one cell changed. A short row is padded with empty cells up to the
 * edited column (and no further). Returns the same doc when nothing changes.
 */
export function setCell(doc: TxtTableDoc, row: number, column: number | string, value: string): TxtTableDoc {
  const idx = resolveCol(doc, column);
  const old = doc.rows[row];
  if (!old) throw new Error(`Row ${row} out of range`);
  if ((old[idx] ?? '') === value && idx < old.length) return doc;
  const next = old.slice();
  while (next.length <= idx) next.push('');
  next[idx] = value;
  const rows = doc.rows.slice();
  rows[row] = next;
  return { ...doc, rows };
}

/** Indices of rows whose cell in `column` equals `value` exactly. */
export function findRows(doc: TxtTableDoc, column: number | string, value: string): number[] {
  const idx = typeof column === 'number' ? column : colIndex(doc, column);
  if (idx < 0) return [];
  const out: number[] = [];
  for (let i = 0; i < doc.rows.length; i++) if ((doc.rows[i][idx] ?? '') === value) out.push(i);
  return out;
}

/**
 * Appends a full-width row at the very end of the table (after any trailing `Expansion`
 * separator row), with the named columns filled and all others empty. The new row's index is
 * `result.rows.length - 1`. Throws on an unknown column name.
 */
export function appendRow(doc: TxtTableDoc, values: Record<string, string> = {}): TxtTableDoc {
  const row = new Array<string>(doc.columns.length).fill('');
  for (const [name, value] of Object.entries(values)) row[resolveCol(doc, name)] = value;
  return { ...doc, rows: [...doc.rows, row] };
}

/** Inserts a copy of row `index` directly after it; the copy's index is `index + 1`. */
export function cloneRow(doc: TxtTableDoc, index: number): TxtTableDoc {
  const src = doc.rows[index];
  if (!src) throw new Error(`Row ${index} out of range`);
  const rows = doc.rows.slice();
  rows.splice(index + 1, 0, src.slice());
  return { ...doc, rows };
}

export function deleteRow(doc: TxtTableDoc, index: number): TxtTableDoc {
  if (index < 0 || index >= doc.rows.length) throw new Error(`Row ${index} out of range`);
  const rows = doc.rows.slice();
  rows.splice(index, 1);
  return { ...doc, rows };
}
