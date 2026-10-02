import { ThemePicker } from './ThemePicker';
import { useEffect, useState, type ReactNode } from 'react';
import type { ResizeDelta } from '../formats/ds1ops';
import type { LvlTypeInfo } from '../game/GameData';
import { HelpTip } from './HelpTip';
import { DEFAULT_PREFS, type Prefs } from './prefs';

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
export function NewMapDialog({ types, onCreate, onClose, defaults = DEFAULT_PREFS.newMap }: { types: LvlTypeInfo[]; onCreate: (c: NewMapChoice) => void; onClose: () => void; defaults?: Prefs['newMap'] }) {
  const [typeMode, setTypeMode] = useState<'new' | 'existing'>('new');
  const [typeId, setTypeId] = useState<number | null>(null);
  const [act, setAct] = useState(defaults.act);
  const [path, setPath] = useState(`data/global/tiles/${defaults.folder || ACT_DIRS[defaults.act]}/newmap.ds1`);
  const [width, setWidth] = useState(defaults.width);
  const [height, setHeight] = useState(defaults.height);
  const [floorLayers, setFloorLayers] = useState(defaults.floorLayers);
  const [wallLayers, setWallLayers] = useState(defaults.wallLayers);
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
export function PreferencesDialog({ prefs, onChange, notify, onClose }: { prefs: Prefs; onChange: (patch: Partial<Prefs>) => void; notify: (text: string, error?: boolean) => void; onClose: () => void }) {
  const check = (key: { [K in keyof Prefs]: Prefs[K] extends boolean ? K : never }[keyof Prefs], title: string, note: string) => (
    <label className="pref-row">
      <input type="checkbox" checked={prefs[key] as boolean} onChange={(e) => onChange({ [key]: e.target.checked } as Partial<Prefs>)} />
      <span>
        <b>{title}</b>
        <span className="muted small"> {note}</span>
      </span>
    </label>
  );
  const speed = (key: 'zoomSpeed' | 'arrowSpeed', title: string, note: string) => (
    <label className="pref-row pref-slider">
      <span>
        <b>{title}</b> <span className="mono small">{prefs[key].toFixed(2)}×</span>
        <span className="muted small"> {note}</span>
      </span>
      <input type="range" min={0.25} max={3} step={0.05} value={prefs[key]} onChange={(e) => onChange({ [key]: Number(e.target.value) } as Partial<Prefs>)} />
      <button className="link small" onClick={() => onChange({ [key]: 1 } as Partial<Prefs>)}>
        reset
      </button>
    </label>
  );
  const nm = prefs.newMap;
  const setNm = (patch: Partial<Prefs['newMap']>) => onChange({ newMap: { ...nm, ...patch } });
  return (
    <Modal title="Preferences" wide onClose={onClose}>
      <div className="pref-section">Appearance</div>
      <ThemePicker prefs={prefs} onChange={onChange} notify={notify} />
      <div className="pref-section">Maps and saving</div>
      {check('saveOnSwitch', 'Save automatically before opening another map', '(on by default). Off: opening another map with unsaved changes asks you to save or discard them.')}
      <label className="pref-row">
        <span>
          <b>Autosave unsaved work every</b>{' '}
          <IntInput value={prefs.autosaveSeconds} onChange={(v) => onChange({ autosaveSeconds: v })} min={0} max={600} /> seconds
          <span className="muted small"> (20 by default; 0 = off). A copy is kept for recovery if the app closes unexpectedly; your map file is only written when you save.</span>
        </span>
      </label>
      <label className="pref-row">
        <span>
          <b>Recent maps to remember</b> <IntInput value={prefs.recentCount} onChange={(v) => onChange({ recentCount: v })} min={1} max={50} />
          <span className="muted small"> (12 by default).</span>
        </span>
      </label>
      {check('syncTablesOnSave', 'Update LvlTypes / Dt1Mask when saving', '(on by default). When the map’s tile libraries changed, saving also puts them in its level type (LvlTypes.txt) and Dt1Mask (LvlPrest.txt), so the game loads them. Off: saving only writes the map; you edit the tables yourself (the Compatibility check shows what the game won’t load).')}
      {check('checkAfterSave', 'Run the Compatibility check after saving', '(off by default). It opens only when it finds problems.')}
      {check('checkAfterAddToGame', 'Run the Compatibility check after Add to game', '(off by default). It opens only when it finds problems.')}

      <div className="pref-section">Colours</div>
      {check('act0View', 'Show maps in the Act 0 colours', '(on by default). Every map is drawn with the colours that look the same in every act, unless you picked a palette for it in View → Colours. Off: each map opens in its own act’s colours.')}
      {check('act0Magenta', 'Mark colours that change between acts in magenta', '(off by default). Off: in the Act 0 colours those pixels show as they look in the map’s own act. On: they turn magenta, to find tiles that still need Map → Make act-safe.')}

      <div className="pref-section">Editing</div>
      {check('pasteStack', 'Paste onto existing tiles (stack) by default', '(off by default). On: a paste goes into the next free layer where tiles are already there, and Alt replaces them instead. Off: a paste replaces them, and Alt stacks.')}
      {check('confirmBulkDelete', 'Ask before deleting in bulk', '(on by default): several objects at once, or a preset.')}

      <div className="pref-section">What a map opens with</div>
      {check('showWalkArea', 'Walkable area box', '(on by default). Also in View → Walkable area.')}
      {check('showGrid', 'Grid', '(off by default).')}
      {check('showMinimap', 'Minimap', '(on by default).')}
      {check('objectLabels', 'Object names on the map', '(on by default). Off: only the object under the cursor or selected is named.')}

      <div className="pref-section">Mouse and keyboard</div>
      {speed('zoomSpeed', 'Mouse-wheel zoom speed', '')}
      {check('smoothZoom', 'Zoom smoothly', '(off by default). Off: the wheel zooms in steps (1/8×, 1/4×, 1/2×, 3/4×, 100%, 2×, 3×…) that keep the tiles’ pixels sharp. On: any amount in between, as before.')}
      {speed('arrowSpeed', 'Arrow-key scrolling speed', '(Shift still scrolls faster).')}
      <label className="pref-row">
        <span>
          <b>Shift+wheel</b>{' '}
          <select value={prefs.shiftWheel} onChange={(e) => onChange({ shiftWheel: e.target.value as Prefs['shiftWheel'] })}>
            <option value="layers">steps through layers (Alt+wheel zooms)</option>
            <option value="zoom">zooms (Alt+wheel steps through layers)</option>
          </select>
        </span>
      </label>

      <div className="pref-section">New map starts with</div>
      <div className="pref-row pref-grid">
        <span>Size</span>
        <span>
          <IntInput value={nm.width} onChange={(v) => setNm({ width: v })} min={1} max={256} /> × <IntInput value={nm.height} onChange={(v) => setNm({ height: v })} min={1} max={256} /> tiles
        </span>
        <span>Act</span>
        <select value={nm.act} onChange={(e) => setNm({ act: Number(e.target.value), folder: nm.folder.replace(/^[^/]*/, ACT_DIRS[Number(e.target.value)]) })}>
          {[0, 1, 2, 3, 4].map((a) => (
            <option key={a} value={a}>
              Act {a + 1}
            </option>
          ))}
        </select>
        <span>Layers</span>
        <span>
          <IntInput value={nm.floorLayers} onChange={(v) => setNm({ floorLayers: v })} min={1} max={2} /> floor <IntInput value={nm.wallLayers} onChange={(v) => setNm({ wallLayers: v })} min={1} max={4} /> wall
        </span>
        <span>Folder</span>
        <span className="inline">
          <span className="mono small muted">data/global/tiles/</span>
          <input className="text-input mono" value={nm.folder} spellCheck={false} onChange={(e) => setNm({ folder: e.target.value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') })} />
        </span>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={() => onChange({ ...DEFAULT_PREFS })}>
          Reset all
        </button>
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
