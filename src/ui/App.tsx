import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isEmptyCell, writeDs1, WRITE_VERSION, type WallCell } from '../formats/ds1';
import { Orientation } from '../formats/dt1';
import { GameData } from '../game/GameData';
import { clampRect, clearEdits, copyRect, fillEdits, pasteEdits, rectFrom, rectSize, type CellRect, type Clipboard } from '../game/clipboard';
import { layerKey, layerLabel, MapDocument, type Brush, type CellEdit, type LayerRef } from '../game/MapDocument';
import { openMap, type MapOverride, type OpenMap } from '../game/openMap';
import { buildScene, hitTest, tilesAt } from '../render/scene';
import { canPickFolders, loadFromDevServer, sourcesFromDirectory } from '../vfs/loaders';
import { devServerSaveTarget, directorySaveTarget, downloadFile, type SaveTarget } from '../vfs/save';
import { LayeredFs, type FileSource } from '../vfs/vfs';
import { FileBrowser } from './FileBrowser';
import { isVisible, MapView, type GhostTile, type HoverInfo, type StrokePhase } from './MapView';
import { CellPanel, LayersPanel, MapInfoPanel, SelectionPanel } from './panels';
import { DEFAULT_VISIBILITY, TOOLS, type Tool, type Visibility } from './state';
import { TilePalette } from './TilePalette';

type DataState =
  | { status: 'connecting' }
  | { status: 'setup'; error?: string }
  | { status: 'loading'; message: string }
  | { status: 'ready'; gd: GameData; files: string[]; saveTarget: SaveTarget | null };

interface Toast {
  text: string;
  error?: boolean;
}

function isSingleCell(r: CellRect): boolean {
  return r.x0 === r.x1 && r.y0 === r.y1;
}

/** Orientation used when painting a brush on a layer kind. */
function brushOrientation(layer: LayerRef, brush: Brush): number {
  return layer.kind === 'floor' ? Orientation.Floor : layer.kind === 'shadow' ? Orientation.Shadow : brush.orientation;
}

