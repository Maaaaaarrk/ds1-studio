import { useEffect, useState } from 'react';
import { AUTOMAP_KIND_LIST, AUTOMAP_PARTS, AUTOMAP_RECOLOUR, DEFAULT_AUTOMAP_STYLE, lookOf, type AutomapKind, type AutomapLookOf, type AutomapStyle } from '../game/automapStyle';

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const toRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A colour by picker, hex (#rrggbb, #rgb or rrggbb) or red/green/blue 0-255. */
export function ColourField({ value, onChange, disabled = false }: { value: string; onChange: (hex: string) => void; disabled?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commitHex = (t: string) => {
    let h = t.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, (c) => c + c);
    if (/^[0-9a-f]{6}$/i.test(h)) onChange(`#${h.toLowerCase()}`);
    else setText(value);
  };
  const rgb = toRgb(value);
  return (
    <span className="colour-field">
      <input type="color" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} title="Pick a colour" />
      <input
        className="colour-hex mono"
        value={text}
        disabled={disabled}
        spellCheck={false}
        maxLength={7}
        title="Hex: #rrggbb"
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commitHex(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commitHex((e.target as HTMLInputElement).value)}
      />
      {(['R', 'G', 'B'] as const).map((c, i) => (
        <label key={c} className="colour-chan" title={`${['Red', 'Green', 'Blue'][i]} 0-255`}>
          <span className="tiny muted">{c}</span>
          <input
            type="number"
            min={0}
            max={255}
            value={rgb[i]}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              const next = rgb.slice();
              next[i] = n;
              onChange(`#${next.map(hex2).join('')}`);
            }}
          />
        </label>
      ))}
    </span>
  );
}

/** A small picture of a category of automap piece, in a colour: a wall run, a floor diamond, waves, a roof, a tree, a shade. */
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
      {kind === 'water' && (
        <>
          <path d="M1 6 Q4.5 3.5 8 6 T15 6" {...common} />
          <path d="M1 11 Q4.5 8.5 8 11 T15 11" {...common} />
        </>
      )}
      {kind === 'roofs' && <path d="M1 12 L8 4 L15 12 Z" {...common} fill={colour} fillOpacity={0.25} />}
      {kind === 'objects' && (
        <>
          <circle cx="8" cy="6" r="4" {...common} fill={colour} fillOpacity={0.25} />
          <path d="M8 10 L8 15" {...common} />
        </>
      )}
      {kind === 'shadows' && <path d="M8 3 L15 8 L8 13 Z" {...common} fill={colour} fillOpacity={0.5} />}
    </svg>
  );
}

/**
 * How the automap is drawn: kind colours or the game's, each kind shown or not in its colour, opacity, thickness, how
 * dark the map underneath is, and the outline of walls with no AutoMap.txt entry. Changes show at once.
 */
