import type { Ds1, TileCell, WallCell } from '../formats/ds1';
import { isEmptyCell } from '../formats/ds1';
import { parseDc6, type SpriteFrame } from '../formats/dc6';
import { getCell, type TxtTableDoc } from '../formats/txtTable';

/**
 * The in-game automap: AutoMap.txt maps (level type, tile code, style, sequence) to a cel of
 * data/global/ui/automap/MaxiMap.dc6. Style is the tile's main index and sequence its sub index; the tile code comes
 * from the DT1 orientation.
 */

export const AUTOMAP_TXT = 'data/global/excel/AutoMap.txt';
export const AUTOMAP_DC6 = 'data/global/ui/automap/MaxiMap.dc6';

/** AutoMap.txt "TileName" for each DT1 orientation (0 floor … 19 lower walls). */
export const AUTOMAP_CODES = ['fl', 'wl', 'wr', 'wtlr', 'wtll', 'wtr', 'wbl', 'wbr', 'wld', 'wrd', 'wle', 'wre', 'co', 'sh', 'tr', 'rf', 'ld', 'lr', 'lf', 'ls'];

export const AUTOMAP_CODE_NAMES: Record<string, string> = {
  fl: 'Floor',
  wl: 'Left wall',
  wr: 'Right wall',
  wtlr: 'North corner, right part',
  wtll: 'North corner, left part',
  wtr: 'East corner',
  wbl: 'West corner',
  wbr: 'South corner',
  wld: 'Left door',
  wrd: 'Right door',
  wle: 'Left wall end',
  wre: 'Right wall end',
  co: 'Column / pillar',
  sh: 'Shadow',
  tr: 'Tree / object',
  rf: 'Roof',
  ld: 'Lower wall, left',
  lr: 'Lower wall, right',
  lf: 'Lower wall, north',
  ls: 'Lower wall, south',
};

export interface AutomapRule {
  /** Row in AutoMap.txt. */
  row: number;
  level: string;
  code: string;
  style: number;
  start: number;
  end: number;
  /** Cel1..Cel4 with the "Type" labels; -1 entries dropped. */
  cels: { cel: number; label: string }[];
}

export interface AutomapTable {
  doc: TxtTableDoc;
  /** Level names as written (e.g. "1 Town"), in file order. */
  levels: string[];
  byKey: Map<string, AutomapRule[]>;
}

const key = (level: string, code: string, style: number) => `${level.toLowerCase()}|${code}|${style}`;

export function parseAutomap(doc: TxtTableDoc): AutomapTable {
  const byKey = new Map<string, AutomapRule[]>();
  const levels: string[] = [];
  // The header repeats "Type2" for the third type column, so go by position: Type1 Cel1 … Type4 Cel4 after EndSequence.
  const end = doc.columns.findIndex((c) => c.toLowerCase() === 'endsequence');
  doc.rows.forEach((r, row) => {
    const level = (r[0] ?? '').trim();
    const code = (r[1] ?? '').trim().toLowerCase();
    if (!level || !code) return;
    if (!levels.includes(level)) levels.push(level);
    const cels: AutomapRule['cels'] = [];
    for (let i = 0; i < 4; i++) {
      const cel = Number(r[end + 2 + i * 2]);
      if (Number.isFinite(cel) && cel >= 0 && (r[end + 2 + i * 2] ?? '').trim() !== '') cels.push({ cel, label: (r[end + 1 + i * 2] ?? '').trim() });
    }
    const rule: AutomapRule = { row, level, code, style: Number(r[2]) || 0, start: Number(r[3]), end: Number(r[4]), cels };
    const k = key(level, code, rule.style);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(rule);
  });
  return { doc, levels, byKey };
}

/** Whether a rule's sequence range covers `sub` (-1 start = every sequence; -1 end = just the start). */
export function ruleCovers(rule: AutomapRule, sub: number): boolean {
  if (rule.start < 0) return true;
  const end = rule.end < 0 ? rule.start : rule.end;
  return sub >= rule.start && sub <= end;
}

