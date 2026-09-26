import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dt1Tile, TileImage } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import { paintableMask } from '../formats/dt1Paint';

type PaintTool = 'pencil' | 'eraser' | 'picker' | 'fill';

interface Props {
  tile: Dt1Tile;
  tileIndex: number;
  /** The image to start from (a previous edit, or the decoded tile). */
  image: TileImage;
  palette: Palette;
  onDone: (image: TileImage | null /* null = cancelled */) => void;
}

const TOOLS: { id: PaintTool; label: string; key: string; hint: string }[] = [
  { id: 'pencil', label: 'Pencil', key: 'B', hint: 'Paint with the chosen colour (Alt+click picks a colour)' },
  { id: 'eraser', label: 'Eraser', key: 'E', hint: 'Make pixels transparent (only where the tile has see-through areas)' },
  { id: 'fill', label: 'Fill', key: 'G', hint: 'Fill the connected area of the same colour' },
  { id: 'picker', label: 'Pick colour', key: 'I', hint: 'Take the colour under the cursor' },
];

/** A thumbnail of a palette-indexed image (for edited tiles, which have no Dt1Tile to decode). */
export function ImageThumb({ image, palette }: { image: TileImage; palette: Palette }) {
  const url = useMemo(() => imageUrl(image, palette), [image, palette]);
  return <div className="thumb-img" style={{ backgroundImage: `url(${url})` }} />;
}

function imageUrl(image: TileImage, palette: Palette): string {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext('2d')!;
  const d = ctx.createImageData(image.width, image.height);
  for (let i = 0; i < image.pixels.length; i++) {
    const p = image.pixels[i];
    if (!p) continue;
    d.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], i * 4);
  }
  ctx.putImageData(d, 0, 0);
  return c.toDataURL();
}

/**
 * Pixel editor for one DT1 tile: pencil / eraser / fill / colour picker with the act palette, zoom, undo/redo. Only
 * pixels inside the tile's blocks can be painted (hatched areas are outside the tile and can't hold pixels).
 */