export function AutomapLook({
  style,
  onChange,
  counts,
  compact = false,
  kinds,
  single = false,
  part = null,
}: {
  style: AutomapStyle;
  onChange: (s: AutomapStyle) => void;
  counts?: Partial<Record<AutomapKind, number>>;
  compact?: boolean;
  kinds?: AutomapKind[];
  /** Just one category's colour, opacity and showing, as a small form. */
  single?: boolean;
  /** With single: one part of the category (Left walls…), which then gets a look of its own. */
  part?: { id: string; label: string } | null;
}) {
  const set = (patch: Partial<AutomapStyle>) => onChange({ ...style, ...patch });
  const setKind = (k: AutomapKind, patch: Partial<AutomapStyle['kinds'][AutomapKind]>) => set({ kinds: { ...style.kinds, [k]: { ...style.kinds[k], ...patch } } });
  const byKind = style.colours === 'kind';
  if (single && kinds?.length) {
    const id = kinds[0];
    const own = part ? style.parts[part.id] : undefined;
    const v = lookOf(style, id, part?.id);
    const setLook = (patch: Partial<AutomapLookOf>) =>
      part ? set({ parts: { ...style.parts, [part.id]: { ...v, ...patch } } }) : setKind(id, patch);
    const kindLabel = AUTOMAP_KIND_LIST.find((k) => k.id === id)!.label;
    const ownParts = AUTOMAP_PARTS.filter((pt) => pt.kind === id && style.parts[pt.id]);
    const dropParts = (ids: string[]) => set({ parts: Object.fromEntries(Object.entries(style.parts).filter(([k]) => !ids.includes(k))) });
    return (
      <div className="am-look single">
        {part && (
          <p className="small am-look-scope">
            {own ? (
              <>
                <b>{part.label}</b> have their own look.{' '}
                <button className="link" onClick={() => dropParts([part.id])}>
                  Use the {kindLabel.toLowerCase()} look again
                </button>
              </>
            ) : (
              <span className="muted">
                {part.label} follow the {kindLabel.toLowerCase()} look; change anything here to give them their own.
              </span>
            )}
          </p>
        )}
        {AUTOMAP_RECOLOUR && (
          <>
            <div className="am-look-row">
              <span>Colour</span>
              <ColourField value={v.colour} disabled={!byKind} onChange={(colour) => setLook({ colour })} />
            </div>
            {!byKind && <p className="small muted">Colours follow the game&apos;s pieces now: switch Look → Colour by kind to use your own.</p>}
          </>
        )}
        <label className="am-look-row">
          <span>Opacity</span>
          <input type="range" min={10} max={100} value={Math.round(v.opacity * 100)} onChange={(e) => setLook({ opacity: Number(e.target.value) / 100 })} />
          <span className="mono small">{Math.round(v.opacity * 100)}%</span>
        </label>
        <label className="am-look-row">
          <span>Show</span>
          <input type="checkbox" checked={v.show} onChange={(e) => setLook({ show: e.target.checked })} />
          <span />
        </label>
        {!part && ownParts.length > 0 && (
          <p className="small muted">
            {ownParts.map((pt) => pt.label).join(', ')} {ownParts.length === 1 ? 'has' : 'have'} a look of {ownParts.length === 1 ? 'its' : 'their'} own.{' '}
            <button className="link" onClick={() => dropParts(ownParts.map((pt) => pt.id))}>
              Make all {kindLabel.toLowerCase()} look the same
            </button>
          </p>
        )}
        {!part && (
          <p className="muted small">
            {AUTOMAP_RECOLOUR
              ? 'How DS1 Studio draws the automap. The game draws each piece in its own pixels from MaxiMap.dc6; AutoMap.txt has no colours.'
              : 'Pieces show in their own MaxiMap.dc6 colours, as in game. Opacity and Show only change how DS1 Studio draws them.'}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className={`am-look${compact ? ' compact' : ''}`}>
      {AUTOMAP_RECOLOUR && (
      <div className="chips am-look-mode">
        <button className={`chip${byKind ? ' active' : ''}`} onClick={() => set({ colours: 'kind' })} title="Each kind of piece in its own colour: easy to tell apart">
          Colour by kind
        </button>
        <button className={`chip${!byKind ? ' active' : ''}`} onClick={() => set({ colours: 'game' })} title="The pieces' own colours, as the game draws them">
          Game colours
        </button>
      </div>
      )}
      <div className="am-look-kinds">
        {(kinds ?? AUTOMAP_KIND_LIST.map((k) => k.id)).map((id) => {
          const k = AUTOMAP_KIND_LIST.find((x) => x.id === id)!;
          const v = style.kinds[id];
          return (
            <div key={id} className={`am-look-kind${v.show ? '' : ' off'}`} title={k.hint}>
              <input type="checkbox" checked={v.show} title="Show on the automap" onChange={(e) => setKind(id, { show: e.target.checked })} />
              <KindIcon kind={id} colour={v.colour} />
              <span className="am-look-name">
                {k.label}
                {counts?.[id] !== undefined && <span className="muted small"> {counts[id]}</span>}
              </span>
              {AUTOMAP_RECOLOUR ? (
                <input type="color" value={v.colour} disabled={!byKind} title={byKind ? `Colour of ${k.label.toLowerCase()}` : 'Colours follow the game (switch to Colour by kind)'} onChange={(e) => setKind(id, { colour: e.target.value })} />
              ) : (
                <span />
              )}
              <input className="am-look-op" type="range" min={10} max={100} value={Math.round(v.opacity * 100)} title={`Opacity: ${Math.round(v.opacity * 100)}%`} onChange={(e) => setKind(id, { opacity: Number(e.target.value) / 100 })} />
            </div>
          );
        })}
      </div>
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