/** The first rule for a tile (the game's lookup), or null when the tile has none (it doesn't show on the automap). */
export function findRule(t: AutomapTable, level: string, orientation: number, main: number, sub: number): AutomapRule | null {
  const code = AUTOMAP_CODES[orientation];
  if (!code) return null;
  return t.byKey.get(key(level, code, main))?.find((r) => ruleCovers(r, sub)) ?? null;
}

/**
 * AutoMap.txt's level name for a level type: its Id ("47"), its exact name, or the vanilla short form ("Act 1 - Town" →
 * "1 Town"), falling back to a prefix match ("Act 5 - Ice Caves" → "5 Ice").
 */
export function automapLevelFor(t: AutomapTable, lvlTypeName: string | undefined | null, act?: number, lvlTypeId?: number): string | null {
  // Mods key their own level types by LvlTypes Id (PD2: "47" = Dark Temple) or by the exact LvlTypes name.
  if (lvlTypeId !== undefined && lvlTypeId > 0) {
    const byId = t.levels.find((l) => l.trim() === String(lvlTypeId));
    if (byId) return byId;
  }
  if (!lvlTypeName) return null;
  const byName = t.levels.find((l) => l.trim().toLowerCase() === lvlTypeName.trim().toLowerCase());
  if (byName) return byName;
  const m = /act\s*(\d)\s*-\s*(.+)/i.exec(lvlTypeName);
  const want = (m ? `${m[1]} ${m[2]}` : lvlTypeName).toLowerCase().trim();
  const exact = t.levels.find((l) => l.toLowerCase() === want);
  if (exact) return exact;
  const prefix = t.levels.find((l) => want.startsWith(l.toLowerCase()) || l.toLowerCase().startsWith(want));
  if (prefix) return prefix;
  // Same act, first word of the name.
  const word = want.split(' ').slice(0, 2).join(' ');
  return t.levels.find((l) => l.toLowerCase().startsWith(word)) ?? (act ? (t.levels.find((l) => l.startsWith(`${act} `)) ?? null) : null);
}

export interface AutomapPiece {
  cellX: number;
  cellY: number;
  orientation: number;
  main: number;
  sub: number;
  rule: AutomapRule | null;
  cel: number | null;
  layer: 'floor' | 'wall';
  /** Set when the cel comes from an unsaved suggestion. */
  suggested?: boolean;
}

/** Pieces with suggestions filled in, for previewing them on the map. */
export function withSuggestions(pieces: AutomapPiece[], suggestions: AutomapSuggestion[]): AutomapPiece[] {
  const by = new Map(suggestions.map((s) => [`${s.orientation}|${s.style}`, s]));
  return pieces.map((p) => {
    if (p.rule) return p;
    const s = by.get(`${p.orientation}|${p.main}`);
    return s && s.seqs.includes(p.sub) ? { ...p, cel: s.cel, suggested: true } : p;
  });
}

/** Every floor and wall tile of the map with its automap rule and chosen cel (random among Cel1..4, stable per cell). */
export function automapPieces(ds1: Ds1, t: AutomapTable, level: string): AutomapPiece[] {
  const out: AutomapPiece[] = [];
  const add = (c: TileCell, orientation: number, x: number, y: number, layer: 'floor' | 'wall') => {
    if (isEmptyCell(c) || c.hidden) return;
    const rule = findRule(t, level, orientation, c.mainIndex, c.subIndex);
    const pick = rule?.cels.length ? rule.cels[(x * 7 + y * 13) % rule.cels.length].cel : null;
    out.push({ cellX: x, cellY: y, orientation, main: c.mainIndex, sub: c.subIndex, rule, cel: pick, layer });
  };
  for (let y = 0; y < ds1.height; y++)
    for (let x = 0; x < ds1.width; x++) {
      const i = y * ds1.width + x;
      for (const f of ds1.floors) add(f[i], 0, x, y, 'floor');
      for (const w of ds1.walls) {
        const c = w[i] as WallCell;
        // Specials (10/11) are markers, not scenery; orientation 0 in a wall layer is a floor-like tile.
        if (c.orientation === 10 || c.orientation === 11) continue;
        add(c, c.orientation, x, y, 'wall');
      }
    }
  return out;
}

/** MaxiMap.dc6 frames (one direction). */
export function parseAutomapCels(bytes: Uint8Array): SpriteFrame[] {
  return parseDc6(bytes).frames[0].map((f) => f.image);
}