export function PixelPainter({ tile, tileIndex, image, palette, onDone }: Props) {
  const [pixels, setPixels] = useState<Uint8Array>(() => image.pixels.slice());
  const [tool, setTool] = useState<PaintTool>('pencil');
  const [color, setColor] = useState(() => {
    // Start with the most used colour of the tile.
    const n = new Uint32Array(256);
    for (const p of image.pixels) if (p) n[p]++;
    let best = 1;
    for (let i = 1; i < 256; i++) if (n[i] > n[best]) best = i;
    return best;
  });
  const [size, setSize] = useState(1);
  const [zoom, setZoom] = useState(() => Math.max(2, Math.min(8, Math.floor(520 / Math.max(image.width, image.height)))));
  const [grid, setGrid] = useState(true);
  const undo = useRef<Uint8Array[]>([]);
  const redo = useRef<Uint8Array[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ last: [number, number] | null } | null>(null);
  const mask = useMemo(() => paintableMask(tile), [tile]);
  // Isometric (diamond) blocks store every pixel; a 0 there would show as black in game, so no eraser on pure floors.
  const canErase = tile.blocks.some((b) => b.format !== 1);
  const { width: w, height: h } = image;
  const changed = useMemo(() => pixels.some((p, i) => p !== image.pixels[i]), [pixels, image]);
  const usedColors = useMemo(() => {
    const n = new Uint32Array(256);
    for (const p of pixels) if (p) n[p]++;
    return [...n.keys()].filter((i) => n[i]).sort((a, b) => n[b] - n[a]).slice(0, 24);
  }, [pixels]);

  // Draw: tile pixels, hatched non-paintable area, optional pixel grid.
  useEffect(() => {
    const c = canvas.current!;
    c.width = w * zoom;
    c.height = h * zoom;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const p = pixels[i];
      const o = i * 4;
      if (!mask[i]) img.data.set(((i % w) + Math.floor(i / w)) % 4 < 2 ? [34, 36, 44, 255] : [24, 26, 32, 255], o);
      else if (!p) img.data.set(((i % w >> 2) + (Math.floor(i / w) >> 2)) % 2 ? [70, 70, 78, 255] : [96, 96, 104, 255], o);
      else img.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], o);
    }
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0, w * zoom, h * zoom);
    if (grid && zoom >= 6) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        ctx.moveTo(x * zoom + 0.5, 0);
        ctx.lineTo(x * zoom + 0.5, h * zoom);
      }
      for (let y = 0; y <= h; y++) {
        ctx.moveTo(0, y * zoom + 0.5);
        ctx.lineTo(w * zoom, y * zoom + 0.5);
      }
      ctx.stroke();
    }
  }, [pixels, zoom, grid, mask, palette, w, h]);

  const snapshot = () => {
    undo.current.push(pixels.slice());
    if (undo.current.length > 80) undo.current.shift();
    redo.current = [];
  };
  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) / r.width) * w), Math.floor(((e.clientY - r.top) / r.height) * h)];
  };
  const stamp = (next: Uint8Array, x: number, y: number, value: number) => {
    const r = Math.floor((size - 1) / 2);
    for (let dy = -r; dy < size - r; dy++)
      for (let dx = -r; dx < size - r; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const i = py * w + px;
        if (mask[i]) next[i] = value;
      }
  };
  const line = (next: Uint8Array, a: [number, number], b: [number, number], value: number) => {
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
    for (let k = 0; k <= n; k++) stamp(next, Math.round(a[0] + ((b[0] - a[0]) * k) / n), Math.round(a[1] + ((b[1] - a[1]) * k) / n), value);
  };
  const fill = (x: number, y: number, value: number) => {
    const start = y * w + x;
    if (!mask[start] || pixels[start] === value) return;
    const from = pixels[start];
    const next = pixels.slice();
    const stack = [start];
    while (stack.length) {
      const i = stack.pop()!;
      if (!mask[i] || next[i] !== from) continue;
      next[i] = value;
      const px = i % w;
      if (px > 0) stack.push(i - 1);
      if (px < w - 1) stack.push(i + 1);
      if (i >= w) stack.push(i - w);
      if (i + w < w * h) stack.push(i + w);
    }
    snapshot();
    setPixels(next);
  };

  const down = (e: React.PointerEvent) => {
    const [x, y] = at(e);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    if (tool === 'picker' || e.altKey) {
      const p = pixels[y * w + x];
      if (p) setColor(p);
      return;
    }
    if (tool === 'fill') return fill(x, y, color);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    snapshot();
    const next = pixels.slice();
    stamp(next, x, y, tool === 'eraser' ? 0 : color);
    setPixels(next);
    drawing.current = { last: [x, y] };
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const p = at(e);
    const next = pixels.slice();
    line(next, drawing.current.last ?? p, p, tool === 'eraser' ? 0 : color);
    drawing.current.last = p;
    setPixels(next);
  };
  const up = () => {
    drawing.current = null;
  };

  const doUndo = () => {
    const prev = undo.current.pop();
    if (!prev) return;
    redo.current.push(pixels.slice());
    setPixels(prev);
  };
  const doRedo = () => {
    const next = redo.current.pop();
    if (!next) return;
    undo.current.push(pixels.slice());
    setPixels(next);
  };

  // Keys while painting (the editor window stops them reaching the map).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') (e.shiftKey ? doRedo : doUndo)();
      else if ((e.ctrlKey || e.metaKey) && k === 'y') doRedo();
      else if (!e.ctrlKey && TOOLS.some((t) => t.key.toLowerCase() === k && (canErase || t.id !== 'eraser'))) setTool(TOOLS.find((t) => t.key.toLowerCase() === k)!.id);
      else if (k === '[') setSize((s) => Math.max(1, s - 1));
      else if (k === ']') setSize((s) => Math.min(8, s + 1));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const swatch = (i: number) => `rgb(${palette[i * 4]},${palette[i * 4 + 1]},${palette[i * 4 + 2]})`;
  return (
    <div className="pp">
      <div className="pp-toolbar">
        <span className="small">
          Painting tile <b>#{tileIndex}</b> · {tile.mainIndex}/{tile.subIndex} · {w}×{h}
        </span>
        <div className="chips">
          {TOOLS.filter((t) => canErase || t.id !== 'eraser').map((t) => (
            <button key={t.id} className={`chip${tool === t.id ? ' active' : ''}`} title={`${t.hint} (${t.key})`} onClick={() => setTool(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <label className="small">
          Size <input type="range" min={1} max={8} value={size} onChange={(e) => setSize(Number(e.target.value))} /> {size}
        </label>
        <label className="small">
          Zoom <input type="range" min={1} max={16} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /> {zoom}×
        </label>
        <label className="small">
          <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> grid
        </label>
        <button className="btn small" onClick={doUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button className="btn small" onClick={doRedo} title="Redo (Ctrl+Y)">
          Redo
        </button>
      </div>
      <div className="pp-body">
        <div
          className="pp-canvas-wrap"
          onWheel={(e) => {
            if (!e.ctrlKey) return;
            setZoom((z) => Math.max(1, Math.min(16, z + (e.deltaY < 0 ? 1 : -1))));
          }}
        >
          <canvas
            ref={canvas}
            className={`pp-canvas tool-${tool}`}
            style={{ width: w * zoom, height: h * zoom }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
        </div>
        <div className="pp-side">
          <div className="pp-current">
            <span className="pp-swatch big" style={{ background: swatch(color) }} />
            <span className="small mono">
              index {color}
              <br />
              rgb {palette[color * 4]},{palette[color * 4 + 1]},{palette[color * 4 + 2]}
            </span>
          </div>
          <div className="field-label">In this tile</div>
          <div className="pp-palette">
            {usedColors.map((i) => (
              <button key={i} className={`pp-swatch${i === color ? ' active' : ''}`} style={{ background: swatch(i) }} title={`#${i}`} onClick={() => setColor(i)} />
            ))}
          </div>
          <div className="field-label">Act palette</div>
          <div className="pp-palette all">
            {Array.from({ length: 255 }, (_, k) => k + 1).map((i) => (
              <button key={i} className={`pp-swatch${i === color ? ' active' : ''}`} style={{ background: swatch(i) }} title={`#${i}`} onClick={() => setColor(i)} />
            ))}
          </div>
          <p className="muted small">
            Hatched areas are outside the tile&apos;s blocks and can&apos;t hold pixels. Floor tiles (diamonds) have no see-through pixels, so the eraser only works on
            walls, trees and other shaped tiles. B/E/G/I switch tools, [ and ] change the size, Alt+click picks a colour.
          </p>
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button className="btn" disabled={!changed} onClick={() => setPixels(image.pixels.slice())}>
          Undo all changes
        </button>
        <button className="btn primary" onClick={() => onDone(changed ? { ...image, pixels } : null)}>
          Done
        </button>
      </div>
    </div>
  );
}
