import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpriteFrame } from '../formats/dc6';
import type { Palette } from '../formats/palette';
import { AUTOMAP_CODE_NAMES, AUTOMAP_CODES, describeRule, type AutomapPiece, type AutomapSuggestion, type AutomapTable } from '../game/automap';
import { kindOfCode, type AutomapKind, type AutomapStyle } from '../game/automapStyle';
import { AutomapLook } from './AutomapLook';
import { Modal } from './Dialogs';

/** The part of a cel with pixels in it (cels are tall with the piece at the bottom). */
function celBounds(frame: SpriteFrame): { x0: number; y0: number; w: number; h: number } {
  let x0 = frame.width;
  let y0 = frame.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++)
      if (frame.pixels[y * frame.width + x]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return x1 < 0 ? { x0: 0, y0: 0, w: frame.width, h: frame.height } : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * One MaxiMap cel: at `scale`, or with `fit` cropped to its pixels and enlarged to fit a `fit`-pixel box (crisp);
 * `tint` draws it in one colour (a kind's) instead of the game's.
 */
export function CelThumb({ frame, palette, scale = 2, title, fit, tint }: { frame: SpriteFrame | undefined; palette: Palette; scale?: number; title?: string; fit?: number; tint?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = frame && fit ? celBounds(frame) : null;
  useEffect(() => {
    const c = ref.current;
    if (!c || !frame) return;
    const b = box ?? { x0: 0, y0: 0, w: frame.width, h: frame.height };
    c.width = b.w;
    c.height = b.h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(b.w, b.h);
    const t = tint ? [1, 3, 5].map((i) => parseInt(tint.slice(i, i + 2), 16)) : null;
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < b.w; x++) {
        const p = frame.pixels[(y + b.y0) * frame.width + x + b.x0];
        if (!p) continue;
        img.data.set(t ? [t[0], t[1], t[2], 255] : [palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], (y * b.w + x) * 4);
      }
    ctx.putImageData(img, 0, 0);
  }, [frame, palette, tint, box?.x0, box?.y0, box?.w, box?.h]); // eslint-disable-line react-hooks/exhaustive-deps
  if (box) {
    const k = Math.max(1, Math.min(8, Math.floor(fit! / Math.max(box.w, box.h)) || 1));
    return <canvas ref={ref} className="cel-thumb fit" title={title} style={{ width: box.w * k, height: box.h * k }} />;
  }
  return <canvas ref={ref} className="cel-thumb" title={title} style={{ width: (frame?.width ?? 16) * scale, height: (frame?.height ?? 32) * scale }} />;
}

interface Props {
  table: AutomapTable;
  cels: SpriteFrame[];
  palette: Palette;
  level: string | null;
  onLevel: (level: string) => void;
  /** Every floor/wall tile with its automap piece. */
  pieces: AutomapPiece[];
  /** The selected cell, if one. */
  cell: { x: number; y: number } | null;
  canSave: boolean;
  hasSelection: boolean;
  onClearSelection: () => void;
  onSet: (piece: AutomapPiece, cel: number, scope: 'cell' | 'seq' | 'style') => void;
  /** Friendlier label for numeric level names (their LvlTypes name). */
  levelLabel?: (level: string) => string;
  /** Pending suggestions for tiles without an entry (previewed on the map), or null. */
  suggestions: AutomapSuggestion[] | null;
  onSuggest: (floors: boolean) => void;
  /** Change the suggested piece for every suggestion of one tile code. */
  onSuggestionCel: (code: string, cel: number) => void;
  /** Leave every suggestion of one tile code out. */
  onSkipCode: (code: string) => void;
  onApplySuggestions: () => void;
  onCancelSuggestions: () => void;
  /** Opens the full automap editor. */
  onOpenEditor: () => void;
  /** How the automap is drawn, and changing it. */
  style: AutomapStyle;
  onStyle: (s: AutomapStyle) => void;
  /** The category of a tile (floors: walkable or water). */
  kindOf?: (orientation: number, main: number, sub: number) => AutomapKind;
}

/** Shows which automap piece each tile uses (AutoMap.txt row + MaxiMap cel) and lets you pick a different one. */
export function AutomapPanel(props: Props) {
  const { table, cels, palette, level, onLevel, pieces, cell, canSave, onSet, levelLabel, suggestions } = props;
  const [picking, setPicking] = useState<AutomapPiece | null>(null);
  const [pickingWall, setPickingWall] = useState<AutomapPiece | null>(null);
  const [pickingCode, setPickingCode] = useState<AutomapSuggestion | null>(null);
  const [floors, setFloors] = useState(false);
  const floorsMissing = pieces.filter((p) => p.layer === 'floor' && !p.rule).length;
  const byCode = useMemo(() => {
    const m = new Map<string, { code: string; orientation: number; cel: number; tiles: number; rows: number; sample: AutomapSuggestion }>();
    for (const sg of suggestions ?? []) {
      const e = m.get(sg.code) ?? m.set(sg.code, { code: sg.code, orientation: sg.orientation, cel: sg.cel, tiles: 0, rows: 0, sample: sg }).get(sg.code)!;
      e.tiles += sg.count;
      e.rows++;
    }
    return [...m.values()];
  }, [suggestions]);
  const here = cell ? pieces.filter((p) => p.cellX === cell.x && p.cellY === cell.y) : [];
  // Only walls leave a hole: trees and props (also on wall layers) are often left off on purpose.
  const wallsMissing = pieces.filter((p) => !p.rule && (props.kindOf ? props.kindOf(p.orientation, p.main, p.sub) === 'walls' : p.layer === 'wall')).length;
  const shown = pieces.filter((p) => p.cel !== null).length;
  const kindCounts = useMemo(() => {
    const n: Partial<Record<AutomapKind, number>> = {};
    for (const p of pieces) {
      if (p.cel === null) continue;
      const k = props.kindOf ? props.kindOf(p.orientation, p.main, p.sub) : kindOfCode(AUTOMAP_CODES[p.orientation] ?? '');
      n[k] = (n[k] ?? 0) + 1;
    }
    return n;
  }, [pieces, props.kindOf]);
  return (
    <section className="panel">
      <div className="panel-header static">
        <span>Automap</span>
        <span className="muted small">
          {shown} pieces{wallsMissing ? ` · ${wallsMissing} walls not on it` : ''}
        </span>
      </div>
      <div className="panel-body">
        <label className="small">
          AutoMap.txt level{' '}
          <select value={level ?? ''} onChange={(e) => onLevel(e.target.value)}>
            {!level && <option value="">(pick one)</option>}
            {table.levels.map((l) => (
              <option key={l} value={l}>
                {levelLabel ? levelLabel(l) : l}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary ame-open" onClick={props.onOpenEditor}>
          Open automap editor…
        </button>
        <button className="btn ame-open" disabled={!canSave || !level || !props.hasSelection} onClick={props.onClearSelection}>
          Clear selected automap pieces…
        </button>
        <p className="muted small">Change or clear a piece at just the selected cell. Select several cells to clear their pieces together. Undo restores your changes.</p>
        <p className="muted small">
          What the map looks like on the in-game automap (Tab in game). Outlined walls have no AutoMap.txt entry and won&apos;t show. Select a cell to
          see and change its pieces.
        </p>
        <details className="am-look-box" open>
          <summary>Look</summary>
          <AutomapLook style={props.style} onChange={props.onStyle} counts={kindCounts} />
        </details>
        {!suggestions ? (
          <div className="am-suggest">
            <button className="btn" disabled={!level || (!wallsMissing && !(floors && floorsMissing))} onClick={() => props.onSuggest(floors)}>
              Suggest pieces for missing tiles
            </button>
            <label className="small">
              <input type="checkbox" checked={floors} onChange={(e) => setFloors(e.target.checked)} /> include floors ({floorsMissing})
            </label>
          </div>
        ) : (
          <div className="am-suggest-box">
            <div className="small">
              <b>Suggested automap</b> <span className="muted">(previewed on the map, outlined in cyan; nothing written yet)</span>
            </div>
            <div className="muted small">
              Each kind of tile gets the piece this level (or its act) normally uses. Kinds the act never shows on the automap (Act 1 trees, say) stay off.
            </div>
            {byCode.length ? (
              <table className="kv automap-rows">
                <tbody>
                  {byCode.map((g) => (
                    <tr key={g.code}>
                      <td>
                        <CelThumb frame={cels[g.cel]} palette={palette} />
                      </td>
                      <td>
                        <div>
                          <code>{g.code}</code> {AUTOMAP_CODE_NAMES[g.code] ?? ''}
                        </div>
                        <div className="muted small">
                          {g.tiles} tiles · {g.rows} style{g.rows === 1 ? '' : 's'} → piece {g.cel}
                        </div>
                        <button className="btn small" onClick={() => setPickingCode(g.sample)}>
                          Use another piece…
                        </button>{' '}
                        <button className="btn small" onClick={() => props.onSkipCode(g.code)} title="Leave these tiles off the automap">
                          Skip
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted small">Nothing to suggest: every tile already has an automap entry.</p>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={props.onCancelSuggestions}>
                Discard
              </button>
              <button className="btn primary" disabled={!canSave || !byCode.length} onClick={props.onApplySuggestions} title={canSave ? '' : 'No writable mod folder'}>
                Write to AutoMap.txt
              </button>
            </div>
          </div>
        )}
        {cell && here.length > 0 && !here.some((p) => /^w/.test(AUTOMAP_CODES[p.orientation] ?? '')) && (
          <p className="small muted am-nowall">
            This cell has no wall tile (a tree or roof stands where the wall would be), so no wall piece belongs to it. To draw one here, give one of its tiles a
            wall piece for this cell only:{' '}
            <button className="link" disabled={!canSave || !level} onClick={() => setPickingWall(here.find((p) => p.cel !== null) ?? here[0])}>
              choose a wall piece…
            </button>
          </p>
        )}
        {cell &&
          (here.length ? (
            <table className="kv automap-rows">
              <tbody>
                {here.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <CelThumb frame={p.cel !== null ? cels[p.cel] : undefined} palette={palette} />
                    </td>
                    <td>
                      <div>
                        <code>{AUTOMAP_CODES[p.orientation]}</code> {AUTOMAP_CODE_NAMES[AUTOMAP_CODES[p.orientation]] ?? ''} · style {p.main} · seq {p.sub}
                      </div>
                      <div className="muted small">
                        {p.rule ? `${describeRule(p.rule)} → cel ${p.rule.cels.map((c) => c.cel).join('/') || 'none'} (row ${p.rule.row + 2})` : 'No AutoMap.txt entry: not shown on the automap'}
                      </div>
                      <button className="btn small" disabled={!canSave || !level} onClick={() => setPicking(p)} title={canSave ? '' : 'No writable mod folder'}>
                        Change piece…
                      </button>{' '}
                      <button
                        className="btn small"
                        disabled={!canSave || !level || p.cel === null}
                        onClick={() => onSet(p, -1, 'cell')}
                        title={p.cel === null ? 'Not on the automap already' : 'Clear only this piece at the selected cell'}
                      >
                        Clear piece
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">This cell has no floor or wall tiles.</p>
          ))}
      </div>
      {pickingCode && level && (
        <CelPicker
          table={table}
          cels={cels}
          palette={palette}
          level={level}
          piece={{ cellX: 0, cellY: 0, orientation: pickingCode.orientation, main: pickingCode.style, sub: pickingCode.seqs[0] ?? 0, rule: null, cel: pickingCode.cel, layer: 'wall' }}
          hideScope
          title={`Piece for every suggested ${AUTOMAP_CODE_NAMES[pickingCode.code] ?? pickingCode.code} (${pickingCode.code})`}
          onClose={() => setPickingCode(null)}
          onPick={(cel) => {
            props.onSuggestionCel(pickingCode.code, cel);
            setPickingCode(null);
          }}
        />
      )}
      {pickingWall && level && (
        <CelPicker
          table={table}
          cels={cels}
          palette={palette}
          level={level}
          piece={pickingWall}
          startWith="walls"
          title={`A wall piece at cell ${pickingWall.cellX}, ${pickingWall.cellY} (drawn for its ${AUTOMAP_CODE_NAMES[AUTOMAP_CODES[pickingWall.orientation]] ?? AUTOMAP_CODES[pickingWall.orientation]} tile)`}
          onClose={() => setPickingWall(null)}
          onPick={(cel, scope) => {
            onSet(pickingWall, cel, scope);
            setPickingWall(null);
          }}
        />
      )}
      {picking && level && (
        <CelPicker
          table={table}
          cels={cels}
          palette={palette}
          level={level}
          piece={picking}
          onClose={() => setPicking(null)}
          onPick={(cel, scope) => {
            onSet(picking, cel, scope);
            setPicking(null);
          }}
        />
      )}
    </section>
  );
}

function CelPicker({ table, cels, palette, level, piece, onPick, onClose, hideScope, title, startWith }: {
  hideScope?: boolean;
  /** The list to open on (the pieces for this kind of tile by default). */
  startWith?: 'kind' | 'walls' | 'level' | 'all';
  title?: string;
  table: AutomapTable;
  cels: SpriteFrame[];
  palette: Palette;
  level: string;
  piece: AutomapPiece;
  onPick: (cel: number, scope: 'cell' | 'seq' | 'style') => void;
  onClose: () => void;
}) {
  const code = AUTOMAP_CODES[piece.orientation];
  // Cels this level already uses for the same kind of tile first, then the rest of the level's, then everything.
  const { sameKind, sameLevel, labels } = useMemo(() => {
    const sameKind = new Set<number>();
    const sameLevel = new Set<number>();
    const labels = new Map<number, string>();
    for (const rules of table.byKey.values())
      for (const r of rules) {
        for (const c of r.cels) if (c.label && !labels.has(c.cel)) labels.set(c.cel, c.label);
        if (r.level !== level) continue;
        for (const c of r.cels) (r.code === code ? sameKind : sameLevel).add(c.cel);
      }
    return { sameKind, sameLevel, labels };
  }, [table, level, code]);
  /** The pieces this level (else any level) uses for its walls: to draw a wall where a tree or roof stands. */
  const walls = useMemo(() => {
    const WALL = new Set(['wl', 'wr', 'wtlr', 'wtll', 'wtr', 'wbl', 'wbr', 'wld', 'wrd', 'wle', 'wre']);
    const mine = new Set<number>();
    const any = new Set<number>();
    for (const rules of table.byKey.values())
      for (const r of rules) {
        if (!WALL.has(r.code)) continue;
        for (const c of r.cels) (r.level === level ? mine : any).add(c.cel);
      }
    return mine.size ? mine : any;
  }, [table, level]);
  const [which, setWhich] = useState<'kind' | 'walls' | 'level' | 'all'>(startWith ?? 'kind');
  const [scope, setScope] = useState<'cell' | 'seq' | 'style'>('cell');
  const [filter, setFilter] = useState('');
  const list = (which === 'kind' ? [...sameKind] : which === 'walls' ? [...walls] : which === 'level' ? [...new Set([...sameKind, ...sameLevel])] : cels.map((_, i) => i))
    .sort((a, b) => a - b)
    .filter((c) => !filter || String(c) === filter.trim() || (labels.get(c) ?? '').toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal title={title ?? `Automap piece for ${code} · style ${piece.main} · seq ${piece.sub}`} onClose={onClose} wide>
      <div className="cel-toolbar small">
        <select value={which} onChange={(e) => setWhich(e.target.value as typeof which)}>
          <option value="kind">
            {level} · {AUTOMAP_CODE_NAMES[code] ?? code} pieces ({sameKind.size})
          </option>
          <option value="walls">Wall pieces ({walls.size}): draw a wall here</option>
          <option value="level">All {level} pieces</option>
          <option value="all">Every piece ({cels.length})</option>
        </select>
        <input className="small-input" placeholder="Filter by name or cel #" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {!hideScope && (
          <>
            <label>
              <input type="radio" checked={scope === 'cell'} onChange={() => setScope('cell')} /> Only this cell
            </label>
            <label>
              <input type="radio" checked={scope === 'seq'} onChange={() => setScope('seq')} /> All matching tiles (sequence {piece.sub})
            </label>
            <label>
              <input type="radio" checked={scope === 'style'} onChange={() => setScope('style')} /> All tiles of style {piece.main}
            </label>
          </>
        )}
      </div>
      <div className="cel-grid">
        <button className={`cel-cell cel-none${piece.cel === null ? ' active' : ''}`} onClick={() => onPick(-1, scope)} title="No automap piece: these tiles aren't drawn on the automap">
          <span className="cel-none-mark">∅</span>
          <span className="small">No piece</span>
          <span className="muted tiny">off the automap</span>
        </button>
        {list.map((c) => (
          <button key={c} className={`cel-cell${piece.cel === c ? ' active' : ''}`} onClick={() => onPick(c, scope)} title={`Cel ${c}${labels.get(c) ? ` · ${labels.get(c)}` : ''}`}>
            <CelThumb frame={cels[c]} palette={palette} scale={3} />
            <span className="mono small">{c}</span>
            <span className="muted tiny">{labels.get(c) ?? ''}</span>
          </button>
        ))}
        {!list.length && <p className="muted small">No pieces match.</p>}
      </div>
      <p className="muted small">{!hideScope && (scope === 'cell' ? 'Only this cell and layer will change. Save the map afterward. ' : 'This changes every matching tile on maps using this automap level. ')}Picking writes AutoMap.txt in your mod folder (original kept as .bak). The game reads the compiled automap.bin, so delete it or let your tools rebuild it.</p>
    </Modal>
  );
}
