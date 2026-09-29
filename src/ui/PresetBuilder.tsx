import { useMemo, useRef, useState } from 'react';
import { isEmptyCell } from '../formats/ds1';
import { newDs1 } from '../formats/ds1ops';
import { parseDt1 } from '../formats/dt1';
import { buildDt1, type Dt1Record } from '../formats/dt1Write';
import { copyRect, clampRect, rectFrom, clearEdits, type CellSelection } from '../game/clipboard';
import { planCustomDt1 } from '../game/customDt1';
import { GameData, TileLibrary } from '../game/GameData';
import { MapDocument, layerKey, layerLabel, type Brush, type LayerRef } from '../game/MapDocument';
import type { OpenMap } from '../game/openMap';
import { presetFromClipboard, type Preset } from '../game/presets';
import { tileKey } from '../game/presetLibrary';
import { buildScene, tilesAt } from '../render/scene';
import { Modal } from './Dialogs';
import { MapView, type HoverInfo, type StrokePhase } from './MapView';
import { TilePalette } from './TilePalette';
import { DEFAULT_VISIBILITY, type Tool } from './state';

/** An isolated scratch document. Closing it never changes the map underneath. */
export function PresetBuilder({ source, gd, onSave, onClose }: {
  source: OpenMap; gd: GameData;
  onSave: (p: Preset, files: { path: string; bytes: Uint8Array }[]) => Promise<void>;
  onClose: () => void;
}) {
  const [doc] = useState(() => new MapDocument('preset-builder', newDs1({ width: 20, height: 20, act: source.ds1.act, floorLayers: 2, wallLayers: 4, tagType: 0, files: [] })));
  const [revision, refresh] = useState(0);
  const [lib, setLib] = useState(source.lib);
  const [paletteLib, setPaletteLib] = useState(source.lib);
  const [layer, setLayer] = useState<LayerRef>({ kind: 'floor', index: 0 });
  const [brush, setBrush] = useState<Brush | null>(null);
  const [paletteBrush, setPaletteBrush] = useState<Brush | null>(null);
  const [tool, setTool] = useState<Tool>('paint');
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const anchor = useRef<[number, number] | null>(null);
  const [fit, setFit] = useState(0);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('My presets');
  const [trim, setTrim] = useState(true);
  const [query, setQuery] = useState('');
  const [dt1Path, setDt1Path] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const records = useRef<Dt1Record[]>([]);
  const remapped = useRef(new Map<string, Brush>());
  const [stagedPath] = useState(() => `data/global/tiles/studio/p${Date.now().toString(36)}.dt1`);
  const sourceBytes = useRef(new Map<string, Uint8Array>());
  const files = useMemo(() => gd.fs.list(p => p.endsWith('.dt1')).sort(), [gd]);
  const map = useMemo(() => ({ ...source, ds1: doc.ds1, lib, path: 'preset-builder' }), [source, doc, lib, revision]);
  const scene = useMemo(() => buildScene(doc.ds1, lib), [doc, lib, revision]);
  const visibility = useMemo(() => ({ ...DEFAULT_VISIBILITY, grid: true, minimap: false }), []);
  const sprites = useMemo(() => new Map(), []);
  const tick = () => refresh(n => n + 1);
  const close = () => { if (!busy) { if (doc.dirty) setDiscard(true); else onClose(); } };
  const chooseLibrary = async (path: string) => {
    setBusy(true); setError('');
    try {
      if (!path) setPaletteLib(source.lib);
      else {
        const bytes = await gd.fs.readOrThrow(path);
        sourceBytes.current.set(path, bytes);
        const next = new TileLibrary(); next.add(path, parseDt1(bytes)); setPaletteLib(next);
      }
      setDt1Path(path); setBrush(null); setPaletteBrush(null);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const pick = (b: Brush) => {
    if (busy) return;
    setError('');
    try {
      let result = b;
      if (dt1Path) {
        const key = `${dt1Path}|${tileKey(b.orientation, b.main, b.sub)}`;
        const cached = remapped.current.get(key);
        if (cached) result = cached;
        else {
          const indices = paletteLib.variants(b.orientation, b.main, b.sub).map(t => ({ dt1: dt1Path, index: paletteLib.sourceOf(t)!.index }));
          const plan = planCustomDt1(indices, sourceBytes.current, new Set(lib.entries().map(e => tileKey(e.orientation, e.main, e.sub))));
          if (plan.skipped.length || !plan.tiles.length) throw new Error(plan.skipped.join('\n') || 'No drawable tile selected.');
          records.current.push(...plan.records);
          const next = new TileLibrary();
          for (const loaded of source.lib.loaded) next.add(loaded.path, { version: [7, 6], tiles: source.lib.tilesOf(loaded.path) });
          next.add(stagedPath, parseDt1(buildDt1(records.current)));
          setLib(next);
          const tile = plan.tiles.find(t => t.orientation === b.orientation)!;
          result = { orientation: b.orientation, main: tile.newMain, sub: tile.newSub };
          remapped.current.set(key, result);
        }
      }
      setBrush(result); setPaletteBrush(b); setTool('paint');
    } catch (e) { setError(String(e)); }
  };
  const stroke = (phase: StrokePhase, cells: [number, number][]) => {
    if (busy) return;
    if (phase === 'end') { doc.endStroke(); anchor.current = null; tick(); return; }
    if (tool === 'select') {
      const cell = cells[cells.length - 1]; if (!cell) return;
      if (phase === 'start') anchor.current = cell;
      if (anchor.current) setSelection(clampRect(rectFrom(anchor.current, cell), 20, 20));
      return;
    }
    if (tool === 'paint' && !brush) return;
    if (phase === 'start') { doc.beginStroke(tool === 'erase' ? 'Erase' : 'Paint'); setSelection(null); }
    doc.apply(cells.filter(([x, y]) => doc.inBounds(x, y)).map(([x, y]) => ({ layer, x, y, cell: MapDocument.painted(layer, doc.cell(layer, x, y), tool === 'erase' ? null : brush) })));
    tick();
  };
  const save = async () => {
    if (!name.trim() || busy) return;
    doc.endStroke();
    const occupied = doc.layers().flatMap(l => Array.from({ length: 400 }, (_, i) => !isEmptyCell(doc.cell(l, i % 20, Math.floor(i / 20))) ? i : -1).filter(i => i >= 0));
    if (!occupied.length) { setError('Place at least one tile before saving.'); return; }
    const xs = occupied.map(i => i % 20), ys = occupied.map(i => Math.floor(i / 20));
    const rect = trim ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } : { x0: 0, y0: 0, x1: 19, y1: 19 };
    setBusy(true); setError('');
    try {
      const preset = presetFromClipboard(copyRect(doc, rect), lib, name.trim(), category.trim() || 'My presets');
      let files: { path: string; bytes: Uint8Array }[] = [];
      if (preset.dt1s.includes(stagedPath)) {
        const staged = buildDt1(records.current);
        const picks = parseDt1(staged).tiles.flatMap((t, index) => preset.tileSources?.[tileKey(t.orientation, t.mainIndex, t.subIndex)] === stagedPath ? [{ dt1: stagedPath, index }] : []);
        const compact = planCustomDt1(picks, new Map([[stagedPath, staged]]), new Set());
        if (compact.skipped.length) throw new Error(compact.skipped.join('\n'));
        files = [{ path: stagedPath, bytes: buildDt1(compact.records) }];
      }
      await onSave(preset, files);
      doc.markSaved(); onClose();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const ghost = hover && brush && tool === 'paint' ? tilesAt(lib, brush.orientation, brush.main, brush.sub, hover.cellX, hover.cellY).map(t => ({ tile: t.tile, x: t.x, y: t.y })) : [];
  return <Modal title="Preset builder · 20×20" wide onClose={close}>
    <div className="preset-builder" onKeyDown={e => {
      if ((e.target as HTMLElement).closest('input,select,textarea')) return;
      if (!busy && (e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); e.stopPropagation(); if (e.key.toLowerCase() === 'y' || e.shiftKey) doc.redo(); else doc.undo(); tick(); }
    }}>
      <div className="builder-tools">
        {(['paint', 'select', 'erase'] as const).map(t => <button key={t} className={`btn ${tool === t ? 'active' : ''}`} onClick={() => setTool(t)} disabled={busy}>{t === 'paint' ? 'Paint' : t === 'select' ? 'Select' : 'Erase'}</button>)}
        <select aria-label="Builder layer" disabled={busy} value={layerKey(layer)} onChange={e => { setLayer(doc.layers().find(l => layerKey(l) === e.target.value)!); setBrush(null); setPaletteBrush(null); }}>{doc.layers().map(l => <option key={layerKey(l)} value={layerKey(l)}>{layerLabel(l)}{l.kind === 'wall' ? ' · walls / roofs / trees' : ''}</option>)}</select>
        <button className="btn" disabled={busy || !doc.canUndo} onClick={() => { doc.undo(); tick(); }}>Undo</button>
        <button className="btn" disabled={busy || !doc.canRedo} onClick={() => { doc.redo(); tick(); }}>Redo</button>
        <button className="btn" disabled={busy || !selection} onClick={() => { if (selection) doc.apply(clearEdits(doc, selection, doc.layers()), 'Clear selection'); tick(); }}>Clear selected cells</button>
        <button className="btn" onClick={() => setFit(n => n + 1)}>Fit grid</button>
      </div>
      <div className="builder-workspace">
        <div className="builder-canvas" tabIndex={0} aria-label="Preset grid">
          <MapView map={map} scene={scene} visibility={visibility} hover={hover} tool={tool} ghost={ghost} objectLabel={() => ''} selectedObject={null} sprites={sprites} resizeMode={false} onResize={() => {}} selection={selection} pasteRect={null} onHover={setHover} onZoom={() => {}} onStroke={stroke} fitSignal={fit} focus={null} hittable={() => true} onCycle={() => {}} />
        </div>
        <aside className="builder-tiles">
          <input className="search" aria-label="Find builder DT1" placeholder="Find a DT1…" value={query} onChange={e => setQuery(e.target.value)} />
          <select aria-label="Builder tile library" value={dt1Path} disabled={busy} onChange={e => void chooseLibrary(e.target.value)}>
            <option value="">Current map tiles</option>
            {files.filter(p => p === dt1Path || p.toLowerCase().includes(query.toLowerCase())).map(p => <option key={p} value={p}>{p.replace('data/global/tiles/', '')}</option>)}
          </select>
          <TilePalette lib={paletteLib} palette={source.palette} layerKind={layer.kind} brush={paletteBrush} focus={null} onLayerKindChange={kind => { setLayer({ kind, index: 0 }); setBrush(null); setPaletteBrush(null); }} onPick={pick} />
        </aside>
      </div>
      <p className="muted small">Choose a layer and tile, then paint. Scroll to zoom; right-drag to pan. Saved presets are available to every map in this asset library.</p>
      <div className="builder-tools">
        <label>Name <input aria-label="Preset name" value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Category <input value={category} onChange={e => setCategory(e.target.value)} /></label>
        <label><input type="checkbox" checked={trim} onChange={e => setTrim(e.target.checked)} /> Trim empty edges</label>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {discard && <p className="error-text">Discard this unsaved preset? <button className="btn" onClick={onClose}>Discard</button> <button className="btn" onClick={() => setDiscard(false)}>Keep editing</button></p>}
      <div className="modal-actions"><button className="btn" disabled={busy} onClick={close}>Close</button><button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Working…' : 'Save to preset library'}</button></div>
    </div>
  </Modal>;
}
