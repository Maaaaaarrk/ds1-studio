import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { decodeTile, type Dt1Tile } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import type { Camera } from '../render/MapRenderer';
import type { Scene } from '../render/scene';

/**
 * A small overview of the whole map (bottom-left of the map view): each cell in the average colour of its floor, with
 * walls mixed in, and the part currently on screen outlined. Click or drag on it to move the view there.
 */

const MAX_W = 220;
const MAX_H = 150;

const averages = new WeakMap<Palette, WeakMap<Dt1Tile, [number, number, number] | null>>();
function average(tile: Dt1Tile, palette: Palette): [number, number, number] | null {
  let byTile = averages.get(palette);
  if (!byTile) averages.set(palette, (byTile = new WeakMap()));
  if (byTile.has(tile)) return byTile.get(tile)!;
  const img = decodeTile(tile);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const p of img?.pixels ?? []) {
    if (!p) continue;
    r += palette[p * 4];
    g += palette[p * 4 + 1];
    b += palette[p * 4 + 2];
    n++;
  }
  const out: [number, number, number] | null = n ? [r / n, g / n, b / n] : null;
  byTile.set(tile, out);
  return out;
}

export interface MinimapView {
  /** Current camera and viewport size (device pixels), read every frame. */
  camera: () => Camera;
  viewport: () => [number, number];
  /** Moves the view centre to a world point. */
  moveTo: (x: number, y: number) => void;
}

/** `drawRef` receives the redraw function; the map view calls it whenever it redraws (camera moves included). */
export function Minimap({ scene, palette, width, height, view, drawRef }: { scene: Scene; palette: Palette; width: number; height: number; view: MinimapView; drawRef: MutableRefObject<(() => void) | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Scale: iso layout is (width + height) cells across and half that down.
  const s = Math.min(MAX_W / (width + height), (MAX_H * 2) / (width + height));
  const w = Math.max(1, Math.ceil((width + height) * s));
  const h = Math.max(1, Math.ceil(((width + height) * s) / 2));
  const toMini = (wx: number, wy: number): [number, number] => [(wx * s) / 80 + height * s, (wy * s) / 80];
  const toWorld = (mx: number, my: number): [number, number] => [((mx - height * s) * 80) / s, (my * 80) / s];

  // The map image, rebuilt when the tiles change.
  const base = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const floor = new Map<number, [number, number, number]>();
    const wall = new Map<number, [number, number, number]>();
    for (const it of scene.items) {
      if (it.kind === 'special' || it.kind === 'shadow') continue;
      const col = average(it.tile, palette);
      if (!col) continue;
      const k = it.cellY * width + it.cellX;
      (it.kind === 'floor' ? floor : wall).set(k, col);
    }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const k = y * width + x;
        const f = floor.get(k);
        const wl = wall.get(k);
        const c3 = f && wl ? f.map((v, i) => v * 0.45 + wl[i] * 0.55) : (f ?? wl);
        if (!c3) continue;
        // Brighter than the game's dark tiles so the layout reads at this size.
        ctx.fillStyle = `rgb(${c3.map((v) => Math.min(255, v * 1.6 + 12)).join(',')})`;
        ctx.fillRect((x - y + height) * s - s / 2, (x + y) * (s / 2), s * 1.5, s * 0.75 + 0.5);
      }
    return c;
  }, [scene, palette, width, height, w, h, s]);

  // Redraw with the viewport outline whenever the map view redraws.
  const draw = () => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(base, 0, 0);
    const cam = view.camera();
    const [vw, vh] = view.viewport();
    const [x0, y0] = toMini(cam.x - vw / 2 / cam.zoom, cam.y - vh / 2 / cam.zoom);
    const [x1, y1] = toMini(cam.x + vw / 2 / cam.zoom, cam.y + vh / 2 / cam.zoom);
    ctx.strokeStyle = 'rgba(232, 184, 76, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.max(0.75, x0), Math.max(0.75, y0), Math.min(w - 1.5, x1) - Math.max(0.75, x0), Math.min(h - 1.5, y1) - Math.max(0.75, y0));
  };
  useEffect(() => {
    drawRef.current = draw;
    draw();
    return () => {
      if (drawRef.current === draw) drawRef.current = null;
    };
  });

  const go = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    view.moveTo(...toWorld(((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h));
  };
  return (
    <canvas
      ref={canvas}
      className="minimap"
      style={{ width: w, height: h }}
      title="Minimap: click or drag to move the view (K to hide)"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        go(e);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && go(e)}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
