import { useEffect, useMemo, useState } from 'react';
import { ownTilesPath } from '../game/ownTiles';
import { decodeTile, parseDt1 } from '../formats/dt1';
import { buildDt1, dt1Records, type Dt1Record } from '../formats/dt1Write';
import { setTilePixels } from '../formats/dt1Paint';
import { animationRecords, generateWater, replaceAnimation } from '../game/waterAnimation';
import { customNameProblem } from '../game/customDt1';
import { TileLibrary, type GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import { Modal } from './Dialogs';
import { TileZoom } from './TileZoom';
import { Thumb } from './TilePalette';
import { PixelPainter } from './PixelPainter';

export interface WaterSave { path: string; bytes: Uint8Array; expected: Uint8Array | null; addToMap: boolean }
interface Props { gd: GameData; map: OpenMap; canSave: boolean; onSave: (change: WaterSave) => Promise<void>; onClose: () => void }
export function WaterEditor({ gd, map, canSave, onSave, onClose }: Props) {
  const paths = useMemo(() => gd.fs.list(p => p.endsWith('.dt1') && p.startsWith('data/global/tiles/')), [gd]);
  const [path, setPath] = useState(paths.find(p => /water/i.test(p)) ?? paths[0] ?? '');
  const [source, setSource] = useState<Uint8Array | null>(null);
  const [frames, setFrames] = useState<Dt1Record[]>([]);
  const [oldKey, setOldKey] = useState<[number, number] | null>(null);
  const [editingPath, setEditingPath] = useState('');
  const [original, setOriginal] = useState<Uint8Array | null>(null);
  const [frame, setFrame] = useState(0), [playing, setPlaying] = useState(true), [painting, setPainting] = useState(false);
  const [main, setMain] = useState(0), [sub, setSub] = useState(0), [count, setCount] = useState(8);
  const [dark, setDark] = useState('#123c60'), [light, setLight] = useState('#78bed0');
  const [blocked, setBlocked] = useState(true), [direction, setDirection] = useState<'left' | 'right'>('right');
  const [name, setName] = useState('water'), [overwrite, setOverwrite] = useState(false), [addToMap, setAddToMap] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [changed, setChanged] = useState(false);
  const [fps, setFps] = useState(10);
  const close = () => {
    if (painting) { if (window.confirm('Discard the unfinished pixel edits for this frame?')) setPainting(false); return; }
    if (!busy && (!changed || window.confirm('Discard the unsaved water animation?'))) onClose();
  };
  useEffect(() => {
    let live = true; setSource(null);
    if (path) void gd.fs.readOrThrow(path).then(b => { parseDt1(b); if (live) setSource(b); }).catch(e => live && setError(String(e)));
    return () => { live = false; };
  }, [gd, path]);
  const groups = useMemo(() => {
    if (!source) return [];
    const grouped = new Map<string, { main: number; sub: number; indices: number[] }>();
    const tiles = parseDt1(source).tiles;
    tiles.forEach((t, index) => {
      if (t.orientation !== 0) return;
      const key = t.mainIndex + '/' + t.subIndex;
      const g = grouped.get(key) ?? { main: t.mainIndex, sub: t.subIndex, indices: [] };
      g.indices.push(index); grouped.set(key, g);
    });
    return [...grouped.values()].map(g => ({ ...g, animated: TileLibrary.isAnimation(g.indices.map(i => tiles[i])), tile: tiles[g.indices[0]] }));
  }, [source]);
  const tiles = useMemo(() => frames.length ? parseDt1(buildDt1(frames)).tiles : [], [frames]);
  const index = Math.min(frame, Math.max(0, tiles.length - 1));
  const image = tiles[index] ? decodeTile(tiles[index]) : null;
  useEffect(() => {
    if (!playing || painting || frames.length < 2) return;
    const timer = setInterval(() => setFrame(n => (n + 1) % frames.length), 1000 / fps);
    return () => clearInterval(timer);
  }, [playing, painting, frames.length, fps]);
  const replaceDraft = () => !changed || window.confirm('Replace the unsaved animation draft?');
  const generate = () => {
    if (!replaceDraft()) return;
    try {
      setFrames(generateWater(map.palette, { main, sub, frames: count, dark, light, blocked, direction }));
      setOldKey(null); setOriginal(null); setEditingPath(''); setOverwrite(false); setFrame(0); setChanged(true); setError('');
    } catch (e) { setError(String(e)); }
  };
  // New water goes next to the level type's other libraries (its home folder: see game/ownTiles.ts).
  const folder = useMemo(() => ownTilesPath(gd, map.path, map.resolution.lvlType).replace(/^data\/global\/tiles\//i, '').replace(/\/[^/]*$/, ''), [gd, map]);
  const newPath = `data/global/tiles/${folder}/${name}.dt1`;
  const problem = overwrite ? null : customNameProblem(name, folder);
  const updateFrames = (next: Dt1Record[]) => { setFrames(next); setChanged(true); };
  return <Modal title="Animated water editor" wide onClose={close}>
    {painting && image && tiles[index] ? <PixelPainter tile={tiles[index]} tileIndex={index} image={image} palette={map.palette} onDone={edited => {
      if (edited) updateFrames(dt1Records(setTilePixels(buildDt1(frames), index, edited)));
      setPainting(false);
    }} /> : <fieldset disabled={busy} className="plain-fieldset water-editor">
      <div className="asset-columns">
        <div className="water-controls">
          <h3>Existing water / floor tiles</h3>
          <select value={path} onChange={e => setPath(e.target.value)}>{paths.map(p => <option key={p} value={p}>{p.replace(/^data\/global\/tiles\//i, '')}</option>)}</select>
          <div className="water-groups">{groups.map(g => <button className="btn small" key={g.main + '/' + g.sub} onClick={() => {
            if (!source || !replaceDraft()) return;
            if (!g.animated && (!Number.isInteger(count) || count < 2 || count > 64)) { setError('Choose 2 to 64 frames.'); return; }
            const records = dt1Records(source);
            const ordered = [...g.indices].sort((a, b) => new DataView(records[a].header.buffer).getInt32(32, true) - new DataView(records[b].header.buffer).getInt32(32, true));
            const selected = g.animated ? ordered.map(i => records[i]) : Array.from({ length: count }, () => records[g.indices[0]]);
            setFrames(animationRecords(selected, g.main, g.sub)); setMain(g.main); setSub(g.sub);
            setOldKey([g.main, g.sub]); setOriginal(source); setEditingPath(path); setOverwrite(g.animated); setFrame(0); setChanged(!g.animated); setError('');
          }}>{g.main}/{g.sub} · {g.animated ? g.indices.length + ' frames — edit' : 'new from this floor'}</button>)}</div>
          <h3>Create new water</h3>
          <div className="asset-toolbar">
            <label>Dark <input type="color" value={dark} onChange={e => setDark(e.target.value)} /></label>
            <label>Light <input type="color" value={light} onChange={e => setLight(e.target.value)} /></label>
            <label>Frames <input type="number" min={2} max={64} value={count} onChange={e => setCount(Number(e.target.value))} /></label>
            <label>Flow <select value={direction} onChange={e => setDirection(e.target.value as typeof direction)}><option value="right">Right</option><option value="left">Left</option></select></label>
            <label><input type="checkbox" checked={blocked} onChange={e => setBlocked(e.target.checked)} /> Block walking</label>
          </div>
          <button className="btn" onClick={generate}>Generate looping water</button>
          <p className="muted small">Creates palette-matched isometric water, ready to paint or refine frame by frame.</p>
        </div>
        <div className="water-preview">
          {image ? <TileZoom image={image} palette={map.palette} /> : <p className="muted">Open an animation or generate new water.</p>}
          <div className="asset-toolbar">
            <button className="btn small" disabled={!frames.length} onClick={() => setPlaying(!playing)}>{playing ? 'Pause' : 'Play'}</button>
            <label>Preview FPS <input type="number" min={1} max={30} value={fps} onChange={e => setFps(Math.max(1, Math.min(30, Number(e.target.value) || 10)))} /></label>
            <span className="muted small">Preview speed only; the game controls playback.</span>
          </div>
        </div>
      </div>
      <div className="water-timeline">{tiles.map((tile, i) => <button className={'thumb' + (i === index ? ' active' : '')} key={i} onClick={() => { setFrame(i); setPlaying(false); }}><Thumb tile={tile} palette={map.palette} /><span className="thumb-label">Frame {i + 1}</span></button>)}</div>
      <div className="asset-toolbar">
        <button className="btn small" disabled={!image} onClick={() => { setPlaying(false); setPainting(true); }}>Edit frame pixels…</button>
        <button className="btn small" disabled={!frames.length || frames.length >= 64} onClick={() => updateFrames([...frames.slice(0, index + 1), frames[index], ...frames.slice(index + 1)])}>Duplicate frame</button>
        <button className="btn small" disabled={frames.length <= 2} onClick={() => { updateFrames(frames.filter((_, i) => i !== index)); setFrame(Math.max(0, index - 1)); }}>Remove frame</button>
        <button className="btn small" disabled={index < 1} onClick={() => { const next = [...frames]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; updateFrames(next); setFrame(index - 1); }}>Move earlier</button>
        <button className="btn small" disabled={index >= frames.length - 1} onClick={() => { const next = [...frames]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; updateFrames(next); setFrame(index + 1); }}>Move later</button>
      </div>
      <div className="asset-toolbar">
        {oldKey && <label><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> Update the original water group</label>}
        {!overwrite && <label>New DT1 name <input value={name} onChange={e => setName(e.target.value)} /></label>}
        <label><input type="checkbox" checked={addToMap} onChange={e => setAddToMap(e.target.checked)} /> Add to this map</label>
      </div>
      <p className="muted small">{overwrite ? editingPath + ' — unrelated tiles stay intact; the original is backed up.' : `Saved in data/global/tiles/${folder}, next to the level’s other tile libraries. Tile numbers are assigned safely when added to the map.`}</p>
      {(error || problem) && <p className="error-text" role="alert">{error || problem}</p>}
      <div className="modal-actions"><button className="btn" onClick={close}>Close</button><button className="btn primary" disabled={!canSave || frames.length < 2 || !!problem} onClick={async () => {
        if (overwrite && !window.confirm('Update this animation in ' + editingPath + '? Every map using this tile group will see the edited animation. A backup will be kept.')) return;
        setBusy(true); setError('');
        try {
          const normalized = animationRecords(frames, main, sub);
          await onSave({ path: overwrite ? editingPath : newPath, bytes: overwrite && original && oldKey ? replaceAnimation(dt1Records(original), oldKey, normalized) : buildDt1(normalized), expected: overwrite ? original : null, addToMap });
          setChanged(false); onClose();
        } catch (e) { setError(String(e)); }
        finally { setBusy(false); }
      }}>{busy ? 'Saving…' : 'Save water animation'}</button></div>
    </fieldset>}
  </Modal>;
}
