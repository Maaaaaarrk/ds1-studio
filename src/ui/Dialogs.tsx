import { useEffect, useState, type ReactNode } from 'react';
import type { ResizeDelta } from '../formats/ds1ops';

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
}

/**
 * A new map starts empty: no tile libraries (the DT1 library opens next to pick them from any act), shown in the Act 0
 * colours so tiles from every act look as they will anywhere. The act is the one the game will give the level: Add
 * to game makes new levels Act 5 levels.
 */
export function NewMapDialog({ onCreate, onClose }: { onCreate: (c: NewMapChoice) => void; onClose: () => void }) {
  const [act, setAct] = useState(4);
  const [path, setPath] = useState('data/global/tiles/expansion/Custom/newmap.ds1');
  const [width, setWidth] = useState(150);
  const [height, setHeight] = useState(150);
  const [floorLayers, setFloorLayers] = useState(1);
  const [wallLayers, setWallLayers] = useState(2);
  const [tag, setTag] = useState(false);
  const valid = /^data\/global\/tiles\/.+\.ds1$/i.test(path);
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
        <button className="btn primary" disabled={!valid} onClick={() => onCreate({ path, width, height, act, floorLayers, wallLayers, tagType: tag ? 1 : 0 })}>
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