/** Size of one automap cell: MaxiMap cels are drawn on a 16×8 diamond grid, a tenth of the world's 160×80. */
export const AUTOMAP_SCALE = 10;

/** Automap-pixel position of a cell's cel origin, relative to the automap origin. */
export function automapCellOrigin(cellX: number, cellY: number): [number, number] {
  return [(cellX - cellY) * 8, (cellX + cellY) * 4];
}

export function describeRule(r: AutomapRule): string {
  const seq = r.start < 0 ? 'any' : r.end < 0 || r.end === r.start ? `${r.start}` : `${r.start}–${r.end}`;
  return `${r.level} · ${r.code} · style ${r.style} · seq ${seq}`;
}

/** Value helpers for editing: the cel columns by position. */
export function celColumns(doc: TxtTableDoc): { type: number; cel: number }[] {
  const end = doc.columns.findIndex((c) => c.toLowerCase() === 'endsequence');
  return [0, 1, 2, 3].map((i) => ({ type: end + 1 + i * 2, cel: end + 2 + i * 2 }));
}

export function ruleText(doc: TxtTableDoc, row: number): string {
  return doc.columns.map((_, i) => getCell(doc, row, i)).join(' · ');
}

/**
 * Sets the automap cel for one tile (`scope: 'seq'`: this style + sequence only) or every sequence of its style
 * (`'style'`). An existing row covering exactly that is updated; otherwise a new row goes in front of the other rows
 * of the same level/code/style, so the game's first-match lookup finds it. Returns the new table and a summary.
 */
export function setAutomapCel(
  doc: TxtTableDoc,
  level: string,
  orientation: number,
  style: number,
  sub: number,
  cel: number,
  scope: 'seq' | 'style',
): { doc: TxtTableDoc; summary: string } {
  const code = AUTOMAP_CODES[orientation];
  if (!code) throw new Error(`orientation ${orientation} has no automap code`);
  const t = parseAutomap(doc);
  const rules = t.byKey.get(key(level, code, style)) ?? [];
  const [start, end] = scope === 'seq' ? [sub, sub] : [-1, -1];
  const cols = celColumns(doc);
  const exact = rules.find((r) => (scope === 'seq' ? r.start === sub && (r.end === sub || r.end < 0) : r.start < 0));
  const rows = doc.rows.map((r) => r.slice());
  const what = `${level} ${code} style ${style} ${scope === 'seq' ? `seq ${sub}` : 'all sequences'} → cel ${cel}`;
  if (exact) {
    const r = rows[exact.row];
    while (r.length < doc.columns.length) r.push('');
    r[cols[0].cel] = String(cel);
    for (const c of cols.slice(1)) r[c.cel] = '-1';
    return { doc: { ...doc, rows }, summary: `AutoMap.txt: ${what} (updated row)` };
  }
  const line = Array<string>(doc.columns.length).fill('');
  line[0] = level;
  line[1] = code;
  line[2] = String(style);
  line[3] = String(start);
  line[4] = String(end);
  line[cols[0].type] = 'DS1 Studio';
  line[cols[0].cel] = String(cel);
  for (const c of cols.slice(1)) line[c.cel] = '-1';
  // In front of the rows it must win over; else after the level's last row; else at the end.
  let at = rules.length ? Math.min(...rules.map((r) => r.row)) : -1;
  if (at < 0) {
    const levelRows = doc.rows.map((r, i) => ((r[0] ?? '').trim().toLowerCase() === level.toLowerCase() ? i : -1)).filter((i) => i >= 0);
    at = levelRows.length ? levelRows[levelRows.length - 1] + 1 : rows.length;
    while (at > 0 && at === rows.length && rows[at - 1].length === 1 && rows[at - 1][0] === '') at--;
  }
  rows.splice(at, 0, line);
  return { doc: { ...doc, rows }, summary: `AutoMap.txt: ${what} (new row)` };
}

export interface AutomapSuggestion {
  code: string;
  orientation: number;
  style: number;
  /** Sequences (sub indices) of this style that have no entry. */
  seqs: number[];
  /** Tiles on the map this covers. */
  count: number;
  cel: number;
}

