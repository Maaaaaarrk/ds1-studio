import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpriteFrame } from '../formats/dc6';
import type { Palette } from '../formats/palette';
import { AUTOMAP_CODE_NAMES, AUTOMAP_CODES, describeRule, type AutomapPiece, type AutomapSuggestion, type AutomapTable } from '../game/automap';
import { Modal } from './Dialogs';

/** One MaxiMap cel drawn at `scale`. */
export function CelThumb({ frame, palette, scale = 2, title }: { frame: SpriteFrame | undefined; palette: Palette; scale?: number; title?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !frame) return;
    c.width = frame.width;
    c.height = frame.height;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(frame.width, frame.height);
    for (let i = 0; i < frame.pixels.length; i++) {
      const p = frame.pixels[i];
      if (!p) continue;
      img.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
  }, [frame, palette]);
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
  onSet: (piece: AutomapPiece, cel: number, scope: 'seq' | 'style') => void;
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
}

/** Shows which automap piece each tile uses (AutoMap.txt row + MaxiMap cel) and lets you pick a different one. */
export function AutomapPanel(props: Props) {
  const { table, cels, palette, level, onLevel, pieces, cell, canSave, onSet, levelLabel, suggestions } = props;
  const [picking, setPicking] = useState<AutomapPiece | null>(null);
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
  const wallsMissing = pieces.filter((p) => p.layer === 'wall' && !p.rule).length;
  const shown = pieces.filter((p) => p.cel !== null).length;
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
        <p className="muted small">
          What the map looks like on the in-game automap (Tab in game). Walls outlined in pink have no AutoMap.txt entry and won&apos;t show.
          Select a cell to see and change its pieces.
        </p>
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

function CelPicker({ table, cels, palette, level, piece, onPick, onClose, hideScope, title }: {
  hideScope?: boolean;
  title?: string;
  table: AutomapTable;
  cels: SpriteFrame[];
  palette: Palette;
  level: string;
  piece: AutomapPiece;
  onPick: (cel: number, scope: 'seq' | 'style') => void;
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
  const [which, setWhich] = useState<'kind' | 'level' | 'all'>('kind');
  const [scope, setScope] = useState<'seq' | 'style'>('seq');
  const [filter, setFilter] = useState('');
  const list = (which === 'kind' ? [...sameKind] : which === 'level' ? [...new Set([...sameKind, ...sameLevel])] : cels.map((_, i) => i))
    .sort((a, b) => a - b)
    .filter((c) => !filter || String(c) === filter.trim() || (labels.get(c) ?? '').toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal title={title ?? `Automap piece for ${code} · style ${piece.main} · seq ${piece.sub}`} onClose={onClose} wide>
      <div className="cel-toolbar small">
        <select value={which} onChange={(e) => setWhich(e.target.value as typeof which)}>
          <option value="kind">
            {level} · {AUTOMAP_CODE_NAMES[code] ?? code} pieces ({sameKind.size})
          </option>
          <option value="level">All {level} pieces</option>
          <option value="all">Every piece ({cels.length})</option>
        </select>
        <input className="small-input" placeholder="Filter by name or cel #" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {!hideScope && (
          <>
            <label>
              <input type="radio" checked={scope === 'seq'} onChange={() => setScope('seq')} /> this sequence ({piece.sub}) only
            </label>
            <label>
              <input type="radio" checked={scope === 'style'} onChange={() => setScope('style')} /> every sequence of style {piece.main}
            </label>
          </>
        )}
      </div>
      <div className="cel-grid">
        {list.map((c) => (
          <button key={c} className={`cel-cell${piece.cel === c ? ' active' : ''}`} onClick={() => onPick(c, scope)} title={`Cel ${c}${labels.get(c) ? ` · ${labels.get(c)}` : ''}`}>
            <CelThumb frame={cels[c]} palette={palette} scale={3} />
            <span className="mono small">{c}</span>
            <span className="muted tiny">{labels.get(c) ?? ''}</span>
          </button>
        ))}
        {!list.length && <p className="muted small">No pieces match.</p>}
      </div>
      <p className="muted small">Picking writes AutoMap.txt in your mod folder (original kept as .bak). The game reads the compiled automap.bin, so delete it or let your tools rebuild it.</p>
    </Modal>
  );
}
