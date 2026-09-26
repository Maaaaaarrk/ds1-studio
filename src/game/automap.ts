import { decodeTile } from '../formats/dt1';
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

/** Colours for matching tiles to automap pieces (average RGB of their visible pixels), when available. */
export interface AutomapColors {
  tile: (orientation: number, main: number, sub: number) => [number, number, number] | null;
  cel: (cel: number) => [number, number, number] | null;
  /** Every tile (main, sub) of an orientation in the map's libraries: references for look-alike matching. */
  keys?: (orientation: number) => [number, number][];
  /**
   * Whether another level's rules can describe this map's tile: its level type loads the DT1 the tile comes from.
   * (Tile numbers repeat across DT1s, so a rule written for another level's DT1 may mean a different tile.)
   */
  appliesTo?: (level: string, orientation: number, main: number, sub: number) => boolean;
  /** Look-alike references from elsewhere in the game (see `referenceTiles`), used after the map's own. */
  extraRefs?: ReferenceTile[];
  /** A tile's look as a 3×3 grid of average colours (null cells = transparent there), for look-alike matching. */
  signature?: (orientation: number, main: number, sub: number) => ([number, number, number] | null)[] | null;
}

type CelCounts = Map<number, number>;

/** Pieces used per tile code (and per code+style) by rules matching `filter`, with how often. */
function celUse(t: AutomapTable, filter: (r: AutomapRule) => boolean) {
  const byCode = new Map<string, CelCounts>();
  const byStyle = new Map<string, CelCounts>();
  const bump = (m: Map<string, CelCounts>, k: string, cel: number) => {
    const c = m.get(k) ?? m.set(k, new Map()).get(k)!;
    c.set(cel, (c.get(cel) ?? 0) + 1);
  };
  for (const rules of t.byKey.values())
    for (const r of rules) {
      if (!filter(r)) continue;
      for (const c of r.cels) {
        bump(byCode, r.code, c.cel);
        bump(byStyle, `${r.code}|${r.style}`, c.cel);
      }
    }
  return { byCode, byStyle };
}

/** How different two tiles look on average ("redmean" weighted RGB distance). */
function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/**
 * Suggestions for every tile of the map without an automap entry (walls always, floors when asked). Candidates come
 * from the closest source that has any: pieces this level already uses for the same code and style, then for the
 * same code, then the same act's levels (then, for mods' numbered level types, any level). Among the candidates the
 * piece whose colours best match the tile wins (so water tiles get water pieces and ground gets ground), falling back
 * to the most used one when colours aren't available.
 */