/**
 * The most used cel per tile code: first among this level's rules, then the same act's levels, then the whole table. Used to suggest
 * pieces for tiles that have none (a left wall gets the level's usual left-wall piece, and so on).
 */
export function usualCels(t: AutomapTable, level: string, opts: { acrossActs?: boolean } = {}): Map<string, number> {
  const count = (filter: (r: AutomapRule) => boolean) => {
    const byCode = new Map<string, Map<number, number>>();
    for (const rules of t.byKey.values())
      for (const r of rules) {
        if (!filter(r) || !r.cels.length) continue;
        const m = byCode.get(r.code) ?? byCode.set(r.code, new Map()).get(r.code)!;
        for (const c of r.cels) m.set(c.cel, (m.get(c.cel) ?? 0) + 1);
      }
    return new Map([...byCode].map(([code, m]) => [code, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  };
  const own = count((r) => r.level === level);
  // Then the same act's other levels ("1 Town" → "1 …"), so an Act 1 map doesn't get an Act 5 piece.
  const act = /^(\d)\s/.exec(level)?.[1];
  if (act) for (const [code, cel] of count((r) => r.level.startsWith(`${act} `))) if (!own.has(code)) own.set(code, cel);
  // Across acts only for levels without an act (mods' numbered level types), or when asked: in vanilla, a kind of tile
  // an act never puts on the automap (Act 1 trees) is left off on purpose.
  if (!act || opts.acrossActs) for (const [code, cel] of count(() => true)) if (!own.has(code)) own.set(code, cel);
  return own;
}

/** Suggestions for every tile of the map without an automap entry (walls always, floors when asked). */
export function suggestAutomap(t: AutomapTable, level: string, pieces: AutomapPiece[], opts: { floors: boolean }): AutomapSuggestion[] {
  const usual = usualCels(t, level);
  const groups = new Map<string, AutomapSuggestion>();
  for (const p of pieces) {
    if (p.rule || (p.layer === 'floor' && !opts.floors)) continue;
    const code = AUTOMAP_CODES[p.orientation];
    const cel = code ? usual.get(code) : undefined;
    if (cel === undefined) continue;
    const k = `${p.orientation}|${p.main}`;
    const g = groups.get(k) ?? groups.set(k, { code, orientation: p.orientation, style: p.main, seqs: [], count: 0, cel }).get(k)!;
    if (!g.seqs.includes(p.sub)) g.seqs.push(p.sub);
    g.count++;
  }
  return [...groups.values()].map((g) => ({ ...g, seqs: g.seqs.sort((a, b) => a - b) })).sort((a, b) => a.orientation - b.orientation || a.style - b.style);
}

/** Applies suggestions to AutoMap.txt: one row per run of consecutive sequences, in front of the level's other rows. */
export function applyAutomapSuggestions(doc: TxtTableDoc, level: string, suggestions: AutomapSuggestion[]): { doc: TxtTableDoc; rows: number } {
  const cols = celColumns(doc);
  const lines: string[][] = [];
  for (const s of suggestions) {
    for (let i = 0; i < s.seqs.length; ) {
      let j = i;
      while (j + 1 < s.seqs.length && s.seqs[j + 1] === s.seqs[j] + 1) j++;
      const line = Array<string>(doc.columns.length).fill('');
      line[0] = level;
      line[1] = s.code;
      line[2] = String(s.style);
      line[3] = String(s.seqs[i]);
      line[4] = String(s.seqs[j]);
      line[cols[0].type] = 'DS1 Studio';
      line[cols[0].cel] = String(s.cel);
      for (const c of cols.slice(1)) line[c.cel] = '-1';
      lines.push(line);
      i = j + 1;
    }
  }
  const rows = doc.rows.map((r) => r.slice());
  const first = rows.findIndex((r) => (r[0] ?? '').trim().toLowerCase() === level.toLowerCase());
  let at = first >= 0 ? first : rows.length;
  while (first < 0 && at > 0 && rows[at - 1].length === 1 && rows[at - 1][0] === '') at--;
  rows.splice(at, 0, ...lines);
  return { doc: { ...doc, rows }, rows: lines.length };
}
