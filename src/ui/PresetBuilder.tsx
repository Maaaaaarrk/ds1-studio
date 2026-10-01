import { CategoryPicker } from './CategoryPicker';
import { useEffect, useMemo, useRef, useState } from 'react';
import { act0Remap, dt1Act, loadAct0Palette } from '../game/act0Palette';
import { decodeTile } from '../formats/dt1';
import { dt1Records } from '../formats/dt1Write';
import { buildCustomDt1 } from '../game/customDt1';
import { guessDrawnAct } from '../game/openMap';
import { isBuiltinPath } from '../game/specialTiles';
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
export function PresetBuilder({ source, gd, onSave, onClose, categories = [] }: {
  source: OpenMap; gd: GameData;
  /** The saved presets' categories, to pick from. */
  categories?: string[];
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
  const [category, setCategory] = useState(categories.includes('My presets') || !categories.length ? 'My presets' : categories[0]);
  const [trim, setTrim] = useState(true);
  const [query, setQuery] = useState('');
  const [dt1Path, setDt1Path] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const records = useRef<Dt1Record[]>([]);
  const remapped = useRef(new Map<string, Brush>());
  // The tiles a preset is built from (its own source, not a level's library): in a folder of their own.
  const [stagedPath] = useState(() => `data/global/tiles/presets/p${Date.now().toString(36)}.dt1`);
  const sourceBytes = useRef(new Map<string, Uint8Array>());
  const files = useMemo(() => gd.fs.list(p => p.endsWith('.dt1')).sort(), [gd]);
  /** The map's own tile libraries: the builder starts with these (their tiles keep their numbers). */
  const mapDt1s = useMemo(() => source.lib.loaded.filter(l => l.found && !isBuiltinPath(l.path)).map(l => l.path), [source]);
  /** Libraries added here from the game or mod: their tiles are copied into the preset's own DT1, in Act 0 colours. */
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState('');
  /** The map's libraries that still use colours that change between acts (they should be Act 0 already). */
  const [notAct0, setNotAct0] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    void (async () => {
      const a0 = await loadAct0Palette(gd.fs).catch(() => null);
      if (!a0) return;
      const out = new Set<string>();
      for (const p of mapDt1s) {
        const d = await gd.dt1(p).catch(() => null);
        if (d?.tiles.some(t => decodeTile(t)?.pixels.some(px => px && !a0.usable[px]))) out.add(p);
      }
      if (live) setNotAct0(out);
    })();
    return () => { live = false; };
  }, [gd, mapDt1s]);
  /** Per added library: the remap that converts its tiles to Act 0 (judged in the act it was drawn for). */
  const act0For = useRef(new Map<string, Uint8Array | null>());
  const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');
  const map = useMemo(() => ({ ...source, ds1: doc.ds1, lib, path: 'preset-builder' }), [source, doc, lib, revision]);
  const scene = useMemo(() => buildScene(doc.ds1, lib), [doc, lib, revision]);
  const visibility = useMemo(() => ({ ...DEFAULT_VISIBILITY, grid: true, minimap: false }), []);
  const sprites = useMemo(() => new Map(), []);
  const tick = () => refresh(n => n + 1);
  const close = () => { if (!busy) { if (doc.dirty) setDiscard(true); else onClose(); } };
  const chooseLibrary = async (choice: string) => {
    setBusy(true); setError('');
    try {
      if (!choice) { setPaletteLib(source.lib); setDt1Path(''); }
      else if (choice.startsWith('map:') && !notAct0.has(choice.slice(4))) {
        // One of the map's own libraries, already in Act 0 colours: its tiles as they are in the map.
        const path = choice.slice(4);
        const next = new TileLibrary(); next.add(path, { version: [7, 6], tiles: source.lib.tilesOf(path) }); setPaletteLib(next);
        setDt1Path('');
      } else {
        // A library to copy tiles from, converted to Act 0: an added one, or one of the map's that isn't Act 0 yet.
        choice = choice.replace(/^map:/, '');
        const bytes = await gd.fs.readOrThrow(choice);
        sourceBytes.current.set(choice, bytes);
        const dt1 = parseDt1(bytes);
        if (!act0For.current.has(choice)) {
          const a0 = await loadAct0Palette(gd.fs).catch(() => null);
          const pals = await Promise.all([0, 1, 2, 3, 4].map(a => gd.palette(a)));
          const act = dt1Act(choice) ?? guessDrawnAct(dt1.tiles, pals) ?? Math.min(4, source.ds1.act);
          act0For.current.set(choice, a0 ? act0Remap(pals[act], a0.usable) : null);
        }
        const next = new TileLibrary(); next.add(choice, dt1); setPaletteLib(next);
        setDt1Path(choice);
      }
      setBrush(null); setPaletteBrush(null);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const [choice, setChoice] = useState('');
  const addLibrary = async () => {
    if (!adding || added.includes(adding) || mapDt1s.includes(adding)) { if (mapDt1s.includes(adding)) { setChoice(`map:${adding}`); await chooseLibrary(`map:${adding}`); } return; }
    setAdded(a => [...a, adding]);
    setChoice(adding);
    await chooseLibrary(adding);
    setAdding('');
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
          // Act 0: the copied tiles are converted from the act their library was drawn for.
          const remap = act0For.current.get(dt1Path) ?? null;
          records.current.push(...(remap ? dt1Records(buildCustomDt1(plan, () => remap)) : plan.records));
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
          <select aria-label="Builder tile library" value={choice} disabled={busy} onChange={e => { setChoice(e.target.value); void chooseLibrary(e.target.value); }}>
            <option value="">All of this map&apos;s tiles</option>
            <optgroup label="This map's tile libraries">
              {mapDt1s.map(p => <option key={p} value={`map:${p}`}>{short(p)}{notAct0.has(p) ? ' (copied as Act 0)' : ''}</option>)}
            </optgroup>
            {added.length > 0 && <optgroup label="Added (copied into the preset, Act 0)">
              {added.map(p => <option key={p} value={p}>{short(p)}</option>)}
            </optgroup>}
          </select>
          {notAct0.size > 0 && <p className="small warn-text">{notAct0.size} of this map&apos;s libraries use colours that change between acts: tiles picked from them are copied into the preset converted to Act 0 (Map → Make act-safe converts the map&apos;s own copies).</p>}
          <div className="builder-add">
            <input className="search" aria-label="Find a DT1 to add" placeholder="Add a DT1: search…" value={query} onChange={e => setQuery(e.target.value)} />
            {query.trim() && <select aria-label="DT1 to add" value={adding} onChange={e => setAdding(e.target.value)}>
              <option value="">{files.filter(p => p.toLowerCase().includes(query.toLowerCase())).length} match</option>
              {files.filter(p => p.toLowerCase().includes(query.toLowerCase())).slice(0, 300).map(p => <option key={p} value={p}>{short(p)}</option>)}
            </select>}
            <button className="btn small" disabled={busy || !adding} onClick={() => void addLibrary()} title="Its tiles are copied into this preset's own DT1, converted to Act 0 colours">Add</button>
          </div>
          <TilePalette lib={paletteLib} palette={source.palette} layerKind={layer.kind} brush={paletteBrush} focus={null} onLayerKindChange={kind => { setLayer({ kind, index: 0 }); setBrush(null); setPaletteBrush(null); }} onPick={pick} />
        </aside>
      </div>
      <p className="muted small">Choose a layer and tile, then paint. Scroll to zoom; right-drag to pan. Saved presets are available to every map in this asset library.</p>
      <div className="builder-tools">
        <label>Name <input aria-label="Preset name" value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Category <CategoryPicker categories={categories} value={category} onChange={setCategory} /></label>
        <label><input type="checkbox" checked={trim} onChange={e => setTrim(e.target.checked)} /> Trim empty edges</label>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {discard && <p className="error-text">Discard this unsaved preset? <button className="btn" onClick={onClose}>Discard</button> <button className="btn" onClick={() => setDiscard(false)}>Keep editing</button></p>}
      <div className="modal-actions"><button className="btn" disabled={busy} onClick={close}>Close</button><button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Working…' : 'Save to preset library'}</button></div>
    </div>
  </Modal>;
}
