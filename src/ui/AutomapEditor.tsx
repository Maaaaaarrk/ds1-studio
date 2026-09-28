import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SpriteFrame } from '../formats/dc6';
import type { Palette } from '../formats/palette';
import {
  AUTOMAP_CODE_NAMES,
  AUTOMAP_CODES,
  AUTOMAP_KINDS,
  automapCellOrigin,
  automapPieces,
  describeRule,
  editKey,
  findRule,
  suggestAutomap,
  type AutomapColors,
  type AutomapEdit,
  type AutomapTable,
} from '../game/automap';
import type { OpenMap } from '../game/openMap';
import { CelThumb } from './AutomapPanel';
import { Thumb } from './TilePalette';

interface Props {
  map: OpenMap;
  table: AutomapTable;
  cels: SpriteFrame[];
  palette: Palette;
  level: string;
  onLevel: (level: string) => void;
  levelLabel: (level: string) => string;
  canSave: boolean;
  onSave: (edits: AutomapEdit[]) => Promise<void>;
  /** Colours and look-alike references for suggestions (may take a moment the first time). */
  makeColors: () => Promise<AutomapColors | undefined>;
  onClose: () => void;
}

/** One kind of tile on the map (same orientation / style / sequence), with where it is. */
interface Group {
  key: string;
  orientation: number;
  style: number;
  sub: number;
  layer: 'floor' | 'wall';
  cells: [number, number][];
}

type Status = 'shown' | 'hidden' | 'missing';
type Filter = 'all' | 'missing' | 'changed' | 'hidden';

const statusOf = (cels: number[] | null): Status => (cels === null ? 'missing' : cels.length ? 'shown' : 'hidden');

/**
 * The automap editor: every kind of tile the map uses, what the automap draws for it (from AutoMap.txt), a live
 * preview of the whole automap, and a piece gallery to change it. Nothing is written until "Save".
 */
