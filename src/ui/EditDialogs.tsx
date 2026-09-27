import { useMemo, useState } from 'react';
import type { Palette } from '../formats/palette';
import type { CellRect } from '../game/clipboard';
import { findTile, keyText, replaceEdits, type TileKey } from '../game/editTools';
import type { TileLibrary } from '../game/GameData';
import { layerLabel, type CellEdit, type LayerRef, type MapDocument } from '../game/MapDocument';
import { exportSize, MAX_PIXELS, MAX_SIDE } from '../render/exportImage';
import { Modal } from './Dialogs';
import { HelpTip } from './HelpTip';
import { Thumb } from './TilePalette';
import { allLevels, allWarps, levelLinks, levelRef, linkWrite, type WarpTables } from '../game/warps';
import type { TableWrite } from '../game/levelTables';

// ---------------------------------------------------------------------------------------------------------------
// Find & replace

function TileField({ label, value, onChange, lib, palette, wall, onUseBrush }: { label: string; value: TileKey; onChange: (k: TileKey) => void; lib: TileLibrary; palette: Palette; wall: boolean; onUseBrush?: () => void }) {
  const tile = lib.pick(value.orientation, value.main, value.sub, 0);
  const num = (field: keyof TileKey, max: number) => (
    <input
      className="num-field mono"
      type="number"
      min={0}
      max={max}
      value={value[field]}
      onChange={(e) => onChange({ ...value, [field]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
  return (
    <div className="rp-tile">
      <div className="field-label">{label}</div>
      <div className="rp-tile-row">
        <div className="rp-thumb">{tile ? <Thumb tile={tile} palette={palette} /> : <span className="muted small">not in this map&apos;s DT1s</span>}</div>
        <div className="rp-nums">
          <label>
            main {num('main', 63)}
          </label>
          <label>
            sub {num('sub', 255)}
          </label>
          {wall && (
            <label title="Wall orientation (1-9 walls, 10/11 special, 12 pillar, 14 tree, 15 roof, 16-19 lower walls)">
              orient. {num('orientation', 19)}
            </label>
          )}
          {onUseBrush && (
            <button className="btn small" onClick={onUseBrush}>
              Use brush
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ReplaceProps {
  doc: MapDocument;
  lib: TileLibrary;
  palette: Palette;
  activeLayer: LayerRef;
  selection: CellRect | null;
  from: TileKey | null;
  brush: TileKey | null;
  onApply: (edits: CellEdit[], label: string) => void;
  onShow: (cells: { x: number; y: number }[]) => void;
  onClose: () => void;
}

export function ReplaceDialog({ doc, lib, palette, activeLayer, selection, from: initialFrom, brush, onApply, onShow, onClose }: ReplaceProps) {
  const orient = activeLayer.kind === 'floor' ? 0 : activeLayer.kind === 'shadow' ? 13 : 1;
  const [from, setFrom] = useState<TileKey>(initialFrom ?? { orientation: orient, main: 0, sub: 0 });
  const [to, setTo] = useState<TileKey>(brush ?? { orientation: orient, main: 0, sub: 1 });
  const [layers, setLayers] = useState<'active' | 'kind'>('kind');
  const [area, setArea] = useState<'map' | 'selection'>(selection ? 'selection' : 'map');
  const targets = layers === 'active' ? [activeLayer] : doc.layers().filter((l) => l.kind === activeLayer.kind);
  const within = area === 'selection' ? selection : null;
  const found = useMemo(() => findTile(doc, targets, from, within), [doc, doc.revision, from, layers, area, activeLayer]); // eslint-disable-line react-hooks/exhaustive-deps
  const wall = activeLayer.kind === 'wall';
  const kindName = activeLayer.kind === 'floor' ? 'floor' : activeLayer.kind === 'wall' ? 'wall' : 'shadow';
  return (
    <Modal title="Find & replace tiles" onClose={onClose}>
      <p className="muted small">
        Swaps every use of one tile for another. It works on {kindName} layers (switch the active layer for another kind) and is one step to undo.
      </p>
      <div className="rp-pair">
        <TileField label="Find" value={from} onChange={setFrom} lib={lib} palette={palette} wall={wall} onUseBrush={brush ? () => setFrom(brush) : undefined} />
        <div className="rp-arrow">→</div>
        <TileField label="Replace with" value={to} onChange={setTo} lib={lib} palette={palette} wall={wall} onUseBrush={brush ? () => setTo(brush) : undefined} />
      </div>
      <div className="rp-options">
        <label>
          <input type="radio" checked={layers === 'kind'} onChange={() => setLayers('kind')} /> every {kindName} layer
        </label>
        <label>
          <input type="radio" checked={layers === 'active'} onChange={() => setLayers('active')} /> only {layerLabel(activeLayer)}
        </label>
        <span className="rp-sep" />
        <label>
          <input type="radio" checked={area === 'map'} onChange={() => setArea('map')} /> whole map
        </label>
        <label className={selection ? '' : 'muted'}>
          <input type="radio" disabled={!selection} checked={area === 'selection'} onChange={() => setArea('selection')} /> selection only
        </label>
      </div>
      <p className="small">
        <b>{found.length}</b> cell{found.length === 1 ? '' : 's'} use {keyText(from)}.{' '}
        {found.length > 0 && (
          <button className="link" onClick={() => onShow(found.map(({ x, y }) => ({ x, y })))}>
            Show them on the map
          </button>
        )}
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button
          className="btn primary"
          disabled={!found.length || keyText(from) + from.orientation === keyText(to) + to.orientation}
          onClick={() => onApply(replaceEdits(doc, targets, from, to, within), `Replace ${keyText(from)} → ${keyText(to)}`)}
        >
          Replace {found.length || ''}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Export image

interface ExportImageProps {
  width: number;
  height: number;
  selection: CellRect | null;
  busy: boolean;
  onExport: (o: { area: CellRect | null; scale: number; objects: boolean }) => void;
  onClose: () => void;
}

const SCALES = [1, 0.5, 0.25, 0.125];

export function ExportImageDialog({ width, height, selection, busy, onExport, onClose }: ExportImageProps) {
  const [area, setArea] = useState<'map' | 'selection'>(selection ? 'selection' : 'map');
  const rect = area === 'selection' && selection ? selection : { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  const fits = (s: number) => {
    const [w, h] = exportSize(rect, s);
    return w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS;
  };
  const [scale, setScale] = useState(() => SCALES.find(fits) ?? 0.125);
  const [objects, setObjects] = useState(true);
  const chosen = fits(scale) ? scale : (SCALES.find(fits) ?? 0.125);
  const [w, h] = exportSize(rect, chosen);
  return (
    <Modal title="Export image" onClose={onClose}>
      <p className="muted small">
        Saves the map as a PNG, drawn with the layers currently shown. <HelpTip text="Tiles and object sprites are drawn solid and shadows as translucent black; glows and fog are left out. Special-tile markers and overlays (grid, walkability…) aren't included." />
      </p>
      <div className="rp-options">
        <label>
          <input type="radio" checked={area === 'map'} onChange={() => setArea('map')} /> whole map
        </label>
        <label className={selection ? '' : 'muted'}>
          <input type="radio" disabled={!selection} checked={area === 'selection'} onChange={() => setArea('selection')} /> selection only
        </label>
      </div>
      <div className="rp-options">
        <span className="muted small">Size</span>
        {SCALES.map((s) => (
          <label key={s} className={fits(s) ? '' : 'muted'} title={fits(s) ? '' : 'Too large for one image: pick a smaller size or the selection'}>
            <input type="radio" disabled={!fits(s)} checked={chosen === s} onChange={() => setScale(s)} /> {s * 100}%
          </label>
        ))}
      </div>
      <label className="small">
        <input type="checkbox" checked={objects} onChange={(e) => setObjects(e.target.checked)} /> include objects and NPCs
      </label>
      <p className="small">
        {w.toLocaleString()} × {h.toLocaleString()} pixels
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={() => onExport({ area: area === 'selection' ? selection : null, scale: chosen, objects })}>
          {busy ? 'Drawing…' : 'Export PNG…'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Warp links

interface WarpProps {
  tables: WarpTables;
  levelId: number;
  vis: number;
  busy: boolean;
  onApply: (write: TableWrite) => void;
  onClose: () => void;
}

/** Sets where link `vis` of a level leads (Levels.txt VisN / WarpN), optionally with the way back. */
export function WarpLinkDialog({ tables, levelId, vis, busy, onApply, onClose }: WarpProps) {
  const current = useMemo(() => levelLinks(tables, levelId), [tables, levelId]);
  const link = current?.links[vis] ?? null;
  const levels = useMemo(() => allLevels(tables), [tables]);
  const warps = useMemo(() => allWarps(tables), [tables]);
  const [target, setTarget] = useState(link?.target.id ?? 0);
  const [warp, setWarp] = useState(link?.warp?.id ?? warps[0]?.id ?? 0);
  const [query, setQuery] = useState('');
  const [back, setBack] = useState(!link);
  const [backWarp, setBackWarp] = useState(link?.warp?.id ?? warps[0]?.id ?? 0);
  const q = query.trim().toLowerCase();
  const shown = levels.filter((l) => !q || l.name.toLowerCase().includes(q) || String(l.id) === q);
  const plan = target ? linkWrite(tables, { levelId, vis, targetId: target, warpId: warp, back: back ? { warpId: backWarp } : null }) : null;
  const name = current?.level.name ?? `level ${levelId}`;
  return (
    <Modal title={`Warp link ${vis} of ${name}`} onClose={onClose}>
      <p className="muted small">
        Warp tiles with main index {vis} in this level&apos;s maps use this link. Choose the level it leads to and the kind of warp (LvlWarp.txt decides the
        look and where the player appears). Saved into Levels.txt in your mod.
      </p>
      <label className="form-row">
        <span>Leads to</span>
        <div className="wl-pick">
          <input className="search small-input" placeholder="Search levels…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <select size={8} value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            {shown.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id} · {l.name}
              </option>
            ))}
          </select>
        </div>
      </label>
      {target > 0 && <p className="small">Its maps: {levelRef(tables, target).maps.map((p) => p.split('/').pop()).join(', ') || 'none (built at random)'}</p>}
      <label className="form-row">
        <span>Kind of warp</span>
        <select value={warp} onChange={(e) => setWarp(Number(e.target.value))}>
          {warps.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id} · {w.name}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        <input type="checkbox" checked={back} onChange={(e) => setBack(e.target.checked)} /> also add the way back (the target level gets a link to {name})
      </label>
      {back && (
        <label className="form-row">
          <span>Way back</span>
          <select value={backWarp} onChange={(e) => setBackWarp(Number(e.target.value))}>
            {warps.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} · {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="change-list">
        {typeof plan === 'string' ? <p className="error-text small">{plan}</p> : plan ? plan.write.summary.map((s) => <div key={s} className="small">• {s}</div>) : <p className="muted small">Pick a level.</p>}
      </div>
      <p className="muted small">If your mod ships compiled .bin tables, rebuild them after applying (start the game once with -direct -txt).</p>
      <div className="modal-actions">
        {link && (
          <button className="btn" disabled={busy} onClick={() => {
            const r = linkWrite(tables, { levelId, vis, targetId: 0, warpId: -1 });
            if (typeof r !== 'string') onApply(r.write);
          }}>
            Remove link
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !plan || typeof plan === 'string'} onClick={() => plan && typeof plan !== 'string' && onApply(plan.write)}>
          {busy ? 'Saving…' : 'Apply'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Import DT1 / DS1

/** Letters, digits, - and _ only: plain names are safe in the game's tables and file lookups on every system. */
export const safeName = (s: string) => /^[A-Za-z0-9_-]{1,48}$/.test(s.trim());
const baseName = (file: string) => file.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'imported';

export interface ImportDt1File {
  name: string;
  /** Subfolder path inside the picked folder ('' for a picked file). */
  folder: string;
  bytes: Uint8Array;
  /** Parsed summary, or why the file can't be used. */
  info: { tiles: number; kinds: string } | string;
}

export interface ImportDt1Choice {
  files: { path: string; bytes: Uint8Array }[];
  addToMap: boolean;
}

/** A path segment made safe for the game's tables (letters, digits, - and _). */
const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'x';

/**
 * Import DT1s (picked files, or whole folders with their subfolders) into data/global/tiles/PD2assets/<folder>/…,
 * optionally adding them to the open map's level type.
 */
export function ImportDt1Dialog({ files, exists, mapOpen, freeSlots, busy, onImport, onClose }: {
  files: ImportDt1File[];
  exists: (path: string) => boolean;
  mapOpen: string | null;
  /** Free File slots in the open map's level type (LvlTypes.txt), when known. */
  freeSlots: number | null;
  busy: boolean;
  onImport: (c: ImportDt1Choice) => void;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState(() => {
    try {
      return localStorage.getItem('ds1studio.importFolder') || 'custom';
    } catch {
      return 'custom';
    }
  });
  const hasFolders = files.some((f) => f.folder);
  const [keepFolders, setKeepFolders] = useState(true);
  const valid = files.map((_, i) => i).filter((i) => typeof files[i].info !== 'string');
  const [chosen, setChosen] = useState(() => new Set(valid));
  const [addToMap, setAddToMap] = useState(!!mapOpen);
  const okFolder = safeName(folder);
  // Target path of every file; clashes (same name after cleaning up) get a number.
  const targets = useMemo(() => {
    const used = new Set<string>();
    return files.map((f) => {
      const sub = keepFolders && f.folder ? `${f.folder.split('/').map(safeSegment).join('/')}/` : '';
      const base = safeSegment(f.name.replace(/\.dt1$/i, ''));
      let path = `data/global/tiles/PD2assets/${folder.trim()}/${sub}${base}.dt1`;
      for (let n = 2; used.has(path.toLowerCase()); n++) path = `data/global/tiles/PD2assets/${folder.trim()}/${sub}${base}_${n}.dt1`;
      used.add(path.toLowerCase());
      return path;
    });
  }, [files, folder, keepFolders]);
  const picked = files.map((_, i) => i).filter((i) => chosen.has(i));
  const tooMany = addToMap && !!mapOpen && freeSlots !== null && picked.length > freeSlots;
  const toggle = (i: number) =>
    setChosen((c) => {
      const n = new Set(c);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <Modal title={files.length === 1 ? 'Import DT1' : `Import ${files.length} DT1s`} onClose={onClose} wide>
      <label className="form-row">
        <span>
          Into PD2assets / <HelpTip text="A subfolder of data/global/tiles/PD2assets/ in your mod, to keep your imported tile libraries together (created if needed)." />
        </span>
        <input className="text-input" value={folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      {!okFolder && <p className="error-text small">Use letters, digits, - and _ only (no spaces): plain names are safe in the game&apos;s tables.</p>}
      {hasFolders && (
        <label className="small">
          <input type="checkbox" checked={keepFolders} onChange={(e) => setKeepFolders(e.target.checked)} /> keep the folder structure (each picked folder and its subfolders)
        </label>
      )}
      <div className="imp-list">
        <div className="imp-head small muted">
          <label>
            <input type="checkbox" checked={valid.length > 0 && valid.every((i) => chosen.has(i))} onChange={(e) => setChosen(new Set(e.target.checked ? valid : []))} /> {picked.length} of {files.length} selected
          </label>
        </div>
        {files.map((f, i) => {
          const bad = typeof f.info === 'string';
          return (
            <label key={i} className={`imp-row${bad ? ' bad' : ''}`} title={bad ? String(f.info) : targets[i]}>
              <input type="checkbox" disabled={bad} checked={chosen.has(i)} onChange={() => toggle(i)} />
              <span className="imp-name">
                {f.folder && <span className="muted">{f.folder}/</span>}
                {f.name}
              </span>
              <span className="small muted">{bad ? <span className="error-text">unreadable</span> : `${(f.info as { tiles: number }).tiles} tiles`}</span>
              <span className="imp-target mono small">
                {targets[i].replace(/^data\/global\/tiles\//, '')}
                {!bad && exists(targets[i]) && <span className="warn-text"> (replaces)</span>}
              </span>
            </label>
          );
        })}
        {!files.length && <p className="muted small pad">No .dt1 files were found there.</p>}
      </div>
      {mapOpen ? (
        <label className="small">
          <input type="checkbox" checked={addToMap} onChange={(e) => setAddToMap(e.target.checked)} /> add them to {mapOpen.split('/').pop()}&apos;s tile libraries{' '}
          <HelpTip text="Puts each DT1 in a free File slot of the map's level type (LvlTypes.txt, 32 slots) and includes it in the map's Dt1Mask (LvlPrest.txt), so both DS1 Studio and the game load them. Without that, the game never loads the files (so it can't crash on them), but maps can't use their tiles either." />
          {freeSlots !== null && <span className="muted"> · {freeSlots} free slot{freeSlots === 1 ? '' : 's'}</span>}
        </label>
      ) : (
        <p className="muted small">Open a map first to add them to that map&apos;s tile libraries right away; otherwise add them later with Map → Tile libraries.</p>
      )}
      {tooMany && (
        <p className="error-text small">
          The map&apos;s level type has only {freeSlots} free slots for {picked.length} DT1s: select fewer (the ones this map needs), or untick “add them” and add them later.
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!okFolder || !picked.length || busy || tooMany}
          onClick={() => onImport({ files: picked.map((i) => ({ path: targets[i], bytes: files[i].bytes })), addToMap: !!mapOpen && addToMap })}
        >
          {busy ? 'Importing…' : `Import ${picked.length || ''}`}
        </button>
      </div>
    </Modal>
  );
}

export interface ImportDs1Choice {
  path: string;
  register: boolean;
}

/** Import a DS1 as data/global/tiles/expansion/Map/<name>.ds1, then (optionally) add it to the game. */
export function ImportDs1Dialog({ file, info, exists, busy, onImport, onClose }: {
  file: { name: string };
  info: { width: number; height: number; act: number; missing: string[] } | string;
  exists: (path: string) => boolean;
  busy: boolean;
  onImport: (c: ImportDs1Choice) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => baseName(file.name));
  const [register, setRegister] = useState(true);
  const path = `data/global/tiles/expansion/Map/${name.trim()}.ds1`;
  const ok = typeof info !== 'string' && safeName(name);
  return (
    <Modal title="Import DS1" onClose={onClose}>
      <p className="small">
        <b>{file.name}</b>: {typeof info === 'string' ? <span className="error-text">{info}</span> : `${info.width}×${info.height} map, act ${info.act + 1}`}
      </p>
      <label className="form-row">
        <span>Map name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      {!safeName(name) && <p className="error-text small">Use letters, digits, - and _ only (no spaces): plain names are safe in the game&apos;s tables.</p>}
      <p className="small mono">{path}</p>
      {exists(path) && <p className="warn-text small">A map with that name exists: it will be replaced (the old one is kept as .bak).</p>}
      {typeof info !== 'string' && info.missing.length > 0 && (
        <p className="warn-text small">
          It lists tile libraries that aren&apos;t in your game or mod: {info.missing.join(', ')}. Import those DT1s too, or its tiles show as missing (and the game can&apos;t
          draw them).
        </p>
      )}
      <label className="small">
        <input type="checkbox" checked={register} onChange={(e) => setRegister(e.target.checked)} /> add it to the game next{' '}
        <HelpTip text="Opens “Add to game” for it: a LvlPrest row pointing at the map, a level for it (existing or new) and its tile libraries in LvlTypes/Dt1Mask. Until then the game doesn't know the map (it can't load it, so it can't crash on it either)." />
      </label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ok || busy} onClick={() => onImport({ path, register })}>
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </Modal>
  );
}