export function suggestAutomap(
  t: AutomapTable,
  level: string,
  pieces: AutomapPiece[],
  opts: { floors: boolean; colors?: AutomapColors },
  /** Receives the tiles ("orientation|style|sub") that look like tiles the game leaves off the automap. */
  out?: { leaveOff?: Set<string> },
): AutomapSuggestion[] {
  const act = /^(\d)\s/.exec(level)?.[1];
  const own = celUse(t, (r) => r.level === level);
  const sameAct = act ? celUse(t, (r) => r.level.startsWith(`${act} `)) : null;
  const anyLevel = act ? null : celUse(t, () => true);
  const candidates = (code: string, style: number): CelCounts | undefined =>
    own.byStyle.get(`${code}|${style}`) ?? own.byCode.get(code) ?? sameAct?.byCode.get(code) ?? anyLevel?.byCode.get(code);

  // Look-alike references: tiles of the same orientation in the map's libraries that this level's rules already
  // give a piece. A missing tile borrows the piece of the one it looks most like (water looks like water).
  type Sig = ([number, number, number] | null)[];
  const refs = new Map<number, { color: [number, number, number]; sig: Sig | null; cel: number; style: number; sub: number; rank: number }[]>();
  // Levels whose rules can describe this map's tiles: its own, then the same act's (or, for mods' numbered level
  // types, every level): maps often reuse vanilla DT1s, whose tiles vanilla levels already give pieces.
  const refLevels = [level, ...t.levels.filter((l) => l !== level && (act ? l.startsWith(`${act} `) : true))];
  const unknown = new Set(pieces.filter((p) => !p.rule).map((p) => `${p.orientation}|${p.main}|${p.sub}`));
  const hasCode = new Map<string, boolean>();
  const levelHasCode = (l: string, code: string) => {
    const k = `${l}|${code}`;
    if (!hasCode.has(k)) hasCode.set(k, [...t.byKey.values()].some((rules) => rules.some((r) => r.level === l && r.code === code)));
    return hasCode.get(k)!;
  };
  const sigDistance = (a: Sig, b: Sig) => {
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      d += x && y ? colorDistance(x, y) : x || y ? 120 : 0; // shape matters too: opaque where the other is empty
    }
    return d / a.length;
  };
  const refsFor = (orientation: number) => {
    if (!opts.colors?.keys) return [];
    let list = refs.get(orientation);
    if (!list) {
      list = [];
      const code = AUTOMAP_CODES[orientation];
      for (const [main, sub] of opts.colors.keys(orientation)) {
        // Tiles still waiting for a piece are the unknowns, not evidence of what the level leaves off.
        if (unknown.has(`${orientation}|${main}|${sub}`)) continue;
        // The first level that describes this tile decides its piece — or that it's left off the automap (-1): a
        // level with automap rows for this kind of tile that gives this one none shows nothing for it on purpose.
        let found: { cel: number; rank: number } | null = null;
        for (let i = 0; i < refLevels.length && !found; i++) {
          const l = refLevels[i];
          if (i > 0 && !opts.colors.appliesTo?.(l, orientation, main, sub)) continue;
          if (!levelHasCode(l, code)) continue;
          const rule = findRule(t, l, orientation, main, sub);
          found = { cel: rule?.cels[0]?.cel ?? -1, rank: i === 0 ? 0 : 1 };
        }
        if (!found) continue;
        const color = opts.colors.tile(orientation, main, sub);
        if (color) list.push({ color, sig: opts.colors.signature?.(orientation, main, sub) ?? null, cel: found.cel, style: main, sub, rank: found.rank });
      }
      // Game-wide look-alikes: only colour and layout compare (their tile numbers mean nothing here).
      for (const r of opts.colors.extraRefs ?? [])
        if (r.orientation === orientation) list.push({ color: r.color, sig: r.sig, cel: r.cel, style: -1, sub: -1, rank: 2 });
      refs.set(orientation, list);
    }
    return list;
  };

  const pick = (code: string, p: AutomapPiece): number | undefined => {
    const tileColor = opts.colors?.tile(p.orientation, p.main, p.sub);
    const references = tileColor ? refsFor(p.orientation) : [];
    if (tileColor && references.length) {
      const sig = opts.colors?.signature?.(p.orientation, p.main, p.sub) ?? null;
      let best = references[0];
      let bestD = Infinity;
      for (const r of references) {
        // Where colours sit on the tile (a 3×3 grid) when known, else its average; same style is a strong hint.
        // The very same tile described by another level wins outright; the map's own level beats borrowed ones.
        const same = r.style === p.main && r.sub === p.sub;
        const d = (sig && r.sig ? sigDistance(sig, r.sig) : colorDistance(tileColor, r.color)) - (r.style === p.main ? 25 : 0) - (same ? 1000 : 0) + r.rank * 10;
        if (d < bestD) [best, bestD] = [r, d];
      }
      return best.cel;
    }
    // Nothing to compare with. Walls: the level's usual piece for the kind. Floors: no guess — levels often show
    // only a few kinds of floor (Act 3's jungle: rivers and bridges), so the usual piece would be wrong for most.
    if (p.layer === 'floor') return undefined;
    const c = candidates(code, p.main);
    if (!c?.size) return undefined;
    return [...c].sort((a, b) => b[1] - a[1])[0][0];
  };

  const groups = new Map<string, AutomapSuggestion>();
  const seen = new Set<string>();
  const leaveOff = new Set<string>();
  for (const p of pieces) {
    if (p.rule || (p.layer === 'floor' && !opts.floors)) continue;
    const code = AUTOMAP_CODES[p.orientation];
    if (!code) continue;
    const tileKey = `${p.orientation}|${p.main}|${p.sub}`;
    const cel = pick(code, p);
    if (cel === undefined) continue;
    if (cel < 0) {
      leaveOff.add(tileKey);
      continue;
    }
    const k = `${p.orientation}|${p.main}|${cel}`;
    const g = groups.get(k) ?? groups.set(k, { code, orientation: p.orientation, style: p.main, seqs: [], count: 0, cel }).get(k)!;
    if (!seen.has(tileKey)) {
      seen.add(tileKey);
      g.seqs.push(p.sub);
    }
    g.count++;
  }
  const suggestions = [...groups.values()].map((g) => ({ ...g, seqs: g.seqs.sort((a, b) => a - b) })).sort((a, b) => a.orientation - b.orientation || a.style - b.style || a.cel - b.cel);
  if (out) out.leaveOff = leaveOff;
  return suggestions;
}

