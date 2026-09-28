import { AUTOMAP_KIND_LIST, DEFAULT_AUTOMAP_STYLE, type AutomapKind, type AutomapStyle } from '../game/automapStyle';

/** A small picture of a kind of automap piece, in a colour: a wall run, a floor diamond, a tree, a roof. */
export function KindIcon({ kind, colour, size = 16 }: { kind: AutomapKind; colour: string; size?: number }) {
  const common = { fill: 'none', stroke: colour, strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg className="am-kind-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      {kind === 'walls' && (
        <>
          <path d="M2 11 L8 8 L14 11" {...common} />
          <path d="M2 11 L2 5 L8 2 L14 5 L14 11" {...common} strokeOpacity={0.55} />
        </>
      )}
      {kind === 'floors' && <path d="M8 3 L15 8 L8 13 L1 8 Z" {...common} fill={colour} fillOpacity={0.25} />}
      {kind === 'objects' && (
        <>
          <circle cx="8" cy="6" r="4" {...common} fill={colour} fillOpacity={0.25} />
          <path d="M8 10 L8 15" {...common} />
        </>
      )}
      {kind === 'other' && <path d="M1 12 L8 4 L15 12 Z" {...common} fill={colour} fillOpacity={0.25} />}
    </svg>
  );
}

/**
 * How the automap is drawn: kind colours or the game's, each kind shown or not in its colour, opacity, thickness, how
 * dark the map underneath is, and the outline of walls with no AutoMap.txt entry. Changes show at once.
 */
export function AutomapLook({ style, onChange, counts, compact = false }: { style: AutomapStyle; onChange: (s: AutomapStyle) => void; counts?: Partial<Record<AutomapKind, number>>; compact?: boolean }) {
  const set = (patch: Partial<AutomapStyle>) => onChange({ ...style, ...patch });
  const setKind = (k: AutomapKind, patch: Partial<AutomapStyle['kinds'][AutomapKind]>) => set({ kinds: { ...style.kinds, [k]: { ...style.kinds[k], ...patch } } });
  const byKind = style.colours === 'kind';
  return (
    <div className={`am-look${compact ? ' compact' : ''}`}>
      <div className="chips am-look-mode">
        <button className={`chip${byKind ? ' active' : ''}`} onClick={() => set({ colours: 'kind' })} title="Each kind of piece in its own colour: easy to tell apart">
          Colour by kind
        </button>
        <button className={`chip${!byKind ? ' active' : ''}`} onClick={() => set({ colours: 'game' })} title="The pieces' own colours, as the game draws them">
          Game colours
        </button>
      </div>
      <div className="am-look-kinds">
        {AUTOMAP_KIND_LIST.map((k) => (
          <label key={k.id} className={`am-look-kind${style.kinds[k.id].show ? '' : ' off'}`} title={k.hint}>
            <input type="checkbox" checked={style.kinds[k.id].show} onChange={(e) => setKind(k.id, { show: e.target.checked })} />
            <KindIcon kind={k.id} colour={style.kinds[k.id].colour} />
            <span className="am-look-name">{k.label}</span>
            {counts?.[k.id] !== undefined && <span className="muted small">{counts[k.id]}</span>}
            <input type="color" value={style.kinds[k.id].colour} disabled={!byKind} title={byKind ? `Colour of ${k.label.toLowerCase()}` : 'Colours follow the game (switch to Colour by kind)'} onChange={(e) => setKind(k.id, { colour: e.target.value })} />
          </label>
        ))}
      </div>
      <label className="am-look-row">
        <span>Opacity</span>
        <input type="range" min={10} max={100} value={Math.round(style.opacity * 100)} onChange={(e) => set({ opacity: Number(e.target.value) / 100 })} />
        <span className="mono small">{Math.round(style.opacity * 100)}%</span>
      </label>
      <label className="am-look-row" title="Thin as in game, or thicker to see them at any zoom">
        <span>Thickness</span>
        <input type="range" min={0} max={3} step={1} value={style.thickness} onChange={(e) => set({ thickness: Number(e.target.value) })} />
        <span className="mono small">{style.thickness ? `+${style.thickness}` : 'game'}</span>
      </label>
      {!compact && (
        <label className="am-look-row" title="How much the map under the automap is darkened">
          <span>Map under it</span>
          <input type="range" min={0} max={95} value={Math.round((0.95 - style.dim) * 100)} onChange={(e) => set({ dim: 0.95 - Number(e.target.value) / 100 })} />
          <span className="mono small">{Math.round((1 - style.dim / 0.95) * 100)}%</span>
        </label>
      )}
      <label className="am-look-kind" title="Outline walls with no AutoMap.txt entry: holes in the automap">
        <input type="checkbox" checked={style.missing} onChange={(e) => set({ missing: e.target.checked })} />
        <svg className="am-kind-icon" width={16} height={16} viewBox="0 0 16 16" aria-hidden>
          <path d="M8 3 L15 8 L8 13 L1 8 Z" fill="none" stroke={style.missingColour} strokeWidth={1.6} />
        </svg>
        <span className="am-look-name">Outline walls with no entry</span>
        <span />
        <input type="color" value={style.missingColour} disabled={!style.missing} onChange={(e) => set({ missingColour: e.target.value })} />
      </label>
      <button className="link small" onClick={() => onChange(DEFAULT_AUTOMAP_STYLE)}>
        reset look
      </button>
    </div>
  );
}
