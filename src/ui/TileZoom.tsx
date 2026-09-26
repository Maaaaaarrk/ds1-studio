import { useEffect, useRef, useState } from 'react';
import type { TileImage } from '../formats/dt1';
import type { Palette } from '../formats/palette';

interface Props {
  image: TileImage;
  palette: Palette;
}

/**
 * A close-up of one tile that fills its container: mouse wheel zooms around the cursor, drag pans, and a pixel grid
 * appears when zoomed in far enough. Pixels are drawn crisp (no smoothing), exactly as stored.
 */
export function TileZoom({ image, palette }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 300 });
  const [view, setView] = useState<{ zoom: number; x: number; y: number } | null>(null); // x/y = image px at the centre
  const [grid, setGrid] = useState(true);
  const [bg, setBg] = useState<'checker' | 'black' | 'grey'>('checker');
  const pan = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // The tile as an image once per change; drawing then only scales it.
  const bitmap = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext('2d')!;
    const d = ctx.createImageData(image.width, image.height);
    for (let i = 0; i < image.pixels.length; i++) {
      const p = image.pixels[i];
      if (p) d.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], i * 4);
    }
    ctx.putImageData(d, 0, 0);
    bitmap.current = c;
  }, [image, palette]);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitZoom = Math.max(0.25, Math.min(size.w / (image.width + 8), size.h / (image.height + 8)));
  const v = view ?? { zoom: fitZoom, x: image.width / 2, y: image.height / 2 };
  // A new tile starts fitted.
  useEffect(() => setView(null), [image.width, image.height, image.offsetX, image.offsetY]);

  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg === 'black' ? '#000' : bg === 'grey' ? '#6b6b73' : '#1a1b21';
    ctx.fillRect(0, 0, size.w, size.h);
    const left = size.w / 2 - v.x * v.zoom;
    const top = size.h / 2 - v.y * v.zoom;
    if (bg === 'checker') {
      // Checkerboard under the tile's box shows which pixels are transparent.
      const cell = Math.max(4, v.zoom * 4);
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, image.width * v.zoom, image.height * v.zoom);
      ctx.clip();
      for (let yy = 0; yy * cell < image.height * v.zoom; yy++)
        for (let xx = 0; xx * cell < image.width * v.zoom; xx++) {
          ctx.fillStyle = (xx + yy) % 2 ? '#2b2c34' : '#3a3b44';
          ctx.fillRect(left + xx * cell, top + yy * cell, cell, cell);
        }
      ctx.restore();
    }
    if (bitmap.current) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bitmap.current, left, top, image.width * v.zoom, image.height * v.zoom);
    }
    if (grid && v.zoom >= 8) {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= image.width; x++) {
        const sx = Math.round(left + x * v.zoom) + 0.5;
        if (sx < 0 || sx > size.w) continue;
        ctx.moveTo(sx, Math.max(0, top));
        ctx.lineTo(sx, Math.min(size.h, top + image.height * v.zoom));
      }
      for (let y = 0; y <= image.height; y++) {
        const sy = Math.round(top + y * v.zoom) + 0.5;
        if (sy < 0 || sy > size.h) continue;
        ctx.moveTo(Math.max(0, left), sy);
        ctx.lineTo(Math.min(size.w, left + image.width * v.zoom), sy);
      }
      ctx.stroke();
    }
  }, [size, v.zoom, v.x, v.y, grid, bg, image, palette]);

  const zoomTo = (zoom: number, at?: { sx: number; sy: number }) => {
    const z = Math.max(0.25, Math.min(64, zoom));
    const sx = at?.sx ?? size.w / 2;
    const sy = at?.sy ?? size.h / 2;
    // Keep the image pixel under the cursor where it is.
    const ix = v.x + (sx - size.w / 2) / v.zoom;
    const iy = v.y + (sy - size.h / 2) / v.zoom;
    setView({ zoom: z, x: ix - (sx - size.w / 2) / z, y: iy - (sy - size.h / 2) / z });
  };

  // Native wheel listener so the page and the modal don't scroll.
  const latest = useRef({ v, zoomTo });
  latest.current = { v, zoomTo };
  useEffect(() => {
    const el = wrap.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      latest.current.zoomTo(latest.current.v.zoom * Math.exp(-e.deltaY * 0.0025), { sx: e.clientX - r.left, sy: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="tz">
      <div className="tz-bar">
        <button className="btn small" onClick={() => setView(null)} title="Fit the tile to the window">
          Fit
        </button>
        {[1, 2, 4, 8, 16].map((z) => (
          <button key={z} className={`btn small${Math.abs(v.zoom - z) < 0.01 ? ' active' : ''}`} onClick={() => zoomTo(z)}>
            {z === 1 ? '1:1' : `${z}×`}
          </button>
        ))}
        <span className="muted small">{Math.round(v.zoom * 100)}%</span>
        <label className="small">
          <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> grid
        </label>
        <select className="small" value={bg} onChange={(e) => setBg(e.target.value as typeof bg)} title="Background behind transparent pixels">
          <option value="checker">checker</option>
          <option value="black">black</option>
          <option value="grey">grey</option>
        </select>
      </div>
      <div
        ref={wrap}
        className="tz-view"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          pan.current = { px: e.clientX, py: e.clientY, x: v.x, y: v.y };
        }}
        onPointerMove={(e) => {
          const p = pan.current;
          if (!p) return;
          setView({ zoom: v.zoom, x: p.x - (e.clientX - p.px) / v.zoom, y: p.y - (e.clientY - p.py) / v.zoom });
        }}
        onPointerUp={() => (pan.current = null)}
        onPointerCancel={() => (pan.current = null)}
        title="Wheel to zoom · drag to pan"
      >
        <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
      </div>
    </div>
  );
}