/** Average colour of a palette-indexed image's visible pixels (for matching tiles to automap pieces). */
export function averageColor(pixels: Uint8Array, palette: Uint8Array): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const p of pixels) {
    if (!p) continue;
    r += palette[p * 4];
    g += palette[p * 4 + 1];
    b += palette[p * 4 + 2];
    n++;
  }
  return n ? [r / n, g / n, b / n] : null;
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

/** A pending automap change for one tile: its pieces (Cel1..Cel4, picked at random in game), or none = hidden. */
export interface AutomapEdit {
  orientation: number;
  style: number;
  sub: number;
  cels: number[];
}

export const editKey = (orientation: number, style: number, sub: number) => `${orientation}|${style}|${sub}`;

/** The pieces a tile gets with pending edits applied: edit first, else its rule; [] = hidden, null = no entry. */
export function effectiveCels(t: AutomapTable, level: string, edits: Map<string, AutomapEdit>, orientation: number, style: number, sub: number): number[] | null {
  const e = edits.get(editKey(orientation, style, sub));
  if (e) return e.cels;
  const rule = findRule(t, level, orientation, style, sub);
  return rule ? rule.cels.map((c) => c.cel) : null;
}

/**
 * Writes pending edits into AutoMap.txt: per tile code and style, consecutive sequences with the same pieces become
 * one row, placed in front of the level's other rows so the game's first-match lookup uses them. Rows this editor
 * wrote before for the same sequences are replaced rather than piled up; everything else is left alone. A tile
 * with no pieces gets a row whose cels are all -1: deliberately not on the automap.
 */
export function applyAutomapEdits(doc: TxtTableDoc, level: string, edits: AutomapEdit[]): { doc: TxtTableDoc; rows: number } {
  const cols = celColumns(doc);
  const byGroup = new Map<string, AutomapEdit[]>();
  for (const e of edits) {
    const code = AUTOMAP_CODES[e.orientation];
    if (!code) continue;
    const k = `${code}|${e.style}`;
    (byGroup.get(k) ?? byGroup.set(k, []).get(k)!).push(e);
  }
  const lines: string[][] = [];
  const covered = new Map<string, Set<number>>(); // code|style → sequences now written
  for (const [k, list] of byGroup) {
    const [code, style] = k.split('|');
    const sorted = [...new Map(list.map((e) => [e.sub, e])).values()].sort((a, b) => a.sub - b.sub);
    covered.set(k, new Set(sorted.map((e) => e.sub)));
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      const sig = sorted[i].cels.join(',');
      while (j + 1 < sorted.length && sorted[j + 1].sub === sorted[j].sub + 1 && sorted[j + 1].cels.join(',') === sig) j++;
      const line = Array<string>(doc.columns.length).fill('');
      line[0] = level;
      line[1] = code;
      line[2] = style;
      line[3] = String(sorted[i].sub);
      line[4] = String(sorted[j].sub);
      cols.forEach((c, n) => {
        const cel = sorted[i].cels[n];
        line[c.type] = cel !== undefined ? 'DS1 Studio' : '';
        line[c.cel] = cel !== undefined ? String(cel) : '-1';
      });
      if (!sorted[i].cels.length) line[cols[0].type] = 'DS1 Studio (hidden)';
      lines.push(line);
      i = j + 1;
    }
  }
  // Drop this editor's earlier rows that the new ones fully replace.
  const lvl = level.trim().toLowerCase();
  const rows = doc.rows.filter((r) => {
    if ((r[0] ?? '').trim().toLowerCase() !== lvl || !/^DS1 Studio/.test((r[cols[0].type] ?? '').trim())) return true;
    const seqs = covered.get(`${(r[1] ?? '').trim().toLowerCase()}|${Number(r[2]) || 0}`);
    if (!seqs) return true;
    const start = Number(r[3]);
    const end = Number(r[4]) < 0 ? start : Number(r[4]);
    if (start < 0) return true;
    for (let s = start; s <= end; s++) if (!seqs.has(s)) return true;
    return false;
  });
  const first = rows.findIndex((r) => (r[0] ?? '').trim().toLowerCase() === lvl);
  let at = first >= 0 ? first : rows.length;
  while (first < 0 && at > 0 && rows[at - 1].length === 1 && rows[at - 1][0] === '') at--;
  rows.splice(at, 0, ...lines);
  return { doc: { ...doc, rows }, rows: lines.length };
}

