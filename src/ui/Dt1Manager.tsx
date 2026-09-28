import { useEffect, useMemo, useState } from 'react';
import type { Dt1 } from '../formats/dt1';
import type { GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import { normalizePath } from '../vfs/vfs';
import { Thumb, TilePreview, tilePicture, usePreview } from './TilePalette';
import { loadAct0Palette } from '../game/act0Palette';
import type { Palette } from '../formats/palette';
import { ORIENTATION_NAMES } from './state';
import { isBuiltinPath } from '../game/specialTiles';
import { Dt1Tree } from './Dt1Tree';

interface Props {
  map: OpenMap;
  gd: GameData;
  /** Placed tiles per DT1 path (normalized), to warn before removing a library in use. */
  usage: Map<string, number>;
  onApply: (paths: string[]) => void;
  onClose: () => void;
}

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

/** Add or remove whole tile libraries (DT1 files) for the open map. */
export function Dt1Manager({ map, gd, usage, onApply, onClose }: Props) {
  const [paths, setPaths] = useState<string[]>(() => map.lib.loaded.filter((l) => !isBuiltinPath(l.path)).map((l) => l.path));
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [previewDt1, setPreviewDt1] = useState<Dt1 | null>(null);

  const all = useMemo(() => gd.fs.list((p) => p.endsWith('.dt1') && p.startsWith('data/global/tiles/')), [gd]);
  const inMap = useMemo(() => new Set(paths.map(normalizePath)), [paths]);
  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((p) => !inMap.has(normalizePath(p)) && (!q || p.toLowerCase().includes(q)));
  }, [all, inMap, query]);

  // DT1s are previewed in Act 1's palette (the game's palette 0), like the DT1 editor.
  const [previewPal, setPreviewPal] = useState<{ act: number | null; palette: Palette } | null>(null);
  useEffect(() => {
    void loadAct0Palette(gd.fs).then((a) => setPreviewPal({ act: -1, palette: a.palette }));
  }, [gd]);
  useEffect(() => {
    setPreviewDt1(null);
    if (preview) void gd.dt1(preview).then(setPreviewDt1);
  }, [preview, gd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const original = map.lib.loaded.filter((l) => !isBuiltinPath(l.path)).map((l) => normalizePath(l.path));
  const changed = paths.length !== original.length || paths.some((p, i) => normalizePath(p) !== original[i]);
  const removeUsed = original.filter((p) => !inMap.has(p) && (usage.get(p) ?? 0) > 0);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dt1-manager" role="dialog" aria-label="Tile libraries">
        <div className="modal-title">Tile libraries (DT1) · {map.path.split('/').pop()}</div>
        <div className="dt1m-cols">
          <div className="dt1m-col">
            <div className="field-label">
              In this map <span className="muted small">{paths.length}</span>
            </div>
            <ul className="dt1m-list">
              {paths.map((p) => {
                const used = usage.get(normalizePath(p)) ?? 0;
                const found = gd.fs.locate(p);
                return (
                  <li key={p} className={preview === p ? 'active' : ''} onClick={() => setPreview(p)}>
                    <span className="mono">{short(p)}</span>
                    <span className="muted small">{found ? (used ? `${used} tiles placed` : 'unused') : 'not found'}</span>
                    <button
                      className="icon-btn"
                      title={used ? `Remove (${used} placed tiles will show as missing)` : 'Remove'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPaths(paths.filter((x) => x !== p));
                      }}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="dt1m-col">
            <div className="field-label">
              Available <span className="muted small">{available.length}</span>
            </div>
            <input className="search small-input" placeholder="Filter… (e.g. act3/kurast)" value={query} onChange={(e) => setQuery(e.target.value)} />
            <ul className="dt1m-list">
              {available.map((p) => (
                <li key={p} className={preview === p ? 'active' : ''} onClick={() => setPreview(p)} onDoubleClick={() => setPaths([...paths, p])}>
                  <span className="mono">{short(p)}</span>
                  <span className="muted small">{gd.fs.locate(p)?.split(/[\\/]/).pop()}</span>
                  <button
                    className="icon-btn add"
                    title="Add to this map"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPaths([...paths, p]);
                    }}
                  >
                    +
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="dt1m-preview">
          {preview ? (
            <Dt1Viewer path={preview} dt1={previewDt1} palette={previewPal?.palette ?? map.palette} paletteNote={previewPal ? 'Act 0 palette (magenta = changes between acts)' : null} inMap={inMap.has(normalizePath(preview))} onAdd={() => setPaths([...paths, preview])} />
          ) : (
            <p className="muted small">Click a library to see all of its tiles. Double-click (or +) to add it.</p>
          )}
        </div>
        {removeUsed.length > 0 && (
          <p className="small error-text">
            Removing {removeUsed.map(short).join(', ')} leaves placed tiles without graphics (they show as missing).
          </p>
        )}
        <p className="muted small">
          Changes apply to the editor and to the DS1&apos;s embedded file list (saved with the map). If the map is in LvlPrest.txt, the game&apos;s tables
          are updated too: new DT1s go into free File slots of its level type in LvlTypes.txt (or, when other levels use that type too, a level type of the map&apos;s own) and its Dt1Mask is recomputed (originals kept as .bak).
          {!map.resolution.preset && ' This map is not in LvlPrest.txt yet: use Data → Add to game so the game can load it.'}
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!changed} onClick={() => onApply(paths)}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

const KINDS: { id: string; label: string; test: (o: number) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'floor', label: 'Floors', test: (o) => o === 0 },
  { id: 'wall', label: 'Walls', test: (o) => (o >= 1 && o <= 9) || o === 12 },
  { id: 'tree', label: 'Trees/objects', test: (o) => o === 14 },
  { id: 'roof', label: 'Roofs', test: (o) => o === 15 },
  { id: 'lower', label: 'Lower walls', test: (o) => o >= 16 },
  { id: 'shadow', label: 'Shadows', test: (o) => o === 13 },
  { id: 'special', label: 'Specials', test: (o) => o === 10 || o === 11 },
];

/**
 * Every tile of one DT1, filterable by kind: resting the pointer on a tile shows it enlarged (as in the Tiles panel),
 * clicking it shows its details.
 */
export function Dt1Viewer({ path, dt1, palette, paletteNote, inMap, onAdd, addLabel = 'Add to map' }: { path: string; dt1: Dt1 | null; palette: Palette; paletteNote: string | null; inMap: boolean; onAdd: () => void; addLabel?: string }) {
  const [kind, setKind] = useState('all');
  const [hovered, hover, hideHover] = usePreview();
  const [picked, setPicked] = useState<number | null>(null);
  const [size, setSize] = useState(64);
  useEffect(() => {
    setPicked(null);
    hideHover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const tiles = (dt1?.tiles ?? []).map((t, i) => ({ t, i })).filter(({ t }) => KINDS.find((k) => k.id === kind)!.test(t.orientation));
  const sel = picked !== null ? dt1?.tiles[picked] : undefined;
  return (
    <div className="dt1v">
      <div className="dt1v-head">
        <span className="mono">{short(path)}</span>
        <span className="muted small">
          {dt1 ? `${dt1.tiles.length} tiles` : 'loading…'}
          {paletteNote ? ` · shown in the ${paletteNote}` : ''}
        </span>
        <div className="chips">
          {KINDS.map((k) => {
            const n = dt1 ? dt1.tiles.filter((t) => k.test(t.orientation)).length : 0;
            return k.id === 'all' || n ? (
              <button key={k.id} className={`chip${kind === k.id ? ' active' : ''}`} onClick={() => setKind(k.id)}>
                {k.label} {k.id !== 'all' && <span className="muted">{n}</span>}
              </button>
            ) : null;
          })}
        </div>
        {!inMap && (
          <button className="btn small" onClick={onAdd}>
            {addLabel}
          </button>
        )}
      </div>
      <div className="dt1v-body">
        <div
          className="thumb-grid dt1v-grid"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 14}px, 1fr))`, ['--thumb-h' as string]: `${size}px` }}
          onWheel={(e) => {
            if (!e.ctrlKey) return;
            setSize((v) => Math.round(Math.min(200, Math.max(36, v * Math.exp(-e.deltaY * 0.0015)))));
          }}
          title="Ctrl + scroll to zoom"
        >
          {tiles.map(({ t, i }) => (
            <div
              key={i}
              className={`thumb${picked === i ? ' active' : ''}`}
              {...hover(() => {
                const pic = tilePicture(t, palette);
                return {
                  tile: t,
                  title: `#${i} · ${ORIENTATION_NAMES[t.orientation] ?? `o${t.orientation}`} · main ${t.mainIndex} · sub ${t.subIndex}`,
                  lines: [[pic ? `${pic.width}×${pic.height} px` : '', `rarity ${t.rarity}`, t.animated ? 'animated' : ''].filter(Boolean).join(' · '), 'Click: details'],
                };
              })}
              onClick={() => setPicked(i)}
            >
              <Thumb tile={t} palette={palette} />
              <span className="thumb-label">
                {t.mainIndex}/{t.subIndex}
              </span>
            </div>
          ))}
        </div>
        {hovered && <TilePreview p={hovered} palette={palette} />}
        <div className="dt1v-detail">
          {sel ? (
            <>
              <div className="dt1v-big">
                <Thumb tile={sel} palette={palette} />
              </div>
              <table className="kv small">
                <tbody>
                  <tr><td className="muted">Tile</td><td>#{picked}</td></tr>
                  <tr><td className="muted">Kind</td><td>{ORIENTATION_NAMES[sel.orientation] ?? '?'} (orientation {sel.orientation})</td></tr>
                  <tr><td className="muted">Main / sub</td><td><code>{sel.mainIndex}/{sel.subIndex}</code></td></tr>
                  <tr><td className="muted">Size</td><td>{sel.width}×{Math.abs(sel.height)}</td></tr>
                  <tr><td className="muted">Rarity / frame</td><td>{sel.rarity}</td></tr>
                  <tr><td className="muted">Animated</td><td>{sel.animated ? 'yes' : 'no'}</td></tr>
                </tbody>
              </table>
            </>
          ) : (
            <p className="muted small">Click a tile for a closer look.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The act a tile library belongs to, from its folder (act1…act5, expansion = Act 5); null when it doesn't say. */
function libraryAct(path: string): number | null {
  const m = /^data\/global\/tiles\/(?:act(\d)|(expansion))\//i.exec(path);
  if (!m) return null;
  return m[2] ? 4 : Math.min(4, Math.max(0, Number(m[1]) - 1));
}

/**
 * Import DT1 → From game library: every tile library the game and mods have, by folder, with each one's tiles to look
 * through (hover to enlarge). Chosen libraries are added to the open map like in the Tile libraries dialog.
 */
export function Dt1LibraryDialog({ map, gd, onApply, onClose }: Omit<Props, 'usage'>) {
  const current = useMemo(() => map.lib.loaded.filter((l) => !isBuiltinPath(l.path)).map((l) => l.path), [map]);
  const inMap = useMemo(() => new Set(current.map(normalizePath)), [current]);
  const all = useMemo(() => gd.fs.list((p) => p.endsWith('.dt1') && p.startsWith('data/global/tiles/')), [gd]);
  const [selected, setSelected] = useState('');
  const [dt1, setDt1] = useState<Dt1 | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  // Colours: the library's own act (from its folder), the map's act, or Act 0 (magenta = colours that change by act).
  const [palMode, setPalMode] = useState<'own' | 'map' | 'act0'>('own');
  const [pal, setPal] = useState<{ palette: Palette; note: string } | null>(null);
  const ownAct = libraryAct(selected);
  useEffect(() => {
    let live = true;
    const act = palMode === 'own' ? (ownAct ?? map.ds1.act) : map.ds1.act;
    const load =
      palMode === 'act0'
        ? loadAct0Palette(gd.fs).then((a) => ({ palette: a.palette, note: 'Act 0 palette (magenta = changes between acts)' }))
        : gd.palette(act).then((palette) => ({ palette, note: `Act ${act + 1} palette` }));
    void load.then((p) => live && setPal(p)).catch(() => live && setPal(null));
    return () => {
      live = false;
    };
  }, [gd, palMode, ownAct, map]);
  useEffect(() => {
    setDt1(null);
    if (selected) void gd.dt1(selected).then(setDt1);
  }, [selected, gd]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isChosen = (p: string) => chosen.some((c) => normalizePath(c) === normalizePath(p));
  const toggle = (p: string) => setChosen((c) => (isChosen(p) ? c.filter((x) => normalizePath(x) !== normalizePath(p)) : [...c, p]));
  const selInMap = selected && inMap.has(normalizePath(selected));
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dt1-manager dt1-library" role="dialog" aria-label="Tile libraries from the game">
        <div className="modal-title">Import DT1 from the game library · {map.path.split('/').pop()}</div>
        <div className="dt1l-cols">
          <Dt1Tree all={all} inMap={current} chosen={chosen} selected={selected} onSelect={setSelected} />
          <div className="dt1l-view">
            {selected ? (
              <Dt1Viewer
                path={selected}
                dt1={dt1}
                palette={pal?.palette ?? map.palette}
                paletteNote={pal?.note ?? null}
                inMap={!!selInMap}
                addLabel={isChosen(selected) ? '✓ Chosen (click to undo)' : 'Choose this library'}
                onAdd={() => toggle(selected)}
              />
            ) : (
              <p className="muted small">
                Pick a tile library on the left to see its tiles. Rest the pointer on a tile to see it enlarged; click it for its details. Choose the libraries
                you want, then add them to the map.
              </p>
            )}
            <label className="small dt1l-colours">
              Colours
              <select value={palMode} onChange={(e) => setPalMode(e.target.value as typeof palMode)}>
                <option value="own">its act{ownAct !== null ? ` (Act ${ownAct + 1})` : ''}</option>
                <option value="map">this map&apos;s act (Act {map.ds1.act + 1})</option>
                <option value="act0">Act 0: show colours that change between acts</option>
              </select>
            </label>
            {selInMap && <p className="muted small">This map already loads this library.</p>}
          </div>
        </div>
        <div className="dt1l-chosen">
          <span className="field-label">Chosen</span>
          {chosen.length ? (
            chosen.map((p) => (
              <span key={p} className="chip active" title={p}>
                <button className="link" onClick={() => setSelected(p)}>
                  {short(p)}
                </button>
                <button className="icon-btn" title="Remove" onClick={() => toggle(p)}>
                  ×
                </button>
              </span>
            ))
          ) : (
            <span className="muted small">none yet</span>
          )}
        </div>
        <p className="muted small">
          The libraries are already in the game (or your mod), so nothing is copied: they are added to the map&apos;s tile libraries, and if the map is in
          LvlPrest.txt its level type (LvlTypes.txt) and Dt1Mask are updated so the game loads them too (originals kept as .bak).
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!chosen.length} onClick={() => onApply([...current, ...chosen])}>
            Add {chosen.length || ''} to the map
          </button>
        </div>
      </div>
    </div>
  );
}