export function App() {
  const [data, setData] = useState<DataState>({ status: 'connecting' });
  const [map, setMap] = useState<OpenMap | null>(null);
  const [doc, setDoc] = useState<MapDocument | null>(null);
  const [revision, setRevision] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>(DEFAULT_VISIBILITY);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitSignal, setFitSignal] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [activeLayer, setActiveLayer] = useState<LayerRef>({ kind: 'floor', index: 0 });
  const [brush, setBrush] = useState<Brush | null>(null);
  const [selection, setSelection] = useState<CellRect | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [pasting, setPasting] = useState(false);
  const selectAnchor = useRef<[number, number] | null>(null);

  const bump = () => setRevision((r) => r + 1);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  useEffect(() => {
    if (!toast || toast.error) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const mountFs = useCallback(async (fs: LayeredFs, saveTarget: SaveTarget | null) => {
    setData({ status: 'loading', message: 'Reading game tables…' });
    const gd = await GameData.load(fs);
    const files = fs.list((p) => p.endsWith('.ds1') && p.startsWith('data/global/tiles/'));
    setData({ status: 'ready', gd, files, saveTarget });
  }, []);

  // In dev, the Vite plugin serves the local install; otherwise ask for a folder.
  useEffect(() => {
    (async () => {
      const fs = await loadFromDevServer();
      if (fs) await mountFs(fs, await devServerSaveTarget());
      else setData({ status: 'setup' });
    })().catch((e) => setData({ status: 'setup', error: String(e) }));
  }, [mountFs]);

  const pickFolders = async (withMod: boolean) => {
    try {
      const sources: FileSource[] = [];
      let saveTarget: SaveTarget | null = null;
      const pick = (id: string) =>
        (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id, mode: 'read' });
      if (withMod) {
        const mod = await pick('d2-mod');
        setData({ status: 'loading', message: `Indexing ${mod.name}…` });
        sources.push(...(await sourcesFromDirectory(mod, true)));
        saveTarget = directorySaveTarget(mod);
      }
      const game = await pick('d2-game');
      setData({ status: 'loading', message: `Opening archives in ${game.name}…` });
      sources.push(...(await sourcesFromDirectory(game, false)));
      if (!sources.length) throw new Error('No MPQs or data folder found there.');
      await mountFs(new LayeredFs(sources), saveTarget);
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setData({ status: 'setup', error: (e as Error).message });
      else setData({ status: 'setup' });
    }
  };

  const gd = data.status === 'ready' ? data.gd : null;

  const confirmDiscard = useCallback(() => !doc?.dirty || window.confirm(`Discard unsaved changes to ${doc.path.split('/').pop()}?`), [doc]);

  const open = useCallback(
    async (path: string) => {
      if (!gd || !confirmDiscard()) return;
      setLoadingPath(path);
      try {
        const m = await openMap(gd, path);
        setMap(m);
        setDoc(new MapDocument(path, m.ds1));
        setHover(null);
        setActiveLayer((l) => (l.kind === 'wall' && m.ds1.walls.length ? { kind: 'wall', index: 0 } : { kind: 'floor', index: 0 }));
        setBrush(null);
        setSelection(null);
        setPasting(false);
        setTool((t) => (t === 'paint' ? 'select' : t));
      } catch (e) {
        notify(`${path}: ${(e as Error).message}`, true);
      } finally {
        setLoadingPath(null);
      }
    },
    [gd, confirmDiscard, notify],
  );

  /** Re-resolve DT1s (level type change) without discarding edits. */
  const reresolve = useCallback(
    async (override?: MapOverride) => {
      if (!gd || !map) return;
      try {
        setMap(await openMap(gd, map.path, override, map.ds1));
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [gd, map, notify],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` invalidates the scene after in-place edits
  const scene = useMemo(() => (map ? buildScene(map.ds1, map.lib) : null), [map, revision]);

  // Preview under the cursor: the pending paste, or the paint brush.
  const pasteRect = useMemo(
    (): CellRect | null =>
      pasting && clipboard && hover
        ? { x0: hover.cellX, y0: hover.cellY, x1: hover.cellX + clipboard.width - 1, y1: hover.cellY + clipboard.height - 1 }
        : null,
    [pasting, clipboard, hover],
  );
  const ghost = useMemo((): GhostTile[] => {
    if (!map || !hover) return [];
    if (pasting && clipboard) {
      return clipboard.layers.flatMap(({ layer, cells }) =>
        layer.kind === 'shadow'
          ? []
          : cells.flatMap((c, i) => {
              if (isEmptyCell(c)) return [];
              const o = layer.kind === 'wall' ? (c as WallCell).orientation : Orientation.Floor;
              return tilesAt(map.lib, o, c.mainIndex, c.subIndex, hover.cellX + (i % clipboard.width), hover.cellY + Math.floor(i / clipboard.width));
            }),
      );
    }
    if (tool !== 'paint' || !brush) return [];
    return tilesAt(map.lib, brushOrientation(activeLayer, brush), brush.main, brush.sub, hover.cellX, hover.cellY);
  }, [map, hover, tool, brush, activeLayer, pasting, clipboard]);

  const pickAt = useCallback(
    (x: number, y: number, world: [number, number]) => {
      if (!doc || !scene) return;
      // What you see is what you pick: the frontmost tile pixel under the cursor.
      const hit = hitTest(scene, world[0], world[1], (it) => isVisible(it, visibility));
      if (hit) {
        const layer: LayerRef = { kind: hit.kind === 'floor' ? 'floor' : 'wall', index: hit.layer };
        const orientation = hit.tile.orientation === Orientation.LeftPartOfNorthCornerWall ? Orientation.RightPartOfNorthCornerWall : hit.tile.orientation;
        setActiveLayer(layer);
        setBrush({ orientation, main: hit.tile.mainIndex, sub: hit.tile.subIndex });
        setTool('paint');
        notify(`Picked ${hit.tile.mainIndex}/${hit.tile.subIndex} from ${layerLabel(layer)}`);
        return;
      }
      if (!doc.inBounds(x, y)) return;
      // Pick what is visible on top: walls (upper layers first), then floors, then the shadow.
      const layers = doc.layers();
      const byKind = (k: LayerRef['kind']) => layers.filter((l) => l.kind === k).reverse();
      for (const layer of [...byKind('wall'), ...byKind('floor'), ...byKind('shadow')]) {
        const c = doc.cell(layer, x, y);
        if (isEmptyCell(c)) continue;
        const orientation = layer.kind === 'wall' ? (c as WallCell).orientation : layer.kind === 'floor' ? Orientation.Floor : Orientation.Shadow;
        setActiveLayer(layer);
        setBrush({ orientation, main: c.mainIndex, sub: c.subIndex });
        setTool('paint');
        notify(`Picked ${c.mainIndex}/${c.subIndex} from ${layerLabel(layer)}`);
        return;
      }
      notify('Nothing to pick in that cell.');
    },
    [doc, scene, visibility, notify],
  );

  const onStroke = useCallback(
    (phase: StrokePhase, cells: [number, number][], world: [number, number]) => {
      if (!doc) return;
      if (pasting) {
        if (phase === 'start' && cells[0] && clipboard) {
          const [x, y] = cells[0];
          if (doc.apply(pasteEdits(doc, clipboard, x, y))) bump();
          setSelection(clampRect({ x0: x, y0: y, x1: x + clipboard.width - 1, y1: y + clipboard.height - 1 }, doc.ds1.width, doc.ds1.height));
          setPasting(false);
        }
        return;
      }
      if (tool === 'select') {
        const cell = cells[cells.length - 1];
        if (phase === 'start' && cell) selectAnchor.current = cell;
        if (cell && selectAnchor.current) setSelection(clampRect(rectFrom(selectAnchor.current, cell), doc.ds1.width, doc.ds1.height));
        if (phase === 'end') selectAnchor.current = null;
        return;
      }
      if (tool === 'pick') {
        if (phase === 'start' && cells[0]) pickAt(cells[0][0], cells[0][1], world);
        return;
      }
      if (tool !== 'paint' && tool !== 'erase') return;
      if (tool === 'paint' && !brush) {
        if (phase === 'start') notify('Choose a tile in the Tiles panel first (or use Pick, I).', true);
        return;
      }
      if (phase === 'start') doc.beginStroke();
      const b = tool === 'paint' && brush ? { ...brush, orientation: brushOrientation(activeLayer, brush) } : null;
      const edits: CellEdit[] = cells
        .filter(([x, y]) => doc.inBounds(x, y))
        .map(([x, y]) => ({ layer: activeLayer, x, y, cell: MapDocument.painted(activeLayer, doc.cell(activeLayer, x, y), b) }));
      const changed = doc.apply(edits);
      if (phase === 'end') doc.endStroke();
      if (changed || phase === 'end') bump();
    },
    [doc, tool, brush, activeLayer, pickAt, notify, pasting, clipboard],
  );

  // Selection commands.
  const copy = useCallback(
    (cut: boolean) => {
      if (!doc || !selection) return;
      setClipboard(copyRect(doc, selection));
      const [w, h] = rectSize(selection);
      if (cut && doc.apply(clearEdits(doc, selection, doc.layers()))) bump();
      notify(`${cut ? 'Cut' : 'Copied'} ${w}×${h} cells (all layers)`);
    },
    [doc, selection, notify],
  );
  const startPaste = useCallback(() => {
    if (!clipboard) return notify('Nothing to paste: copy a selection first (Ctrl+C).');
    setPasting(true);
    notify('Click to place the paste · Esc to cancel');
  }, [clipboard, notify]);
  const clearSelection = useCallback(
    (allLayers: boolean) => {
      if (!doc || !selection) return;
      if (doc.apply(clearEdits(doc, selection, allLayers ? doc.layers() : [activeLayer]))) bump();
    },
    [doc, selection, activeLayer],
  );
  const fillSelection = useCallback(() => {
    if (!doc || !selection) return;
    if (!brush) return notify('Choose a tile in the Tiles panel first.', true);
    if (doc.apply(fillEdits(doc, selection, activeLayer, { ...brush, orientation: brushOrientation(activeLayer, brush) }))) bump();
  }, [doc, selection, brush, activeLayer, notify]);
  const applyEdits = useCallback(
    (edits: CellEdit[]) => {
      if (doc?.apply(edits)) bump();
    },
    [doc],
  );

  const undo = useCallback(() => {
    if (doc?.undo()) bump();
  }, [doc]);
  const redo = useCallback(() => {
    if (doc?.redo()) bump();
  }, [doc]);

  const save = useCallback(async () => {
    if (!doc || !gd || data.status !== 'ready') return;
    const bytes = writeDs1(doc.ds1);
    const name = doc.path.split('/').pop()!;
    try {
      if (data.saveTarget) {
        notify(await data.saveTarget.save(doc.path, bytes));
        gd.fs.remember(doc.path, bytes, data.saveTarget.label);
      } else {
        downloadFile(name, bytes);
        notify(`Downloaded ${name} (no writable mod folder configured)`);
      }
      doc.ds1.version = WRITE_VERSION;
      doc.markSaved();
      bump();
    } catch (e) {
      notify(`Save failed: ${(e as Error).message}`, true);
    }
  }, [doc, gd, data, notify]);

  const exportFile = useCallback(() => {
    if (doc) downloadFile(doc.path.split('/').pop()!, writeDs1(doc.ds1));
  }, [doc]);

  // Keyboard shortcuts.
  const handlers = useRef({ undo, redo, save, copy, startPaste, clearSelection, doc });
  handlers.current = { undo, redo, save, copy, startPaste, clearSelection, doc };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) handlers.current.redo();
        else handlers.current.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        handlers.current.redo();
      } else if (mod && k === 's') {
        e.preventDefault();
        void handlers.current.save();
      } else if (mod && (k === 'c' || k === 'x')) {
        handlers.current.copy(k === 'x');
      } else if (mod && k === 'v') {
        handlers.current.startPaste();
      } else if (mod && k === 'a') {
        const d = handlers.current.doc;
        if (d) {
          e.preventDefault();
          setSelection({ x0: 0, y0: 0, x1: d.ds1.width - 1, y1: d.ds1.height - 1 });
          setTool('select');
        }
      } else if (k === 'escape') {
        setPasting(false);
        setSelection(null);
      } else if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        handlers.current.clearSelection(e.shiftKey);
      } else if (!mod && !e.altKey) {
        const t = TOOLS.find((t) => t.key === k);
        if (t) setTool(t.id);
        else if (k === 'f') setFitSignal((n) => n + 1);
        else if (k === 'g') setVisibility((v) => ({ ...v, grid: !v.grid }));
        else if (k === 'o') setVisibility((v) => ({ ...v, objects: !v.objects }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (doc?.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [doc]);

  if (data.status !== 'ready') {
    return <SetupScreen state={data} onPick={pickFolders} />;
  }

  const layers = doc?.layers() ?? [];
  const title = map?.path.split('/').pop();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> DS1 Studio
        </div>
        <div className="topbar-file">
          {map ? (
            <>
              <span className="topbar-title">
                {title}
                {doc?.dirty && <span className="dirty-dot" title="Unsaved changes" />}
              </span>
              <span className="topbar-path">{map.path}</span>
            </>
          ) : (
            <span className="muted">No map open</span>
          )}
        </div>
        {doc && (
          <div className="toolbar">
            <div className="segmented">
              {TOOLS.map((t) => (
                <button key={t.id} className={tool === t.id ? 'active' : ''} onClick={() => setTool(t.id)} title={`${t.hint} (${t.key.toUpperCase()})`}>
                  {t.label}
                </button>
              ))}
            </div>
            <select
              className="layer-select"
              value={layerKey(activeLayer)}
              onChange={(e) => setActiveLayer(layers.find((l) => layerKey(l) === e.target.value)!)}
              title="Active layer"
            >
              {layers.map((l) => (
                <option key={layerKey(l)} value={layerKey(l)}>
                  {layerLabel(l)}
                </option>
              ))}
            </select>
            <div className="segmented">
              <button disabled={!doc.canUndo} onClick={undo} title="Undo (Ctrl+Z)">
                Undo
              </button>
              <button disabled={!doc.canRedo} onClick={redo} title="Redo (Ctrl+Y)">
                Redo
              </button>
            </div>
            <button className="btn ghost" onClick={() => setFitSignal((n) => n + 1)} title="Fit map (F)">
              Fit
            </button>
            <button className="btn ghost" onClick={exportFile} title="Download the current map as a .ds1 file">
              Export
            </button>
            <button
              className={`btn${doc.dirty ? ' primary' : ''}`}
              onClick={save}
              title={data.saveTarget ? `Save into ${data.saveTarget.label} (Ctrl+S)` : 'No writable mod folder: saving downloads the file (Ctrl+S)'}
            >
              Save
            </button>
          </div>
        )}
      </header>

      <aside className="sidebar left">
        <FileBrowser files={data.files} current={map?.path ?? null} loading={loadingPath} onOpen={open} />
      </aside>

      <main className="stage">
        {map && scene ? (
          <MapView
            map={map}
            scene={scene}
            visibility={visibility}
            hover={hover}
            tool={tool}
            ghost={ghost}
            selection={selection}
            pasteRect={pasteRect}
            onHover={setHover}
            onZoom={setZoom}
            onStroke={onStroke}
            fitSignal={fitSignal}
          />
        ) : (
          <div className="empty-stage">
            <div className="empty-title">Open a map</div>
            <div className="muted">
              Pick a DS1 from the list. {data.files.length.toLocaleString()} presets found across {data.gd.fs.baseSources.length} sources.
            </div>
          </div>
        )}
        {toast && (
          <div className={`toast${toast.error ? ' error' : ''}`} onClick={() => setToast(null)}>
            {toast.text}
          </div>
        )}
        {loadingPath && <div className="toast">Loading {loadingPath.split('/').pop()}…</div>}
      </main>

      <aside className="sidebar right">
        {map && scene && doc && (
          <>
            <section className="panel">
              <div className="panel-header static">
                <span>Tiles · {layerLabel(activeLayer)}</span>
                {brush && (
                  <span className="muted small">
                    brush {brush.main}/{brush.sub}
                  </span>
                )}
              </div>
              <TilePalette
                lib={map.lib}
                palette={map.palette}
                layerKind={activeLayer.kind}
                brush={brush}
                onPick={(b) => {
                  setBrush(b);
                  setTool('paint');
                }}
              />
            </section>
            {selection && !isSingleCell(selection) && (
              <SelectionPanel
                selection={selection}
                activeLayer={activeLayer}
                brush={brush}
                canPaste={!!clipboard}
                onFill={fillSelection}
                onClear={clearSelection}
                onCopy={copy}
                onPaste={startPaste}
                onDeselect={() => setSelection(null)}
              />
            )}
            <CellPanel
              map={map}
              doc={doc}
              cell={selection && isSingleCell(selection) ? { cellX: selection.x0, cellY: selection.y0 } : hover}
              editable={!!selection && isSingleCell(selection)}
              revision={revision}
              onEdit={applyEdits}
            />
            <LayersPanel map={map} scene={scene} visibility={visibility} onChange={setVisibility} />
            <MapInfoPanel map={map} gd={data.gd} onReopen={reresolve} />
          </>
        )}
      </aside>

      <footer className="statusbar">
        <span>{data.gd.fs.baseSources.map((s) => s.label.split(/[\\/]/).slice(-2).join('/')).join('  ›  ')}</span>
        <span className="spacer" />
        {map && doc && (
          <>
            <span>
              {TOOLS.find((t) => t.id === tool)!.label} · {layerLabel(activeLayer)}
            </span>
            <span>{hover ? `Cell ${hover.cellX}, ${hover.cellY}` : '—'}</span>
            <span>{Math.round(zoom * 100)}%</span>
            <span>
              {map.ds1.width}×{map.ds1.height} · v{map.ds1.version} · Act {map.ds1.act + 1}
            </span>
          </>
        )}
      </footer>
    </div>
  );
}

function SetupScreen({ state, onPick }: { state: Exclude<DataState, { status: 'ready' }>; onPick: (withMod: boolean) => void }) {
  return (
    <div className="setup">
      <div className="setup-card">
        <div className="brand big">
          <span className="brand-mark">◆</span> DS1 Studio
        </div>
        <p className="muted">A map preset viewer and editor for Diablo II (classic 1.13 / 1.14).</p>
        {state.status === 'connecting' && <p>Looking for game data…</p>}
        {state.status === 'loading' && <p>{state.message}</p>}
        {state.status === 'setup' && (
          <>
            {canPickFolders ? (
              <div className="setup-actions">
                <button className="btn primary" onClick={() => onPick(true)}>
                  Open mod folder + Diablo II folder
                </button>
                <button className="btn" onClick={() => onPick(false)}>
                  Diablo II folder only (view)
                </button>
              </div>
            ) : (
              <p>This browser can't open local folders. Use Chrome or Edge, or the desktop app.</p>
            )}
            <p className="muted small">
              The Diablo II folder needs d2data.mpq, d2exp.mpq and patch_d2.mpq. The mod folder may contain an extracted <code>data/</code>{' '}
              tree and/or mod MPQs; its files take priority, and saved maps are written into it. The Diablo II folder is never written to.
            </p>
            {state.error && <p className="error-text">{state.error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
