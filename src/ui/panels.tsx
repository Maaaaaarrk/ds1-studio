import { useState, type ReactNode } from 'react';
import { DEFAULT_PROP1, isEmptyCell, withFields, type TileCell, type WallCell } from '../formats/ds1';
import { Orientation } from '../formats/dt1';
import { GameData } from '../game/GameData';
import { rectSize, type CellRect } from '../game/clipboard';
import { layerKey, layerLabel, MapDocument, type Brush, type CellEdit, type LayerRef } from '../game/MapDocument';
import type { MapOverride, OpenMap } from '../game/openMap';
import type { Scene } from '../render/scene';
import type { HoverInfo } from './MapView';
import { ORIENTATION_NAMES, type Visibility } from './state';

function Panel({ title, extra, children, defaultOpen = true }: { title: string; extra?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel">
      <button className="panel-header" onClick={() => setOpen(!open)}>
        <span>
          <span className="chev">{open ? '▾' : '▸'}</span> {title}
        </span>
        {extra && <span className="muted small">{extra}</span>}
      </button>
      {open && <div className="panel-body">{children}</div>}
    </section>
  );
}

function Toggle({ label, checked, onChange, count, swatch }: { label: string; checked: boolean; onChange: (v: boolean) => void; count?: number; swatch?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {swatch && <span className="swatch" style={{ background: swatch }} />}
      <span className="toggle-label">{label}</span>
      {count !== undefined && <span className="muted small">{count}</span>}
    </label>
  );
}

