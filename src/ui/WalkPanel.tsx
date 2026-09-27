import { WALK_FLAGS } from '../game/walkEdit';
import { HelpTip } from './HelpTip';

export type WalkBrushSize = 1 | 3 | 5 | 'cell';

export interface WalkBrush {
  mode: 'block' | 'clear';
  /** Flag bits the brush sets or clears (WALK_FLAGS). */
  bits: number;
  size: WalkBrushSize;
}

interface Props {
  brush: WalkBrush;
  onChange: (b: WalkBrush) => void;
  busy: boolean;
  canWrite: boolean;
  /** The map's walkability library, tiles-relative (where blockers and tile copies go). */
  libraryPath: string;
  /** The last stroke's result, in words. */
  last: string | null;
  onDone: () => void;
}

/** The side panel while the walkability overlay is on: painting sub-tiles blocked or walkable, for this map only. */
export function WalkPanel({ brush, onChange, busy, canWrite, libraryPath, last, onDone }: Props) {
  const set = (patch: Partial<WalkBrush>) => onChange({ ...brush, ...patch });
  return (
    <section className="panel">
      <div className="panel-header static">
        <span>Walkability</span>
        <HelpTip text="The game works out where units can go from the sub-tiles of every tile in a cell (5×5 per cell). Here you change them for this map only: blocking adds an invisible blocker tile to the cell, making walkable gives the cell its own copy of the blocking tile without that flag. Other maps using the same tiles don't change." />
      </div>
      <div className="panel-body">
        <p className="small muted">
          Click or drag on the map to paint sub-tiles. <b>Shift</b>+drag paints a rectangle; hold <b>Ctrl</b> to do the opposite. Amber can&apos;t be
          walked, red can&apos;t be jumped or teleported over either.
        </p>
        <div className="field-label">Paint</div>
        <div className="segmented">
          <button className={brush.mode === 'block' ? 'active' : ''} onClick={() => set({ mode: 'block' })} title="Block the chosen movement on the sub-tiles you paint">
            Blocked
          </button>
          <button className={brush.mode === 'clear' ? 'active' : ''} onClick={() => set({ mode: 'clear' })} title="Allow the chosen movement on the sub-tiles you paint">
            Walkable
          </button>
        </div>
        <div className="field-label">What it blocks or allows</div>
        {WALK_FLAGS.map((f) => (
          <label key={f.bit} className="mini-check" title={f.help}>
            <input type="checkbox" checked={(brush.bits & f.bit) !== 0} onChange={(e) => set({ bits: e.target.checked ? brush.bits | f.bit : brush.bits & ~f.bit })} /> {f.name}
          </label>
        ))}
        <div className="field-label">Brush</div>
        <div className="segmented">
          {([1, 3, 5, 'cell'] as const).map((s) => (
            <button key={s} className={brush.size === s ? 'active' : ''} onClick={() => set({ size: s })} title={s === 'cell' ? 'Every sub-tile of the cells you paint' : `${s}×${s} sub-tiles`}>
              {s === 'cell' ? 'Cell' : `${s}×${s}`}
            </button>
          ))}
        </div>
        {!canWrite && <p className="small warn-text">Needs a writable mod folder: the changes add a small tile library for this map.</p>}
        {busy && <p className="small muted">Applying…</p>}
        {last && !busy && <p className="small">{last}</p>}
        <p className="small muted">
          Blockers and tile copies go into <span className="mono">{libraryPath}</span>, which is added to the map&apos;s tile libraries and level type. Undo
          (Ctrl+Z) takes a stroke back; save the map to keep them.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </section>
  );
}
