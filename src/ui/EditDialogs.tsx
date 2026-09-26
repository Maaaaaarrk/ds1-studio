import { useMemo, useState } from 'react';
import type { Palette } from '../formats/palette';
import type { CellRect } from '../game/clipboard';
import { findTile, keyText, replaceEdits, type TileKey } from '../game/editTools';
import type { TileLibrary } from '../game/GameData';
import { layerLabel, type CellEdit, type LayerRef, type MapDocument } from '../game/MapDocument';
import { exportSize, MAX_PIXELS, MAX_SIDE } from '../render/exportImage';
import { Modal } from './Dialogs';
import { HelpTip } from './HelpTip';
import { Thumb } from './TilePalette';

// ---------------------------------------------------------------------------------------------------------------
// Find & replace

function TileField({ label, value, onChange, lib, palette, wall, onUseBrush }: { label: string; value: TileKey; onChange: (k: TileKey) => void; lib: TileLibrary; palette: Palette; wall: boolean; onUseBrush?: () => void }) {
  const tile = lib.pick(value.orientation, value.main, value.sub, 0);
  const num = (field: keyof TileKey, max: number) => (
    <input
      className="num-field mono"
      type="number"
      min={0}
      max={max}
      value={value[field]}
      onChange={(e) => onChange({ ...value, [field]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
  return (
    <div className="rp-tile">
      <div className="field-label">{label}</div>
      <div className="rp-tile-row">
        <div className="rp-thumb">{tile ? <Thumb tile={tile} palette={palette} /> : <span className="muted small">not in this map&apos;s DT1s</span>}</div>
        <div className="rp-nums">
          <label>
            main {num('main', 63)}
          </label>
          <label>
            sub {num('sub', 255)}
          </label>
          {wall && (
            <label title="Wall orientation (1-9 walls, 10/11 special, 12 pillar, 14 tree, 15 roof, 16-19 lower walls)">
              orient. {num('orientation', 19)}
            </label>
          )}
          {onUseBrush && (
            <button className="btn small" onClick={onUseBrush}>
              Use brush
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ReplaceProps {
  doc: MapDocument;
  lib: TileLibrary;
  palette: Palette;
  activeLayer: LayerRef;
  selection: CellRect | null;
  from: TileKey | null;
  brush: TileKey | null;
  onApply: (edits: CellEdit[], label: string) => void;
  onShow: (cells: { x: number; y: number }[]) => void;
  onClose: () => void;
}

export function ReplaceDialog({ doc, lib, palette, activeLayer, selection, from: initialFrom, brush, onApply, onShow, onClose }: ReplaceProps) {
  const orient = activeLayer.kind === 'floor' ? 0 : activeLayer.kind === 'shadow' ? 13 : 1;
  const [from, setFrom] = useState<TileKey>(initialFrom ?? { orientation: orient, main: 0, sub: 0 });
  const [to, setTo] = useState<TileKey>(brush ?? { orientation: orient, main: 0, sub: 1 });
  const [layers, setLayers] = useState<'active' | 'kind'>('kind');
  const [area, setArea] = useState<'map' | 'selection'>(selection ? 'selection' : 'map');
  const targets = layers === 'active' ? [activeLayer] : doc.layers().filter((l) => l.kind === activeLayer.kind);
  const within = area === 'selection' ? selection : null;
  const found = useMemo(() => findTile(doc, targets, from, within), [doc, doc.revision, from, layers, area, activeLayer]); // eslint-disable-line react-hooks/exhaustive-deps
  const wall = activeLayer.kind === 'wall';
  const kindName = activeLayer.kind === 'floor' ? 'floor' : activeLayer.kind === 'wall' ? 'wall' : 'shadow';
  return (
    <Modal title="Find & replace tiles" onClose={onClose}>
      <p className="muted small">
        Swaps every use of one tile for another. It works on {kindName} layers (switch the active layer for another kind) and is one step to undo.
      </p>
      <div className="rp-pair">
        <TileField label="Find" value={from} onChange={setFrom} lib={lib} palette={palette} wall={wall} onUseBrush={brush ? () => setFrom(brush) : undefined} />
        <div className="rp-arrow">→</div>
        <TileField label="Replace with" value={to} onChange={setTo} lib={lib} palette={palette} wall={wall} onUseBrush={brush ? () => setTo(brush) : undefined} />
      </div>
      <div className="rp-options">
        <label>
          <input type="radio" checked={layers === 'kind'} onChange={() => setLayers('kind')} /> every {kindName} layer
        </label>
        <label>
          <input type="radio" checked={layers === 'active'} onChange={() => setLayers('active')} /> only {layerLabel(activeLayer)}
        </label>
        <span className="rp-sep" />
        <label>
          <input type="radio" checked={area === 'map'} onChange={() => setArea('map')} /> whole map
        </label>
        <label className={selection ? '' : 'muted'}>
          <input type="radio" disabled={!selection} checked={area === 'selection'} onChange={() => setArea('selection')} /> selection only
        </label>
      </div>
      <p className="small">
        <b>{found.length}</b> cell{found.length === 1 ? '' : 's'} use {keyText(from)}.{' '}
        {found.length > 0 && (
          <button className="link" onClick={() => onShow(found.map(({ x, y }) => ({ x, y })))}>
            Show them on the map
          </button>
        )}
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button
          className="btn primary"
          disabled={!found.length || keyText(from) + from.orientation === keyText(to) + to.orientation}
          onClick={() => onApply(replaceEdits(doc, targets, from, to, within), `Replace ${keyText(from)} → ${keyText(to)}`)}
        >
          Replace {found.length || ''}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Export image

interface ExportImageProps {
  width: number;
  height: number;
  selection: CellRect | null;
  busy: boolean;
  onExport: (o: { area: CellRect | null; scale: number; objects: boolean }) => void;
  onClose: () => void;
}

const SCALES = [1, 0.5, 0.25, 0.125];

export function ExportImageDialog({ width, height, selection, busy, onExport, onClose }: ExportImageProps) {
  const [area, setArea] = useState<'map' | 'selection'>(selection ? 'selection' : 'map');
  const rect = area === 'selection' && selection ? selection : { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  const fits = (s: number) => {
    const [w, h] = exportSize(rect, s);
    return w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS;
  };
  const [scale, setScale] = useState(() => SCALES.find(fits) ?? 0.125);
  const [objects, setObjects] = useState(true);
  const chosen = fits(scale) ? scale : (SCALES.find(fits) ?? 0.125);
  const [w, h] = exportSize(rect, chosen);
  return (
    <Modal title="Export image" onClose={onClose}>
      <p className="muted small">
        Saves the map as a PNG, drawn with the layers currently shown. <HelpTip text="Tiles and object sprites are drawn solid and shadows as translucent black; glows and fog are left out. Special-tile markers and overlays (grid, walkability…) aren't included." />
      </p>
      <div className="rp-options">
        <label>
          <input type="radio" checked={area === 'map'} onChange={() => setArea('map')} /> whole map
        </label>
        <label className={selection ? '' : 'muted'}>
          <input type="radio" disabled={!selection} checked={area === 'selection'} onChange={() => setArea('selection')} /> selection only
        </label>
      </div>
      <div className="rp-options">
        <span className="muted small">Size</span>
        {SCALES.map((s) => (
          <label key={s} className={fits(s) ? '' : 'muted'} title={fits(s) ? '' : 'Too large for one image: pick a smaller size or the selection'}>
            <input type="radio" disabled={!fits(s)} checked={chosen === s} onChange={() => setScale(s)} /> {s * 100}%
          </label>
        ))}
      </div>
      <label className="small">
        <input type="checkbox" checked={objects} onChange={(e) => setObjects(e.target.checked)} /> include objects and NPCs
      </label>
      <p className="small">
        {w.toLocaleString()} × {h.toLocaleString()} pixels
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={() => onExport({ area: area === 'selection' ? selection : null, scale: chosen, objects })}>
          {busy ? 'Drawing…' : 'Export PNG…'}
        </button>
      </div>
    </Modal>
  );
}
