import { useCallback, useEffect, useMemo, useState } from 'react';
import { GameData } from '../game/GameData';
import { openMap, type MapOverride, type OpenMap } from '../game/openMap';
import { canPickFolders, loadFromDevServer, sourcesFromDirectory } from '../vfs/loaders';
import { LayeredFs, type FileSource } from '../vfs/vfs';
import { FileBrowser } from './FileBrowser';
import { Inspector, LayersPanel, MapInfoPanel } from './panels';
import { MapView, type HoverInfo } from './MapView';
import { DEFAULT_VISIBILITY, type Visibility } from './state';

type DataState =
  | { status: 'connecting' }
  | { status: 'setup'; error?: string }
  | { status: 'loading'; message: string }
  | { status: 'ready'; gd: GameData; files: string[] };

export function App() {
  const [data, setData] = useState<DataState>({ status: 'connecting' });
  const [map, setMap] = useState<OpenMap | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>(DEFAULT_VISIBILITY);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitSignal, setFitSignal] = useState(0);

  const mountFs = useCallback(async (fs: LayeredFs) => {
    setData({ status: 'loading', message: 'Reading game tables…' });
    const gd = await GameData.load(fs);
    const files = fs.list((p) => p.endsWith('.ds1') && p.startsWith('data/global/tiles/'));
    setData({ status: 'ready', gd, files });
  }, []);

  // In dev, the Vite plugin serves the local install; otherwise ask for a folder.
  useEffect(() => {
    loadFromDevServer()
      .then((fs) => (fs ? mountFs(fs) : setData({ status: 'setup' })))
      .catch((e) => setData({ status: 'setup', error: String(e) }));
  }, [mountFs]);

  const pickFolders = async (withMod: boolean) => {
    try {
      const sources: FileSource[] = [];
      const pick = (id: string) =>
        (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id, mode: 'read' });
      if (withMod) {
        const mod = await pick('d2-mod');
        setData({ status: 'loading', message: `Indexing ${mod.name}…` });
        sources.push(...(await sourcesFromDirectory(mod, true)));
      }
      const game = await pick('d2-game');
      setData({ status: 'loading', message: `Opening archives in ${game.name}…` });
      sources.push(...(await sourcesFromDirectory(game, false)));
      if (!sources.length) throw new Error('No MPQs or data folder found there.');
      await mountFs(new LayeredFs(sources));
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setData({ status: 'setup', error: (e as Error).message });
      else setData({ status: 'setup' });
    }
  };

  const open = useCallback(
    async (path: string, override?: MapOverride) => {
      if (data.status !== 'ready') return;
      setLoadingPath(path);
      setMapError(null);
      try {
        setMap(await openMap(data.gd, path, override));
        setHover(null);
      } catch (e) {
        setMapError(`${path}: ${(e as Error).message}`);
      } finally {
        setLoadingPath(null);
      }
    },
    [data],
  );

  // Keyboard: F = fit, G = grid, O = objects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      if (e.key === 'f') setFitSignal((n) => n + 1);
      if (e.key === 'g') setVisibility((v) => ({ ...v, grid: !v.grid }));
      if (e.key === 'o') setVisibility((v) => ({ ...v, objects: !v.objects }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const title = useMemo(() => map?.path.split('/').pop(), [map]);

  if (data.status !== 'ready') {
    return <SetupScreen state={data} onPick={pickFolders} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> DS1 Studio
        </div>
        <div className="topbar-file">
          {map ? (
            <>
              <span className="topbar-title">{title}</span>
              <span className="topbar-path">{map.path}</span>
            </>
          ) : (
            <span className="muted">No map open</span>
          )}
        </div>
        <div className="topbar-actions">
          <button className="btn ghost" disabled={!map} onClick={() => setFitSignal((n) => n + 1)} title="Fit map (F)">
            Fit
          </button>
        </div>
      </header>

      <aside className="sidebar left">
        <FileBrowser files={data.files} current={map?.path ?? null} loading={loadingPath} onOpen={(p) => open(p)} />
      </aside>

      <main className="stage">
        {map ? (
          <MapView map={map} visibility={visibility} hover={hover} onHover={setHover} onZoom={setZoom} fitSignal={fitSignal} />
        ) : (
          <div className="empty-stage">
            <div className="empty-title">Open a map</div>
            <div className="muted">
              Pick a DS1 from the list. {data.files.length.toLocaleString()} presets found across {data.gd.fs.sources.length} sources.
            </div>
          </div>
        )}
        {mapError && (
          <div className="toast error" onClick={() => setMapError(null)}>
            {mapError}
          </div>
        )}
        {loadingPath && <div className="toast">Loading {loadingPath.split('/').pop()}…</div>}
      </main>

      <aside className="sidebar right">
        {map && (
          <>
            <LayersPanel map={map} visibility={visibility} onChange={setVisibility} />
            <Inspector map={map} hover={hover} />
            <MapInfoPanel map={map} gd={data.gd} onReopen={(o) => open(map.path, o)} />
          </>
        )}
      </aside>

      <footer className="statusbar">
        <span>{data.gd.fs.sources.map((s) => s.label.split(/[\\/]/).slice(-2).join('/')).join('  ›  ')}</span>
        <span className="spacer" />
        {map && (
          <>
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
                <button className="btn primary" onClick={() => onPick(false)}>
                  Open Diablo II folder
                </button>
                <button className="btn" onClick={() => onPick(true)}>
                  Open mod folder + Diablo II folder
                </button>
              </div>
            ) : (
              <p>This browser can't open local folders. Use Chrome or Edge, or the desktop app.</p>
            )}
            <p className="muted small">
              The Diablo II folder needs d2data.mpq, d2exp.mpq and patch_d2.mpq. A mod folder may contain an extracted <code>data/</code>{' '}
              tree and/or mod MPQs; its files take priority. Nothing is ever written to these folders.
            </p>
            {state.error && <p className="error-text">{state.error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
