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
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isEmptyCell, writeDs1, WRITE_VERSION, type Ds1, type Ds1Object, type WallCell } from '../formats/ds1';
import { embeddedFileName, newDs1, resizeDs1, type ResizeDelta } from '../formats/ds1ops';
import { Orientation, type Dt1Tile } from '../formats/dt1';
import { PALETTE_NAMES } from '../formats/palette';
import { GameData } from '../game/GameData';
import { clampRect, clearEdits, copyRect, fillEdits, pasteEdits, pasteObjects, rectFrom, rectSize, type CellRect, type Clipboard } from '../game/clipboard';
import { checkMap, type CheckResult } from '../game/compat';
import { buildMapPackage, collectMapTxtRows, planImport, readMapPackage, type ImportPlan, type MapPackage } from '../game/mapPackage';
import { loadPresets, presetFromSelection, presetPath, presetToClipboard, serializePreset, suggestPresets, type Preset, type SuggestProgress } from '../game/presets';
import { layerKey, layerLabel, MapDocument, type Brush, type CellEdit, type LayerRef } from '../game/MapDocument';
import { openMap, withPalette, type MapOverride, type OpenMap } from '../game/openMap';
import { buildScene, hitTest, subTileToWorld, tilesAt, worldToSubTile, type DrawItem } from '../render/scene';
import { canPickFolders, loadFromDevServer, sourcesFromDirectory } from '../vfs/loaders';
import { devServerSaveTarget, directorySaveTarget, downloadFile, exportBytes, importBytes, type SaveTarget } from '../vfs/save';
import { LayeredFs, normalizePath, type FileSource } from '../vfs/vfs';
import { FileBrowser } from './FileBrowser';
import { isVisible, MapView, type GhostTile, type HoverInfo, type StrokePhase } from './MapView';
import { CellPanel, GroupsPanel, LayersPanel, MapInfoPanel, SelectionPanel } from './panels';
import { DEFAULT_VISIBILITY, TOOLS, type Tool, type Visibility } from './state';
import { NewMapDialog, ResizeDialog, SaveAsDialog, type NewMapChoice } from './Dialogs';
import { DataTables, type TableTarget } from './DataTables';
import { Dt1Manager } from './Dt1Manager';
import { CubeRecipeDialog, RegisterMapDialog, type TableWrite } from './LevelTools';
import { ObjectPreview } from './ObjectPreview';
import { PresetsPanel } from './PresetsPanel';
import { Ribbon, type RibbonTab } from './Ribbon';
import { CompatDialog, ExportPackageDialog, ImportPackageDialog } from './ToolDialogs';
import type { Sprite } from '../game/sprites';
import { getConfig, isTauri, loadFromTauri, setConfig, tauriSaveTarget, type DesktopConfig } from '../vfs/tauri';
import { DesktopSetup } from './DesktopSetup';
import { ObjectPanel } from './ObjectPanel';
import { TilePalette, type PaletteFocus } from './TilePalette';

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

