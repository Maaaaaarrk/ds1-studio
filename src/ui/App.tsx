import {
  Box,
  ClipboardPaste,
  Copy,
  Download,
  Eraser,
  Expand,
  FilePlus2,
  FolderCog,
  Footprints,
  Grid3x3,
  RefreshCw,
  Info,
  Bug,
  BookOpen,
  Palette as PaletteIcon,
  ScanEye,
  Map as MapIcon,
  Keyboard,
  LayoutGrid,
  Layers,
  Library,
  Maximize,
  MousePointer2,
  PackageOpen,
  PackagePlus,
  Paintbrush,
  Pipette,
  Redo2,
  Save,
  Scissors,
  ShieldCheck,
  Sparkles,
  Stamp,
  Table2,
  Trash2,
  Undo2,
  FlaskConical,
  FileOutput,
  Replace,
  ImageDown,
  Clock,
  SquareDashed,
  PaintBucket,
  MapPinned,
  Lightbulb,
  FileInput,
  Grid2x2Plus,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ds1FileToDt1Path, EMPTY_CELL, isEmptyCell, parseDs1, writeDs1, WRITE_VERSION, type Ds1, type Ds1Object, type WallCell } from '../formats/ds1';
import { embeddedFileName, newDs1, resizeDs1, type ResizeDelta } from '../formats/ds1ops';
import { Orientation, type Dt1Tile } from '../formats/dt1';
import { PALETTE_NAMES } from '../formats/palette';
import { GameData } from '../game/GameData';
import { clampRect, clearEdits, clipboardSources, copyRect, missingForPaste, overlapEdits, pasteEdits, pasteObjects, rectFrom, rectSize, type CellRect, type Clipboard } from '../game/clipboard';
import { checkMap, type CheckResult, type Fix } from '../game/compat';
import { buildMapPackage, collectMapTxtRows, planImport, readMapPackage, type ImportPlan, type MapPackage } from '../game/mapPackage';
import { loadPresets, presetFromSelection, presetPath, presetToClipboard, serializePreset, suggestPresets, type Preset, type SuggestProgress } from '../game/presets';
import { layerKey, layerLabel, MapDocument, type Brush, type CellEdit, type LayerRef } from '../game/MapDocument';
import { openMap, withPalette, type MapOverride, type OpenMap } from '../game/openMap';
import { buildScene, cellToWorld, hitTest, hitTestAll, sameItem, stackAt, subTileToWorld, tilesAt, worldToSubTile, type DrawItem } from '../render/scene';
import { canPickFolders, loadFromDevServer, sourcesFromDirectory } from '../vfs/loaders';
import { devServerSaveTarget, directorySaveTarget, downloadFile, exportBytes, importBytes, importNamed, type SaveTarget } from '../vfs/save';
import { LayeredFs, normalizePath, type FileSource } from '../vfs/vfs';
import { FileBrowser } from './FileBrowser';
import { isVisible, MapView, type GhostTile, type HoverInfo, type StrokeMods, type StrokePhase } from './MapView';
import { CellPanel, GroupsPanel, HistoryPanel, LayersPanel, MapInfoPanel, MapObjectsPanel, SelectionPanel } from './panels';
import { DEFAULT_VISIBILITY, TOOLS, type Tool, type Visibility } from './state';
import { comboOf, useKeybindings, type ActionId } from './keybindings';
import { ShortcutsDialog } from './ShortcutsDialog';
import { Splitter, usePersistentSize } from './Splitter';
import { Modal, NewMapDialog, ResizeDialog, SaveAsDialog, type NewMapChoice } from './Dialogs';
import { DataTables, type TableTarget } from './DataTables';
import { Dt1Manager } from './Dt1Manager';
import { RegisterMapDialog, type TableWrite } from './LevelTools';
import { CubeRecipeDialog } from './CubeRecipe';
import { syncLevelTables } from '../game/levelTables';
import { applyAutomapEdits, applyAutomapSuggestions, automapColors, referenceTiles, type AutomapColors, type ReferenceTile, AUTOMAP_DC6, AUTOMAP_TXT, automapLevelFor, automapPieces, parseAutomap, parseAutomapCels, setAutomapCel, suggestAutomap, withSuggestions, type AutomapEdit, type AutomapPiece, type AutomapSuggestion, type AutomapTable } from '../game/automap';
import { parseTxtTable, serializeTxtTable } from '../formats/txtTable';
import type { SpriteFrame } from '../formats/dc6';
import { AutomapPanel } from './AutomapPanel';
import { AutomapEditor } from './AutomapEditor';
import { ObjectGallery } from './ObjectGallery';
import type { SpriteAnimation } from '../game/spriteAnim';
import { GameSizePicker } from './GameSizePicker';
import { AboutDialog, UpdateDialog } from './HelpDialogs';
import { bugReportUrl, checkForUpdate, featureRequestUrl, openExternal, REPO_URL, type UpdateInfo } from '../app/updates';
import { Dt1Editor, type Dt1EditResult } from './Dt1Editor';
import { ObjectPreview } from './ObjectPreview';
import { PresetsPanel } from './PresetsPanel';
import { Ribbon, type RibbonTab } from './Ribbon';
import { CompatDialog, ExportPackageDialog, ImportPackageDialog } from './ToolDialogs';
import type { Sprite } from '../game/sprites';
import { getConfig, isTauri, loadFromTauri, setConfig, tauriSaveTarget, type DesktopConfig } from '../vfs/tauri';
import { DesktopSetup } from './DesktopSetup';
import { ErrorBoundary } from './ErrorBoundary';
import { ObjectPanel } from './ObjectPanel';
import { TilePalette, type PaletteFocus } from './TilePalette';
import { isBuiltinPath, specialTileInfo } from '../game/specialTiles';
import { floodRegion, keyOf, objectInRect, paintEdits, rectCells, rerollEdits, type TileKey } from '../game/editTools';
import { addRecentMap, pinnedTiles, recentMaps, recentTiles, reopenLast, setReopenLast, togglePinned, noteTileUse, type RecentMap } from '../app/prefs';
import { deleteRecovery, getRecovery, listRecoveries, saveRecovery, type Recovery } from '../app/recovery';
import { renderMapImage } from '../render/exportImage';
import { writeTileSettings } from '../formats/dt1Header';
import { ExportImageDialog, ImportDs1Dialog, ImportDt1Dialog, ReplaceDialog, WarpLinkDialog, type ImportDs1Choice, type ImportDt1Choice } from './EditDialogs';
import { levelLinks, loadWarpTables, type WarpTables } from '../game/warps';
import { parseDt1 } from '../formats/dt1';

type DataState =
  | { status: 'connecting' }
  | { status: 'setup'; error?: string }
  | { status: 'loading'; message: string }
  | { status: 'ready'; gd: GameData; files: string[]; saveTarget: SaveTarget | null };

interface Toast {
  text: string;
  error?: boolean;
}

/** The editable layer a drawn item belongs to. */
function layerOfItem(it: DrawItem): LayerRef {
  return it.kind === 'floor' ? { kind: 'floor', index: it.layer } : it.kind === 'shadow' ? { kind: 'shadow', index: it.layer } : { kind: 'wall', index: it.layer };
}


function isSingleCell(r: CellRect): boolean {
  return r.x0 === r.x1 && r.y0 === r.y1;
}