export function LayersPanel({ map, scene, visibility: v, onChange }: { map: OpenMap; scene: Scene; visibility: Visibility; onChange: (v: Visibility) => void }) {
  const { ds1 } = map;
  const count = (kind: string, layer?: number) => scene.items.filter((i) => i.kind === kind && (layer === undefined || i.layer === layer)).length;
  const set = (patch: Partial<Visibility>) => onChange({ ...v, ...patch });
  const setIdx = (key: 'floors' | 'walls', i: number, val: boolean) => {
    const arr = [...v[key]];
    arr[i] = val;
    set({ [key]: arr });
  };
  const npcs = ds1.objects.filter((o) => o.type === 1).length;
  return (
    <Panel title="Layers">
      <div className="toggle-group">
        {ds1.floors.map((_, i) => (
          <Toggle key={`f${i}`} label={`Floor ${i + 1}`} checked={v.floors[i]} onChange={(x) => setIdx('floors', i, x)} count={count('floor', i)} />
        ))}
        {ds1.walls.map((_, i) => (
          <Toggle key={`w${i}`} label={`Wall ${i + 1}`} checked={v.walls[i]} onChange={(x) => setIdx('walls', i, x)} count={count('wall', i) + count('roof', i) + count('lowerWall', i)} />
        ))}
        <Toggle label="Shadows" checked={v.shadows} onChange={(x) => set({ shadows: x })} count={count('shadow')} />
        <Toggle label="Roofs" checked={v.roofs} onChange={(x) => set({ roofs: x })} count={count('roof')} />
        <Toggle label="Lower walls" checked={v.lowerWalls} onChange={(x) => set({ lowerWalls: x })} count={count('lowerWall')} />
      </div>
      <div className="toggle-group">
        <Toggle label="Monsters / NPCs" swatch="rgb(240,80,80)" checked={v.objects} onChange={(x) => set({ objects: x })} count={npcs} />
        <Toggle label="NPC paths" swatch="rgb(255,150,60)" checked={v.paths} onChange={(x) => set({ paths: x })} count={ds1.objects.filter((o) => o.path.length).length} />
        <Toggle label="Special tiles" swatch="rgb(200,140,255)" checked={v.specials} onChange={(x) => set({ specials: x })} />
        {ds1.groups.length > 0 && <Toggle label="Substitution groups" swatch="rgb(120,200,255)" checked={v.groups} onChange={(x) => set({ groups: x })} count={ds1.groups.length} />}
        <Toggle label="Missing tiles" swatch="rgb(255,70,90)" checked={v.missing} onChange={(x) => set({ missing: x })} count={scene.missing.length} />
        <Toggle label="Grid (G)" checked={v.grid} onChange={(x) => set({ grid: x })} />
      </div>
      <p className="muted small">Objects (blue) share the monster toggle. Space/right-drag to pan, scroll to zoom, F to fit.</p>
    </Panel>
  );
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Number input that commits on Enter/blur (one undo step per commit, not per keystroke). */
function NumField({ value, min, max, onCommit, hexMode = false, width = 44 }: { value: number; min: number; max: number; onCommit: (v: number) => void; hexMode?: boolean; width?: number }) {
  const shown = hexMode ? hex(value) : String(value);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const commit = () => {
    setEditing(false);
    const v = hexMode ? parseInt(text, 16) : Number(text);
    if (Number.isFinite(v) && v >= min && v <= max && v !== value) onCommit(v);
    else setText(shown);
  };
  return (
    <input
      className="num-field mono"
      style={{ width }}
      value={editing ? text : shown}
      onFocus={(e) => {
        setText(shown);
        setEditing(true);
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(shown);
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

interface CellPanelProps {
  map: OpenMap;
  doc: MapDocument;
  cell: HoverInfo | null;
  /** True when one cell is selected: fields become editable. */
  editable: boolean;
  /** Changes whenever the document changes, so the panel re-reads cells. */
  revision: number;
  onEdit: (edits: CellEdit[]) => void;
}

/** Shows every layer of one cell; editable when that cell is selected. */
export function CellPanel({ map, doc, cell, editable, onEdit }: CellPanelProps) {
  const { ds1, lib } = map;
  if (!cell) {
    return (
      <Panel title="Cell">
        <p className="muted small">Hover a cell to inspect it; click one with Select (V) to edit it.</p>
      </Panel>
    );
  }
  const { cellX: x, cellY: y } = cell;
  const i = y * ds1.width + x;
  const found = (o: number, c: TileCell) =>
    o === Orientation.SpecialTile1 || o === Orientation.SpecialTile2 || lib.variants(o, c.mainIndex, c.subIndex).length > 0 || (o === Orientation.Floor && c.mainIndex >= 30);

  const rows = doc.layers().map((layer) => {
    const c = doc.cell(layer, x, y);
    const orientation = layer.kind === 'wall' ? (c as WallCell).orientation : layer.kind === 'floor' ? Orientation.Floor : Orientation.Shadow;
    const empty = isEmptyCell(c);
    const set = (next: TileCell | WallCell) => onEdit([{ layer, x, y, cell: next }]);
    const label = layerLabel(layer);
    if (!editable) {
      if (empty) return null;
      return (
        <tr key={layerKey(layer)}>
          <td className="muted">{label}</td>
          <td>
            <code>
              {c.mainIndex}/{c.subIndex}
            </code>
            {layer.kind === 'wall' && <span className="muted"> · {ORIENTATION_NAMES[orientation] ?? `o${orientation}`}</span>}
            {c.hidden && <span className="badge">hidden</span>}
            {!found(orientation, c) && <span className="badge error">missing</span>}
          </td>
          <td className="muted mono small">{hex(c.prop1) + hex(c.prop2) + hex(c.prop3) + hex(c.prop4)}</td>
        </tr>
      );
    }
    return (
      <tr key={layerKey(layer)} className={empty ? 'row-empty' : ''}>
        <td className="muted">{label}</td>
        <td>
          <div className="cell-edit">
            <NumField value={c.mainIndex} min={0} max={63} onCommit={(v) => set(withFields(c, { main: v, prop1: c.prop1 || DEFAULT_PROP1[layer.kind] }))} />
            <span className="muted">/</span>
            <NumField value={c.subIndex} min={0} max={255} onCommit={(v) => set(withFields(c, { sub: v, prop1: c.prop1 || DEFAULT_PROP1[layer.kind] }))} />
            <span className="muted small">flags</span>
            <NumField value={c.prop1} min={0} max={255} hexMode width={34} onCommit={(v) => set(withFields(c, { prop1: v }))} />
            <label className="mini-check" title="Hidden (prop4 bit 0x80): the game does not draw this tile">
              <input type="checkbox" checked={c.hidden} disabled={empty} onChange={(e) => set(withFields(c, { hidden: e.target.checked }))} />
              hid
            </label>
            {!empty && (
              <button className="icon-btn" title="Clear this layer" onClick={() => set(MapDocument.painted(layer, c, null))}>
                ×
              </button>
            )}
          </div>
          {layer.kind === 'wall' && (
            <select
              className="orient-select"
              value={orientation}
              onChange={(e) => set({ ...(c as WallCell), orientation: Number(e.target.value) })}
            >
              <option value={0}>0 · (none)</option>
              {Object.entries(ORIENTATION_NAMES)
                .filter(([o]) => Number(o) !== Orientation.Floor && Number(o) !== Orientation.Shadow)
                .map(([o, name]) => (
                  <option key={o} value={o}>
                    {o} · {name}
                  </option>
                ))}
            </select>
          )}
          {!empty && !found(orientation, c) && <span className="badge error">missing</span>}
        </td>
      </tr>
    );
  });

  const objs = ds1.objects.filter((o) => Math.floor(o.x / 5) === x && Math.floor(o.y / 5) === y);
  const tag = ds1.tags[0]?.[i];
  const visible = rows.filter(Boolean);
  return (
    <Panel title={editable ? 'Cell · editing' : 'Cell'} extra={`${x}, ${y}`}>
      {visible.length ? (
        <table className="kv">
          <tbody>{visible}</tbody>
        </table>
      ) : (
        <p className="muted small">Empty cell.</p>
      )}
      {editable && <p className="muted small">main 0-63 · sub 0-255 · flags = prop1 (hex; 00 = empty). Enter to apply.</p>}
      {tag !== undefined && tag !== 0 && (
        <p className="small">
          Tag: <code>{tag}</code>
        </p>
      )}
      {objs.map((o, n) => (
        <p key={n} className="small">
          {o.type === 1 ? 'Monster/NPC' : 'Object'} <code>#{o.id}</code> at sub-tile ({o.x}, {o.y}){o.path.length ? ` · path of ${o.path.length}` : ''}
          {o.flags ? ` · flags ${o.flags}` : ''}
        </p>
      ))}
    </Panel>
  );
}

interface SelectionPanelProps {
  selection: CellRect;
  activeLayer: LayerRef;
  brush: Brush | null;
  canPaste: boolean;
  onFill: () => void;
  onClear: (allLayers: boolean) => void;
  onCopy: (cut: boolean) => void;
  onPaste: () => void;
  onDeselect: () => void;
}

export function SelectionPanel({ selection, activeLayer, brush, canPaste, onFill, onClear, onCopy, onPaste, onDeselect }: SelectionPanelProps) {
  const [w, h] = rectSize(selection);
  return (
    <Panel title="Selection" extra={`${w} × ${h} · from ${selection.x0}, ${selection.y0}`}>
      <div className="button-grid">
        <button className="btn" disabled={!brush} onClick={onFill} title="Fill the selection with the brush tile on the active layer">
          Fill {layerLabel(activeLayer)}
        </button>
        <button className="btn" onClick={() => onClear(false)} title="Clear the active layer in the selection (Delete)">
          Clear {layerLabel(activeLayer)}
        </button>
        <button className="btn" onClick={() => onClear(true)} title="Clear every tile layer in the selection (Shift+Delete)">
          Clear all layers
        </button>
        <button className="btn" onClick={() => onCopy(false)} title="Copy all tile layers (Ctrl+C)">
          Copy
        </button>
        <button className="btn" onClick={() => onCopy(true)} title="Cut all tile layers (Ctrl+X); paste to move">
          Cut
        </button>
        <button className="btn" disabled={!canPaste} onClick={onPaste} title="Paste; click on the map to place it (Ctrl+V)">
          Paste
        </button>
      </div>
      <p className="muted small">
        Empty cells paste as transparent. Move = Cut, then Paste. <button className="link" onClick={onDeselect}>Deselect (Esc)</button>
      </p>
    </Panel>
  );
}

export function MapInfoPanel({ map, gd, onReopen }: { map: OpenMap; gd: GameData; onReopen: (o?: MapOverride) => void }) {
  const { ds1, resolution: r, lib } = map;
  const sourceText = {
    lvlprest: 'from LvlPrest.txt',
    guessed: 'guessed (not in LvlPrest.txt)',
    embedded: "from the DS1's own file list",
    manual: 'chosen manually',
  }[r.source];
  const chooseType = (id: string) => {
    const t = gd.lvlType(Number(id));
    if (!t) return onReopen(undefined);
    onReopen({ source: 'manual', lvlType: t, paths: GameData.dt1sFor(t, r.preset?.dt1Mask || 0xffffffff) });
  };
  return (
    <Panel title="Map">
      <table className="kv">
        <tbody>
          <tr><td className="muted">Size</td><td>{ds1.width} × {ds1.height} tiles</td></tr>
          <tr><td className="muted">Version</td><td>{ds1.version}{ds1.trailing ? <span className="muted"> (+{ds1.trailing} padding bytes)</span> : null}</td></tr>
          <tr><td className="muted">Act</td><td>{ds1.act + 1}</td></tr>
          <tr><td className="muted">Layers</td><td>{ds1.floors.length} floor · {ds1.walls.length} wall · {ds1.tags.length ? 'tag' : 'no tag'}</td></tr>
          <tr><td className="muted">Objects</td><td>{ds1.objects.length}</td></tr>
          {r.preset && <tr><td className="muted">Preset</td><td>{r.preset.name} <span className="muted">(Def {r.preset.def})</span></td></tr>}
          <tr><td className="muted">Source</td><td className="small">{gd.fs.locate(map.path) ?? '?'}</td></tr>
        </tbody>
      </table>

      <div className="field">
        <div className="field-label">
          Level type <span className="muted small">{sourceText}</span>
        </div>
        <select value={r.lvlType?.id ?? ''} onChange={(e) => chooseType(e.target.value)}>
          <option value="">(auto)</option>
          {gd.lvlTypes.filter((t) => t.id > 0).map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} · {t.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field-label">
        Tile libraries <span className="muted small">{lib.loaded.length}</span>
      </div>
      <ul className="dt1-list">
        {lib.loaded.map((l) => (
          <li key={l.path} className={l.found ? '' : 'error-text'} title={l.path}>
            <span>{l.path.replace(/^data\/global\/tiles\//, '')}</span>
            <span className="muted small">{l.found ? `${l.tiles} tiles` : 'not found'}</span>
          </li>
        ))}
      </ul>
      {ds1.files.length > 0 && (
        <details className="small">
          <summary className="muted">Embedded file list ({ds1.files.length})</summary>
          <ul className="dt1-list">
            {ds1.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}