export function AutomapEditor({ map, table, cels, palette, level, onLevel, levelLabel, canSave, onSave, makeColors, onClose }: Props) {
  const [edits, setEdits] = useState<Map<string, AutomapEdit>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lastClicked = useRef<string | null>(null);

  // A new level starts over.
  useEffect(() => {
    setEdits(new Map());
    setSelected(new Set());
  }, [level]);

  const pieces = useMemo(() => automapPieces(map.ds1, table, level), [map, table, level]);
  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    for (const p of pieces) {
      const k = editKey(p.orientation, p.main, p.sub);
      const g = m.get(k) ?? m.set(k, { key: k, orientation: p.orientation, style: p.main, sub: p.sub, layer: p.layer, cells: [] }).get(k)!;
      g.cells.push([p.cellX, p.cellY]);
    }
    return [...m.values()].sort((a, b) => a.orientation - b.orientation || a.style - b.style || a.sub - b.sub);
  }, [pieces]);

  const fileCels = useCallback(
    (g: Group): number[] | null => {
      const r = findRule(table, level, g.orientation, g.style, g.sub);
      return r ? r.cels.map((c) => c.cel) : null;
    },
    [table, level],
  );
  const celsOf = useCallback((g: Group): number[] | null => edits.get(g.key)?.cels ?? fileCels(g), [edits, fileCels]);

  const counts = useMemo(() => {
    const c = { shown: 0, hidden: 0, missing: 0 };
    for (const g of groups) c[statusOf(edits.get(g.key)?.cels ?? fileCels(g))] += g.cells.length;
    return c;
  }, [groups, edits, fileCels]);

  const q = query.trim().toLowerCase();
  const visible = groups.filter((g) => {
    const code = AUTOMAP_CODES[g.orientation] ?? '';
    const st = statusOf(celsOf(g));
    if (filter === 'missing' && st !== 'missing') return false;
    if (filter === 'hidden' && st !== 'hidden') return false;
    if (filter === 'changed' && !edits.has(g.key)) return false;
    return !q || `${code} ${AUTOMAP_CODE_NAMES[code] ?? ''} ${g.style}/${g.sub}`.toLowerCase().includes(q);
  });
  const ordered = AUTOMAP_KINDS.map((k) => ({ ...k, items: visible.filter((g) => k.codes.includes(AUTOMAP_CODES[g.orientation] ?? '')) })).filter((k) => k.items.length);
  const flat = ordered.flatMap((k) => (collapsed.has(k.label) ? [] : k.items));

  const click = (g: Group, e: React.MouseEvent) => {
    setSelected((prev) => {
      if (e.shiftKey && lastClicked.current) {
        const a = flat.findIndex((x) => x.key === lastClicked.current);
        const b = flat.findIndex((x) => x.key === g.key);
        if (a >= 0 && b >= 0) {
          const next = new Set(prev);
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(flat[i].key);
          return next;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(g.key)) next.delete(g.key);
        else next.add(g.key);
        return next;
      }
      return new Set([g.key]);
    });
    lastClicked.current = g.key;
  };

  const sel = groups.filter((g) => selected.has(g.key));
  const setCels = (targets: Group[], value: number[] | ((current: number[] | null) => number[])) =>
    setEdits((prev) => {
      const next = new Map(prev);
      for (const g of targets) {
        const v = typeof value === 'function' ? value(celsOf(g)) : value;
        const file = fileCels(g);
        if (file && file.join(',') === v.join(',')) next.delete(g.key);
        else next.set(g.key, { orientation: g.orientation, style: g.style, sub: g.sub, cels: v });
      }
      return next;
    });
  const revert = (targets: Group[]) =>
    setEdits((prev) => {
      const next = new Map(prev);
      for (const g of targets) next.delete(g.key);
      return next;
    });
  const suggestFor = async (targets: Group[]) => {
    setMessage('Analysing tiles: comparing them with tiles this level (and the rest of the game) already puts on the automap…');
    const colors = await makeColors();
    const missing = pieces.filter((p) => targets.some((g) => g.orientation === p.orientation && g.style === p.main && g.sub === p.sub));
    const out: { leaveOff?: Set<string> } = {};
    const s = suggestAutomap(table, level, missing.map((p) => ({ ...p, rule: null })), { floors: true, colors }, out);
    const bySeq = new Map<string, number>();
    for (const x of s) for (const q of x.seqs) bySeq.set(`${x.orientation}|${x.style}|${q}`, x.cel);
    const pieceFor = targets.filter((g) => bySeq.has(g.key));
    const off = targets.filter((g) => !bySeq.has(g.key) && out.leaveOff?.has(g.key));
    for (const g of pieceFor) setCels([g], [bySeq.get(g.key)!]);
    if (off.length) setCels(off, []);
    const none = targets.length - pieceFor.length - off.length;
    setMessage(
      `Suggested: ${pieceFor.length} tile kind${pieceFor.length === 1 ? '' : 's'} get a piece` +
        (off.length ? `, ${off.length} look like tiles the level leaves off the automap (marked hidden)` : '') +
        (none ? `, ${none} without a confident match (left as they are)` : '') +
        '. Review, then save.',
    );
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave([...edits.values()]);
      setEdits(new Map());
      setMessage('Saved to AutoMap.txt');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tileOf = (g: Group) => map.lib.pick(g.orientation, g.style, g.sub, 0);
  return (
    <div className="modal-backdrop">
      <div className="modal am-editor" role="dialog" aria-label="Automap editor" onKeyDown={(e) => e.stopPropagation()}>
        <div className="ame-head">
          <div className="modal-title">Automap editor</div>
          <label className="small">
            AutoMap.txt level{' '}
            <select value={level} onChange={(e) => (!edits.size || window.confirm('Discard the unsaved automap changes?')) && onLevel(e.target.value)}>
              {(table.levels.includes(level) ? table.levels : [level, ...table.levels]).map((l) => (
                <option key={l} value={l}>
                  {levelLabel(l)}
                  {table.levels.includes(l) ? '' : ' (new: no entries yet)'}
                </option>
              ))}
            </select>
          </label>
          <span className="ame-stat shown">{counts.shown} shown</span>
          <span className="ame-stat hidden">{counts.hidden} hidden</span>
          <span className="ame-stat missing">{counts.missing} missing</span>
          <span className="muted small ame-help">
            <b className="ame-pink">Missing</b> = no AutoMap.txt entry, so the automap draws nothing there. Give it a piece, or mark it <b>hidden</b> if it
            shouldn&apos;t show (like Act 1&apos;s trees).
          </span>
        </div>
        <div className="ame-body">
          {/* Tile kinds */}
          <div className="ame-list">
            <div className="ame-list-tools">
              <input className="search small-input" placeholder="Search code, name, style/seq…" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="chips">
                {(['all', 'missing', 'changed', 'hidden'] as Filter[]).map((f) => (
                  <button key={f} className={`chip${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
                    {f === 'all' ? 'All' : f === 'missing' ? 'Missing' : f === 'changed' ? `Changed (${edits.size})` : 'Hidden'}
                  </button>
                ))}
              </div>
              <div className="ame-sel-tools small">
                <button className="link" onClick={() => setSelected(new Set(flat.map((g) => g.key)))}>
                  select all shown
                </button>
                {' · '}
                <button className="link" onClick={() => setSelected(new Set(flat.filter((g) => statusOf(celsOf(g)) === 'missing').map((g) => g.key)))}>
                  select missing
                </button>
                {selected.size > 0 && (
                  <>
                    {' · '}
                    <button className="link" onClick={() => setSelected(new Set())}>
                      clear ({selected.size})
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="ame-rows">
              {ordered.map((k) => (
                <div key={k.label}>
                  <button
                    className="ame-kind"
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c);
                        if (n.has(k.label)) n.delete(k.label);
                        else n.add(k.label);
                        return n;
                      })
                    }
                  >
                    <span>{collapsed.has(k.label) ? '▸' : '▾'}</span> {k.label}
                    <span className="muted small">
                      {k.items.length} kind{k.items.length === 1 ? '' : 's'} · {k.items.reduce((n, g) => n + g.cells.length, 0)} tiles
                    </span>
                  </button>
                  {!collapsed.has(k.label) &&
                    k.items.map((g) => {
                      const c = celsOf(g);
                      const st = statusOf(c);
                      const tile = tileOf(g);
                      const code = AUTOMAP_CODES[g.orientation];
                      return (
                        <div key={g.key} className={`ame-row${selected.has(g.key) ? ' selected' : ''}${edits.has(g.key) ? ' changed' : ''}`} onClick={(e) => click(g, e)}>
                          <div className="ame-tile">{tile ? <Thumb tile={tile} palette={palette} /> : null}</div>
                          <div className="ame-what">
                            <div>
                              <code>{code}</code> <span className="small">{AUTOMAP_CODE_NAMES[code] ?? ''}</span>
                            </div>
                            <div className="muted small">
                              style {g.style} · seq {g.sub} · {g.cells.length} on map
                            </div>
                          </div>
                          <div className={`ame-piece ${st}`}>
                            {st === 'shown' ? (
                              c!.map((cel, i) => <CelThumb key={i} frame={cels[cel]} palette={palette} scale={1.5} title={`piece ${cel}`} />)
                            ) : (
                              <span className={`ame-badge ${st}`}>{st}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              ))}
              {!ordered.length && <p className="muted small pad">Nothing matches.</p>}
            </div>
          </div>

          {/* Preview */}
          <AutomapPreview
            map={map}
            groups={groups}
            celsOf={celsOf}
            cels={cels}
            palette={palette}
            selected={selected}
            onPick={(keys, add) =>
              setSelected((prev) => {
                const next = add ? new Set(prev) : new Set<string>();
                for (const k of keys) next.add(k);
                return next;
              })
            }
          />

          {/* Piece editor */}
          <PiecePanel
            table={table}
            level={level}
            cels={cels}
            palette={palette}
            selection={sel}
            celsOf={celsOf}
            fileCels={fileCels}
            edited={(g) => edits.has(g.key)}
            onSet={(value) => setCels(sel, value)}
            onRevert={() => revert(sel)}
            onSuggest={() => void suggestFor(sel)}
          />
        </div>
        <div className="modal-actions">
          <span className="muted small ame-foot">
            {message ??
              (edits.size
                ? `${edits.size} unsaved change${edits.size === 1 ? '' : 's'}. Saving writes AutoMap.txt in your mod folder (original kept as .bak); rebuild automap.bin for the game to see it.`
                : 'Click tile kinds on the left (Shift/Ctrl for several) or spots on the preview, then choose pieces on the right.')}
          </span>
          <button className="btn" disabled={!edits.size} onClick={() => window.confirm('Discard all unsaved automap changes?') && setEdits(new Map())}>
            Discard
          </button>
          <button className="btn" onClick={() => (!edits.size || window.confirm('Close without saving your automap changes?')) && onClose()}>
            Close
          </button>
          <button className="btn primary" disabled={!canSave || !edits.size || busy} onClick={() => void save()} title={canSave ? '' : 'No writable mod folder'}>
            {busy ? 'Saving…' : `Save to AutoMap.txt${edits.size ? ` (${edits.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function PiecePanel({
  table,
  level,
  cels,
  palette,
  selection,
  celsOf,
  fileCels,
  edited,
  onSet,
  onRevert,
  onSuggest,
}: {
  table: AutomapTable;
  level: string;
  cels: SpriteFrame[];
  palette: Palette;
  selection: Group[];
  celsOf: (g: Group) => number[] | null;
  fileCels: (g: Group) => number[] | null;
  edited: (g: Group) => boolean;
  onSet: (value: number[] | ((current: number[] | null) => number[])) => void;
  onRevert: () => void;
  onSuggest: () => void;
}) {
  const [which, setWhich] = useState<'kind' | 'level' | 'act' | 'all'>('kind');
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<'replace' | 'variant'>('replace');
  const codes = [...new Set(selection.map((g) => AUTOMAP_CODES[g.orientation]))];
  const act = /^(\d)\s/.exec(level)?.[1];
  const { lists, labels } = useMemo(() => {
    const kind = new Set<number>();
    const lvl = new Set<number>();
    const actSet = new Set<number>();
    const labels = new Map<number, string>();
    for (const rules of table.byKey.values())
      for (const r of rules) {
        for (const c of r.cels) if (c.label && !labels.has(c.cel)) labels.set(c.cel, c.label);
        const sameAct = act ? r.level.startsWith(`${act} `) : r.level === level;
        if (r.level === level) for (const c of r.cels) lvl.add(c.cel);
        if (sameAct) for (const c of r.cels) actSet.add(c.cel);
        if ((r.level === level || sameAct) && codes.includes(r.code)) for (const c of r.cels) kind.add(c.cel);
      }
    return { lists: { kind, level: lvl, act: actSet }, labels };
  }, [table, level, act, codes.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!selection.length) {
    return (
      <div className="ame-panel">
        <div className="field-label">Piece</div>
        <p className="muted small">
          Select one or more tile kinds on the left, or click the map preview. Then pick the automap piece they should draw — or hide them from the automap.
        </p>
        <div className="ame-legend small">
          <div>
            <span className="ame-badge missing">missing</span> no AutoMap.txt entry: drawn as nothing (pink on the preview)
          </div>
          <div>
            <span className="ame-badge hidden">hidden</span> deliberately not on the automap
          </div>
          <div>Up to 4 pieces per tile: the game picks one at random for each tile, for variety.</div>
        </div>
      </div>
    );
  }

  const shared = (() => {
    const first = celsOf(selection[0]);
    return selection.every((g) => (celsOf(g) ?? []).join(',') === (first ?? []).join(',')) ? first : undefined;
  })();
  const pool = which === 'all' ? cels.map((_, i) => i) : [...(which === 'kind' ? lists.kind : which === 'level' ? lists.level : lists.act)];
  const shown = pool
    .sort((a, b) => a - b)
    .filter((c) => !filter || String(c) === filter.trim() || (labels.get(c) ?? '').toLowerCase().includes(filter.toLowerCase()));
  const one = selection.length === 1 ? selection[0] : null;
  const rule = one ? findRule(table, level, one.orientation, one.style, one.sub) : null;

  return (
    <div className="ame-panel">
      <div className="field-label">
        {one ? (
          <>
            <code>{AUTOMAP_CODES[one.orientation]}</code> style {one.style} · seq {one.sub}
          </>
        ) : (
          `${selection.length} tile kinds selected`
        )}
      </div>
      <div className="muted small">
        {one
          ? rule
            ? `In AutoMap.txt: ${describeRule(rule)} (row ${rule.row + 2})${edited(one) ? ' — changed, not saved yet' : ''}`
            : `No AutoMap.txt entry${edited(one) ? ' — changed, not saved yet' : ''}`
          : `${selection.filter(edited).length} changed · ${selection.filter((g) => fileCels(g) === null).length} missing in the file`}
      </div>
      <div className="ame-slots">
        {shared === undefined ? (
          <span className="muted small">Selected kinds use different pieces; picking one sets them all.</span>
        ) : shared === null ? (
          <span className="ame-badge missing">missing</span>
        ) : shared.length === 0 ? (
          <span className="ame-badge hidden">hidden</span>
        ) : (
          shared.map((cel, i) => (
            <div key={i} className="ame-slot">
              <CelThumb frame={cels[cel]} palette={palette} scale={3} title={`piece ${cel}`} />
              <span className="mono small">{cel}</span>
              <button className="icon-btn" title="Remove this piece" onClick={() => onSet((cur) => (cur ?? []).filter((_, n) => n !== i))}>
                ×
              </button>
            </div>
          ))
        )}
      </div>
      <div className="ame-actions">
        <button className="btn small" onClick={() => onSet([])} title="Leave this tile off the automap: no AutoMap.txt row for it, as the game does for tiles it does not draw">
          Hide on automap
        </button>
        <button className="btn small" onClick={onSuggest} title="The piece this level/act normally uses for this kind of tile">
          Suggest
        </button>
        <button className="btn small" disabled={!selection.some(edited)} onClick={onRevert} title="Back to what AutoMap.txt says">
          Revert
        </button>
      </div>
      <div className="ame-gallery-tools small">
        <label>
          <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> click sets the piece
        </label>
        <label>
          <input type="radio" checked={mode === 'variant'} onChange={() => setMode('variant')} /> click adds a random variant (max 4)
        </label>
      </div>
      <div className="ame-gallery-tools">
        <select className="small" value={which} onChange={(e) => setWhich(e.target.value as typeof which)}>
          <option value="kind">Pieces for this kind of tile ({lists.kind.size})</option>
          <option value="level">All of {level}&apos;s pieces ({lists.level.size})</option>
          {act && <option value="act">All Act {act} pieces ({lists.act.size})</option>}
          <option value="all">Every piece ({cels.length})</option>
        </select>
        <input className="small-input" placeholder="name or #" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="ame-gallery">
        {shown.map((c) => (
          <button
            key={c}
            className={`cel-cell${shared?.includes(c) ? ' active' : ''}`}
            title={`Piece ${c}${labels.get(c) ? ` · ${labels.get(c)}` : ''}`}
            onClick={() => onSet(mode === 'replace' ? [c] : (cur) => [...(cur ?? []).filter((x) => x !== c), c].slice(-4))}
          >
            <CelThumb frame={cels[c]} palette={palette} scale={2.5} />
            <span className="mono small">{c}</span>
            <span className="muted tiny">{labels.get(c) ?? ''}</span>
          </button>
        ))}
        {!shown.length && <p className="muted small">No pieces here — try “Every piece”.</p>}
      </div>
    </div>
  );
}

/** The whole automap with pending changes, zoomable; selected kinds outlined; click to select what's there. */
function AutomapPreview({
  map,
  groups,
  celsOf,
  cels,
  palette,
  selected,
  onPick,
}: {
  map: OpenMap;
  groups: Group[];
  celsOf: (g: Group) => number[] | null;
  cels: SpriteFrame[];
  palette: Palette;
  selected: Set<string>;
  onPick: (keys: string[], add: boolean) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: 400 });
  const [view, setView] = useState<{ zoom: number; x: number; y: number } | null>(null);
  const pan = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const { width, height } = map.ds1;
  const ox = height * 8 + 16;
  const oy = 40;
  const W = (width + height) * 8 + 32;
  const H = (width + height) * 4 + 56;

  // The automap image (automap pixels), rebuilt when pieces change.
  const image = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    for (const g of groups) {
      const list = celsOf(g);
      if (!list?.length) continue;
      for (const [cx, cy] of g.cells) {
        const f = cels[list[(cx * 7 + cy * 13) % list.length]];
        if (!f) continue;
        const [ax, ay] = automapCellOrigin(cx, cy);
        const x0 = ox + ax - 8 + f.offsetX;
        const y0 = oy + ay + 8 + f.offsetY;
        for (let y = 0; y < f.height; y++)
          for (let x = 0; x < f.width; x++) {
            const p = f.pixels[y * f.width + x];
            if (!p) continue;
            const X = x0 + x;
            const Y = y0 + y;
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            img.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], (Y * W + X) * 4);
          }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }, [groups, celsOf, cels, palette, W, H, ox]);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = Math.min(size.w / W, size.h / H) * 0.96;
  const v = view ?? { zoom: fit, x: W / 2, y: H / 2 };

  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.save();
    ctx.translate(size.w / 2 - v.x * v.zoom, size.h / 2 - v.y * v.zoom);
    ctx.scale(v.zoom, v.zoom);
    // The map's outline, faintly.
    const corner = (cx: number, cy: number): [number, number] => {
      const [ax, ay] = automapCellOrigin(cx, cy);
      return [ox + ax, oy + ay];
    };
    ctx.beginPath();
    for (const [i, [cx, cy]] of ([[0, 0], [width, 0], [width, height], [0, height]] as [number, number][]).entries()) {
      const [x, y] = corner(cx, cy);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fill();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0);
    const diamond = (cx: number, cy: number) => {
      const [x, y] = corner(cx, cy);
      ctx.moveTo(x, y);
      ctx.lineTo(x + 8, y + 4);
      ctx.lineTo(x, y + 8);
      ctx.lineTo(x - 8, y + 4);
      ctx.closePath();
    };
    const lw = 1.5 / v.zoom;
    // Missing (pink) and selected (gold) outlines.
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(255, 90, 200, 0.85)';
    ctx.beginPath();
    for (const g of groups) if (g.layer === 'wall' && celsOf(g) === null) for (const [cx, cy] of g.cells) diamond(cx, cy);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 210, 90, 1)';
    ctx.fillStyle = 'rgba(255, 210, 90, 0.25)';
    ctx.beginPath();
    for (const g of groups) if (selected.has(g.key)) for (const [cx, cy] of g.cells) diamond(cx, cy);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }, [size, v.zoom, v.x, v.y, image, groups, selected, celsOf, width, height, ox]);

  const latest = useRef({ v });
  latest.current = { v };
  useEffect(() => {
    const el = wrap.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = latest.current.v;
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const z = Math.max(0.3, Math.min(24, cur.zoom * Math.exp(-e.deltaY * 0.0025)));
      const ix = cur.x + (sx - r.width / 2) / cur.zoom;
      const iy = cur.y + (sy - r.height / 2) / cur.zoom;
      setView({ zoom: z, x: ix - (sx - r.width / 2) / z, y: iy - (sy - r.height / 2) / z });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const cellAt = (sx: number, sy: number): [number, number] => {
    const ax = v.x + (sx - size.w / 2) / v.zoom - ox;
    const ay = v.y + (sy - size.h / 2) / v.zoom - oy - 4; // diamond centre
    return [Math.floor((ax / 8 + ay / 4) / 2 + 0.5), Math.floor((ay / 4 - ax / 8) / 2 + 0.5)];
  };

  return (
    <div className="ame-preview">
      <div className="ame-preview-bar small">
        <span className="muted">Automap preview (with your changes) · wheel to zoom, drag to pan, click to select</span>
        <button className="btn small" onClick={() => setView(null)}>
          Fit
        </button>
      </div>
      <div
        ref={wrap}
        className="ame-canvas"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          pan.current = { px: e.clientX, py: e.clientY, x: v.x, y: v.y, moved: false };
        }}
        onPointerMove={(e) => {
          const p = pan.current;
          if (!p) return;
          if (Math.abs(e.clientX - p.px) + Math.abs(e.clientY - p.py) > 3) p.moved = true;
          if (p.moved) setView({ zoom: v.zoom, x: p.x - (e.clientX - p.px) / v.zoom, y: p.y - (e.clientY - p.py) / v.zoom });
        }}
        onPointerUp={(e) => {
          const p = pan.current;
          pan.current = null;
          if (!p || p.moved) return;
          const r = wrap.current!.getBoundingClientRect();
          const [cx, cy] = cellAt(e.clientX - r.left, e.clientY - r.top);
          const keys = groups.filter((g) => g.cells.some(([x, y]) => x === cx && y === cy)).map((g) => g.key);
          if (keys.length) onPick(keys, e.shiftKey || e.ctrlKey);
        }}
      >
        <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
      </div>
    </div>
  );
}
