import { useEffect, useMemo, useRef, useState } from 'react';
import type { Palette } from '../formats/palette';
import { GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import { scanAssetUsage, splitUnusedTiles, tileIdentity, type UsageScan } from '../game/assetUsage';
import { archiveAsset, findManagedAsset, managedAssets, recycledAssets, restoreAsset, type ManagedAsset, type RecycledAsset } from '../vfs/assetFiles';
import { getConfig, isTauri, loadFromTauri } from '../vfs/tauri';
import { Modal } from './Dialogs';
import { Thumb, TilePreview, usePreview } from './TilePalette';

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');
interface Props {
  gd: GameData; map: OpenMap | null; palette: Palette; initialRestore?: boolean;
  onChanged: () => Promise<void>; onShowUses: (path: string) => void; onClose: () => void;
}
export function AssetCleanup({ gd, map, palette, initialRestore = false, onChanged, onShowUses, onClose }: Props) {
  const [tab, setTab] = useState<'files' | 'tiles' | 'restore'>(initialRestore ? 'restore' : 'files');
  const [scan, setScan] = useState<UsageScan | null>(null);
  const [inventory, setInventory] = useState<ManagedAsset[]>([]);
  const [backups, setBackups] = useState<RecycledAsset[]>([]);
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [path, setPath] = useState('');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [preview, hover, hidePreview] = usePreview();
  const controller = useRef<AbortController | null>(null);
  const scanning = !!progress;
  const runScan = async () => {
    controller.current?.abort();
    const control = new AbortController(); controller.current = control;
    setProgress('Reading maps…'); setMessage(''); setScan(null); setChecked(new Set()); setSelectedFiles(new Set());
    try {
      const [result, owned] = await Promise.all([
        scanAssetUsage(gd, map ? { path: map.path, ds1: map.ds1, paths: map.resolution.paths } : null,
          (n, total, phase) => !control.signal.aborted && setProgress(phase + ': ' + n + ' / ' + total), control.signal),
        isTauri ? managedAssets() : Promise.resolve([]),
      ]);
      if (!control.signal.aborted) { setScan(result); setInventory(owned); }
    } catch (e) { if (!control.signal.aborted) setMessage(String(e)); }
    finally { if (!control.signal.aborted) setProgress(''); }
  };
  const wantsScan = tab !== 'restore';
  useEffect(() => {
    setScan(null); setProgress('');
    if (wantsScan) void runScan();
    return () => controller.current?.abort();
  }, [gd, wantsScan]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (isTauri) void recycledAssets().then(setBackups).catch(e => setMessage(String(e))); }, [tab, gd]);
  const rows = useMemo(() => (scan?.assets ?? []).filter(a =>
    (tab === 'files' ? !a.maps.length : a.unusedIndices.length > 0) && a.path.toLowerCase().includes(query.toLowerCase())), [scan, tab, query]);
  const asset = rows.find(a => a.path === path) ?? rows[0];
  useEffect(() => { setChecked(new Set()); hidePreview(); }, [asset?.path, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const ownerOf = (p: string) => findManagedAsset(inventory, p, gd.fs.locate(p));
  const owner = asset && ownerOf(asset.path);
  const safe = !!scan && !scan.errors.length && !scanning && !busy && isTauri;
  const toggleTile = (index: number) => {
    if (!asset) return;
    const tile = asset.tiles[index];
    const key = tileIdentity(tile.orientation, tile.mainIndex, tile.subIndex);
    const family = asset.tiles.flatMap((t, i) => tileIdentity(t.orientation, t.mainIndex, t.subIndex) === key ? [i] : []);
    setChecked(prev => { const next = new Set(prev); const off = prev.has(index); family.forEach(i => off ? next.delete(i) : next.add(i)); return next; });
  };
  const cleanup = async (action: 'delete' | 'unused') => {
    if (!safe || !scan) return;
    const requests = tab === 'files'
      ? scan.assets.filter(a => selectedFiles.has(a.path) && !a.maps.length).map(a => ({ asset: a, indices: a.tiles.map((_, i) => i) }))
      : asset ? [{ asset, indices: [...checked] }] : [];
    if (!requests.length || requests.some(r => !r.indices.length)) return;
    const label = tab === 'files' ? requests.length + ' DT1 file(s)' : requests[0].indices.length + ' tile(s)';
    if (!window.confirm((action === 'delete' ? 'Delete ' : 'Move ') + label + (action === 'unused' ? ' to PD2 Assets/unused?' : '?') +
      '\n\nOriginal DT1 files will be backed up in DS1 Studio’s data folder (Asset backups). Use “Deleted by accident?” to restore them.')) return;
    setBusy(true); setMessage(''); hidePreview();
    let completed = 0;
    try {
      setProgress('Rechecking map references before cleanup…');
      const freshData = await GameData.load(await loadFromTauri(await getConfig()));
      const fresh = await scanAssetUsage(freshData, map ? { path: map.path, ds1: map.ds1, paths: map.resolution.paths } : null);
      if (fresh.errors.length) throw new Error('Some maps could not be checked. Scan again and resolve the reported errors before cleanup.');
      const owners = await managedAssets();
      for (const request of requests) {
        const latest = fresh.assets.find(a => a.path === request.asset.path);
        if (!latest || latest.error || (tab === 'files' ? latest.maps.length : request.indices.some(i => !latest.unusedIndices.includes(i))))
          throw new Error('Map references changed. Scan again before cleaning this library.');
        const owned = findManagedAsset(owners, request.asset.path, freshData.fs.locate(request.asset.path));
        if (!owned || request.asset.error) throw new Error('This asset is read-only or could not be checked.');
        if (tab === 'tiles' && request.indices.some(i => !request.asset.unusedIndices.includes(i))) throw new Error('A selected tile is still in use.');
        const bytes = await freshData.fs.readOrThrow(request.asset.path);
        if (!request.asset.bytes || bytes.length !== request.asset.bytes.length || bytes.some((b, i) => b !== request.asset.bytes![i]))
          throw new Error('This DT1 changed after the scan. Scan again before removing tiles.');
        const split = splitUnusedTiles(bytes, request.indices);
        await archiveAsset(owned, bytes, action, split.remaining, split.removed);
        completed++;
      }
      setMessage('Completed ' + completed + ' file(s). Originals are available under “Deleted by accident?”.');
    } catch (e) { setMessage('Completed ' + completed + ' file(s). ' + String(e)); }
    finally {
      setBusy(false); setProgress(''); setChecked(new Set()); setSelectedFiles(new Set());
      if (completed) { try { await onChanged(); } catch (e) { setMessage('Files were updated, but refreshing failed: ' + String(e)); } }
    }
  };
  const restore = async (entry: RecycledAsset) => {
    setBusy(true); setMessage('');
    try { setMessage(await restoreAsset(entry.id)); setBackups(await recycledAssets()); await onChanged(); }
    catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  };
  return <Modal title="DT1 cleanup & recovery" wide onClose={() => !busy && onClose()}>
    <div className="asset-cleanup">
      <div className="chips">
        <button className={'chip' + (tab === 'files' ? ' active' : '')} disabled={busy} onClick={() => setTab('files')}>Unused DT1 files</button>
        <button className={'chip' + (tab === 'tiles' ? ' active' : '')} disabled={busy} onClick={() => setTab('tiles')}>Unused tiles inside DT1s</button>
        <button className={'chip' + (tab === 'restore' ? ' active' : '')} disabled={busy} onClick={() => setTab('restore')}>Deleted by accident?</button>
        <button className="btn small" disabled={busy || scanning} onClick={() => void runScan()}>Scan again</button>
      </div>
      {tab === 'restore' ? <div className="asset-restore">
        <p className="small">Restore original files or tile groups. Backups are kept in DS1 Studio’s data folder (Asset backups; older ones beside the app). A newer file at the original location is never overwritten.</p>
        {!isTauri && <p>Restore is available in the desktop app.</p>}
        {backups.map(b => <div className="asset-restore-row" key={b.id}>
          <div><b>{short(b.path)}</b><div className="muted small">{b.root} · {new Date(b.created).toLocaleString()} · {b.partial ? 'tile group' : 'whole file'} · {b.action === 'unused' ? 'moved to unused' : 'deleted'}</div></div>
          <button className="btn" disabled={busy} onClick={() => void restore(b)}>Restore</button>
        </div>)}
        {!backups.length && <p className="muted">No deleted assets to restore.</p>}
      </div> : <>
        <p className="small">Scans all indexed DS1s, including the open map’s unsaved edits, embedded library lists and game-table references. Hover a tile to enlarge it. Animation frames and random variants stay together.</p>
        {!isTauri && <p className="small">Preview is available here; moving, deleting and restoring files requires the desktop app.</p>}
        {progress && <p role="status">{progress}</p>}
        {scan && <p className="small">{scan.mapsScanned} maps checked · {scan.assets.length} DT1 libraries · {rows.length} matching libraries</p>}
        {!!scan?.errors.length && <details className="error-text"><summary>Scan incomplete: {scan.errors.length} map(s) could not be checked. Cleanup is disabled.</summary>{scan.errors.map(e => <div key={e} className="small">{e}</div>)}</details>}
        {!!scan?.warnings.length && <details><summary className="small">{scan.warnings.length} missing table references: affected libraries are protected</summary>{scan.warnings.map(e => <div className="small muted" key={e}>{e}</div>)}</details>}
        <input className="search" placeholder="Search DT1 folders or names…" value={query} disabled={busy} onChange={e => setQuery(e.target.value)} />
        <div className="asset-columns">
          <div className="asset-files">{rows.map(a => <div className={'asset-file' + (asset?.path === a.path ? ' active' : '')} key={a.path}>
            {tab === 'files' && <input type="checkbox" aria-label={'Select ' + short(a.path)} checked={selectedFiles.has(a.path)} disabled={!safe || !ownerOf(a.path) || !!a.error || !a.tiles.length}
              onChange={e => setSelectedFiles(prev => { const next = new Set(prev); if (e.target.checked) next.add(a.path); else next.delete(a.path); return next; })} />}
            <button onClick={() => setPath(a.path)} disabled={busy}><span>{short(a.path)}</span><small>{a.error ? 'Unreadable' : a.unusedIndices.length + ' / ' + a.tiles.length + ' unused tiles'}{!ownerOf(a.path) ? ' · read-only source' : ''}</small></button>
          </div>)}</div>
          <div className="asset-view">{asset ? <>
            <b>{short(asset.path)}</b>
            <div className="small muted">{asset.maps.length ? asset.maps.length + ' map(s) reference this library.' : 'No DS1 references this library.'}</div>
            {!!asset.maps.length && <details><summary className="small">Referenced by</summary>{asset.maps.map(m => <div className="small mono" key={m}>{short(m)}</div>)}</details>}
            {map && <button className="btn small" onClick={() => onShowUses(asset.path)}>Find content in the open map</button>}
            {asset.error && <p className="error-text">{asset.error}</p>}
            {tab === 'tiles' && <button className="btn small" disabled={!safe || !owner} onClick={() => setChecked(new Set(asset.unusedIndices))}>Check all unused tiles in this file</button>}
            <div className="asset-grid">{asset.tiles.map((t, i) => {
              const unused = asset.unusedIndices.includes(i);
              return <label key={i} className={'asset-tile' + (!unused ? ' in-use' : '')} {...hover(() => ({ tile: t, title: short(asset.path) + ' #' + i, lines: [t.mainIndex + '/' + t.subIndex, unused ? 'Unused by scanned maps' : 'Used — protected'] }))}>
                <Thumb tile={t} palette={palette} />
                <span>{tab === 'tiles' && <input type="checkbox" aria-label={'Select tile ' + i} checked={checked.has(i)} disabled={!safe || !owner || !unused} onChange={() => toggleTile(i)} />}#{i} · {t.mainIndex}/{t.subIndex}</span>
                <small>{unused ? 'unused' : 'in use'}</small>
              </label>;
            })}</div>
          </> : !scanning && <p className="muted">No matching unused assets.</p>}</div>
        </div>
        {preview && <TilePreview p={preview} palette={palette} />}
        <div className="modal-actions">
          <span className="small">{tab === 'files' ? selectedFiles.size + ' files checked' : checked.size + ' tiles checked'}</span>
          <button className="btn" disabled={!safe || (tab === 'files' ? !selectedFiles.size : !checked.size || !owner)} onClick={() => void cleanup('unused')}>Move checked to unused</button>
          <button className="btn danger" disabled={!safe || (tab === 'files' ? !selectedFiles.size : !checked.size || !owner)} onClick={() => void cleanup('delete')}>Delete checked…</button>
        </div>
      </>}
      {message && <p className="small" role="status">{message}</p>}
      <div className="modal-actions"><button className="btn" disabled={busy} onClick={onClose}>Close</button></div>
    </div>
  </Modal>;
}
