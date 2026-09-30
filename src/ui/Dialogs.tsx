import { useEffect, useState, type ReactNode } from 'react';
import type { ResizeDelta } from '../formats/ds1ops';
import type { LvlTypeInfo } from '../game/GameData';
import { HelpTip } from './HelpTip';

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-label={title}>
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

function IntInput({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min: number; max: number }) {
  return (
    <input
      type="number"
      className="num-field mono"
      style={{ width: 70 }}
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const v = Math.round(Number(e.target.value));
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
      }}
    />
  );
}

const ACT_DIRS = ['ACT1', 'ACT2', 'ACT3', 'ACT4', 'Expansion'];

export interface NewMapChoice {
  path: string;
  width: number;
  height: number;
  act: number;
  floorLayers: number;
  wallLayers: number;
  tagType: number;
  /** null: a new level type (made when it is added to the game); else an existing LvlTypes Id whose tiles it starts with. */
  lvlType: number | null;
}

/**
 * A new map starts empty: no tile libraries (the DT1 library opens next to pick them from any act), shown in the Act 0
 * colours so tiles from every act look as they will anywhere. The act is the one the game will give the level: Add
 * to game makes new levels Act 5 levels.
 */
export function NewMapDialog({ types, onCreate, onClose }: { types: LvlTypeInfo[]; onCreate: (c: NewMapChoice) => void; onClose: () => void }) {
  const [typeMode, setTypeMode] = useState<'new' | 'existing'>('new');
  const [typeId, setTypeId] = useState<number | null>(null);
  const [act, setAct] = useState(4);
  const [path, setPath] = useState('data/global/tiles/expansion/Custom/newmap.ds1');
  const [width, setWidth] = useState(150);
  const [height, setHeight] = useState(150);
  const [floorLayers, setFloorLayers] = useState(1);
  const [wallLayers, setWallLayers] = useState(2);
  const [tag, setTag] = useState(false);
  const valid = /^data\/global\/tiles\/.+\.ds1$/i.test(path) && (typeMode === 'new' || typeId !== null);
  const pickType = (id: number) => {
    setTypeId(id);
    const t = types.find((x) => x.id === id);
    if (t?.act) pickAct(Math.min(4, Math.max(0, t.act - 1)));
  };
  const pickAct = (a: number) => {
    setAct(a);
    setPath((p) => p.replace(/^data\/global\/tiles\/[^/]+\//i, `data/global/tiles/${ACT_DIRS[a]}/`));
  };

  return (
    <Modal title="New map" onClose={onClose}>
      <label className="form-row">
        <span>Save path</span>
        <input className="text-input mono" value={path} onChange={(e) => setPath(e.target.value.replace(/\\/g, '/'))} spellCheck={false} />
      </label>
      <div className="form-row">
        <span>Size</span>
        <div className="inline">
          <IntInput value={width} onChange={setWidth} min={1} max={256} /> × <IntInput value={height} onChange={setHeight} min={1} max={256} /> tiles
        </div>
      </div>
      <div className="form-row">
        <span>Level type</span>
        <div className="inline">
          <label className="mini-check">
            <input type="radio" checked={typeMode === 'new'} onChange={() => setTypeMode('new')} /> (New Lvltype)
          </label>
          <HelpTip text="The map starts with no tile libraries: choose any from any act. Game → Add to game gives it a level type of its own (a new LvlTypes.txt row) listing just the tile libraries it uses, so no other level is affected." />
          <label className="mini-check">
            <input type="radio" checked={typeMode === 'existing'} onChange={() => setTypeMode('existing')} /> (Choose Existing)
          </label>
          <HelpTip text="The map starts with an existing level type's tile libraries (LvlTypes.txt), in that act's colours: paint with the tiles that type already loads. Game → Add to game uses that type; if you add libraries it doesn't list, the map gets its own type then instead of changing the shared one." />
        </div>
      </div>
      {typeMode === 'existing' && (
        <label className="form-row">
          <span>Existing type</span>
          <select value={typeId ?? ''} onChange={(e) => pickType(Number(e.target.value))}>
            <option value="" disabled>
              Choose…
            </option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} · {t.name}
                {t.act ? ` (Act ${t.act}` : ' ('}
                {`${t.act ? ', ' : ''}${t.files.filter(Boolean).length} tile libraries)`}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="form-row">
        <span>Act</span>
        <select value={act} onChange={(e) => pickAct(Number(e.target.value))}>
          {[0, 1, 2, 3, 4].map((a) => (
            <option key={a} value={a}>
              Act {a + 1}
              {a === 4 ? ' (new levels added to the game are Act 5)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <span>Layers</span>
        <div className="inline">
          <IntInput value={floorLayers} onChange={setFloorLayers} min={1} max={2} /> floor
          <IntInput value={wallLayers} onChange={setWallLayers} min={1} max={4} /> wall
          <label className="mini-check">
            <input type="checkbox" checked={tag} onChange={(e) => setTag(e.target.checked)} /> tag layer + groups
          </label>
        </div>
      </div>
      <p className="muted small">
        The map starts with just the special-tile library (act1/barracks/warp.dt1: Map entry, warps and the other special tiles the game needs a DT1 for); the DT1 library opens next, to choose the rest from any act. It&apos;s shown in the <b>Act 0</b> colours (the ones
        that look the same in every act; magenta marks colours that change between acts). <b>Game → Add to game</b> later makes the game load it, with a
        level type of its own when it needs one.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid} onClick={() => onCreate({ path, width, height, act, floorLayers, wallLayers, tagType: tag ? 1 : 0, lvlType: typeMode === 'existing' ? typeId : null })}>
          Create
        </button>
      </div>
    </Modal>
  );
}

export function SaveAsDialog({ path, onSave, onClose }: { path: string; onSave: (path: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(path);
  const valid = /^data\/global\/tiles\/.+\.ds1$/i.test(value);
  return (
    <Modal title="Save as" onClose={onClose}>
      <label className="form-row">
        <span>Game path</span>
        <input className="text-input mono" autoFocus value={value} onChange={(e) => setValue(e.target.value.replace(/\\/g, '/'))} spellCheck={false} />
      </label>
      <p className="muted small">Written under your mod folder at this path, so it overrides any copy in the MPQs.</p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid} onClick={() => onSave(value)}>
          Save
        </button>
      </div>
    </Modal>
  );
}

export function ResizeDialog({ width, height, onResize, onClose }: { width: number; height: number; onResize: (d: ResizeDelta) => void; onClose: () => void }) {
  const [d, setD] = useState<ResizeDelta>({ left: 0, top: 0, right: 0, bottom: 0 });
  const w = width + d.left + d.right;
  const h = height + d.top + d.bottom;
  const set = (k: keyof ResizeDelta) => (v: number) => setD({ ...d, [k]: v });
  const shrinking = d.left < 0 || d.top < 0 || d.right < 0 || d.bottom < 0;
  return (
    <Modal title="Resize map" onClose={onClose}>
      <p className="muted small">Add (positive) or remove (negative) cells on each side. Objects, paths and groups move with the content.</p>
      <div className="resize-grid">
        <div />
        <label>
          Top (-y)
          <IntInput value={d.top} onChange={set('top')} min={-height + 1} max={256} />
        </label>
        <div />
        <label>
          Left (-x)
          <IntInput value={d.left} onChange={set('left')} min={-width + 1} max={256} />
        </label>
        <div className="resize-size mono">
          {width}×{height}
          <br />→ {w}×{h}
        </div>
        <label>
          Right (+x)
          <IntInput value={d.right} onChange={set('right')} min={-width + 1} max={256} />
        </label>
        <div />
        <label>
          Bottom (+y)
          <IntInput value={d.bottom} onChange={set('bottom')} min={-height + 1} max={256} />
        </label>
        <div />
      </div>
      {shrinking && <p className="small error-text">Shrinking deletes the cells and objects that fall outside (undo restores them).</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={w < 1 || h < 1 || (w === width && h === height)} onClick={() => onResize(d)}>
          Resize
        </button>
      </div>
    </Modal>
  );
}

/** Unsaved changes: save, discard or cancel (before opening another map, or closing this one). */
export function UnsavedPrompt({ name, dirty, closing, onChoose }: { name: string; dirty: boolean; closing: boolean; onChoose: (c: 'save' | 'discard' | 'cancel') => void }) {
  return (
    <Modal title={closing ? `Close ${name}?` : `Unsaved changes in ${name}`} onClose={() => onChoose('cancel')}>
      <p className="small">
        {dirty
          ? closing
            ? `${name} has unsaved changes.`
            : `${name} has unsaved changes. Save them before opening the other map?`
          : `${name} has no unsaved changes.`}
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={() => onChoose('cancel')}>
          Cancel
        </button>
        {dirty && (
          <button className="btn danger" onClick={() => onChoose('discard')}>
            {closing ? 'Discard and close' : 'Discard changes'}
          </button>
        )}
        <button className="btn primary" autoFocus onClick={() => onChoose('save')}>
          {closing ? (dirty ? 'Save and close' : 'Close') : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

/** Preferences, remembered on this computer. */
export function PreferencesDialog({ prefs, onChange, onClose }: { prefs: import('./prefs').Prefs; onChange: (patch: Partial<import('./prefs').Prefs>) => void; onClose: () => void }) {
  return (
    <Modal title="Preferences" onClose={onClose}>
      <label className="pref-row">
        <input type="checkbox" checked={prefs.saveOnSwitch} onChange={(e) => onChange({ saveOnSwitch: e.target.checked })} />
        <span>
          <b>Save automatically before opening another map</b>
          <span className="muted small">
            {' '}
            (on by default). Off: opening another map with unsaved changes asks you to save or discard them.
          </span>
        </span>
      </label>
      <label className="pref-row">
        <input type="checkbox" checked={prefs.act0View} onChange={(e) => onChange({ act0View: e.target.checked })} />
        <span>
          <b>Show maps in the Act 0 colours</b>
          <span className="muted small">
            {' '}
            (on by default). Every map is drawn with the colours that look the same in every act, unless you picked a palette for it in View → Colours.
            Off: each map opens in its own act&apos;s colours.
          </span>
        </span>
      </label>
      <label className="pref-row">
        <input type="checkbox" checked={prefs.act0Magenta} onChange={(e) => onChange({ act0Magenta: e.target.checked })} />
        <span>
          <b>Mark colours that change between acts in magenta</b>
          <span className="muted small">
            {' '}
            (off by default). Off: in the Act 0 colours, those pixels show as they look in the map&apos;s own act, so nothing is magenta. On: they turn
            magenta, to find tiles that still need Map → Make act-safe.
          </span>
        </span>
      </label>
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

/**
 * Tile files whose paths are too long for the game, listed together to rename: the files move and every LvlTypes /
 * LvlPrest row naming them is updated (the old files are kept aside).
 */
export function ShortenPathsDialog({ paths, max, suggest, onApply, onClose }: {
  paths: string[];
  max: number;
  suggest: (rel: string) => string;
  onApply: (renames: { from: string; to: string }[]) => Promise<void>;
  onClose: () => void;
}) {
  const [names, setNames] = useState(() => paths.map(suggest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = names.map((n) => n.trim().replace(/\\/g, '/').replace(/^\/+/, ''));
  const problem = (i: number): string | null => {
    const n = clean[i];
    const ext = paths[i].slice(paths[i].lastIndexOf('.')).toLowerCase();
    if (!n) return 'Give it a path.';
    if (n.length > max) return `${n.length - max} too many`;
    if (!n.toLowerCase().endsWith(ext)) return `Keep the ${ext} ending`;
    if (clean.some((o, j) => j !== i && o.toLowerCase() === n.toLowerCase())) return 'Two files would share this path';
    return null;
  };
  const ok = clean.every((_, i) => !problem(i));
  return (
    <Modal title="Shorten long tile paths" wide onClose={() => !busy && onClose()}>
      <p className="small">
        The game copies each tile path into a buffer that holds {max} characters after <code>data\global\tiles\</code>; a longer one can crash it or fail to load.
        Give these files shorter paths: each is moved, and every LvlTypes.txt and LvlPrest.txt row that names it is updated (the old file and tables are kept as
        backups).
      </p>
      <table className="shorten-table">
        <thead>
          <tr>
            <th>Now</th>
            <th>New path (in data/global/tiles)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {paths.map((p, i) => {
            const bad = problem(i);
            return (
              <tr key={p}>
                <td className="mono small" title={p}>
                  {p} <span className="muted">({p.length})</span>
                </td>
                <td>
                  <input className="mono" value={names[i]} spellCheck={false} onChange={(e) => setNames(names.map((n, j) => (j === i ? e.target.value : n)))} />
                </td>
                <td className={`small ${bad ? 'bad' : 'good'}`}>{bad ?? `${clean[i].length} / ${max}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="small bad">{error}</p>}
      <div className="modal-actions">
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!ok || busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            onApply(paths.map((from, i) => ({ from, to: clean[i] })).filter((r) => r.from !== r.to))
              .then(onClose)
              .catch((e) => setError(String(e?.message ?? e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Renaming…' : `Rename ${paths.length === 1 ? 'it' : `all ${paths.length}`}`}
        </button>
      </div>
    </Modal>
  );
}
