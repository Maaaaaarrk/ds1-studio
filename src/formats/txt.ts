/** Tab-separated D2 excel .txt tables. */
export interface TxtTable {
  columns: string[];
  rows: Record<string, string>[];
}

export function parseTxt(bytes: Uint8Array): TxtTable {
  const text = new TextDecoder('latin1').decode(bytes);
  const lines = text.split(/\r?\n/);
  const columns = (lines.shift() ?? '').split('\t');
  const rows: Record<string, string>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    columns.forEach((c, i) => (row[c] = cells[i] ?? ''));
    rows.push(row);
  }
  return { columns, rows };
}