/** Layer visibility toggled by the number keys. */
const LAYER_KEYS: Record<string, (v: Visibility) => Visibility> = {
  '1': (v) => ({ ...v, floors: v.floors.map((x, i) => (i === 0 ? !x : x)) }),
  '2': (v) => ({ ...v, floors: v.floors.map((x, i) => (i === 1 ? !x : x)) }),
  '3': (v) => ({ ...v, walls: v.walls.map((x, i) => (i === 0 ? !x : x)) }),
  '4': (v) => ({ ...v, walls: v.walls.map((x, i) => (i === 1 ? !x : x)) }),
  '5': (v) => ({ ...v, walls: v.walls.map((x, i) => (i === 2 ? !x : x)) }),
  '6': (v) => ({ ...v, walls: v.walls.map((x, i) => (i === 3 ? !x : x)) }),
  '7': (v) => ({ ...v, shadows: !v.shadows }),
  '8': (v) => ({ ...v, roofs: !v.roofs }),
  '9': (v) => ({ ...v, lowerWalls: !v.lowerWalls }),
  '0': (v) => ({ ...v, specials: !v.specials }),
};

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
  const [paletteFocus, setPaletteFocus] = useState<PaletteFocus | null>(null);
  /** Shows a tile in the Tiles panel: switches to its layer and DT1, scrolls to it and highlights it. */
  const focusTile = useCallback((tile: Dt1Tile, layer: LayerRef) => {
    setActiveLayer(layer);
    setPaletteFocus((f) => ({ tile, seq: (f?.seq ?? 0) + 1 }));
  }, []);
  const [selection, setSelection] = useState<CellRect | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [pasting, setPasting] = useState(false);
  const [selectedObject, setSelectedObject] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'new' | 'saveAs' | 'resize' | 'dt1s' | 'tables' | 'register' | 'cube' | 'check' | 'export' | 'import' | null>(null);
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
    (phase: StrokePhase, cells: [number, number][], world: [number, number]) => {
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
          const edits = pasteEdits(doc, clipboard, x, y);
          const objects = pasteObjects(doc, clipboard, x, y);
          if (objects.length) {
            // Cells and objects together, as one undo step.
            doc.mutate((d) => {
              for (const e of edits) {
                const layers = e.layer.kind === 'floor' ? d.floors : e.layer.kind === 'wall' ? d.walls : d.shadows;
                (layers[e.layer.index] as typeof e.cell[])[e.y * d.width + e.x] = e.cell;
              }
              d.objects = [...d.objects, ...objects];
            });
            bump();
          } else if (doc.apply(edits)) bump();
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
          const hit = scene && hitTest(scene, world[0], world[1], (it) => isVisible(it, visibility));
          if (hit) {
            selectAnchor.current = [hit.cellX, hit.cellY];
            focusTile(hit.tile, layerOfItem(hit));
          }
          setSelection(clampRect(rectFrom(selectAnchor.current, selectAnchor.current), doc.ds1.width, doc.ds1.height));
          return;
        }
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
    [doc, tool, brush, activeLayer, pickAt, notify, pasting, clipboard, placing, selectedObject, scene, visibility, focusTile],
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
        d.revision = 1; // unsaved
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
      setMap(await openMap(gd, map.path, { source: 'manual', lvlType: map.resolution.lvlType, paths }, map.ds1));
      setDialog(null);
      notify(`Tile libraries: ${paths.length}`);
    },
    [gd, map, doc, mutate, notify],
  );

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
  const placePreset = useCallback(
    (p: Preset) => {
      setClipboard(presetToClipboard(p));
      setPasting(true);
      notify(`Placing "${p.name}" · click the map · Esc to cancel`);
    },
    [notify],
  );
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
    setCheckResults(await checkMap(gd, map, scene));
  }, [gd, map, scene]);

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
          { path: doc.path, ds1: doc.ds1, dt1Paths: map.lib.loaded.filter((l) => l.found && !l.path.startsWith('winds1/')).map((l) => l.path) },
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

  // Keyboard shortcuts.
  const handlers = useRef({ undo, redo, save, copy, startPaste, clearSelection, deleteSelectedObject, doc, tool });
  handlers.current = { undo, redo, save, copy, startPaste, clearSelection, deleteSelectedObject, doc, tool };
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
        setPlacing(null);
        setResizeMode(false);
        setMarks(undefined);
        if (handlers.current.tool === 'object') setSelectedObject(null);
        else setSelection(null);
      } else if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        if (handlers.current.tool !== 'object' || !handlers.current.deleteSelectedObject()) handlers.current.clearSelection(e.shiftKey);
      } else if (!mod && !e.altKey) {
        const t = TOOLS.find((t) => t.key === k);
        if (t) setTool(t.id);
        else if (k === 'f') setFitSignal((n) => n + 1);
        else if (k === 'g') setVisibility((v) => ({ ...v, grid: !v.grid }));
        else if (k === 'w') setVisibility((v) => ({ ...v, walkable: !v.walkable }));
        else if (LAYER_KEYS[e.key]) setVisibility(LAYER_KEYS[e.key]);
        else if (k === 'p') setVisibility((v) => ({ ...v, paths: !v.paths }));
        else if (k === 'm') setVisibility((v) => ({ ...v, objects: !v.objects }));
        else if (k === 'n') setVisibility((v) => ({ ...v, sprites: !v.sprites }));
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
  const TOOL_ICONS = { select: <MousePointer2 />, paint: <Paintbrush />, erase: <Eraser />, pick: <Pipette />, object: <Box /> };
  const ribbonTabs: RibbonTab[] = [
    {
      id: 'home',
      label: 'Home',
      groups: [
        {
          label: 'File',
          items: [
            { label: 'Save', icon: <Save />, onClick: () => void save(), disabled: noMap, active: !!doc?.dirty, shortcut: 'Ctrl+S', title: data.saveTarget ? `Save into ${data.saveTarget.label}` : 'Save (downloads: no mod folder)' },
            { label: 'Save as…', icon: <FilePlus2 />, onClick: () => setDialog('saveAs'), disabled: noMap, size: 'sm' },
            { label: 'Export .ds1', icon: <FileOutput />, onClick: () => void exportFile(), disabled: noMap, size: 'sm' },
            ...(isTauri ? [{ label: 'Folders…', icon: <FolderCog />, onClick: () => confirmDiscard() && setChangingFolders(true), size: 'sm' as const }] : []),
          ],
        },
        {
          label: 'Edit',
          items: [
            { label: 'Paste', icon: <ClipboardPaste />, onClick: startPaste, disabled: noMap || !clipboard, shortcut: 'Ctrl+V' },
            { label: 'Cut', icon: <Scissors />, onClick: () => copy(true), disabled: !selection, size: 'sm', shortcut: 'Ctrl+X' },
            { label: 'Copy', icon: <Copy />, onClick: () => copy(false), disabled: !selection, size: 'sm', shortcut: 'Ctrl+C' },
            { label: 'Delete', icon: <Trash2 />, onClick: () => clearSelection(false), disabled: !selection, size: 'sm', shortcut: 'Del' },
            { label: 'Undo', icon: <Undo2 />, onClick: undo, disabled: !doc?.canUndo, size: 'sm', shortcut: 'Ctrl+Z' },
            { label: 'Redo', icon: <Redo2 />, onClick: redo, disabled: !doc?.canRedo, size: 'sm', shortcut: 'Ctrl+Y' },
          ],
        },
        {
          label: 'Tools',
          items: TOOLS.map((t) => ({ label: t.label, icon: TOOL_ICONS[t.id], onClick: () => setTool(t.id), active: tool === t.id, disabled: noMap, title: t.hint, shortcut: t.key.toUpperCase() })),
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
            { label: 'Fit', icon: <Maximize />, onClick: () => setFitSignal((n) => n + 1), disabled: noMap, shortcut: 'F' },
            { label: 'Grid', icon: <Grid3x3 />, onClick: () => setVisibility((v) => ({ ...v, grid: !v.grid })), active: visibility.grid, size: 'sm', shortcut: 'G' },
            { label: 'Walkability', icon: <Footprints />, onClick: () => setVisibility((v) => ({ ...v, walkable: !v.walkable })), active: visibility.walkable, size: 'sm', shortcut: 'W' },
            { label: 'Sprites', icon: <Box />, onClick: () => setVisibility((v) => ({ ...v, sprites: !v.sprites })), active: visibility.sprites, size: 'sm', shortcut: 'N' },
          ],
        },
        { label: 'Check', items: [{ label: 'Compatibility', icon: <ShieldCheck />, onClick: () => void runCheck(), disabled: noMap, title: 'Check that this map will load and play in game' }] },
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
        { label: 'Tiles', items: [{ label: 'Tile libraries', icon: <Library />, onClick: () => setDialog('dt1s'), disabled: noMap, title: 'Add or remove DT1 files for this map' }] },
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
  ];

  return (
    <div className="app">
      <Ribbon
        tabs={ribbonTabs}
        brand={
          <>
            <span className="brand-mark">◆</span> DS1 Studio
          </>
        }
        right={
          map ? (
            <>
              <span className="topbar-title">
                {title}
                {doc?.dirty && <span className="dirty-dot" title="Unsaved changes" />}
              </span>
              <span className="topbar-path">{map.path}</span>
            </>
          ) : (
            <span className="muted">No map open</span>
          )
        }
      />

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
            objectLabel={objectLabel}
            selectedObject={selectedObject}
            sprites={sprites}
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
                onAddDt1s={(paths) => void applyDt1s([...map.lib.loaded.filter((l) => l.found && !l.path.startsWith('winds1/')).map((l) => l.path), ...paths])}
              />
            )}
            <section className="panel" hidden={tool === 'object' || sidePanel !== 'tiles'}>
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
                focus={paletteFocus}
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
              onMutate={mutate}
              scene={scene}
              onFocusTile={focusTile}
            />
            <GroupsPanel ds1={map.ds1} selection={selection} onMutate={mutate} onShowGroups={() => setVisibility((v) => ({ ...v, groups: true }))} />
            <LayersPanel map={map} scene={scene} visibility={visibility} onChange={setVisibility} />
            <MapInfoPanel map={map} gd={data.gd} onReopen={reresolve} onPalette={(act) => void withPalette(data.gd, map, act).then(setMap)} />
          </>
        )}
      </aside>

      {dialog === 'new' && <NewMapDialog gd={data.gd} onCreate={createMap} onClose={() => setDialog(null)} />}
      {dialog === 'saveAs' && doc && <SaveAsDialog path={doc.path} onSave={saveAs} onClose={() => setDialog(null)} />}
      {dialog === 'resize' && doc && <ResizeDialog width={doc.ds1.width} height={doc.ds1.height} onResize={resize} onClose={() => setDialog(null)} />}
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
          usedDt1s={[...dt1Usage.keys()].filter((p) => !p.startsWith('winds1/'))}
          onApply={applyTableWrites}
          onClose={() => setDialog(null)}
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
          onFix={(fix) => {
            if (fix.kind === 'open-table') openTable(fix.table.replace(/\.txt$/i, ''), fix.key);
            else void applyDt1s([...(map?.lib.loaded.filter((l) => l.found && !l.path.startsWith('winds1/')).map((l) => l.path) ?? []), ...fix.paths]);
          }}
          onRegister={() => setDialog('register')}
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
