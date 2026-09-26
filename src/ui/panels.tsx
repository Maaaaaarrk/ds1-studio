import { useState, type ReactNode } from 'react';
import { isEmptyCell, type TileCell } from '../formats/ds1';
import { Orientation } from '../formats/dt1';
import { GameData } from '../game/GameData';
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
      <p className="muted small">Objects (blue) share the monster toggle. Drag to pan, scroll to zoom, F to fit.</p>
    </Panel>
  );
}

function cellRow(label: string, c: TileCell, found: boolean | null, orientation?: number) {
  if (isEmptyCell(c)) return null;
  return (
    <tr key={label}>
      <td className="muted">{label}</td>
      <td>
        <code>
          {c.mainIndex}/{c.subIndex}
        </code>
        {orientation !== undefined && <span className="muted"> · {ORIENTATION_NAMES[orientation] ?? `o${orientation}`}</span>}
        {c.hidden && <span className="badge">hidden</span>}
        {found === false && <span className="badge error">missing</span>}
      </td>
      <td className="muted mono small">{`${c.prop1.toString(16).padStart(2, '0')}${c.prop2.toString(16).padStart(2, '0')}${c.prop3.toString(16).padStart(2, '0')}${c.prop4.toString(16).padStart(2, '0')}`}</td>
    </tr>
  );
}

export function Inspector({ map, hover }: { map: OpenMap; hover: HoverInfo | null }) {
  const { ds1, lib } = map;
  if (!hover) {
    return (
      <Panel title="Inspector">
        <p className="muted small">Hover a cell to inspect it.</p>
      </Panel>
    );
  }
  const i = hover.cellY * ds1.width + hover.cellX;
  const has = (o: number, c: TileCell) => lib.variants(o, c.mainIndex, c.subIndex).length > 0 || (o === Orientation.Floor && c.mainIndex >= 30);
  const rows = [
    ...ds1.floors.map((l, n) => cellRow(`Floor ${n + 1}`, l[i], has(Orientation.Floor, l[i]))),
    ...ds1.walls.map((l, n) => {
      const special = l[i].orientation === Orientation.SpecialTile1 || l[i].orientation === Orientation.SpecialTile2;
      return cellRow(`Wall ${n + 1}`, l[i], special ? null : has(l[i].orientation, l[i]), l[i].orientation);
    }),
    ...ds1.shadows.map((l) => cellRow('Shadow', l[i], has(Orientation.Shadow, l[i]))),
  ].filter(Boolean);
  const objs = ds1.objects.filter((o) => Math.floor(o.x / 5) === hover.cellX && Math.floor(o.y / 5) === hover.cellY);
  const tag = ds1.tags[0]?.[i];
  return (
    <Panel title="Inspector" extra={`${hover.cellX}, ${hover.cellY}`}>
      {rows.length ? (
        <table className="kv">
          <tbody>{rows}</tbody>
        </table>
      ) : (
        <p className="muted small">Empty cell.</p>
      )}
      {tag !== undefined && tag !== 0 && <p className="small">Tag: <code>{tag}</code></p>}
      {objs.map((o, n) => (
        <p key={n} className="small">
          {o.type === 1 ? 'Monster/NPC' : 'Object'} <code>#{o.id}</code> at sub-tile ({o.x}, {o.y}){o.path.length ? ` · path of ${o.path.length}` : ''}
          {o.flags ? ` · flags ${o.flags}` : ''}
        </p>
      ))}
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