/** Orientation used when painting a brush on a layer kind. */
/** A map's folder, shortened for lists ("act1/town"). */
const folderOf = (path: string) => path.replace(/^data\/global\/tiles\//i, '').replace(/\/[^/]+$/, '');

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
  const [gameView, setGameView] = useState<{ on: boolean; signal: number; center?: [number, number] | null }>({ on: false, signal: 0 });
  /** The game screen size Game view shows (remembered on this computer). */
  const [gameSize, setGameSizeState] = useState<[number, number]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('ds1studio.gameSize') ?? 'null');
      if (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n >= 320 && n <= 7680)) return v as [number, number];
    } catch {
      // per-viewer convenience only
    }
    return [800, 600];
  });
  const setGameSize = useCallback((size: [number, number]) => {
    setGameSizeState(size);
    try {
      localStorage.setItem('ds1studio.gameSize', JSON.stringify(size));
    } catch {
      // ignore
    }
    // Re-frame the view at the new size when Game view is on.
    setGameView((g) => (g.on ? { ...g, signal: g.signal + 1, center: null } : g));
  }, []);
  const [tool, setTool] = useState<Tool>('select');
  const [activeLayer, setActiveLayer] = useState<LayerRef>({ kind: 'floor', index: 0 });
  const [brush, setBrush] = useState<Brush | null>(null);
  /** Extra tiles painted at random together with the brush (Ctrl+click in the Tiles panel). */
  const [mix, setMix] = useState<Brush[]>([]);
  /** How Paint and Erase apply: freehand, a dragged rectangle, or a flood fill of the connected area. */
  const [paintMode, setPaintMode] = useState<'brush' | 'rect' | 'fill'>('brush');
  /** The rectangle being dragged in rectangle mode (previewed as an outline). */
  const [paintRect, setPaintRect] = useState<CellRect | null>(null);
  const paintAnchor = useRef<[number, number] | null>(null);
  const [recentTileList, setRecentTileList] = useState<Brush[]>([]);
  const [pinned, setPinned] = useState<Brush[]>([]);
  const [recentMapList, setRecentMapList] = useState<RecentMap[]>(() => recentMaps());
  const [reopenLastMap, setReopenLastMap] = useState(() => reopenLast());
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  /** Autosaved changes found for the map just opened, offered for restoring. */
  const [recoveryOffer, setRecoveryOffer] = useState<Recovery | null>(null);
  const [centerOn, setCenterOn] = useState<{ x: number; y: number; signal: number } | null>(null);
  const [exportingImage, setExportingImage] = useState(false);
  /**
   * Sub-tile flag edits made from the Cell panel, not saved yet. They change the loaded tiles directly (so the map and
   * the walkability overlay show them at once); the original flags are kept to discard. Saving writes the DT1s.
   */
  const flagEdits = useRef(new Map<Dt1Tile, { path: string; index: number; original: Uint8Array }>());
  const [flagEditCount, setFlagEditCount] = useState(0);
  const [savingFlags, setSavingFlags] = useState(false);
  /** Levels / LvlWarp / LvlPrest, for showing and changing where warps lead. */
  const [warpTables, setWarpTables] = useState<WarpTables | null>(null);
  const [warpEdit, setWarpEdit] = useState<number | null>(null);
  const [warpBusy, setWarpBusy] = useState(false);
  /** A DT1 or DS1 picked for importing (with what it contains, or why it can't be used). */
  const [importing, setImporting] = useState<
    | { kind: 'dt1'; name: string; bytes: Uint8Array; info: { tiles: number; kinds: string } | string }
    | { kind: 'ds1'; name: string; bytes: Uint8Array; info: { width: number; height: number; act: number; missing: string[] } | string }
    | null
  >(null);
  const [importBusy, setImportBusy] = useState(false);
  /** Choices "Add to game" starts with (after importing a map). */
  const [registerInitial, setRegisterInitial] = useState<{ mode?: 'existing' | 'new'; levelId?: number; name?: string; note?: string } | undefined>(undefined);
  const [paletteFocus, setPaletteFocus] = useState<PaletteFocus | null>(null);
  /** Shows a tile in the Tiles panel: switches to its layer and DT1, scrolls to it and highlights it. */
  const focusTile = useCallback((tile: Dt1Tile, layer: LayerRef) => {
    setActiveLayer(layer);
    setSidePanel('tiles');
    setPaletteFocus((f) => ({ tile, seq: (f?.seq ?? 0) + 1 }));
  }, []);
  const [selection, setSelection] = useState<CellRect | null>(null);
  /**
   * Tiles stacked under the last Shift+wheel / click point, frontmost first, and which one is chosen (-1 = none:
   * the selection covers every layer). While one is chosen, copy/cut/delete only touch its layer.
   */
  const [stack, setStack] = useState<{ items: DrawItem[]; index: number; anchor?: [number, number] } | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [pasting, setPasting] = useState(false);
  const [selectedObject, setSelectedObject] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'new' | 'saveAs' | 'resize' | 'dt1s' | 'tables' | 'register' | 'cube' | 'check' | 'export' | 'import' | 'shortcuts' | 'dt1edit' | 'about' | 'update' | 'automap' | 'replace' | 'image' | null>(null);
  const [tableTarget, setTableTarget] = useState<TableTarget | null>(null);
  const [sidePanel, setSidePanel] = useState<'tiles' | 'presets'>('tiles');
  const [resizeMode, setResizeMode] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [suggested, setSuggested] = useState<Preset[] | null>(null);
  const [suggesting, setSuggesting] = useState<SuggestProgress | null>(null);
  const [checkResults, setCheckResults] = useState<CheckResult[] | null>(null);
  const [marks, setMarks] = useState<{ x: number; y: number }[] | undefined>(undefined);
  const [exportState, setExportState] = useState<{ building: boolean; result: { files: { path: string; size: number; from: string }[]; missing: string[] } | null }>({ building: false, result: null });
  const [importState, setImportState] = useState<{ pkg: MapPackage; plan: ImportPlan } | null>(null);
  const [sprites, setSprites] = useState<Map<string, Sprite>>(() => new Map());
  const [placing, setPlacing] = useState<{ type: number; id: number } | null>(null);
  const [desktopCfg, setDesktopCfg] = useState<DesktopConfig>({ modDirs: [], modMpqs: false });
  /** Desktop app: the folder dialog is open over a loaded workspace. */
  const [changingFolders, setChangingFolders] = useState(false);
  /** Current object drag: what is being moved, and the sub-tile offset from the grab point. */
  const objectDrag = useRef<{ obj: number; point: number | null } | null>(null);
  const selectAnchor = useRef<[number, number] | null>(null);
  /** The tile tool to return to when Tab leaves object editing. */
  const lastTileTool = useRef<Tool>('select');
  const keys = useKeybindings();
  const [leftW, setLeftW] = usePersistentSize('left', 260, 180, 560);
  const [rightW, setRightW] = usePersistentSize('right', 330, 260, 760);

  const bump = () => setRevision((r) => r + 1);
  const shiftHeld = useRef(false);
  useEffect(() => {
    const track = (e: KeyboardEvent | PointerEvent) => (shiftHeld.current = e.shiftKey);
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    window.addEventListener('pointerdown', track, true);
    return () => {
      window.removeEventListener('keydown', track);
      window.removeEventListener('keyup', track);
      window.removeEventListener('pointerdown', track, true);
    };
  }, []);
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

  /** Desktop app: remember the folders and mount them. */
  const openDesktop = useCallback(
    async (cfg: DesktopConfig) => {
      try {
        setData({ status: 'loading', message: 'Opening game archives…' });
        await setConfig(cfg);
        setDesktopCfg(cfg);
        const fs = await loadFromTauri(cfg);
        if (!fs.baseSources.length) throw new Error('No game data found in the chosen folders.');
        setMap(null);
        setDoc(null);
        setChangingFolders(false);
        await mountFs(fs, tauriSaveTarget(cfg));
      } catch (e) {
        setData({ status: 'setup', error: String(e) });
      }
    },
    [mountFs],
  );

  // Desktop app: use the remembered folders. Dev: the Vite plugin serves the local install. Otherwise ask for a folder.
  useEffect(() => {
    (async () => {
      if (isTauri) {
        const cfg = await getConfig();
        setDesktopCfg(cfg);
        if (cfg.gameDir) await openDesktop(cfg);
        else setData({ status: 'setup' });
        return;
      }
      const fs = await loadFromDevServer();
      if (fs) await mountFs(fs, await devServerSaveTarget());
      else setData({ status: 'setup' });
    })().catch((e) => setData({ status: 'setup', error: String(e) }));
  }, [mountFs, openDesktop]);

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

  const confirmDiscard = useCallback(() => {
    if (flagEdits.current.size) {
      if (!window.confirm(`Discard the unsaved sub-tile changes to ${flagEdits.current.size} tile${flagEdits.current.size === 1 ? '' : 's'}?`)) return false;
      for (const [t, e] of flagEdits.current) t.subTileFlags = e.original;
      flagEdits.current.clear();
      setFlagEditCount(0);
    }
    if (!doc?.dirty) return true;
    if (!window.confirm(`Discard unsaved changes to ${doc.path.split('/').pop()}?`)) return false;
    void deleteRecovery(doc.path).then(() => listRecoveries().then(setRecoveries));
    return true;
  }, [doc]);

  const open = useCallback(
    /** `confirmed`: the caller already asked about unsaved changes. */
    async (path: string, confirmed = false) => {
      if (!gd || (!confirmed && !confirmDiscard())) return;
      setLoadingPath(path);
      try {
        const m = await openMap(gd, path);
        setMap(m);
        setDoc(new MapDocument(path, m.ds1));
        setRecentMapList(addRecentMap(path));
        // Autosaved changes from a session that ended without saving: offer them.
        void getRecovery(path).then((r) => setRecoveryOffer(r));
        setHover(null);
        setMix([]);
        setPaintRect(null);
        setActiveLayer((l) => (l.kind === 'wall' && m.ds1.walls.length ? { kind: 'wall', index: 0 } : { kind: 'floor', index: 0 }));
        setBrush(null);
        setSelection(null);
        setPasting(false);
        setSelectedObject(null);
        setPlacing(null);
        setSuggested(null);
        setMarks(undefined);
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

  // Recent and pinned tiles belong to a tile set (the level type): the same numbers are other tiles elsewhere.
  const tileSet = map ? String(map.resolution.lvlType?.id ?? map.path.toLowerCase()) : '';
  useEffect(() => {
    setRecentTileList(tileSet ? recentTiles(tileSet) : []);
    setPinned(tileSet ? pinnedTiles(tileSet) : []);
  }, [tileSet]);
  const pickBrush = useCallback(
    (b: Brush, add = false) => {
      if (add && brush) {
        // Ctrl+click: add to / remove from the random mix painted together with the brush.
        const same = (x: Brush) => x.orientation === b.orientation && x.main === b.main && x.sub === b.sub;
        if (same(brush)) return;
        setMix((m) => (m.some(same) ? m.filter((x) => !same(x)) : [...m, b]));
      } else {
        setBrush(b);
        setMix([]);
      }
      setTool('paint');
      if (tileSet) setRecentTileList(noteTileUse(tileSet, b));
    },
    [brush, tileSet],
  );

  // Autosave: every 20 s, keep a copy of a map with unsaved changes (in the app's own storage) for recovery.
  const autosaved = useRef<{ doc: MapDocument | null; revision: number }>({ doc: null, revision: -1 });
  useEffect(() => {
    const t = setInterval(() => {
      if (!doc) return;
      if (!doc.dirty) {
        // Back to the saved state (undone): an autosaved copy of this map is out of date.
        if (autosaved.current.doc === doc && autosaved.current.revision !== -1) void deleteRecovery(doc.path);
        autosaved.current = { doc, revision: -1 };
        return;
      }
      if (autosaved.current.doc === doc && autosaved.current.revision === doc.revision) return;
      autosaved.current = { doc, revision: doc.revision };
      try {
        void saveRecovery(doc.path, writeDs1(doc.ds1));
      } catch {
        // an unsavable state (mid-edit) is caught on the next tick
      }
    }, 20_000);
    return () => clearInterval(t);
  }, [doc]);

  // On start: list autosaved work, and reopen the last map if asked to.
  const started = useRef(false);
  useEffect(() => {
    if (data.status !== 'ready' || started.current) return;
    started.current = true;
    void listRecoveries().then(setRecoveries);
    const last = recentMaps()[0];
    if (reopenLast() && last && data.files.some((f) => f.toLowerCase() === last.path.toLowerCase())) void open(last.path);
  }, [data, open]);
  const restoreRecovery = useCallback(async () => {
    const r = recoveryOffer;
    if (!r || !gd || !map || map.path.toLowerCase() !== r.path.toLowerCase()) return setRecoveryOffer(null);
    try {
      const m = await openMap(gd, map.path, undefined, parseDs1(r.bytes));
      const d = new MapDocument(map.path, m.ds1);
      d.markUnsaved();
      setMap(m);
      setDoc(d);
      notify(`Restored the changes autosaved ${new Date(r.time).toLocaleString()}. Save to keep them.`);
    } catch (e) {
      notify(`Couldn't restore: ${(e as Error).message}`, true);
    }
    setRecoveryOffer(null);
  }, [recoveryOffer, gd, map, notify]);

  /** Changes the sub-tile flags of `tiles` (in their DT1s) with `fn`; shown at once, saved with saveTileFlags. */
  const editTileFlags = useCallback(
    (tiles: Dt1Tile[], fn: (current: Uint8Array) => Uint8Array) => {
      if (!map) return;
      for (const t of tiles) {
        const src = map.lib.sourceOf(t);
        if (!src || isBuiltinPath(src.path)) continue;
        const entry = flagEdits.current.get(t) ?? { path: src.path, index: src.index, original: t.subTileFlags.slice() };
        t.subTileFlags = fn(t.subTileFlags);
        if (t.subTileFlags.every((f, i) => f === entry.original[i])) flagEdits.current.delete(t);
        else flagEdits.current.set(t, entry);
      }
      setFlagEditCount(flagEdits.current.size);
      bump();
    },
    [map],
  );
  const discardTileFlags = useCallback(() => {
    for (const [t, e] of flagEdits.current) t.subTileFlags = e.original;
    flagEdits.current.clear();
    setFlagEditCount(0);
    bump();
  }, []);

  useEffect(() => {
    if (!gd) return;
    let live = true;
    void loadWarpTables(gd.fs).then((t) => live && setWarpTables(t));
    return () => {
      live = false;
    };
  }, [gd]);
  const mapLevelId = map?.resolution.preset?.levelId ?? 0;
  const links = useMemo(() => (warpTables && gd && mapLevelId > 0 ? levelLinks(warpTables, mapLevelId, gd.fs) : null), [warpTables, gd, mapLevelId]);
  const specialLabel = useCallback(
    (main: number, sub: number) => {
      const base = main <= 7 ? `Warp · link ${main}` : null;
      if (base === null) return specialTileInfo(main, sub).label;
      const link = links?.links[main];
      return link ? `${base} → ${link.target.name}` : links ? `${base} (not set)` : specialTileInfo(main, sub).label;
    },
    [links],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` invalidates the scene after in-place edits
  const scene = useMemo(() => (map ? buildScene(map.ds1, map.lib) : null), [map, revision]);

  // Preview under the cursor: the pending paste, or the paint brush.
  const pasteRect = useMemo(
    (): CellRect | null =>
      pasting && clipboard && hover
        ? { x0: hover.cellX, y0: hover.cellY, x1: hover.cellX + clipboard.width - 1, y1: hover.cellY + clipboard.height - 1 }
        : paintRect,
    [pasting, clipboard, hover, paintRect],
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

  // The chosen stacked tile, found again in the current scene (edits rebuild it); gone when its tile is gone.
  const focus = useMemo(() => {
    if (!stack || stack.index < 0 || !scene) return null;
    const want = stack.items[stack.index];
    const item = scene.items.find((it) => sameItem(it, want));
    if (!item) return null;
    return { item, index: stack.index, count: stack.items.length, label: `${layerLabel(layerOfItem(item))} ${item.tile.mainIndex}/${item.tile.subIndex}` };
  }, [stack, scene]);
  const onlyLayer = focus ? layerOfItem(focus.item) : null;
  const cycleStack = useCallback(
    (dir: 1 | -1, world: [number, number]) => {
      if (!doc || !scene || tool === 'object' || pasting) return;
      // Keep stepping through the same stack while the cursor stays near where it started (a pixel of mouse drift
      // would otherwise land on a different set of tiles and start over); farther away, stack up the new spot.
      const near = stack?.anchor && Math.hypot(world[0] - stack.anchor[0], world[1] - stack.anchor[1]) * zoom < 24;
      const items = near ? stack!.items : stackAt(scene, world[0], world[1], (it) => isVisible(it, visibility));
      if (!items.length) return;
      const index = near && stack!.index >= 0 ? (stack!.index + dir + items.length) % items.length : dir > 0 ? 0 : items.length - 1;
      const item = items[index];
      setStack({ items, index, anchor: near ? stack!.anchor : world });
      setSelection({ x0: item.cellX, y0: item.cellY, x1: item.cellX, y1: item.cellY });
      focusTile(item.tile, layerOfItem(item));
      if (tool !== 'select' && tool !== 'paint') setTool('select');
    },
    [doc, scene, tool, pasting, visibility, stack, focusTile, zoom],
  );

  const pickAt = useCallback(
    (x: number, y: number, world: [number, number]) => {
      if (!doc || !scene) return;
      // What you see is what you pick: the frontmost tile pixel under the cursor.
      const hit = hitTest(scene, world[0], world[1], (it) => isVisible(it, visibility));
      if (hit) {
        const layer: LayerRef = { kind: hit.kind === 'floor' ? 'floor' : 'wall', index: hit.layer };
        const orientation = hit.tile.orientation === Orientation.LeftPartOfNorthCornerWall ? Orientation.RightPartOfNorthCornerWall : hit.tile.orientation;
        focusTile(hit.tile, layer);
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
    [doc, scene, visibility, notify, focusTile],
  );

  const onStroke = useCallback(
    (phase: StrokePhase, cells: [number, number][], world: [number, number], mods?: StrokeMods) => {
      if (!doc) return;
      if (tool === 'object') {
        const [fx, fy] = worldToSubTile(world[0], world[1]);
        const sx = Math.round(fx);
        const sy = Math.round(fy);
        const objs = doc.ds1.objects;
        if (phase === 'start') {
          const near = (x: number, y: number) => {
            const [wx, wy] = subTileToWorld(x, y);
            return Math.hypot(wx - world[0], wy - world[1]) < 10;
          };
          if (placing) {
            const next: Ds1Object[] = [...objs, { type: placing.type, id: placing.id, x: sx, y: sy, flags: 0, path: [] }];
            doc.setObjects(next);
            setSelectedObject(next.length - 1);
            setPlacing(null);
            bump();
            return;
          }
          const sel = selectedObject !== null ? objs[selectedObject] : null;
          const point = sel ? sel.path.findIndex((p) => near(p.x, p.y)) : -1;
          if (sel && point >= 0) {
            doc.beginObjectEdit();
            objectDrag.current = { obj: selectedObject!, point };
            return;
          }
          if (sel && shiftHeld.current) {
            doc.setObjects(objs.map((o, i) => (i === selectedObject ? { ...o, path: [...o.path, { x: sx, y: sy, action: 1 }] } : o)));
            bump();
            return;
          }
          // Topmost (last drawn) object under the cursor.
          let hit = -1;
          for (let i = objs.length - 1; i >= 0 && hit < 0; i--) if (near(objs[i].x, objs[i].y)) hit = i;
          setSelectedObject(hit >= 0 ? hit : null);
          if (hit >= 0) {
            doc.beginObjectEdit();
            objectDrag.current = { obj: hit, point: null };
          }
          return;
        }
        const drag = objectDrag.current;
        if (drag && phase === 'move') {
          const next = objs.map((o, i) => {
            if (i !== drag.obj) return o;
            if (drag.point === null) return o.x === sx && o.y === sy ? o : { ...o, x: sx, y: sy };
            return { ...o, path: o.path.map((p, n) => (n === drag.point ? { ...p, x: sx, y: sy } : p)) };
          });
          if (next[drag.obj] !== objs[drag.obj]) {
            doc.liveObjects(next);
            bump();
          }
        }
        if (phase === 'end') {
          doc.endObjectEdit();
          objectDrag.current = null;
          bump();
        }
        return;
      }
      if (pasting) {
        if (phase === 'start' && cells[0] && clipboard) {
          const [x, y] = cells[0];
          // Alt: stack onto the tiles already there (next free wall/floor layer) instead of replacing them.
          const overlap = mods?.alt ? overlapEdits(doc, clipboard, x, y) : null;
          const edits = overlap ? overlap.edits : pasteEdits(doc, clipboard, x, y);
          const objects = pasteObjects(doc, clipboard, x, y);
          const addsLayers = !!overlap && (overlap.walls > doc.ds1.walls.length || overlap.floors > doc.ds1.floors.length);
          if (overlap) notify(`Stacked onto existing tiles${addsLayers ? ` (now ${overlap.walls} wall / ${overlap.floors} floor layers)` : ''}${overlap.replaced ? ` · ${overlap.replaced} cells had no free layer and were replaced` : ''}`);
          if (objects.length || addsLayers) {
            // Cells, new layers and objects together, as one undo step.
            doc.mutate((d) => {
              const cellCount = d.width * d.height;
              while (overlap && d.walls.length < overlap.walls) d.walls.push(Array.from({ length: cellCount }, () => ({ ...EMPTY_CELL, orientation: 0, orientationHigh: 0 })));
              while (overlap && d.floors.length < overlap.floors) d.floors.push(Array.from({ length: cellCount }, () => EMPTY_CELL));
              for (const e of edits) {
                const layers = e.layer.kind === 'floor' ? d.floors : e.layer.kind === 'wall' ? d.walls : d.shadows;
                (layers[e.layer.index] as typeof e.cell[])[e.y * d.width + e.x] = e.cell;
              }
              d.objects = [...d.objects, ...objects];
            }, `Paste ${clipboard.width}×${clipboard.height}${objects.length ? ` + ${objects.length} object${objects.length === 1 ? '' : 's'}` : ''}`);
            bump();
          } else if (doc.apply(edits, `Paste ${clipboard.width}×${clipboard.height}`)) bump();
          setSelection(clampRect({ x0: x, y0: y, x1: x + clipboard.width - 1, y1: y + clipboard.height - 1 }, doc.ds1.width, doc.ds1.height));
          setPasting(false);
        }
        return;
      }
      if (tool === 'select') {
        const cell = cells[cells.length - 1];
        if (phase === 'start' && cell) {
          selectAnchor.current = cell;
          // Clicking a tile selects the cell it belongs to (tall walls and trees overlap the cells behind them)
          // and reveals the tile in its DT1 in the Tiles panel.
          const opaque = scene ? hitTestAll(scene, world[0], world[1], (it) => isVisible(it, visibility)) : [];
          const hit = opaque[0];
          const hits = scene && hit ? stackAt(scene, world[0], world[1], (it) => isVisible(it, visibility)) : opaque;
          setStack(hits.length > 1 ? { items: hits, index: -1, anchor: world } : null);
          if (hit) {
            selectAnchor.current = [hit.cellX, hit.cellY];
            focusTile(hit.tile, layerOfItem(hit));
            if (hits.length > 1) notify(`${hits.length} tiles overlap here: Shift+wheel to pick one layer`);
          }
          setSelection(clampRect(rectFrom(selectAnchor.current, selectAnchor.current), doc.ds1.width, doc.ds1.height));
          return;
        }
        if (cell && selectAnchor.current) {
          const r = clampRect(rectFrom(selectAnchor.current, cell), doc.ds1.width, doc.ds1.height);
          if (!r || !isSingleCell(r)) setStack(null);
          setSelection(r);
        }
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
      // The tiles to paint with (the brush plus the random mix), oriented for the active layer; null = erase.
      const tiles = tool === 'paint' && brush ? [brush, ...mix].map((b) => ({ ...b, orientation: brushOrientation(activeLayer, b) })) : null;
      const verb = tool === 'paint' ? 'Paint' : 'Erase';
      const where = ` on ${layerLabel(activeLayer)}`;
      if (paintMode === 'rect') {
        const cell = cells[cells.length - 1];
        if (phase === 'start' && cell) paintAnchor.current = cell;
        if (cell && paintAnchor.current) setPaintRect(clampRect(rectFrom(paintAnchor.current, cell), doc.ds1.width, doc.ds1.height));
        if (phase === 'end') {
          const r = paintAnchor.current && hover ? clampRect(rectFrom(paintAnchor.current, [hover.cellX, hover.cellY]), doc.ds1.width, doc.ds1.height) : paintRect;
          paintAnchor.current = null;
          setPaintRect(null);
          if (r && doc.apply(paintEdits(doc, activeLayer, rectCells(r), tiles), `${verb} rectangle${where}`)) bump();
        }
        return;
      }
      if (paintMode === 'fill') {
        const cell = cells[0];
        if (phase !== 'start' || !cell) return;
        // Inside the selection, the fill stays within it.
        const within = selection && cell[0] >= selection.x0 && cell[0] <= selection.x1 && cell[1] >= selection.y0 && cell[1] <= selection.y1 ? selection : null;
        const region = floodRegion(doc, activeLayer, cell[0], cell[1], within);
        if (doc.apply(paintEdits(doc, activeLayer, region, tiles), `${tool === 'paint' ? 'Fill' : 'Erase'} area${where}`)) {
          bump();
          notify(`${tool === 'paint' ? 'Filled' : 'Erased'} ${region.length} connected cell${region.length === 1 ? '' : 's'}${within ? ' (inside the selection)' : ''}`);
        }
        return;
      }
      if (phase === 'start') doc.beginStroke(`${verb}${where}`);
      const changed = doc.apply(paintEdits(doc, activeLayer, cells, tiles));
      if (phase === 'end') doc.endStroke();
      if (changed || phase === 'end') bump();
    },
    [doc, tool, brush, mix, paintMode, paintRect, hover, selection, activeLayer, pickAt, notify, pasting, clipboard, placing, selectedObject, scene, visibility, focusTile],
  );

  // Selection commands.
  const copy = useCallback(
    (cut: boolean) => {
      if (!doc || !selection) return;
      const raw = copyRect(doc, selection);
      const clip = map ? { ...raw, ...clipboardSources(raw, map.lib) } : raw;
      const [w, h] = rectSize(selection);
      if (onlyLayer) {
        // One tile of a stack (Shift+wheel): just its layer, no objects.
        setClipboard({ ...clip, layers: clip.layers.filter((l) => layerKey(l.layer) === layerKey(onlyLayer)), objects: undefined });
        if (cut && doc.apply(clearEdits(doc, selection, [onlyLayer]))) bump();
        notify(`${cut ? 'Cut' : 'Copied'} ${layerLabel(onlyLayer)} only`);
        return;
      }
      setClipboard(clip);
      const objects = clip.objects?.length ?? 0;
      if (cut) clearArea(selection, true, `Cut ${w}×${h}`);
      notify(`${cut ? 'Cut' : 'Copied'} ${w}×${h} cells (all layers${objects ? ` + ${objects} object${objects === 1 ? '' : 's'}` : ''})${cut ? ': paste to move them' : ''}`);
    },
    [doc, selection, notify, onlyLayer], // eslint-disable-line react-hooks/exhaustive-deps
  );
  /** Before pasting into a map that lacks the copied tiles' DT1s, offer to load them. */
  const [pasteOffer, setPasteOffer] = useState<{ clip: Clipboard; tiles: number; different: number; dt1s: string[]; label: string } | null>(null);
  const beginPaste = useCallback(
    (clip: Clipboard, label: string, skipCheck = false) => {
      if (!skipCheck && map) {
        const m = missingForPaste(clip, map.lib);
        if (m.tiles || m.different) {
          setPasteOffer({ clip, tiles: m.tiles, different: m.different, dt1s: m.dt1s, label });
          return;
        }
      }
      setClipboard(clip);
      setPasting(true);
      notify(`${label} · click the map (hold Alt to stack onto existing tiles) · Esc to cancel`);
    },
    [map, notify],
  );
  const startPaste = useCallback(() => {
    if (!clipboard) return notify('Nothing to paste: copy a selection first (Ctrl+C).');
    beginPaste(clipboard, 'Pasting');
  }, [clipboard, notify, beginPaste]);
  /**
   * Clears `r`: the active layer, or (everything) every tile layer plus the objects and NPCs standing in it, so a
   * cut takes everything with it. One undo step.
   */
  function clearArea(r: CellRect, everything: boolean, label: string) {
    if (!doc) return;
    const edits = clearEdits(doc, r, everything ? doc.layers() : [activeLayer]);
    const inside = everything ? doc.ds1.objects.filter((o) => objectInRect(o, r)).length : 0;
    if (!inside) {
      if (doc.apply(edits, label)) bump();
      return;
    }
    doc.mutate((d) => {
      for (const e of edits) {
        const layers = e.layer.kind === 'floor' ? d.floors : e.layer.kind === 'wall' ? d.walls : d.shadows;
        (layers[e.layer.index] as typeof e.cell[])[e.y * d.width + e.x] = e.cell;
      }
      d.objects = d.objects.filter((o) => !objectInRect(o, r));
    }, `${label} + ${inside} object${inside === 1 ? '' : 's'}`);
    setSelectedObject(null);
    bump();
  }
  const clearSelection = useCallback(
    (allLayers: boolean) => {
      if (!doc || !selection) return;
      const [w, h] = rectSize(selection);
      clearArea(selection, allLayers, allLayers ? `Clear ${w}×${h}` : `Clear ${layerLabel(activeLayer)} ${w}×${h}`);
    },
    [doc, selection, activeLayer], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const fillSelection = useCallback(() => {
    if (!doc || !selection) return;
    if (!brush) return notify('Choose a tile in the Tiles panel first.', true);
    const tiles = [brush, ...mix].map((b) => ({ ...b, orientation: brushOrientation(activeLayer, b) }));
    if (doc.apply(paintEdits(doc, activeLayer, rectCells(selection), tiles), `Fill ${layerLabel(activeLayer)}`)) bump();
  }, [doc, selection, brush, mix, activeLayer, notify]);
  const rerollSelection = useCallback(() => {
    if (!doc || !selection) return;
    const edits = rerollEdits(doc, selection, [activeLayer]);
    if (doc.apply(edits, `Re-roll ${layerLabel(activeLayer)}`)) {
      bump();
      notify(`Re-rolled ${edits.length} tiles on ${layerLabel(activeLayer)}`);
    } else notify(`Nothing to re-roll: ${layerLabel(activeLayer)} here uses one tile per group. Re-roll mixes the tiles of a group (same main index) already in the selection.`);
  }, [doc, selection, activeLayer, notify]);
  /** The tile to find, for Find & replace: the selected cell's on the active layer, else the brush. */
  const replaceFrom = useMemo((): TileKey | null => {
    if (!doc || dialog !== 'replace') return null;
    const c = selection && isSingleCell(selection) ? keyOf(activeLayer, doc.cell(activeLayer, selection.x0, selection.y0)) : null;
    return c ?? (brush ? { ...brush, orientation: brushOrientation(activeLayer, brush) } : null);
  }, [doc, dialog, selection, activeLayer, brush]);
  const exportImage = useCallback(
    async (o: { area: CellRect | null; scale: number; objects: boolean }) => {
      if (!doc || !map || !scene) return;
      setExportingImage(true);
      try {
        const blob = await renderMapImage(scene, doc.ds1.objects, sprites, map.palette, doc.ds1.width, doc.ds1.height, { ...o, visible: (it) => isVisible(it, visibility) });
        const where = await exportBytes(`${doc.path.split('/').pop()!.replace(/\.ds1$/i, '')}.png`, new Uint8Array(await blob.arrayBuffer()));
        if (where) notify(`Exported ${where}`);
        setDialog(null);
      } catch (e) {
        notify(`Export failed: ${(e as Error).message}`, true);
      } finally {
        setExportingImage(false);
      }
    },
    [doc, map, scene, sprites, visibility, notify],
  );
  const setObjects = useCallback(
    (next: Ds1Object[]) => {
      if (!doc) return;
      doc.setObjects(next);
      if (selectedObject !== null && selectedObject >= next.length) setSelectedObject(null);
      bump();
    },
    [doc, selectedObject],
  );
  const deleteSelectedObject = useCallback(() => {
    if (!doc || selectedObject === null) return false;
    setObjects(doc.ds1.objects.filter((_, i) => i !== selectedObject));
    setSelectedObject(null);
    return true;
  }, [doc, selectedObject, setObjects]);
  // Load sprites for every distinct object on the map (cached per object id in GameData).
  const objectKeys = map ? [...new Set(map.ds1.objects.map((o) => `${o.type}:${o.id}`))].sort().join(',') : '';
  useEffect(() => {
    if (!gd || !map || !objectKeys) return setSprites(new Map());
    let cancelled = false;
    const act = map.ds1.act;
    Promise.all(
      objectKeys.split(',').map(async (k) => {
        const [type, id] = k.split(':').map(Number);
        return [k, await gd.objectSprite(act, type, id)] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setSprites(new Map(entries.filter((e): e is [string, Sprite] => !!e[1])));
    });
    return () => {
      cancelled = true;
    };
  }, [gd, map, objectKeys]);
  // Animations for the same objects, loaded only while animation and sprites are shown.
  const [animations, setAnimations] = useState<Map<string, SpriteAnimation>>(() => new Map());
  useEffect(() => {
    // Loaded whenever sprites show (not only while animating): they also carry the translucent/glowing layers.
    if (!gd || !map || !objectKeys || !visibility.sprites) return setAnimations(new Map());
    let cancelled = false;
    const act = map.ds1.act;
    Promise.all(
      objectKeys.split(',').map(async (k) => {
        const [type, id] = k.split(':').map(Number);
        return [k, await gd.objectAnimation(act, type, id)] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setAnimations(new Map(entries.filter((e): e is [string, SpriteAnimation] => !!e[1] && e[1].parts.length > 0)));
    });
    return () => {
      cancelled = true;
    };
  }, [gd, map, objectKeys, visibility.sprites]);

  const objectLabel = useCallback((o: Ds1Object) => (gd && map ? gd.objectName(map.ds1.act, o.type, o.id) : `${o.type},${o.id}`), [gd, map]);
  const nameOf = useCallback((type: number, id: number) => (gd && map ? gd.objectName(map.ds1.act, type, id) : `${type},${id}`), [gd, map]);

  const mutate = useCallback(
    (fn: (ds1: Ds1) => Ds1 | void) => {
      if (!doc) return;
      doc.mutate(fn);
      bump();
    },
    [doc],
  );
  const resize = useCallback(
    (d: ResizeDelta) => {
      mutate((ds1) => resizeDs1(ds1, d));
      setSelection(null);
      setSelectedObject(null);
      setDialog(null);
      setFitSignal((n) => n + 1);
    },
    [mutate],
  );
  const createMap = useCallback(
    async (c: NewMapChoice) => {
      if (!gd || !confirmDiscard()) return;
      const paths = GameData.dt1sFor(c.lvlType, 0xffffffff);
      const ds1 = newDs1({ ...c, files: paths.map(embeddedFileName) });
      try {
        const m = await openMap(gd, c.path, { source: 'manual', lvlType: c.lvlType, paths }, ds1);
        const d = new MapDocument(c.path, m.ds1);
        d.markUnsaved();
        setMap(m);
        setDoc(d);
        setSelection(null);
        setSelectedObject(null);
        setActiveLayer({ kind: 'floor', index: 0 });
        setDialog(null);
        notify(`New ${c.width}×${c.height} map. Pick tiles in the Tiles panel and paint (B); Save writes ${c.path}.`);
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [gd, confirmDiscard, notify],
  );
  const saveAs = useCallback(
    (path: string) => {
      if (!doc || !map) return;
      doc.path = path;
      setMap({ ...map, path });
      setDialog(null);
      // Save on the next render, once `data.files`/`doc.path` reflect the new name.
      setTimeout(() => void handlers.current.save(), 0);
    },
    [doc, map],
  );

  const applyEdits = useCallback(
    (edits: CellEdit[]) => {
      if (doc?.apply(edits)) bump();
    },
    [doc],
  );

  /** Writes files into the mod (via the save target) and makes the app see them right away. */
  const writeFiles = useCallback(
    async (files: { path: string; bytes: Uint8Array }[]) => {
      if (!gd || data.status !== 'ready' || !data.saveTarget) throw new Error('No writable mod folder is configured.');
      for (const f of files) {
        await data.saveTarget.save(f.path, f.bytes);
        gd.fs.remember(f.path, f.bytes, data.saveTarget.label);
      }
    },
    [gd, data],
  );

  /** After table edits: reload the game tables and re-resolve the open map (keeping its edits). */
  const reloadTables = useCallback(async () => {
    if (!gd || data.status !== 'ready') return;
    const next = await GameData.load(gd.fs);
    const files = gd.fs.list((p) => p.endsWith('.ds1') && p.startsWith('data/global/tiles/'));
    setData({ ...data, gd: next, files });
    if (map) setMap(await openMap(next, map.path, undefined, map.ds1));
  }, [gd, data, map]);

  const applyTableWrites = useCallback(
    async (writes: TableWrite[]) => {
      try {
        await writeFiles(writes);
        await reloadTables();
        setDialog(null);
        notify(`Updated ${writes.map((w) => w.table).join(', ')}`);
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [writeFiles, reloadTables, notify],
  );

  /** DT1s the placed tiles come from, with counts (for the DT1 manager and checks). */
  const dt1Usage = useMemo(() => {
    const usage = new Map<string, number>();
    for (const it of scene?.items ?? []) {
      const src = map?.lib.sourceOf(it.tile);
      if (src) usage.set(normalizePath(src.path), (usage.get(normalizePath(src.path)) ?? 0) + 1);
    }
    return usage;
  }, [scene, map]);

  const applyDt1s = useCallback(
    async (paths: string[]) => {
      if (!gd || !map || !doc) return;
      // The DS1's embedded list mirrors the libraries (WinDS1 keeps its own DS1EDIT_* notes in there too).
      mutate((d) => {
        const notes = d.files.filter((f) => !/data[\\/]/i.test(f));
        d.files = [...paths.map(embeddedFileName), ...notes];
      });
      setDialog(null);
      // Keep the game's tables in step, or the game won't load the new tiles: new DT1s go into free File slots of
      // the level type (LvlTypes.txt) and the preset's Dt1Mask (LvlPrest.txt) selects exactly these libraries.
      let tableNote = '';
      if (data.status === 'ready' && data.saveTarget) {
        try {
          const writes = await syncLevelTables(gd.fs, map.path, paths, map.resolution.lvlType?.id);
          if (writes.length) {
            await writeFiles(writes);
            await reloadTables();
            notify(`Tile libraries: ${paths.length}. Updated ${writes.flatMap((w) => w.summary).join('; ')}`);
            return;
          }
        } catch (e) {
          tableNote = ` (game tables not updated: ${(e as Error).message})`;
        }
      } else tableNote = ' (no writable mod folder, so LvlTypes/Dt1Mask were not updated)';
      setMap(await openMap(gd, map.path, { source: 'manual', lvlType: map.resolution.lvlType, paths }, map.ds1));
      notify(`Tile libraries: ${paths.length}${tableNote}`, !!tableNote);
    },
    [gd, map, doc, data, mutate, notify, writeFiles, reloadTables],
  );

  // Automap preview: AutoMap.txt + MaxiMap.dc6, loaded the first time the view is turned on (and after table edits).
  const [automapData, setAutomapData] = useState<{ gd: GameData; table: AutomapTable; cels: SpriteFrame[] } | null>(null);
  const [automapLevelOverride, setAutomapLevelOverride] = useState<{ path: string; level: string } | null>(null);
  useEffect(() => {
    if ((!visibility.automap && dialog !== 'automap') || !gd || automapData?.gd === gd) return;
    void (async () => {
      try {
        const [txt, dc6] = await Promise.all([gd.fs.read(AUTOMAP_TXT), gd.fs.read(AUTOMAP_DC6)]);
        if (!txt || !dc6) throw new Error('AutoMap.txt or MaxiMap.dc6 not found');
        setAutomapData({ gd, table: parseAutomap(parseTxtTable(txt)), cels: parseAutomapCels(dc6) });
      } catch (e) {
        notify(`Automap: ${(e as Error).message}`, true);
        setVisibility((v) => ({ ...v, automap: false }));
      }
    })();
  }, [visibility.automap, dialog, gd, automapData, notify]);
  const automapLevel = useMemo(() => {
    if (!automapData || !map) return null;
    if (automapLevelOverride?.path === map.path) return automapLevelOverride.level;
    return automapLevelFor(automapData.table, map.resolution.lvlType?.name, map.ds1.act + 1, map.resolution.lvlType?.id);
  }, [automapData, map, automapLevelOverride]);
  const automapPiecesNow = useMemo(
    () => (visibility.automap && automapData && map && automapLevel ? automapPieces(map.ds1, automapData.table, automapLevel) : null),
    [visibility.automap, automapData, map, automapLevel, revision], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [automapSuggestions, setAutomapSuggestions] = useState<AutomapSuggestion[] | null>(null);
  useEffect(() => setAutomapSuggestions(null), [map?.path, automapLevel]);
  const automapView = useMemo(
    () =>
      automapPiecesNow && automapData && map
        ? { pieces: automapSuggestions ? withSuggestions(automapPiecesNow, automapSuggestions) : automapPiecesNow, cels: automapData.cels, palette: map.palette }
        : null,
    [automapPiecesNow, automapData, map, automapSuggestions],
  );
  /** Opens the automap editor (loading AutoMap.txt first if the automap view hasn't yet). */
  const openAutomapEditor = useCallback(() => setDialog('automap'), []);
  const saveAutomapEdits = useCallback(
    async (edits: AutomapEdit[]) => {
      if (!gd || !automapLevel) return;
      const bytes = await gd.fs.read(AUTOMAP_TXT);
      if (!bytes) throw new Error('AutoMap.txt not found');
      const { doc: next, rows } = applyAutomapEdits(parseTxtTable(bytes), automapLevel, edits);
      await writeFiles([{ path: AUTOMAP_TXT, bytes: serializeTxtTable(next) }]);
      setAutomapData((d) => (d ? { ...d, table: parseAutomap(next) } : d));
      notify(`AutoMap.txt: ${edits.length} tile kinds saved as ${rows} rows for ${automapLevel}`);
    },
    [gd, automapLevel, writeFiles, notify],
  );
  const automapLevelLabel = useCallback(
    (l: string) => {
      const t = gd && /^\d+$/.test(l.trim()) ? gd.lvlType(Number(l)) : null;
      return t && t.name !== l.trim() ? `${l} · ${t.name}` : l;
    },
    [gd],
  );

  // Colours and look-alike references for automap suggestions; game-wide references are built once per level.
  const automapRefCache = useRef(new Map<string, Promise<ReferenceTile[]>>());
  const makeAutomapColors = useCallback(async (): Promise<AutomapColors | undefined> => {
    if (!gd || !map || !automapData || !automapLevel) return undefined;
    const table = automapData.table;
    const act = /^(\d)\s/.exec(automapLevel)?.[1];
    const key = `${automapLevel}|${automapData.gd === gd}`;
    let refs = automapRefCache.current.get(key);
    if (!refs) {
      refs = referenceTiles({
        table,
        types: gd.lvlTypes,
        levels: (l) => l !== automapLevel && (act ? l.startsWith(`${act} `) : true),
        loadDt1: (p) => gd.dt1(p),
        palette: (a) => gd.palette(a),
      });
      automapRefCache.current.set(key, refs);
    }
    return { ...automapColors(map.lib, automapData.cels, map.palette, { table, types: gd.lvlTypes }), extraRefs: await refs };
  }, [gd, map, automapData, automapLevel]);

  const applyAutomapSuggestionsNow = useCallback(async () => {
    if (!gd || !automapLevel || !automapSuggestions) return;
    try {
      const bytes = await gd.fs.read(AUTOMAP_TXT);
      if (!bytes) throw new Error('AutoMap.txt not found');
      const { doc: next, rows } = applyAutomapSuggestions(parseTxtTable(bytes), automapLevel, automapSuggestions);
      await writeFiles([{ path: AUTOMAP_TXT, bytes: serializeTxtTable(next) }]);
      setAutomapData((d) => (d ? { ...d, table: parseAutomap(next) } : d));
      setAutomapSuggestions(null);
      notify(`AutoMap.txt: added ${rows} rows for ${automapLevel}`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }, [gd, automapLevel, automapSuggestions, writeFiles, notify]);
  const setAutomapPiece = useCallback(
    async (piece: AutomapPiece, cel: number, scope: 'seq' | 'style') => {
      if (!gd || !automapLevel) return;
      try {
        const bytes = await gd.fs.read(AUTOMAP_TXT);
        if (!bytes) throw new Error('AutoMap.txt not found');
        const { doc: next, summary } = setAutomapCel(parseTxtTable(bytes), automapLevel, piece.orientation, piece.main, piece.sub, cel, scope);
        const out = serializeTxtTable(next);
        await writeFiles([{ path: AUTOMAP_TXT, bytes: out }]);
        setAutomapData((d) => (d ? { ...d, table: parseAutomap(next) } : d));
        notify(summary);
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [gd, automapLevel, writeFiles, notify],
  );

  /** DT1 editor: write the edited DT1, optionally swap it in for the original, then reload so every cache sees it. */
  const saveEditedDt1 = useCallback(
    async (r: Dt1EditResult) => {
      if (!gd || !map || !doc) return;
      await writeFiles([{ path: r.path, bytes: r.bytes }]);
      const notes: string[] = [`Saved ${r.path.split('/').pop()}`];
      if (r.switchMap) {
        const paths = map.lib.loaded
          .filter((l) => l.found && !isBuiltinPath(l.path))
          .map((l) => (normalizePath(l.path) === normalizePath(r.original) ? r.path : l.path));
        mutate((d) => {
          const others = d.files.filter((f) => !/data[\\/]/i.test(f));
          d.files = [...paths.map(embeddedFileName), ...others];
        });
        try {
          const writes = await syncLevelTables(gd.fs, map.path, paths, map.resolution.lvlType?.id);
          if (writes.length) await writeFiles(writes);
          notes.push(writes.length ? 'LvlTypes/Dt1Mask updated' : 'map now uses it');
        } catch (e) {
          notes.push(`game tables not updated: ${(e as Error).message}`);
        }
      }
      await reloadTables();
      setDialog(null);
      notify(notes.join(' · '));
    },
    [gd, map, doc, writeFiles, mutate, reloadTables, notify],
  );

  /** Writes the DT1s whose sub-tile flags were changed in the Cell panel into the mod (originals kept as .bak). */
  const saveTileFlags = useCallback(async () => {
    if (!gd || !flagEdits.current.size) return;
    setSavingFlags(true);
    try {
      const byPath = new Map<string, Map<number, { flags: Uint8Array }>>();
      for (const [t, e] of flagEdits.current) {
        if (!byPath.has(e.path)) byPath.set(e.path, new Map());
        byPath.get(e.path)!.set(e.index, { flags: t.subTileFlags });
      }
      const writes: { path: string; bytes: Uint8Array }[] = [];
      for (const [path, changes] of byPath) {
        const bytes = await gd.fs.read(path);
        if (!bytes) throw new Error(`${path} could not be read`);
        writes.push({ path, bytes: writeTileSettings(bytes, changes) });
      }
      await writeFiles(writes);
      const n = flagEdits.current.size;
      flagEdits.current.clear();
      setFlagEditCount(0);
      await reloadTables();
      notify(`Saved sub-tile flags of ${n} tile${n === 1 ? '' : 's'} into ${writes.map((w) => w.path.split('/').pop()).join(', ')}`);
    } catch (e) {
      notify(`Couldn't save the DT1: ${(e as Error).message}`, true);
    } finally {
      setSavingFlags(false);
    }
  }, [gd, writeFiles, reloadTables, notify]);

  /** Saves a warp link change (Levels.txt) and reloads the tables so labels and panels show it. */
  const applyWarpLink = useCallback(
    async (write: TableWrite) => {
      setWarpBusy(true);
      try {
        await writeFiles([write]);
        await reloadTables();
        setWarpEdit(null);
        notify(`Levels.txt: ${write.summary.join('; ')}`);
      } catch (e) {
        notify(`Couldn't save Levels.txt: ${(e as Error).message}`, true);
      } finally {
        setWarpBusy(false);
      }
    },
    [writeFiles, reloadTables, notify],
  );

  /** Picks a DT1 or DS1 to import and checks it can be read. */
  const pickImport = useCallback(
    async (kind: 'dt1' | 'ds1') => {
      if (!gd) return;
      const f = await importNamed(kind);
      if (!f) return;
      if (kind === 'dt1') {
        let info: { tiles: number; kinds: string } | string;
        try {
          const d = parseDt1(f.bytes);
          if (!d.tiles.length) throw new Error('it has no tiles');
          const floors = d.tiles.filter((t) => t.orientation === 0).length;
          const shadows = d.tiles.filter((t) => t.orientation === 13).length;
          info = { tiles: d.tiles.length, kinds: [floors && `${floors} floors`, d.tiles.length - floors - shadows && `${d.tiles.length - floors - shadows} walls/objects`, shadows && `${shadows} shadows`].filter(Boolean).join(', ') };
        } catch (e) {
          info = `This isn't a DT1 DS1 Studio can read (${(e as Error).message}), so the game couldn't either.`;
        }
        setImporting({ kind, name: f.name, bytes: f.bytes, info });
      } else {
        let info: { width: number; height: number; act: number; missing: string[] } | string;
        try {
          const d = parseDs1(f.bytes);
          const missing = d.files
            .map(ds1FileToDt1Path)
            .filter((p): p is string => !!p)
            .filter((p) => !gd.fs.locate(normalizePath(p)))
            .map((p) => p.replace(/^data\/global\/tiles\//i, ''));
          info = { width: d.width, height: d.height, act: d.act, missing };
        } catch (e) {
          info = `This isn't a DS1 DS1 Studio can read (${(e as Error).message}), so the game couldn't either.`;
        }
        setImporting({ kind, name: f.name, bytes: f.bytes, info });
      }
    },
    [gd],
  );

  const importDt1 = useCallback(
    async (c: ImportDt1Choice) => {
      if (!importing || importing.kind !== 'dt1') return;
      setImportBusy(true);
      try {
        await writeFiles([{ path: c.path, bytes: importing.bytes }]);
        try {
          localStorage.setItem('ds1studio.importFolder', c.path.split('/').slice(-2, -1)[0]);
        } catch {
          // per-viewer convenience only
        }
        setImporting(null);
        if (c.addToMap && map) {
          // Same as adding it in Tile libraries: the map's list, a LvlTypes File slot and the Dt1Mask.
          await applyDt1s([...map.lib.loaded.filter((l) => l.found && !isBuiltinPath(l.path)).map((l) => l.path), normalizePath(c.path)]);
          notify(`Imported ${c.path.split('/').pop()} and added it to this map's tile libraries (LvlTypes / Dt1Mask).`);
        } else {
          await reloadTables();
          notify(`Imported ${c.path}. Add it to a map with Map → Tile libraries.`);
        }
      } catch (e) {
        notify(`Import failed: ${(e as Error).message}`, true);
      } finally {
        setImportBusy(false);
      }
    },
    [importing, map, writeFiles, applyDt1s, reloadTables, notify],
  );

  const importDs1 = useCallback(
    async (c: ImportDs1Choice) => {
      if (!importing || importing.kind !== 'ds1' || !gd) return;
      if (!confirmDiscard()) return;
      setImportBusy(true);
      try {
        await writeFiles([{ path: c.path, bytes: importing.bytes }]);
        setImporting(null);
        await reloadTables();
        await open(normalizePath(c.path), true);
        if (c.register) {
          // Start "Add to game" from a level that uses the same tile set (a new level cloned from it).
          const m = await openMap(gd, normalizePath(c.path));
          // The level type whose files cover the map's tile libraries best (a map new to the game has none yet).
          let typeId = m.resolution.lvlType?.id;
          if (typeId === undefined) {
            const want = new Set(m.resolution.paths.map(normalizePath));
            let best = 0;
            for (const t of gd.lvlTypes) {
              const score = GameData.dt1sFor(t, 0xffffffff).filter((p) => want.has(p)).length;
              if (score > best) [best, typeId] = [score, t.id];
            }
          }
          const t = warpTables;
          let levelId: number | undefined;
          if (t && typeId !== undefined) {
            const idCol = t.levels.columns.indexOf('Id');
            const typeCol = t.levels.columns.indexOf('LevelType');
            const row = t.levels.rows.find((r) => Number(r[typeCol]) === typeId && Number(r[idCol]) > 0);
            if (row) levelId = Number(row[idCol]);
          }
          setRegisterInitial({
            mode: 'new',
            levelId,
            name: c.path.split('/').pop()!.replace(/\.ds1$/i, ''),
            note: `Imported. Now add it to the game: a new level${levelId ? ' is pre-filled from one using the same tiles' : ''}; pick another level to copy settings from if you like, then Apply.`,
          });
          setDialog('register');
        } else notify(`Imported ${c.path}. Use Data → Add to game when you want the game to load it.`);
      } catch (e) {
        notify(`Import failed: ${(e as Error).message}`, true);
      } finally {
        setImportBusy(false);
      }
    },
    [importing, gd, confirmDiscard, writeFiles, reloadTables, open, warpTables, notify],
  );

  // Desktop app: a quiet update check at most once a day; a newer version is announced, never installed unasked.
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    let last = 0;
    try {
      last = Number(localStorage.getItem('ds1studio.updateCheck')) || 0;
    } catch {
      // per-viewer convenience only
    }
    if (Date.now() - last < 86_400_000) return;
    const t = setTimeout(() => {
      checkForUpdate()
        .then((u) => {
          try {
            localStorage.setItem('ds1studio.updateCheck', String(Date.now()));
          } catch {
            // ignore
          }
          if (u) {
            setPendingUpdate(u);
            notify(`DS1 Studio ${u.version} is available: Help → Check for updates`);
          }
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearTimeout(t);
  }, [notify]);

  // Presets: saved ones come from the mod folder.
  useEffect(() => {
    if (gd) void loadPresets(gd).then(setPresets);
  }, [gd]);
  const savePreset = useCallback(
    async (p: Preset) => {
      if (!gd) return;
      try {
        const stored = { ...p, id: Math.random().toString(36).slice(2, 10) };
        await writeFiles([{ path: presetPath(stored), bytes: serializePreset(stored) }]);
        setPresets(await loadPresets(gd));
        notify(`Saved preset "${p.name}"`);
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [gd, writeFiles, notify],
  );
  const saveSelectionPreset = useCallback(async () => {
    if (!doc || !map || !selection) return;
    const name = window.prompt('Preset name', `${map.path.split('/').pop()!.replace(/\.ds1$/i, '')} ${rectSize(selection).join('×')}`);
    if (!name) return;
    const category = window.prompt('Category', 'My presets') || 'My presets';
    await savePreset(presetFromSelection(doc, map.lib, selection, name, category));
  }, [doc, map, selection, savePreset]);
  const placePreset = useCallback((p: Preset) => beginPaste(presetToClipboard(p), `Placing "${p.name}"`), [beginPaste]);
  const suggest = useCallback(async () => {
    if (!gd || !map) return;
    setSuggesting({ phase: 'scan', done: 0, total: 1 });
    try {
      setSuggested(await suggestPresets(gd, { path: map.path, lib: map.lib, dt1Paths: map.lib.loaded.filter((l) => l.found).map((l) => l.path) }, setSuggesting));
    } finally {
      setSuggesting(null);
    }
  }, [gd, map]);

  const runCheck = useCallback(async () => {
    if (!gd || !map || !scene) return;
    setCheckResults(null);
    setDialog('check');
    // The automap part needs AutoMap.txt (read here, so the automap view needn't be open).
    let automap: { pieces: AutomapPiece[] } | undefined;
    try {
      const bytes = await gd.fs.read(AUTOMAP_TXT);
      if (bytes) {
        const table = automapData?.table ?? parseAutomap(parseTxtTable(bytes));
        const level = automapLevel ?? automapLevelFor(table, map.resolution.lvlType?.name, map.ds1.act + 1, map.resolution.lvlType?.id);
        if (level) automap = { pieces: automapPieces(map.ds1, table, level) };
      }
    } catch {
      // the automap check is optional
    }
    setCheckResults(await checkMap(gd, map, scene, automap));
  }, [gd, map, scene, automapData, automapLevel]);
  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;
  /** Carries out a compatibility-check fix, then checks again (fixes that edit the map can be undone). */
  const applyFix = useCallback(
    async (fix: Fix) => {
      if (!gd || !map || !doc) return;
      const libs = map.lib.loaded.filter((l) => l.found && !isBuiltinPath(l.path)).map((l) => l.path);
      const recheck = () => {
        setTimeout(() => void runCheckRef.current(), 300);
      };
      try {
        switch (fix.kind) {
          case 'open-table':
            setTableTarget({ table: fix.table.replace(/\.txt$/i, ''), key: fix.key });
            return setDialog('tables');
          case 'register':
            return setDialog('register');
          case 'automap-editor':
            return setDialog('automap');
          case 'place-object':
            setDialog(null);
            setTool('object');
            setPlacing({ type: fix.type, id: fix.id });
            return notify('Click the map to place it · Esc to stop');
          case 'add-dt1s':
            await applyDt1s([...libs, ...fix.paths]);
            return recheck();
          case 'remove-dt1s': {
            const drop = new Set(fix.paths.map(normalizePath));
            await applyDt1s(libs.filter((p) => !drop.has(normalizePath(p))));
            return recheck();
          }
          case 'sync-tables': {
            const writes = await syncLevelTables(gd.fs, map.path, libs, map.resolution.lvlType?.id);
            if (writes.length) {
              await writeFiles(writes);
              await reloadTables();
            }
            notify(writes.length ? `Updated ${writes.flatMap((w) => w.summary).join('; ')}` : 'LvlTypes and Dt1Mask already match');
            return recheck();
          }
          case 'clear-cells': {
            const edits: CellEdit[] = fix.cells.map((c) => {
              const layer: LayerRef = { kind: c.layer, index: c.index };
              return { layer, x: c.x, y: c.y, cell: MapDocument.painted(layer, doc.cell(layer, c.x, c.y), null) };
            });
            if (doc.apply(edits)) bump();
            notify(`Cleared ${edits.length} tiles (Ctrl+Z to undo)`);
            return recheck();
          }
          case 'move-objects': {
            const to = new Map(fix.moves.map((m) => [m.index, m]));
            setObjects(doc.ds1.objects.map((o, i) => (to.has(i) ? { ...o, x: to.get(i)!.x, y: to.get(i)!.y } : o)));
            notify(`Moved ${fix.moves.length} objects (Ctrl+Z to undo)`);
            return recheck();
          }
          case 'delete-objects': {
            const drop = new Set(fix.indices);
            setObjects(doc.ds1.objects.filter((_, i) => !drop.has(i)));
            notify(`Deleted ${drop.size} objects (Ctrl+Z to undo)`);
            return recheck();
          }
          case 'set-act':
            mutate((d) => {
              d.act = fix.act;
              d.actRaw = fix.act;
            });
            notify(`DS1 header set to Act ${fix.act + 1} (Ctrl+Z to undo)`);
            return recheck();
        }
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [gd, map, doc, applyDt1s, writeFiles, reloadTables, setObjects, mutate, notify],
  );

  const exportPackage = useCallback(
    async (notes: string, includeBaseGame: boolean) => {
      if (!gd || !map || !doc) return;
      setExportState({ building: true, result: null });
      try {
        const objectSpecs = [...new Set(doc.ds1.objects.map((o) => `${o.type}:${o.id}`))]
          .map((k) => {
            const [t, id] = k.split(':').map(Number);
            return gd.objectSpec(doc.ds1.act, t, id);
          })
          .filter((x): x is NonNullable<typeof x> => !!x);
        const built = await buildMapPackage(
          gd.fs,
          { path: doc.path, ds1: doc.ds1, dt1Paths: map.lib.loaded.filter((l) => l.found && !isBuiltinPath(l.path)).map((l) => l.path) },
          { ds1Bytes: writeDs1(doc.ds1), objectSpecs, txtRows: await collectMapTxtRows(gd.fs, doc.path), notes, includeBaseGameDt1s: includeBaseGame },
        );
        setExportState({ building: false, result: { files: built.manifest.files, missing: built.missing } });
        const where = await exportBytes(`${doc.path.split('/').pop()!.replace(/\.ds1$/i, '')}.zip`, built.zip);
        if (where) notify(`Exported ${where}`);
      } catch (e) {
        setExportState({ building: false, result: null });
        notify(`Export failed: ${(e as Error).message}`, true);
      }
    },
    [gd, map, doc, notify],
  );

  const startImport = useCallback(async () => {
    if (!gd) return;
    try {
      const bytes = await importBytes('zip');
      if (!bytes) return;
      const pkg = readMapPackage(bytes);
      setImportState({ pkg, plan: await planImport(pkg, gd.fs) });
      setDialog('import');
    } catch (e) {
      notify(`Import failed: ${(e as Error).message}`, true);
    }
  }, [gd, notify]);
  const finishImport = useCallback(async () => {
    if (!importState) return;
    try {
      const files = importState.plan.writes.filter((w) => w.action !== 'identical');
      await writeFiles([...files, ...importState.plan.txtWrites]);
      await reloadTables();
      setDialog(null);
      notify(`Imported ${files.length} files${importState.plan.txtWrites.length ? ` and ${importState.plan.txtWrites.length} tables` : ''}`);
      setImportState(null);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }, [importState, writeFiles, reloadTables, notify]);

  const undo = useCallback(() => {
    if (doc?.undo()) bump();
  }, [doc]);
  const redo = useCallback(() => {
    if (doc?.redo()) bump();
  }, [doc]);

  const save = useCallback(async () => {
    if (!doc || !gd || data.status !== 'ready') return;
    const known = data.files.some((f) => f.toLowerCase() === doc.path.toLowerCase());
    if (!known) setData({ ...data, files: [...data.files, doc.path].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)) });
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
      // Saved: the autosaved copy isn't needed any more.
      void deleteRecovery(doc.path).then(() => listRecoveries().then(setRecoveries));
      bump();
    } catch (e) {
      notify(`Save failed: ${(e as Error).message}`, true);
    }
  }, [doc, gd, data, notify]);

  const exportFile = useCallback(async () => {
    if (!doc) return;
    const where = await exportBytes(doc.path.split('/').pop()!, writeDs1(doc.ds1));
    if (where) notify(`Exported ${where}`);
  }, [doc, notify]);

  // Keyboard shortcuts: every key goes through the (user-rebindable) keymap.
  const toggleObjects = useCallback(() => {
    setTool((t) => {
      if (t === 'object') return lastTileTool.current;
      lastTileTool.current = t;
      return 'object';
    });
  }, []);
  const toggleGameView = useCallback(() => {
    setGameView((g) => {
      if (g.on) return { ...g, on: false };
      const r = selection;
      const center = r ? (cellToWorld((r.x0 + r.x1 + 1) / 2, (r.y0 + r.y1 + 1) / 2) as [number, number]) : null;
      return { on: true, signal: g.signal + 1, center };
    });
  }, [selection]);
  const actions = useMemo((): Partial<Record<ActionId, () => void>> => {
    const vis = (f: (v: Visibility) => Visibility) => () => setVisibility(f);
    const layerToggle = (key: 'floors' | 'walls', i: number) => vis((v) => ({ ...v, [key]: v[key].map((x, n) => (n === i ? !x : x)) }));
    return {
      'tool.select': () => setTool('select'),
      'tool.paint': () => {
        setTool('paint');
        setPaintMode('brush');
      },
      'tool.rect': () => {
        setPaintMode('rect');
        setTool((t) => (t === 'erase' ? t : 'paint'));
      },
      'tool.fill': () => {
        setPaintMode('fill');
        setTool((t) => (t === 'erase' ? t : 'paint'));
      },
      'edit.replace': () => doc && setDialog('replace'),
      'view.minimap': vis((v) => ({ ...v, minimap: !v.minimap })),
      'tool.erase': () => setTool('erase'),
      'tool.pick': () => setTool('pick'),
      'tool.object': () => setTool('object'),
      'tool.toggleObjects': toggleObjects,
      'edit.undo': undo,
      'edit.redo': redo,
      'edit.redo2': redo,
      'file.save': () => void save(),
      'edit.copy': () => copy(false),
      'edit.cut': () => copy(true),
      'edit.paste': startPaste,
      'edit.selectAll': () => {
        if (!doc) return;
        setSelection({ x0: 0, y0: 0, x1: doc.ds1.width - 1, y1: doc.ds1.height - 1 });
        setTool('select');
      },
      'edit.cancel': () => {
        setResizeMode(false);
        setMarks(undefined);
        paintAnchor.current = null;
        setPaintRect(null);
        // First Esc frees the cursor: a paste / preset, an object to place, or the tile being painted with.
        if (pasting || placing || (brush && tool === 'paint')) {
          setPasting(false);
          setPlacing(null);
          if (tool === 'paint') {
            setBrush(null);
            setMix([]);
            setTool('select');
          }
          return;
        }
        if (tool === 'object') setSelectedObject(null);
        else if (stack && stack.index >= 0) setStack({ ...stack, index: -1 });
        else {
          setSelection(null);
          setStack(null);
        }
      },
      'edit.delete': () => {
        if (tool !== 'object' || !deleteSelectedObject()) clearSelection(false);
      },
      'edit.deleteAll': () => clearSelection(true),
      'view.fit': () => setFitSignal((n) => n + 1),
      'view.game': toggleGameView,
      'view.grid': vis((v) => ({ ...v, grid: !v.grid })),
      'view.rooms': vis((v) => ({ ...v, rooms: !v.rooms })),
      'view.walkable': vis((v) => ({ ...v, walkable: !v.walkable })),
      'view.automap': vis((v) => ({ ...v, automap: !v.automap })),
      'view.markers': vis((v) => ({ ...v, objects: !v.objects })),
      'view.sprites': vis((v) => ({ ...v, sprites: !v.sprites })),
      'view.paths': vis((v) => ({ ...v, paths: !v.paths })),
      'layer.floor1': layerToggle('floors', 0),
      'layer.floor2': layerToggle('floors', 1),
      'layer.wall1': layerToggle('walls', 0),
      'layer.wall2': layerToggle('walls', 1),
      'layer.wall3': layerToggle('walls', 2),
      'layer.wall4': layerToggle('walls', 3),
      'layer.shadows': vis((v) => ({ ...v, shadows: !v.shadows })),
      'layer.roofs': vis((v) => ({ ...v, roofs: !v.roofs })),
      'layer.lowerWalls': vis((v) => ({ ...v, lowerWalls: !v.lowerWalls })),
      'layer.specials': vis((v) => ({ ...v, specials: !v.specials })),
    };
  }, [toggleObjects, undo, redo, save, copy, startPaste, doc, tool, deleteSelectedObject, clearSelection, stack, toggleGameView, pasting, placing, brush]);
  const keyState = useRef({ actions, actionFor: keys.actionFor, dialogOpen: false });
  keyState.current = { actions, actionFor: keys.actionFor, dialogOpen: dialog !== null };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (keyState.current.dialogOpen) return;
      const combo = comboOf(e);
      if (!combo) return;
      const id = keyState.current.actionFor(combo);
      const run = id && keyState.current.actions[id];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // saveAs() saves on the next tick through this ref.
  const handlers = useRef({ save });
  handlers.current = { save };

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (doc?.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [doc]);

  if (isTauri && (data.status === 'setup' || data.status === 'loading' || changingFolders)) {
    return (
      <DesktopSetup
        initial={desktopCfg}
        error={data.status === 'setup' ? data.error : undefined}
        busy={data.status === 'loading' ? data.message : undefined}
        onOpen={openDesktop}
        onCancel={changingFolders ? () => setChangingFolders(false) : undefined}
      />
    );
  }
  if (data.status !== 'ready') {
    return <SetupScreen state={data} onPick={pickFolders} />;
  }

  const layers = doc?.layers() ?? [];
  const title = map?.path.split('/').pop();
  const noMap = !doc || !map;
  const canWrite = !!data.saveTarget;
  const openTable = (table: string, key?: string) => {
    setTableTarget({ table, key });
    setDialog('tables');
  };
  const kb = keys.bindings;
  const TOOL_ICONS = { select: <MousePointer2 />, paint: <Paintbrush />, erase: <Eraser />, pick: <Pipette />, object: <Box /> };
  const ribbonTabs: RibbonTab[] = [
    {
      id: 'home',
      label: 'Home',
      groups: [
        {
          label: 'File',
          items: [
            { label: 'Save', icon: <Save />, onClick: () => void save(), disabled: noMap, active: !!doc?.dirty, shortcut: kb['file.save'], title: data.saveTarget ? `Save into ${data.saveTarget.label}` : 'Save (downloads: no mod folder)' },
            { label: 'Save as…', icon: <FilePlus2 />, onClick: () => setDialog('saveAs'), disabled: noMap, size: 'sm' },
            { label: 'Export .ds1', icon: <FileOutput />, onClick: () => void exportFile(), disabled: noMap, size: 'sm' },
            { label: 'Export image', icon: <ImageDown />, onClick: () => setDialog('image'), disabled: noMap, size: 'sm', title: 'Save the map (or the selection) as a PNG picture' },
            { label: 'Import DS1…', icon: <FileInput />, onClick: () => void pickImport('ds1'), disabled: !canWrite, size: 'sm', title: canWrite ? 'Bring a map (.ds1) into your mod as expansion/Map/<name>.ds1, then add it to the game' : 'No writable mod folder' },
            { label: 'Import DT1…', icon: <Grid2x2Plus />, onClick: () => void pickImport('dt1'), disabled: !canWrite, size: 'sm', title: canWrite ? 'Bring a tile library (.dt1) into your mod under PD2assets/<folder>, and add it to the open map' : 'No writable mod folder' },
            {
              label: 'Recent',
              icon: <Clock />,
              onClick: () => undefined,
              size: 'sm',
              title: 'Recently opened maps',
              emptyMenu: 'No maps opened yet.',
              menu: [
                ...recentMapList.map((m) => ({ label: m.path.split('/').pop()!, hint: folderOf(m.path), title: m.path, onClick: () => void open(m.path) })),
                {
                  label: `${reopenLastMap ? '☑' : '☐'} Reopen the last map on start`,
                  onClick: () => {
                    setReopenLast(!reopenLastMap);
                    setReopenLastMap(!reopenLastMap);
                  },
                },
              ],
            },
            ...(isTauri ? [{ label: 'Folders…', icon: <FolderCog />, onClick: () => confirmDiscard() && setChangingFolders(true), size: 'sm' as const }] : []),
          ],
        },
        {
          label: 'Edit',
          items: [
            { label: 'Paste', icon: <ClipboardPaste />, onClick: startPaste, disabled: noMap || !clipboard, shortcut: kb['edit.paste'] },
            { label: 'Cut', icon: <Scissors />, onClick: () => copy(true), disabled: !selection, size: 'sm', shortcut: kb['edit.cut'] },
            { label: 'Copy', icon: <Copy />, onClick: () => copy(false), disabled: !selection, size: 'sm', shortcut: kb['edit.copy'] },
            { label: 'Delete', icon: <Trash2 />, onClick: () => clearSelection(false), disabled: !selection, size: 'sm', shortcut: kb['edit.delete'] },
            { label: 'Undo', icon: <Undo2 />, onClick: undo, disabled: !doc?.canUndo, size: 'sm', shortcut: kb['edit.undo'] },
            { label: 'Redo', icon: <Redo2 />, onClick: redo, disabled: !doc?.canRedo, size: 'sm', shortcut: kb['edit.redo'] },
            { label: 'Replace…', icon: <Replace />, onClick: () => setDialog('replace'), disabled: noMap, size: 'sm', shortcut: kb['edit.replace'], title: 'Find & replace a tile across the map or the selection' },
          ],
        },
        {
          label: 'Tools',
          items: TOOLS.map((t) => ({ label: t.label, icon: TOOL_ICONS[t.id], onClick: () => setTool(t.id), active: tool === t.id, disabled: noMap, title: t.hint, shortcut: kb[`tool.${t.id}` as ActionId] })),
        },
        {
          label: 'Paint / erase',
          items: [
            { label: 'Freehand', icon: <Paintbrush />, onClick: () => setPaintMode('brush'), active: paintMode === 'brush', disabled: noMap, size: 'sm', title: 'Paint and Erase follow the mouse' },
            { label: 'Rectangle', icon: <SquareDashed />, onClick: () => { setPaintMode('rect'); setTool((t) => (t === 'erase' ? t : 'paint')); }, active: paintMode === 'rect', disabled: noMap, size: 'sm', shortcut: kb['tool.rect'], title: 'Drag a rectangle to paint (or erase) it all at once' },
            { label: 'Fill area', icon: <PaintBucket />, onClick: () => { setPaintMode('fill'); setTool((t) => (t === 'erase' ? t : 'paint')); }, active: paintMode === 'fill', disabled: noMap, size: 'sm', shortcut: kb['tool.fill'], title: 'Click to fill the connected area of the same tile (kept inside the selection when you click in it)' },
          ],
        },
        {
          label: 'Layer',
          items: [
            {
              custom: (
                <>
                  <span className="muted small">Active layer</span>
                  <select value={layerKey(activeLayer)} disabled={noMap} onChange={(e) => setActiveLayer(layers.find((l) => layerKey(l) === e.target.value)!)}>
                    {layers.map((l) => (
                      <option key={layerKey(l)} value={layerKey(l)}>
                        {layerLabel(l)}
                      </option>
                    ))}
                  </select>
                </>
              ),
            },
          ],
        },
        {
          label: 'View',
          items: [
            { label: 'Fit', icon: <Maximize />, onClick: () => setFitSignal((n) => n + 1), disabled: noMap, shortcut: kb['view.fit'] },
            { label: 'Game view', icon: <ScanEye />, onClick: toggleGameView, active: gameView.on, disabled: noMap, shortcut: kb['view.game'], title: `Zoom to what the character sees in game (${gameSize[0]}×${gameSize[1]}, centred on the selection)` },
            {
              custom: (
                <GameSizePicker size={gameSize} onChange={setGameSize} />
              ),
            },
            { label: 'Grid', icon: <Grid3x3 />, onClick: () => setVisibility((v) => ({ ...v, grid: !v.grid })), active: visibility.grid, size: 'sm', shortcut: kb['view.grid'] },
            { label: 'Rooms 8×8', icon: <LayoutGrid />, onClick: () => setVisibility((v) => ({ ...v, rooms: !v.rooms })), active: visibility.rooms, size: 'sm', shortcut: kb['view.rooms'], title: 'Show the 8×8-tile rooms the game builds the level from' },
            { label: 'Walkability', icon: <Footprints />, onClick: () => setVisibility((v) => ({ ...v, walkable: !v.walkable })), active: visibility.walkable, size: 'sm', shortcut: kb['view.walkable'] },
            { label: 'Automap', icon: <MapIcon />, onClick: () => setVisibility((v) => ({ ...v, automap: !v.automap })), active: visibility.automap, size: 'sm', shortcut: kb['view.automap'], title: 'Preview the in-game automap and see/change the AutoMap.txt piece of each tile' },
            { label: 'Sprites', icon: <Box />, onClick: () => setVisibility((v) => ({ ...v, sprites: !v.sprites })), active: visibility.sprites, size: 'sm', shortcut: kb['view.sprites'] },
            { label: 'Minimap', icon: <MapPinned />, onClick: () => setVisibility((v) => ({ ...v, minimap: !v.minimap })), active: visibility.minimap, size: 'sm', shortcut: kb['view.minimap'], title: 'Overview of the whole map in the corner: click it to move there' },
          ],
        },
        { label: 'Check', items: [{ label: 'Compatibility', icon: <ShieldCheck />, onClick: () => void runCheck(), disabled: noMap, title: 'Check that this map will load and play in game' }] },
        { label: 'Settings', items: [{ label: 'Shortcuts', icon: <Keyboard />, onClick: () => setDialog('shortcuts'), title: 'View and change keyboard shortcuts' }] },
      ],
    },
    {
      id: 'map',
      label: 'Map',
      groups: [
        {
          label: 'Map',
          items: [
            { label: 'New map', icon: <FilePlus2 />, onClick: () => setDialog('new') },
            { label: 'Resize', icon: <Expand />, onClick: () => setResizeMode((m) => !m), active: resizeMode, disabled: noMap, title: 'Drag the handles on the map edges to add or remove cells' },
            { label: 'Resize…', icon: <Expand />, onClick: () => setDialog('resize'), disabled: noMap, size: 'sm', title: 'Resize by numbers' },
          ],
        },
        {
          label: 'Palette',
          items: [
            {
              custom: (
                <>
                  <span className="muted small">Colours</span>
                  <select value={map?.paletteAct ?? 0} disabled={noMap} onChange={(e) => map && void withPalette(data.gd, map, Number(e.target.value)).then(setMap)}>
                    {PALETTE_NAMES.map((n, i) => (
                      <option key={i} value={i}>
                        {n}
                      </option>
                    ))}
                  </select>
                </>
              ),
            },
          ],
        },
        {
          label: 'Tiles',
          items: [
            { label: 'Tile libraries', icon: <Library />, onClick: () => setDialog('dt1s'), disabled: noMap, title: 'Add or remove DT1 files for this map' },
            { label: 'DT1 editor', icon: <PaletteIcon />, onClick: () => setDialog('dt1edit'), disabled: noMap, title: 'Duplicate, rename and recolour a DT1 (whole file, chosen tiles, or the tiles of a preset)' },
            { label: 'Automap editor', icon: <MapIcon />, onClick: openAutomapEditor, disabled: noMap, title: 'See and change what the in-game automap draws for every tile of this map' },
          ],
        },
        {
          label: 'Presets',
          items: [
            { label: 'Presets', icon: <Stamp />, onClick: () => setSidePanel((p) => (p === 'presets' ? 'tiles' : 'presets')), active: sidePanel === 'presets', disabled: noMap },
            { label: 'Save selection', icon: <Save />, onClick: () => void saveSelectionPreset(), disabled: !selection || !canWrite, size: 'sm' },
            { label: 'Suggest', icon: <Sparkles />, onClick: () => { setSidePanel('presets'); void suggest(); }, disabled: noMap || !!suggesting, size: 'sm' },
          ],
        },
        {
          label: 'Share',
          items: [
            { label: 'Export package', icon: <PackagePlus />, onClick: () => { setExportState({ building: false, result: null }); setDialog('export'); }, disabled: noMap, title: 'Zip the map with everything it needs' },
            { label: 'Import package', icon: <PackageOpen />, onClick: () => void startImport(), disabled: !canWrite, title: canWrite ? 'Import a map package into your mod' : 'No writable mod folder' },
          ],
        },
      ],
    },
    {
      id: 'data',
      label: 'Data',
      groups: [
        {
          label: 'Tables',
          items: [
            { label: 'Data tables', icon: <Table2 />, onClick: () => openTable('LvlPrest'), title: 'Edit the game\u2019s .txt tables' },
            { label: 'LvlPrest', icon: <Table2 />, onClick: () => openTable('LvlPrest', map?.resolution.preset?.name), size: 'sm' },
            { label: 'LvlTypes', icon: <Table2 />, onClick: () => openTable('LvlTypes', map?.resolution.lvlType?.name), size: 'sm' },
            { label: 'Levels', icon: <Table2 />, onClick: () => openTable('Levels'), size: 'sm' },
            { label: 'Objects', icon: <Table2 />, onClick: () => openTable('Objects'), size: 'sm' },
            { label: 'MonPreset', icon: <Table2 />, onClick: () => openTable('MonPreset'), size: 'sm' },
            { label: 'CubeMain', icon: <Table2 />, onClick: () => openTable('CubeMain'), size: 'sm' },
          ],
        },
        {
          label: 'Game',
          items: [
            { label: 'Add to game', icon: <Layers />, onClick: () => setDialog('register'), disabled: noMap || !canWrite, title: 'Create the LvlPrest/Levels/LvlTypes rows that make the game load this map' },
            { label: 'Cube recipe', icon: <FlaskConical />, onClick: () => setDialog('cube'), disabled: noMap || !canWrite, title: 'Create a map item and a cube recipe for it' },
          ],
        },
        { label: 'Check', items: [{ label: 'Compatibility', icon: <ShieldCheck />, onClick: () => void runCheck(), disabled: noMap }] },
        { label: 'Share', items: [{ label: 'Export .ds1', icon: <Download />, onClick: () => void exportFile(), disabled: noMap }] },
      ],
    },
    {
      id: 'help',
      label: 'Help',
      groups: [
        {
          label: 'Updates',
          items: [
            { label: 'Check for updates', icon: <RefreshCw />, onClick: () => setDialog('update'), title: 'Look for a newer version on GitHub and install it' },
            { label: 'About', icon: <Info />, onClick: () => setDialog('about'), title: 'Version and build information' },
          ],
        },
        {
          label: 'Support',
          items: [
            { label: 'Suggest a feature', icon: <Lightbulb />, onClick: () => void openExternal(featureRequestUrl({ map: map?.path })), title: 'Open a pre-filled feature request on GitHub' },
            { label: 'Report a bug', icon: <Bug />, onClick: () => void openExternal(bugReportUrl({ map: map?.path })), title: 'Open a pre-filled bug report on GitHub' },
            { label: 'User guide', icon: <BookOpen />, onClick: () => void openExternal(`${REPO_URL}#readme`), title: 'Features, shortcuts and how-tos' },
            { label: 'Shortcuts', icon: <Keyboard />, onClick: () => setDialog('shortcuts'), title: 'View and change keyboard shortcuts' },
          ],
        },
      ],
    },
  ];

  return (
    <div className="app" style={{ gridTemplateColumns: `${leftW}px 1fr ${rightW}px` }}>
      <Ribbon
        tabs={ribbonTabs}
        brand={
          <>
            <span className="brand-mark">◆</span> DS1 Studio
          </>
        }
        right={
          <>
            <button className="topbar-idea" onClick={() => void openExternal(featureRequestUrl({ map: map?.path }))} title="Suggest a feature: opens a pre-filled idea on GitHub">
              <Lightbulb size={14} /> Suggest a feature
            </button>
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
          </>
        }
      />

      <Splitter axis="x" direction={1} size={leftW} onResize={setLeftW} className="edge-right" title="Drag to widen or narrow the presets list" />
      <aside className="sidebar left">
        <FileBrowser files={data.files} current={map?.path ?? null} loading={loadingPath} onOpen={open} />
      </aside>

      <main className="stage">
        <ErrorBoundary
          what="the map view"
          resetKey={map}
          context={() => ({ map: map?.path })}
          action={map ? { label: 'Close this map', onClick: () => { if (confirmDiscard()) { setMap(null); setDoc(null); } } } : undefined}
        >
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
            objectLabel={objectLabel}
            selectedObject={selectedObject}
            sprites={sprites}
            animations={animations}
            marks={marks}
            resizeMode={resizeMode}
            onResize={(d) => {
              resize(d);
              notify(`Resized to ${doc!.ds1.width}×${doc!.ds1.height}`);
            }}
            onHover={setHover}
            onZoom={setZoom}
            onStroke={onStroke}
            fitSignal={fitSignal}
            gameView={{ ...gameView, width: gameSize[0], height: gameSize[1] }}
            focus={focus}
            onCycle={cycleStack}
            automap={automapView}
            centerOn={centerOn}
            specialLabel={specialLabel}
          />
        ) : (
          <div className="empty-stage">
            <div className="empty-title">Open a map</div>
            <div className="muted">
              Pick a DS1 from the list. {data.files.length.toLocaleString()} presets found across {data.gd.fs.baseSources.length} sources.
            </div>
            {recoveries.length > 0 && (
              <div className="recent-maps">
                <div className="field-label warn-text">Unsaved work kept from an earlier session</div>
                {recoveries.map((r) => (
                  <button key={r.path} className="mo-row" onClick={() => void open(r.path)} title="Open it: you'll be offered the autosaved changes">
                    <Clock size={13} />
                    <span className="mo-name">{r.path.split('/').pop()}</span>
                    <span className="muted small">{new Date(r.time).toLocaleString()}</span>
                  </button>
                ))}
              </div>
            )}
            {recentMapList.length > 0 && (
              <div className="recent-maps">
                <div className="field-label">Recent maps</div>
                {recentMapList.map((m) => (
                  <button key={m.path} className="mo-row" onClick={() => void open(m.path)} title={m.path}>
                    <span className="mo-name">{m.path.split('/').pop()}</span>
                    <span className="muted small">{folderOf(m.path)}</span>
                  </button>
                ))}
                <label className="small muted">
                  <input
                    type="checkbox"
                    checked={reopenLastMap}
                    onChange={(e) => {
                      setReopenLast(e.target.checked);
                      setReopenLastMap(e.target.checked);
                    }}
                  />{' '}
                  Reopen the last map on start
                </label>
              </div>
            )}
          </div>
        )}
        {toast && (
          <div className={`toast${toast.error ? ' error' : ''}`} onClick={() => setToast(null)}>
            {toast.text}
          </div>
        )}
        </ErrorBoundary>
        {loadingPath && <div className="toast">Loading {loadingPath.split('/').pop()}…</div>}
      </main>

      <Splitter axis="x" direction={-1} size={rightW} onResize={setRightW} className="edge-left" title="Drag to widen or narrow the side panel" />
      <aside className="sidebar right">
        <ErrorBoundary what="the side panel" resetKey={`${map?.path}:${tool}`} context={() => ({ map: map?.path })} compact>
        {map && scene && doc && (
          <>
            {tool === 'object' && (
              <section className="panel object-preview-panel">
                <div className="panel-header static">
                  <span>Preview</span>
                </div>
                <div className="panel-body">
                  <ObjectPreview
                    fs={data.gd.fs}
                    palette={map.palette}
                    spec={selectedObject !== null && map.ds1.objects[selectedObject] ? data.gd.objectSpec(map.ds1.act, map.ds1.objects[selectedObject].type, map.ds1.objects[selectedObject].id) : null}
                    name={selectedObject !== null && map.ds1.objects[selectedObject] ? nameOf(map.ds1.objects[selectedObject].type, map.ds1.objects[selectedObject].id) : ''}
                  />
                </div>
              </section>
            )}
            {tool === 'object' && (
              <MapObjectsPanel
                objects={map.ds1.objects}
                nameOf={nameOf}
                onJump={(i) => {
                  const o = map.ds1.objects[i];
                  if (!o) return;
                  setSelectedObject(i);
                  const [x, y] = subTileToWorld(o.x, o.y);
                  setCenterOn((c) => ({ x, y, signal: (c?.signal ?? 0) + 1 }));
                }}
              />
            )}
            {tool === 'object' && (
              <ObjectPanel
                objects={map.ds1.objects}
                selected={selectedObject}
                nameOf={nameOf}
                hasNames={data.gd.hasObjectNames}
                placing={placing}
                onSelect={setSelectedObject}
                onChange={setObjects}
                onStartPlacing={setPlacing}
              />
            )}
            {tool === 'object' && (
              <section className="panel">
                <div className="panel-header static">
                  <span>Objects &amp; NPCs</span>
                  <span className="muted small">{placing ? 'click the map to place · Esc to stop' : 'click one to place it'}</span>
                </div>
                <div className="panel-body">
                  <ObjectGallery
                    gd={data.gd}
                    act={map.ds1.act}
                    palette={map.palette}
                    placing={placing}
                    onPlace={(o) => setPlacing(placing && placing.type === o.type && placing.id === o.id ? null : o)}
                  />
                </div>
              </section>
            )}
            {tool !== 'object' && (
              <div className="side-tabs">
                <button className={sidePanel === 'tiles' ? 'active' : ''} onClick={() => setSidePanel('tiles')}>
                  Tiles
                </button>
                <button className={sidePanel === 'presets' ? 'active' : ''} onClick={() => setSidePanel('presets')}>
                  Presets
                </button>
              </div>
            )}
            {tool !== 'object' && sidePanel === 'presets' && (
              <PresetsPanel
                saved={presets}
                suggested={suggested}
                suggesting={suggesting}
                lib={map.lib}
                palette={map.palette}
                dt1Paths={map.lib.loaded.filter((l) => l.found).map((l) => l.path)}
                hasSelection={!!selection}
                canSave={canWrite}
                onPlace={placePreset}
                onSaveSelection={() => void saveSelectionPreset()}
                onSavePreset={(p) => void savePreset(p)}
                onSuggest={() => void suggest()}
                onAddDt1s={(paths) => void applyDt1s([...map.lib.loaded.filter((l) => l.found && !isBuiltinPath(l.path)).map((l) => l.path), ...paths])}
              />
            )}
            <section className="panel" hidden={tool === 'object' || sidePanel !== 'tiles'}>
              <div className="panel-header static">
                <span>Tiles · {layerLabel(activeLayer)}</span>
                {brush && (
                  <span className="muted small" title={mix.length ? 'Each painted cell gets one of these at random (Ctrl+click tiles to add or remove)' : 'Ctrl+click more tiles to paint a random mix'}>
                    brush {brush.main}/{brush.sub}
                    {mix.length ? ` + ${mix.length} mixed` : ''}
                    {mix.length > 0 && (
                      <button className="link mix-clear" onClick={() => setMix([])}>
                        clear mix
                      </button>
                    )}
                  </span>
                )}
              </div>
              <TilePalette
                lib={map.lib}
                palette={map.palette}
                layerKind={activeLayer.kind}
                brush={brush}
                mix={mix}
                focus={paletteFocus}
                onPick={pickBrush}
                recent={recentTileList}
                favourites={pinned}
                onToggleFavourite={(b) => tileSet && setPinned(togglePinned(tileSet, b))}
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
                onlyLayer={onlyLayer}
                onReroll={rerollSelection}
                onReplace={() => setDialog('replace')}
                objectCount={doc.ds1.objects.filter((o) => objectInRect(o, selection)).length}
                onDeselect={() => {
                  setSelection(null);
                  setStack(null);
                }}
              />
            )}
            {visibility.automap && automapData && (
              <AutomapPanel
                onOpenEditor={openAutomapEditor}
                table={automapData.table}
                cels={automapData.cels}
                palette={map.palette}
                level={automapLevel}
                onLevel={(level) => setAutomapLevelOverride({ path: map.path, level })}
                pieces={automapPiecesNow ?? []}
                cell={selection && isSingleCell(selection) ? { x: selection.x0, y: selection.y0 } : null}
                canSave={canWrite}
                onSet={(p, cel, scope) => void setAutomapPiece(p, cel, scope)}
                suggestions={automapSuggestions}
                onSuggest={(floors) => {
                  if (!automapLevel) return;
                  notify('Analysing tiles for automap suggestions…');
                  void makeAutomapColors().then((colors) => setAutomapSuggestions(suggestAutomap(automapData.table, automapLevel, automapPiecesNow ?? [], { floors, colors })));
                }}
                onSuggestionCel={(code, cel) => setAutomapSuggestions((list) => list && list.map((sg) => (sg.code === code ? { ...sg, cel } : sg)))}
                onSkipCode={(code) => setAutomapSuggestions((list) => list && list.filter((sg) => sg.code !== code))}
                onApplySuggestions={() => void applyAutomapSuggestionsNow()}
                onCancelSuggestions={() => setAutomapSuggestions(null)}
                levelLabel={(l) => {
                  const t = /^\d+$/.test(l.trim()) ? data.gd.lvlType(Number(l)) : null;
                  return t && t.name !== l.trim() ? `${l} · ${t.name}` : l;
                }}
              />
            )}
            <CellPanel
              map={map}
              doc={doc}
              cell={selection && isSingleCell(selection) ? { cellX: selection.x0, cellY: selection.y0 } : hover}
              editable={!!selection && isSingleCell(selection)}
              revision={revision}
              onEdit={applyEdits}
              onMutate={mutate}
              scene={scene}
              onFocusTile={focusTile}
              onlyLayer={onlyLayer}
              brush={brush}
              tileFlags={{
                pending: flagEditCount,
                edited: (t) => flagEdits.current.has(t),
                onEdit: editTileFlags,
                onSave: () => void saveTileFlags(),
                onDiscard: discardTileFlags,
                canSave: canWrite,
                saving: savingFlags,
                walkabilityShown: visibility.walkable,
                onShowWalkability: () => setVisibility((v) => ({ ...v, walkable: true })),
              }}
              warps={{ links, onOpen: (p) => void open(p), onEdit: (vis) => setWarpEdit(vis) }}
            />
            <HistoryPanel
              doc={doc}
              revision={revision}
              onGoTo={(n) => {
                doc.goTo(n);
                bump();
              }}
            />
            <GroupsPanel ds1={map.ds1} selection={selection} onMutate={mutate} onShowGroups={() => setVisibility((v) => ({ ...v, groups: true }))} />
            <LayersPanel map={map} scene={scene} visibility={visibility} onChange={setVisibility} keys={kb} />
            <MapInfoPanel map={map} gd={data.gd} onReopen={reresolve} onPalette={(act) => void withPalette(data.gd, map, act).then(setMap)} />
          </>
        )}
        </ErrorBoundary>
      </aside>

      {dialog === 'new' && <NewMapDialog gd={data.gd} onCreate={createMap} onClose={() => setDialog(null)} />}
      {dialog === 'saveAs' && doc && <SaveAsDialog path={doc.path} onSave={saveAs} onClose={() => setDialog(null)} />}
      {dialog === 'resize' && doc && <ResizeDialog width={doc.ds1.width} height={doc.ds1.height} onResize={resize} onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog bindings={keys.bindings} onBind={keys.bind} onReset={keys.reset} onClose={() => setDialog(null)} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {warpEdit !== null && warpTables && mapLevelId > 0 && (
        <WarpLinkDialog tables={warpTables} levelId={mapLevelId} vis={warpEdit} busy={warpBusy} onApply={(w) => void applyWarpLink(w)} onClose={() => setWarpEdit(null)} />
      )}
      {importing?.kind === 'dt1' && (
        <ImportDt1Dialog
          file={importing}
          info={importing.info}
          exists={(p) => !!data.gd.fs.locate(normalizePath(p))}
          mapOpen={map?.path ?? null}
          busy={importBusy}
          onImport={(c) => void importDt1(c)}
          onClose={() => setImporting(null)}
        />
      )}
      {importing?.kind === 'ds1' && (
        <ImportDs1Dialog file={importing} info={importing.info} exists={(p) => !!data.gd.fs.locate(normalizePath(p))} busy={importBusy} onImport={(c) => void importDs1(c)} onClose={() => setImporting(null)} />
      )}
      {dialog === 'replace' && doc && map && (
        <ReplaceDialog
          doc={doc}
          lib={map.lib}
          palette={map.palette}
          activeLayer={activeLayer}
          selection={selection && !isSingleCell(selection) ? selection : null}
          from={replaceFrom}
          brush={brush ? { ...brush, orientation: brushOrientation(activeLayer, brush) } : null}
          onApply={(edits, label) => {
            if (doc.apply(edits, label)) {
              bump();
              notify(`${label}: ${edits.length} cell${edits.length === 1 ? '' : 's'} changed (Ctrl+Z to undo)`);
            }
          }}
          onShow={(cells) => {
            setMarks(cells);
            notify(`${cells.length} cells marked · Esc to clear`);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'image' && doc && (
        <ExportImageDialog width={doc.ds1.width} height={doc.ds1.height} selection={selection && !isSingleCell(selection) ? selection : null} busy={exportingImage} onExport={(o) => void exportImage(o)} onClose={() => setDialog(null)} />
      )}
      {recoveryOffer && map && recoveryOffer.path.toLowerCase() === map.path.toLowerCase() && (
        <Modal title="Unsaved changes were kept" onClose={() => setRecoveryOffer(null)}>
          <p>
            <b>{map.path.split('/').pop()}</b> had changes that weren&apos;t saved, autosaved {new Date(recoveryOffer.time).toLocaleString()}. Restore them?
          </p>
          <p className="muted small">Restoring opens the autosaved version; nothing is written to your mod until you save. Discarding deletes the autosaved copy.</p>
          <div className="modal-actions">
            <button
              className="btn"
              onClick={() => {
                void deleteRecovery(recoveryOffer.path).then(() => listRecoveries().then(setRecoveries));
                setRecoveryOffer(null);
              }}
            >
              Discard them
            </button>
            <button className="btn primary" onClick={() => void restoreRecovery()}>
              Restore
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'update' && <UpdateDialog initial={pendingUpdate} onClose={() => setDialog(null)} />}
      {pasteOffer && map && (
        <Modal title="These tiles need other tile libraries" onClose={() => setPasteOffer(null)}>
          {pasteOffer.tiles > 0 && (
            <p className="small">
              {pasteOffer.tiles} of the tiles you&apos;re pasting aren&apos;t in this map&apos;s tile libraries, so they would show as missing here and in game.
            </p>
          )}
          {pasteOffer.different > 0 && (
            <p className="small">
              {pasteOffer.different} tile{pasteOffer.different === 1 ? '' : 's'} use numbers this map already has from a different DT1, so they would look like this
              map&apos;s tiles instead. Adding the DT1s makes both versions available (the game then picks between them at random for those numbers).
            </p>
          )}
          {pasteOffer.dt1s.length ? (
            <>
              <p className="small">They come from:</p>
              <ul className="small mono">
                {pasteOffer.dt1s.map((p) => (
                  <li key={p}>{p.replace(/^data\/global\/tiles\//i, '')}</li>
                ))}
              </ul>
              <p className="muted small">Adding them loads them for this map (and updates LvlTypes.txt / Dt1Mask when the map is in LvlPrest.txt).</p>
            </>
          ) : (
            <p className="muted small">The DT1s they came from aren&apos;t known (copied before this version, or built-in special tiles).</p>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={() => setPasteOffer(null)}>
              Cancel
            </button>
            <button
              className="btn"
              onClick={() => {
                const o = pasteOffer;
                setPasteOffer(null);
                beginPaste(o.clip, o.label, true);
              }}
            >
              Paste anyway
            </button>
            {pasteOffer.dt1s.length > 0 && (
              <button
                className="btn primary"
                onClick={async () => {
                  const o = pasteOffer;
                  setPasteOffer(null);
                  await applyDt1s([...map.lib.loaded.filter((l) => l.found && !isBuiltinPath(l.path)).map((l) => l.path), ...o.dt1s]);
                  beginPaste(o.clip, o.label, true);
                }}
              >
                Add {pasteOffer.dt1s.length} DT1{pasteOffer.dt1s.length === 1 ? '' : 's'} and paste
              </button>
            )}
          </div>
        </Modal>
      )}
           {dialog === 'automap' && map && (automapData && automapLevel ? (
        <AutomapEditor
          map={map}
          table={automapData.table}
          cels={automapData.cels}
          palette={map.palette}
          level={automapLevel}
          onLevel={(level) => setAutomapLevelOverride({ path: map.path, level })}
          levelLabel={automapLevelLabel}
          canSave={canWrite}
          onSave={saveAutomapEdits}
          makeColors={makeAutomapColors}
          onClose={() => setDialog(null)}
        />
      ) : (
        <Modal title="Automap editor" onClose={() => setDialog(null)}>
          <p className="small">{automapData ? 'Pick the AutoMap.txt level for this map in the Automap panel first.' : 'Loading AutoMap.txt and MaxiMap.dc6…'}</p>
        </Modal>
      ))}
 {dialog === 'dt1edit' && map && (
        <Dt1Editor
          map={map}
          gd={data.gd}
          presets={[...presets, ...(suggested ?? [])]}
          selection={selection}
          canSave={canWrite}
          onSave={saveEditedDt1}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'dt1s' && map && <Dt1Manager map={map} gd={data.gd} usage={dt1Usage} onApply={(p) => void applyDt1s(p)} onClose={() => setDialog(null)} />}
      {dialog === 'tables' && (
        <DataTables
          fs={data.gd.fs}
          initial={tableTarget}
          canSave={canWrite}
          onSave={async (path, bytes) => {
            await writeFiles([{ path, bytes }]);
            await reloadTables();
            return `Saved ${path.split('/').pop()} into ${data.saveTarget?.label}`;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'register' && doc && (
        <RegisterMapDialog
          fs={data.gd.fs}
          mapPath={doc.path}
          width={doc.ds1.width}
          height={doc.ds1.height}
          usedDt1s={[...dt1Usage.keys()].filter((p) => !isBuiltinPath(p))}
          onApply={applyTableWrites}
          onClose={() => {
            setDialog(null);
            setRegisterInitial(undefined);
          }}
          initial={registerInitial}
        />
      )}
      {dialog === 'cube' && doc && <CubeRecipeDialog fs={data.gd.fs} mapName={doc.path.split('/').pop()!.replace(/\.ds1$/i, '')} onApply={applyTableWrites} onClose={() => setDialog(null)} />}
      {dialog === 'check' && (
        <CompatDialog
          results={checkResults}
          onRerun={() => void runCheck()}
          onShowCells={(cells) => {
            setMarks(cells);
            setDialog(null);
            notify(`${cells.length} cells marked · Esc to clear`);
          }}
          onFix={applyFix}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'export' && doc && (
        <ExportPackageDialog mapPath={doc.path} building={exportState.building} result={exportState.result} onBuild={(n, b) => void exportPackage(n, b)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'import' && importState && (
        <ImportPackageDialog pkg={importState.pkg} plan={importState.plan} canWrite={canWrite} onImport={finishImport} onClose={() => setDialog(null)} />
      )}

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
              {map.paletteAct !== map.ds1.act ? ` · ${PALETTE_NAMES[map.paletteAct]} palette` : ''}
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
