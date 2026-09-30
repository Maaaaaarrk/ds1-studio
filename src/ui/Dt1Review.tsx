import { useEffect, useMemo, useState } from 'react';
import type { Ds1 } from '../formats/ds1';
import type { Dt1 } from '../formats/dt1';
import { customNameProblem } from '../game/customDt1';
import { cellsUsing, mapTileUsage, typesUsing } from '../game/dt1Review';
import type { GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import { isBuiltinPath } from '../game/specialTiles';
import { normalizePath } from '../vfs/vfs';
import { Dt1Viewer } from './Dt1Manager';

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

interface Props {
  map: OpenMap;
  gd: GameData;
  /** The map as edited (unsaved changes included), for which tiles it places. */
  ds1: Ds1;
  /** Drawn tiles per DT1 path (normalized). */
  usage: Map<string, number>;
  /** The mod folder saves go to (null: none), to tell the mod's own DT1s from the game's. */
  modRoot: string | null;
  onApply: (paths: string[]) => void;
  onShowCells: (cells: { x: number; y: number }[]) => void;
  onRemoveTile: (path: string, index: number) => Promise<void>;
  /** Renames a DT1 (same folder); resolves to its new path. */
  onRename: (path: string, name: string) => Promise<string>;
  onOpenLibrary: () => void;
  onSelectLibrary: (path: string) => void;
  onDetach: (path: string) => Promise<void>;
  onRestore: () => void;
  onClose: () => void;
}

/**
 * Map → Tile libraries: the DT1s the map is attached to, what of each it uses (tiles marked, and shown on the map),
 * and taking a whole library off the map, taking one tile out of a DT1, or renaming a DT1.
 */
export function MapDt1Review({ map, gd, ds1, usage, modRoot, onApply, onShowCells, onRemoveTile, onRename, onOpenLibrary, onSelectLibrary, onDetach, onRestore, onClose }: Props) {
  const original = useMemo(() => map.lib.loaded.filter((l) => !isBuiltinPath(l.path)).map((l) => l.path), [map]);
  const [paths, setPaths] = useState<string[]>(original);
  useEffect(() => setPaths(original), [original]);
  const [selected, setSelected] = useState<string>(() => original[0] ?? '');
  const [dt1, setDt1] = useState<Dt1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const tileUsage = useMemo(() => mapTileUsage(ds1), [ds1]);
  useEffect(() => {
    setDt1(null);
    setRenaming(null);
    setError(null);
    let live = true;
    if (selected) void gd.dt1(selected).then(d => live && setDt1(d)).catch(e => live && setError(String(e)));
    return () => { live = false; };
  }, [selected, gd]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  /** Where a DT1 comes from, and whether it is the mod's own file (the only kind changed in place). */
  const origin = (p: string) => {
    const src = gd.fs.locate(p);
    const root = modRoot?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const own = !!src && (src === 'Saved this session' || (!!root && src.replace(/\\/g, '/').toLowerCase().startsWith(root)));
    return { src, own, archive: !!src && /\.mpq$/i.test(src) };
  };
  const drawnOf = (p: string) => usage.get(normalizePath(p)) ?? 0;
  /** How many of a library's tiles the map places (by tile number), and how many it has. */
  const usedOf = (p: string) => {
    const tiles = map.lib.tilesOf(p);
    return { used: tiles.filter((t) => tileUsage.has(`${t.orientation}|${t.mainIndex}|${t.subIndex}`)).length, total: tiles.length };
  };
  const inMap = new Set(paths.map(normalizePath));
  const removed = original.filter((p) => !inMap.has(normalizePath(p)));
  const removedUsed = removed.filter((p) => drawnOf(p) > 0);
  const sel = origin(selected);
  const otherTypes = selected ? typesUsing(gd.lvlTypes, selected).filter((t) => !map.resolution.lvlType || !t.startsWith(`${map.resolution.lvlType.id} `)) : [];
  const folder = short(selected).split('/').slice(0, -1).join('/');
  const name = short(selected).split('/').pop()?.replace(/\.dt1$/i, '') ?? '';
  const renameProblem = renaming === null ? null : renaming.trim() === name ? 'That is its name already.' : customNameProblem(renaming, folder) ?? (gd.fs.locate(`data/global/tiles/${folder}/${renaming.trim()}.dt1`) ? 'A DT1 of that name is already there.' : null);
  const cantChange = !sel.own
    ? sel.archive
      ? "This DT1 is in the game's archives, shared by every map that uses it: make your own copy with Map → DT1 editor to change it."
      : "This DT1 isn't in your mod folder, so it isn't changed here."
    : null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => !busy && e.target === e.currentTarget && onClose()}>
      <div className="modal dt1-manager dt1-library dt1-review" role="dialog" aria-label="Tile libraries">
        <div className="modal-title">Tile libraries · {map.path.split('/').pop()}</div>
        <div className="dt1l-cols">
          <div className="dt1l-side">
            <div className="field-label">
              This map&apos;s tile libraries <span className="muted small">{paths.length}</span>
            </div>
            <input className="search" aria-label="Search map libraries" placeholder="Search map libraries…" value={query} onChange={e => setQuery(e.target.value)} />
            <ul className="dt1m-list dt1r-list">
              {original.filter(p => p.toLowerCase().includes(query.toLowerCase())).map((p) => {
                const drawn = drawnOf(p);
                const u = usedOf(p);
                const o = origin(p);
                const off = !inMap.has(normalizePath(p));
                return (
                  <li key={p} className={`${selected === p ? 'active' : ''}${off ? ' off' : ''}`} onClick={() => setSelected(p)}>
                    <span className="mono">{short(p)}</span>
                    <span
                      className="muted small"
                      title={
                        u.used && !drawn
                          ? 'The map uses tile numbers this library has, but a library listed later has the same numbers and is the one drawn (the game does the same)'
                          : `${u.used} of its ${u.total} tiles are placed in this map; ${drawn} cells draw from it`
                      }
                    >
                      {!o.src ? 'not found' : u.used ? `${u.used}/${u.total} used${drawn ? '' : ' (drawn from a later library)'}` : 'unused'} · {o.own ? 'mod' : o.archive ? 'game' : 'other'}
                    </span>
                    <button
                      className="icon-btn"
                      title={off ? 'Keep it' : drawn ? `Remove from this map (${drawn} placed tiles will show as missing)` : 'Remove from this map'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPaths(off ? [...paths, p] : paths.filter((x) => normalizePath(x) !== normalizePath(p)));
                      }}
                    >
                      {off ? '↺' : '×'}
                    </button>
                  </li>
                );
              })}
            </ul>
            <button className="btn small" disabled={busy} onClick={onOpenLibrary} title="Browse every tile library, add your own DT1s, or build a custom one">
              + Add libraries…
            </button>
            <p className="muted small">
              Tiles this map places are outlined in green with how many cells use them. Removing a library takes it off this map only (and its level type&apos;s Dt1Mask); the file stays.
            </p>
          </div>
          <div className="dt1l-view">
            {selected ? (
              <Dt1Viewer
                path={selected}
                dt1={dt1}
                palette={map.palette}
                paletteNote="map's palette"
                inMap
                onAdd={() => undefined}
                usage={tileUsage}
                headActions={
                  <span className="dt1r-actions">
                    <button className="btn small" disabled={busy || !dt1} onClick={() => onSelectLibrary(selected)}>Select matching map tiles</button>
                    <button className="btn small danger" disabled={busy || !dt1 || !modRoot} onClick={() => void run(() => onDetach(selected))}>Clear tiles & detach…</button>
                    {renaming === null ? (
                      <button className="btn small" disabled={busy || !!cantChange || !!gd.fs.baseSources.some((s) => /\.mpq$/i.test(s.label) && s.has(selected))} title={cantChange ?? 'Rename the file, and every level type that loads it'} onClick={() => setRenaming(name)}>
                        Rename…
                      </button>
                    ) : (
                      <>
                        <input className="mono dt1r-name" value={renaming} autoFocus onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                        <button
                          className="btn small primary"
                          disabled={busy || !!renameProblem}
                          onClick={() =>
                            void run(async () => {
                              const next = await onRename(selected, renaming.trim());
                              setRenaming(null);
                              setSelected(next);
                            })
                          }
                        >
                          {busy ? 'Renaming…' : 'Rename'}
                        </button>
                        <button className="btn small" onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </>
                    )}
                  </span>
                }
                tileActions={(index, tile, uses) => (
                  <div className="dt1r-tile">
                    {uses > 0 ? (
                      <button className="btn small" onClick={() => onShowCells(cellsUsing(ds1, `${tile.orientation}|${tile.mainIndex}|${tile.subIndex}`))}>
                        Show on map ({uses} cell{uses === 1 ? '' : 's'})
                      </button>
                    ) : (
                      <span className="muted small">Not used in this map.</span>
                    )}
                    <button
                      className="btn small danger"
                      disabled={busy || !!cantChange}
                      title={cantChange ?? 'Remove this whole tile group, keeping a recoverable original in Asset backups'}
                      onClick={() => {
                        const lines = [
                          `Take tile #${index} (${tile.mainIndex}/${tile.subIndex}) out of ${short(selected)}?`,
                          uses ? `\nThis map places it in ${uses} cell${uses === 1 ? '' : 's'}: ${uses === 1 ? 'it' : 'they'} will show as missing unless another variant remains.` : '',
                          otherTypes.length ? `\nOther level types load this DT1 too (${otherTypes.join(', ')}): their maps lose the tile as well.` : '',
                          '\nEvery animation frame and random variant in this tile group is removed together. The original is kept in DS1 Studio’s data folder (Asset backups). Use “Deleted by accident?” to restore it.',
                        ];
                        if (window.confirm(lines.join(''))) void run(() => onRemoveTile(selected, index));
                      }}
                    >
                      Remove this tile group from the DT1…
                    </button>
                  </div>
                )}
              />
            ) : (
              <p className="muted small">This map has no tile libraries yet.</p>
            )}
            {selected && (
              <p className="muted small">
                {sel.src ? `From ${sel.src}.` : 'Not found.'}
                {otherTypes.length ? ` Also loaded by: ${otherTypes.join(', ')}.` : ''}
                {cantChange ? ` ${cantChange}` : ''}
              </p>
            )}
            {renameProblem && renaming !== null && <p className="error-text small">{renameProblem}</p>}
            {error && <p className="error-text small">{error}</p>}
          </div>
        </div>
        {removed.length > 0 && (
          <p className={`small ${removedUsed.length ? 'error-text' : 'muted'}`}>
            To remove from this map: {removed.map(short).join(', ')}
            {removedUsed.length ? ` — ${removedUsed.map((p) => drawnOf(p)).reduce((a, b) => a + b, 0)} placed tiles will show as missing.` : '.'}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={onRestore}>Deleted by accident?</button>
          <button className="btn" disabled={busy} onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!removed.length || busy} onClick={() => onApply(paths)}>
            Remove {removed.length || ''} from the map
          </button>
        </div>
      </div>
    </div>
  );
}
