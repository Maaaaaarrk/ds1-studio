import { useEffect, useMemo, useState } from 'react';
import type { Dt1 } from '../formats/dt1';
import type { GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import { normalizePath } from '../vfs/vfs';
import { Thumb } from './TilePalette';

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
  const [paths, setPaths] = useState<string[]>(() => map.lib.loaded.filter((l) => !l.path.startsWith('winds1/')).map((l) => l.path));
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [previewDt1, setPreviewDt1] = useState<Dt1 | null>(null);

  const all = useMemo(() => gd.fs.list((p) => p.endsWith('.dt1') && p.startsWith('data/global/tiles/')), [gd]);
  const inMap = useMemo(() => new Set(paths.map(normalizePath)), [paths]);
  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((p) => !inMap.has(normalizePath(p)) && (!q || p.toLowerCase().includes(q)));
  }, [all, inMap, query]);

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

  const original = map.lib.loaded.filter((l) => !l.path.startsWith('winds1/')).map((l) => normalizePath(l.path));
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
            <>
              <div className="field-label">
                <span className="mono">{short(preview)}</span>
                <span className="muted small">{previewDt1 ? `${previewDt1.tiles.length} tiles` : 'loading…'}</span>
              </div>
              <div className="thumb-grid dt1m-thumbs">
                {previewDt1?.tiles.slice(0, 60).map((t, i) => (
                  <div key={i} className="thumb" title={`#${i} · o${t.orientation} · ${t.mainIndex}/${t.subIndex}`}>
                    <Thumb tile={t} palette={map.palette} />
                    <span className="thumb-label">#{i}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="muted small">Click a library to preview its tiles. Double-click (or +) to add it.</p>
          )}
        </div>
        {removeUsed.length > 0 && (
          <p className="small error-text">
            Removing {removeUsed.map(short).join(', ')} leaves placed tiles without graphics (they show as missing).
          </p>
        )}
        <p className="muted small">
          Changes apply to the editor and to the DS1&apos;s embedded file list (saved with the map). If the map is in LvlPrest.txt, the game&apos;s tables
          are updated too: new DT1s go into free File slots of its level type in LvlTypes.txt and its Dt1Mask is recomputed (originals kept as .bak).
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
