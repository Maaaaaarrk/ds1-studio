import { useEffect, useMemo, useState } from 'react';
import type { Dt1 } from '../formats/dt1';
import type { GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import type { CellSelection } from '../game/clipboard';
import { selectionCount } from '../game/clipboard';
import type { FloorChoice, RerollOptions } from '../game/floorReroll';
import { normalizePath } from '../vfs/vfs';
import { Modal } from './Dialogs';
import { Thumb, TilePreview, usePreview } from './TilePalette';

interface Props {
  gd: GameData; map: OpenMap; selection: CellSelection | null; initialLayer: number;
  onApply: (choices: FloorChoice[], layer: number, options: RerollOptions) => Promise<void>; onClose: () => void;
}
export function FloorRerollDialog({ gd, map, selection, initialLayer, onApply, onClose }: Props) {
  const paths = useMemo(() => gd.fs.list(p => p.endsWith('.dt1') && p.startsWith('data/global/tiles/')), [gd]);
  const [query, setQuery] = useState('');
  const [path, setPath] = useState(() => map.lib.loaded.find(l => map.lib.tilesOf(l.path).some(t => t.orientation === 0))?.path ?? paths[0] ?? '');
  const [dt1, setDt1] = useState<Dt1 | null>(null);
  const [choices, setChoices] = useState<Map<string, FloorChoice>>(new Map());
  const [layer, setLayer] = useState(initialLayer);
  const [options, setOptions] = useState<RerollOptions>({ preserveWalkability: true, avoidRepeats: true, seed: 1 });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, hover] = usePreview();
  useEffect(() => {
    let live = true; setDt1(null); setError('');
    if (path) void gd.dt1(path).then(d => live && setDt1(d)).catch(e => live && setError(String(e)));
    return () => { live = false; };
  }, [gd, path]);
  const floors = useMemo(() => dt1?.tiles.flatMap((tile, index) => tile.orientation === 0 ? [{ tile, index }] : []) ?? [], [dt1]);
  const key = (p: string, i: number) => normalizePath(p) + '#' + i;
  const choose = (index: number, on: boolean) => {
    const tile = dt1?.tiles[index]; if (!tile || busy) return;
    setChoices(prev => {
      const next = new Map(prev), k = key(path, index);
      if (on) next.set(k, { path, index, tile, brush: { orientation: 0, main: tile.mainIndex, sub: tile.subIndex } }); else next.delete(k);
      return next;
    });
  };
  return <Modal title="Reroll floors" wide onClose={() => !busy && onClose()}>
    <fieldset disabled={busy} className="plain-fieldset">
      <p className="small">Check any number of floor tiles, across multiple libraries. Reroll spreads the choices evenly, avoids adjacent repeats, leaves empty cells alone and can preserve the existing walkability.</p>
      <div className="asset-toolbar">
        <label>Floor layer <select value={layer} onChange={e => setLayer(Number(e.target.value))}>{map.ds1.floors.map((_, i) => <option value={i} key={i}>Floor {i + 1}</option>)}</select></label>
        <span>{selection ? selectionCount(selection) + ' selected cells' : 'Whole map'}</span>
        <label><input type="checkbox" checked={options.preserveWalkability} onChange={e => setOptions({ ...options, preserveWalkability: e.target.checked })} /> Preserve walkability</label>
        <label><input type="checkbox" checked={options.avoidRepeats} onChange={e => setOptions({ ...options, avoidRepeats: e.target.checked })} /> Avoid adjacent repeats</label>
        <label>Variation <input type="number" min={0} max={999999} value={options.seed} onChange={e => setOptions({ ...options, seed: Number(e.target.value) || 0 })} /></label>
      </div>
      <input className="search" placeholder="Search DT1 folders…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="asset-columns">
        <div className="asset-files">{paths.filter(p => p.toLowerCase().includes(query.toLowerCase())).map(p =>
          <button className={'asset-file-button' + (normalizePath(path) === normalizePath(p) ? ' active' : '')} key={p} onClick={() => setPath(p)}>{p.replace(/^data\/global\/tiles\//i, '')}</button>)}</div>
        <div className="asset-view">
          <b>{path.replace(/^data\/global\/tiles\//i, '')}</b>
          <div className="asset-toolbar"><button className="btn small" onClick={() => floors.forEach(f => choose(f.index, true))}>Check every floor in this file</button></div>
          {!dt1 ? <p>Loading…</p> : !floors.length ? <p className="muted">This library has no floor tiles.</p> : null}
          <div className="asset-grid">{floors.map(({tile, index}) => <label className="asset-tile" key={index} {...hover(() => ({ tile, title: 'Floor ' + tile.mainIndex + '/' + tile.subIndex, lines: [path] }))}>
            <Thumb tile={tile} palette={map.palette} />
            <span><input type="checkbox" checked={choices.has(key(path, index))} onChange={e => choose(index, e.target.checked)} />#{index} · {tile.mainIndex}/{tile.subIndex}{tile.animated ? ' · animated' : ''}</span>
          </label>)}</div>
        </div>
      </div>
      <div className="asset-toolbar"><b>{choices.size} floor tiles checked</b><button className="btn small" onClick={() => setChoices(new Map())}>Clear choices</button></div>
      <p className="muted small">Tiles from another library are copied into a new map library with safe tile numbers. The originals stay intact. Cells with no walkability-compatible choice stay unchanged. Map placement is one undo step.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!choices.size} onClick={async () => {
        setBusy(true); setError('');
        try { await onApply([...choices.values()], layer, options); onClose(); }
        catch (e) { setError(String(e)); }
        finally { setBusy(false); }
      }}>{busy ? 'Rerolling…' : 'Reroll selected floors'}</button></div>
    </fieldset>
    {preview && <TilePreview p={preview} palette={map.palette} />}
  </Modal>;
}