/** Groups for the editor's list, by tile code. */
export const AUTOMAP_KINDS: { label: string; codes: string[] }[] = [
  { label: 'Floors', codes: ['fl'] },
  { label: 'Walls', codes: ['wl', 'wr'] },
  { label: 'Corners', codes: ['wtlr', 'wtll', 'wtr', 'wbl', 'wbr'] },
  { label: 'Doors', codes: ['wld', 'wrd'] },
  { label: 'Wall ends', codes: ['wle', 'wre'] },
  { label: 'Columns & props', codes: ['co'] },
  { label: 'Trees & objects', codes: ['tr'] },
  { label: 'Roofs', codes: ['rf'] },
  { label: 'Lower walls', codes: ['ld', 'lr', 'lf', 'ls'] },
  { label: 'Shadows', codes: ['sh'] },
];

/** Colour lookups for a map: tile colours from its library, piece colours from MaxiMap, both in the map's palette. */
export function automapColors(
  lib: {
    pick: (o: number, main: number, sub: number, seed: number) => import('../formats/dt1').Dt1Tile | null;
    entries?: () => { orientation: number; main: number; sub: number }[];
    sourceOf?: (tile: import('../formats/dt1').Dt1Tile) => { path: string } | null;
  },
  cels: SpriteFrame[],
  palette: Uint8Array,
  /** Level types (LvlTypes.txt), to know which AutoMap.txt levels load which DT1s. */
  levelTypes?: { table: AutomapTable; types: { id: number; name: string; act: number; files: string[] }[] },
): AutomapColors {
  const tiles = new Map<string, [number, number, number] | null>();
  // AutoMap.txt level → the DT1s its level type(s) load (normalised "act3/jungle/x.dt1").
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/?data\/global\/tiles\//i, '').toLowerCase();
  const levelFiles = new Map<string, Set<string>>();
  if (levelTypes)
    for (const lt of levelTypes.types) {
      const l = automapLevelFor(levelTypes.table, lt.name, lt.act || undefined, lt.id);
      if (!l) continue;
      const set = levelFiles.get(l) ?? levelFiles.set(l, new Set()).get(l)!;
      for (const f of lt.files) if (f) set.add(norm(f));
    }
  const sigs = new Map<string, ([number, number, number] | null)[] | null>();
  const pieces = new Map<number, [number, number, number] | null>();
  return {
    appliesTo: (level, o, main, sub) => {
      const files = levelFiles.get(level);
      const t = files && lib.pick(o, main, sub, 0);
      const src = t && lib.sourceOf?.(t);
      return !!src && files!.has(norm(src.path));
    },
    keys: (o) => lib.entries?.().filter((e) => e.orientation === o).map((e) => [e.main, e.sub] as [number, number]) ?? [],
    tile: (o, main, sub) => {
      const k = `${o}|${main}|${sub}`;
      if (!tiles.has(k)) {
        const t = lib.pick(o, main, sub, 0);
        const img = t ? decodeTile(t) : null;
        tiles.set(k, img ? averageColor(img.pixels, palette) : null);
      }
      return tiles.get(k)!;
    },
    signature: (o, main, sub) => {
      const k = `${o}|${main}|${sub}`;
      if (!sigs.has(k)) {
        const t = lib.pick(o, main, sub, 0);
        const img = t ? decodeTile(t) : null;
        if (!img) sigs.set(k, null);
        else {
          const out: ([number, number, number] | null)[] = [];
          for (let gy = 0; gy < 3; gy++)
            for (let gx = 0; gx < 3; gx++) {
              const x0 = Math.floor((gx * img.width) / 3);
              const x1 = Math.floor(((gx + 1) * img.width) / 3);
              const y0 = Math.floor((gy * img.height) / 3);
              const y1 = Math.floor(((gy + 1) * img.height) / 3);
              const cell: number[] = [];
              for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cell.push(img.pixels[y * img.width + x]);
              out.push(averageColor(Uint8Array.from(cell), palette));
            }
          sigs.set(k, out);
        }
      }
      return sigs.get(k)!;
    },
    cel: (cel) => {
      if (!pieces.has(cel)) pieces.set(cel, cels[cel] ? averageColor(cels[cel].pixels, palette) : null);
      return pieces.get(cel)!;
    },
  };
}

