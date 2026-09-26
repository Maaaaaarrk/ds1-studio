import { useEffect, useMemo, useState } from 'react';
import { isEmptyCell, type WallCell } from '../formats/ds1';
import { decodeTile, Orientation, type Dt1, type TileImage } from '../formats/dt1';
import { setManyTilePixels } from '../formats/dt1Paint';
import { ImageThumb, PixelPainter } from './PixelPainter';
import { FloatingWindow } from './FloatingWindow';
import { TileZoom } from './TileZoom';
import type { Palette } from '../formats/palette';
import { hueRemap, recolorDt1, swapRemap } from '../formats/dt1Edit';
import type { GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import { presetToClipboard, type Preset } from '../game/presets';
import type { CellRect } from '../game/clipboard';
import { normalizePath } from '../vfs/vfs';
import { ORIENTATION_NAMES } from './state';
import { Thumb } from './TilePalette';

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

export interface Dt1EditResult {
  /** Where the edited DT1 goes (a new name, or the original to overwrite it). */
  path: string;
  bytes: Uint8Array;
  /** Replace the original with the new DT1 in this map's tile libraries. */
  switchMap: boolean;
  original: string;
}

interface Props {
  map: OpenMap;
  gd: GameData;
  /** Saved + suggested presets (their tiles can be selected in one go). */
  presets: Preset[];
  /** The map selection, to select the tiles used there. */
  selection: CellRect | null;
  canSave: boolean;
  onSave: (r: Dt1EditResult) => Promise<void>;
  onClose: () => void;
}

interface Adjust {
  hue: number;
  saturation: number;
  brightness: number;
  tint: string;
  tintAmount: number;
  swapFrom: string;
  swapTo: string;
  swapTolerance: number;
  swapOn: boolean;
}

const NO_ADJUST: Adjust = { hue: 0, saturation: 1, brightness: 1, tint: '#ff8040', tintAmount: 0, swapFrom: '#808080', swapTo: '#4060c0', swapTolerance: 40, swapOn: false };

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Palette whose entry i shows the colour index remap[i] has: drawing with it previews a remap without touching the DT1. */
function remappedPalette(palette: Palette, remap: Uint8Array): Palette {
  const out = new Uint8Array(palette.length);
  for (let i = 0; i < 256; i++) out.set(palette.subarray(remap[i] * 4, remap[i] * 4 + 4), i * 4);
  return out;
}

/**
 * Duplicate / rename / recolour a DT1. Pick tiles one by one, by preset, or from the map selection; adjust hue,
 * saturation, brightness, tint or swap a colour; the preview shows exactly what gets written (colours are snapped to
 * the act palette, since DT1s store palette indices).
 */
export function Dt1Editor({ map, gd, presets, selection, canSave, onSave, onClose }: Props) {
  const libs = useMemo(() => map.lib.loaded.filter((l) => l.found && !l.path.startsWith('winds1/')).map((l) => l.path), [map]);
  const [path, setPath] = useState(libs[0] ?? '');
  const [dt1, setDt1] = useState<Dt1 | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [adjust, setAdjust] = useState<Adjust>(NO_ADJUST);
  const [name, setName] = useState('');
  const [switchMap, setSwitchMap] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(64);
  /** Pixel edits per tile index, applied (before any recolour) when saving. */
  const [edits, setEdits] = useState<Map<number, TileImage>>(new Map());
  const [painting, setPainting] = useState<number | null>(null);
  /** The tile shown in the zoom window (the last one clicked). */
  const [zoomed, setZoomed] = useState<number | null>(null);

  useEffect(() => {
    setDt1(null);
    setPicked(new Set());
    setEdits(new Map());
    setPainting(null);
    setZoomed(null);
    if (!path) return;
    void gd.dt1(path).then(setDt1);
    setName(path.split('/').pop()!.replace(/\.dt1$/i, '') + '_edit');
  }, [path, gd]);

  const remap = useMemo(() => {
    let r = hueRemap(map.palette, {
      hue: adjust.hue,
      saturation: adjust.saturation,
      brightness: adjust.brightness,
      tint: rgb(adjust.tint),
      tintAmount: adjust.tintAmount,
    });
    if (adjust.swapOn) {
      const s = swapRemap(map.palette, rgb(adjust.swapFrom), rgb(adjust.swapTo), adjust.swapTolerance);
      r = r.map((v) => s[v]);
    }
    return r;
  }, [map.palette, adjust]);
  const previewPal = useMemo(() => remappedPalette(map.palette, remap), [map.palette, remap]);
  const changes = remap.some((v, i) => v !== i);

  // Tiles of this DT1 matching a set of (orientation, main, sub) keys.
  const tilesMatching = (keys: Set<string>) => {
    const out = new Set<number>();
    dt1?.tiles.forEach((t, i) => keys.has(`${t.orientation}|${t.mainIndex}|${t.subIndex}`) && out.add(i));
    return out;
  };
  const keysOfCells = (cells: { kind: string; cell: { mainIndex: number; subIndex: number; prop1: number } & Partial<WallCell> }[]) => {
    const keys = new Set<string>();
    for (const { kind, cell } of cells) {
      if (isEmptyCell(cell as never)) continue;
      const o = kind === 'floor' ? Orientation.Floor : kind === 'shadow' ? Orientation.Shadow : (cell.orientation ?? 0);
      keys.add(`${o}|${cell.mainIndex}|${cell.subIndex}`);
      if (o === Orientation.RightPartOfNorthCornerWall) keys.add(`${Orientation.LeftPartOfNorthCornerWall}|${cell.mainIndex}|${cell.subIndex}`);
    }
    return keys;
  };
  const presetTiles = useMemo(() => {
    if (!dt1) return [];
    return presets
      .map((p) => {
        const clip = presetToClipboard(p);
        const keys = keysOfCells(clip.layers.flatMap((l) => l.cells.map((cell) => ({ kind: l.layer.kind, cell }))));
        return { preset: p, tiles: tilesMatching(keys) };
      })
      .filter((x) => x.tiles.size > 0);
  }, [presets, dt1]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectionTiles = () => {
    if (!selection) return new Set<number>();
    const cells = [];
    for (let y = selection.y0; y <= selection.y1; y++)
      for (let x = selection.x0; x <= selection.x1; x++) {
        const i = y * map.ds1.width + x;
        for (const f of map.ds1.floors) cells.push({ kind: 'floor', cell: f[i] });
        for (const w of map.ds1.walls) cells.push({ kind: 'wall', cell: w[i] });
      }
    return tilesMatching(keysOfCells(cells));
  };

  const toggle = (i: number, range: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && prev.size) {
        const last = [...prev].pop()!;
        for (let k = Math.min(last, i); k <= Math.max(last, i); k++) next.add(k);
      } else if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const dir = path.replace(/[^/]+$/, '');
  const newPath = `${dir}${name.replace(/\.dt1$/i, '')}.dt1`;
  const overwrite = normalizePath(newPath) === normalizePath(path);
  const exists = !overwrite && !!gd.fs.locate(newPath);
  const validName = /^[\w\- .]+$/.test(name);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const bytes = await gd.fs.read(path);
      if (!bytes) throw new Error(`${path} not found`);
      const painted = edits.size ? setManyTilePixels(bytes, [...edits].map(([tileIndex, image]) => ({ tileIndex, image }))) : bytes;
      const out = changes ? recolorDt1(painted, remap, picked.size ? [...picked] : undefined) : painted;
      await onSave({ path: newPath, bytes: out, switchMap: switchMap && !overwrite, original: path });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof Adjust>(k: K, v: Adjust[K]) => setAdjust((a) => ({ ...a, [k]: v }));
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dt1-editor" role="dialog" aria-label="DT1 editor" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-title">DT1 editor</div>
        <div className="dte-top">
          <label className="small">
            Tile library{' '}
            <select value={path} onChange={(e) => setPath(e.target.value)}>
              {libs.map((p) => (
                <option key={p} value={p}>
                  {short(p)}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small">{dt1 ? `${dt1.tiles.length} tiles · ${picked.size ? `${picked.size} selected` : 'none selected = whole DT1'}` : 'loading…'}</span>
          <button className="btn small" onClick={() => setPicked(new Set(dt1?.tiles.map((_, i) => i)))}>
            Select all
          </button>
          <button className="btn small" onClick={() => setPicked(new Set())}>
            Clear
          </button>
          <button className="btn small" disabled={picked.size !== 1} onClick={() => setPainting([...picked][0])} title="Paint the selected tile pixel by pixel (or double-click a tile)">
            Paint pixels…
          </button>
          {edits.size > 0 && (
            <span className="small accent-text">
              {edits.size} tile{edits.size === 1 ? '' : 's'} painted{' '}
              <button className="link" onClick={() => setEdits(new Map())}>
                discard
              </button>
            </span>
          )}
          <button className="btn small" disabled={!selection} onClick={() => setPicked(selectionTiles())} title="Select the tiles of this DT1 used in the map selection">
            From map selection
          </button>
          <select
            className="small"
            value=""
            onChange={(e) => {
              const p = presetTiles.find((x) => x.preset.id === e.target.value);
              if (p) setPicked(new Set(p.tiles));
            }}
            title="Select the tiles a preset is built from"
          >
            <option value="">From preset… ({presetTiles.length})</option>
            {presetTiles.map((x) => (
              <option key={x.preset.id} value={x.preset.id}>
                {x.preset.name} ({x.tiles.size} tiles)
              </option>
            ))}
          </select>
        </div>
        {painting !== null && dt1 && (
          <PixelPainter
            key={painting}
            tile={dt1.tiles[painting]}
            tileIndex={painting}
            image={edits.get(painting) ?? decodeTile(dt1.tiles[painting])!}
            palette={map.palette}
            onDone={(img) => {
              if (img) setEdits((m) => new Map(m).set(painting, img));
              setPainting(null);
            }}
          />
        )}
        <div className="dte-body" hidden={painting !== null}>
          <div
            className="thumb-grid dte-grid"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 14}px, 1fr))`, ['--thumb-h' as string]: `${size}px` }}
            onWheel={(e) => e.ctrlKey && setSize((v) => Math.round(Math.min(200, Math.max(36, v * Math.exp(-e.deltaY * 0.0015)))))}
            title="Click to select tiles (Shift+click for a range) · Ctrl + scroll to zoom"
          >
            {dt1?.tiles.map((t, i) => {
              const affected = changes && (picked.size === 0 || picked.has(i));
              const edited = edits.get(i);
              return (
                <div
                  key={i}
                  className={`thumb${picked.has(i) ? ' active' : ''}${edited ? ' edited' : ''}`}
                  title={`#${i} · ${ORIENTATION_NAMES[t.orientation] ?? `o${t.orientation}`} · ${t.mainIndex}/${t.subIndex}${edited ? ' · painted' : ''} · double-click to paint`}
                  onClick={(e) => {
                    toggle(i, e.shiftKey);
                    setZoomed(i);
                  }}
                  onDoubleClick={() => t.blocks.length && setPainting(i)}
                >
                  {edited ? <ImageThumb image={edited} palette={affected ? previewPal : map.palette} /> : <Thumb tile={t} palette={affected ? previewPal : map.palette} />}
                  <span className="thumb-label">
                    {t.mainIndex}/{t.subIndex}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="dte-side">
            <div className="field-label">Colour</div>
            <label className="dte-slider">
              Hue <input type="range" min={-180} max={180} value={adjust.hue} onChange={(e) => set('hue', Number(e.target.value))} /> <span>{adjust.hue}°</span>
            </label>
            <label className="dte-slider">
              Saturation <input type="range" min={0} max={200} value={Math.round(adjust.saturation * 100)} onChange={(e) => set('saturation', Number(e.target.value) / 100)} />{' '}
              <span>{Math.round(adjust.saturation * 100)}%</span>
            </label>
            <label className="dte-slider">
              Brightness <input type="range" min={20} max={200} value={Math.round(adjust.brightness * 100)} onChange={(e) => set('brightness', Number(e.target.value) / 100)} />{' '}
              <span>{Math.round(adjust.brightness * 100)}%</span>
            </label>
            <label className="dte-slider">
              Tint <input type="color" value={adjust.tint} onChange={(e) => set('tint', e.target.value)} />
              <input type="range" min={0} max={100} value={Math.round(adjust.tintAmount * 100)} onChange={(e) => set('tintAmount', Number(e.target.value) / 100)} />{' '}
              <span>{Math.round(adjust.tintAmount * 100)}%</span>
            </label>
            <label className="small">
              <input type="checkbox" checked={adjust.swapOn} onChange={(e) => set('swapOn', e.target.checked)} /> Replace a colour
            </label>
            {adjust.swapOn && (
              <label className="dte-slider">
                <input type="color" value={adjust.swapFrom} onChange={(e) => set('swapFrom', e.target.value)} /> →{' '}
                <input type="color" value={adjust.swapTo} onChange={(e) => set('swapTo', e.target.value)} /> range
                <input type="range" min={5} max={160} value={adjust.swapTolerance} onChange={(e) => set('swapTolerance', Number(e.target.value))} />
              </label>
            )}
            <button className="btn small" onClick={() => setAdjust(NO_ADJUST)} disabled={!changes && !adjust.swapOn}>
              Reset colours
            </button>
            <p className="muted small">
              DT1s store colours as palette indices, so every colour is snapped to the nearest one in the act palette; the preview shows exactly what will be
              written. Tile shapes, walkability flags and indices stay the same.
            </p>
            <div className="field-label">Save as</div>
            <div className="dte-name">
              <span className="muted small mono">{short(dir)}</span>
              <input className="small-input" value={name} onChange={(e) => setName(e.target.value)} />
              <span className="muted small">.dt1</span>
            </div>
            {overwrite && <p className="small warn-text">Overwrites the original (kept as .bak).</p>}
            {exists && <p className="small warn-text">A DT1 with that name already exists and will be replaced.</p>}
            {!overwrite && (
              <label className="small">
                <input type="checkbox" checked={switchMap} onChange={(e) => setSwitchMap(e.target.checked)} /> Use it in this map instead of {short(path).split('/').pop()}
              </label>
            )}
            <p className="muted small">
              A copy keeps the same tile indices, so the map&apos;s tiles use it as soon as it replaces the original. Loading both at once makes the game pick
              between them at random.
            </p>
            {error && <p className="small error-text">{error}</p>}
          </div>
        </div>
        {zoomed !== null && painting === null && dt1?.tiles[zoomed] && (
          <FloatingWindow
            title={
              <>
                Tile #{zoomed} · {dt1.tiles[zoomed].mainIndex}/{dt1.tiles[zoomed].subIndex}
                {edits.has(zoomed) ? ' · painted' : ''}
                {changes && (picked.size === 0 || picked.has(zoomed)) ? ' · recolour preview' : ''}
              </>
            }
            storageKey="dt1-zoom"
            initial={{ x: Math.max(16, window.innerWidth - 520), y: 90, w: 480, h: 520 }}
            onClose={() => setZoomed(null)}
          >
            <TileZoom
              image={edits.get(zoomed) ?? decodeTile(dt1.tiles[zoomed]) ?? { width: 1, height: 1, offsetX: 0, offsetY: 0, pixels: new Uint8Array(1) }}
              palette={changes && (picked.size === 0 || picked.has(zoomed)) ? previewPal : map.palette}
            />
          </FloatingWindow>
        )}
        <div className="modal-actions" hidden={painting !== null}>
          <button className="btn" onClick={() => (!edits.size || window.confirm('Discard the painted tiles?')) && onClose()}>
            Close
          </button>
          <button className="btn primary" disabled={!canSave || !dt1 || busy || !validName} onClick={() => void save()} title={canSave ? '' : 'No writable mod folder'}>
            {busy ? 'Saving…' : overwrite ? 'Save (overwrite)' : changes || edits.size ? 'Save edited copy' : 'Save copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