/** A tile somewhere in the game with the automap piece its level gives it, described by its look. */
export interface ReferenceTile {
  orientation: number;
  color: [number, number, number];
  sig: ([number, number, number] | null)[];
  cel: number;
}

/** A tile's look: 3×3 grid of average colours (null = transparent cell). */
export function tileSignature(img: { width: number; height: number; pixels: Uint8Array }, palette: Uint8Array): ([number, number, number] | null)[] {
  const out: ([number, number, number] | null)[] = [];
  for (let gy = 0; gy < 3; gy++)
    for (let gx = 0; gx < 3; gx++) {
      const x0 = Math.floor((gx * img.width) / 3);
      const x1 = Math.floor(((gx + 1) * img.width) / 3);
      const y0 = Math.floor((gy * img.height) / 3);
      const y1 = Math.floor(((gy + 1) * img.height) / 3);
      const cell: number[] = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cell.push(img.pixels[y * img.width + x]);
      out.push(averageColor(Uint8Array.from(cell), palette));
    }
  return out;
}

/**
 * Look-alike references from the game's other levels: every tile of the DT1s their level types load, with the piece
 * their AutoMap.txt rows give it (the DT1 is known, so the tile numbers are unambiguous). `levels` limits which
 * levels are used (e.g. the same act). Tiles are seen in their own act's palette, as in game.
 */
export async function referenceTiles(opts: {
  table: AutomapTable;
  types: { id: number; name: string; act: number; files: string[] }[];
  levels: (level: string) => boolean;
  loadDt1: (path: string) => Promise<import('../formats/dt1').Dt1 | null>;
  palette: (act: number) => Promise<Uint8Array>;
  onProgress?: (done: number, total: number) => void;
}): Promise<ReferenceTile[]> {
  const jobs: { level: string; act: number; file: string }[] = [];
  const seen = new Set<string>();
  for (const lt of opts.types) {
    const level = automapLevelFor(opts.table, lt.name, lt.act || undefined, lt.id);
    if (!level || !opts.levels(level)) continue;
    for (const f of lt.files) {
      if (!f) continue;
      const k = `${level}|${f.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      jobs.push({ level, act: Math.max(0, (lt.act || 1) - 1), file: `data/global/tiles/${f.replace(/\\/g, '/')}` });
    }
  }
  const out: ReferenceTile[] = [];
  let done = 0;
  const codeSets = new Map<string, Set<string>>();
  const codesOf = (level: string) => {
    let set = codeSets.get(level);
    if (!set) {
      set = new Set();
      for (const rules of opts.table.byKey.values()) for (const r of rules) if (r.level === level) set.add(r.code);
      codeSets.set(level, set);
    }
    return set;
  };
  for (const j of jobs) {
    const dt1 = await opts.loadDt1(j.file).catch(() => null);
    const palette = await opts.palette(Math.min(4, j.act));
    for (const t of dt1?.tiles ?? []) {
      const code = AUTOMAP_CODES[t.orientation];
      if (!code || !codesOf(j.level).has(code)) continue;
      const rule = findRule(opts.table, j.level, t.orientation, t.mainIndex, t.subIndex);
      const img = decodeTile(t);
      if (!img) continue;
      const color = averageColor(img.pixels, palette);
      // -1: this level shows nothing for the tile (it has rows for this kind of tile, just not this one).
      if (color) out.push({ orientation: t.orientation, color, sig: tileSignature(img, palette), cel: rule?.cels[0]?.cel ?? -1 });
    }
    opts.onProgress?.(++done, jobs.length);
  }
  return out;
}
