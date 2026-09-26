import { useEffect, useRef } from 'react';
import { Orientation } from '../formats/dt1';
import type { OpenMap } from '../game/openMap';
import { TileAtlas } from '../render/atlas';
import { InstanceFlag, MapRenderer, type Camera, type Instance } from '../render/MapRenderer';
import { cellToWorld, subTileToWorld, worldToCell, type DrawItem } from '../render/scene';
import type { Visibility } from './state';

export interface HoverInfo {
  cellX: number;
  cellY: number;
}

interface Props {
  map: OpenMap;
  visibility: Visibility;
  hover: HoverInfo | null;
  onHover: (h: HoverInfo | null) => void;
  onZoom: (zoom: number) => void;
  /** Bumped by the parent to request "fit map to view". */
  fitSignal: number;
}

const BACKGROUND: [number, number, number] = [0.043, 0.047, 0.059];

function isVisible(it: DrawItem, v: Visibility): boolean {
  switch (it.kind) {
    case 'floor':
      return v.floors[it.layer] ?? true;
    case 'shadow':
      return v.shadows;
    case 'lowerWall':
      return v.lowerWalls && (v.walls[it.layer] ?? true);
    case 'wall':
      return v.walls[it.layer] ?? true;
    case 'roof':
      return v.roofs && (v.walls[it.layer] ?? true);
  }
}

export function MapView({ map, visibility, hover, onHover, onZoom, fitSignal }: Props) {
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const atlas = useRef(new TileAtlas());
  const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const dirty = useRef(true);
  const latest = useRef({ map, visibility, hover });
  latest.current = { map, visibility, hover };

  // One renderer per canvas.
  useEffect(() => {
    renderer.current = new MapRenderer(glCanvas.current!);
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dpr = window.devicePixelRatio || 1;
      for (const c of [glCanvas.current!, overlay.current!]) {
        const w = Math.round(c.clientWidth * dpr);
        const h = Math.round(c.clientHeight * dpr);
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
          dirty.current = true;
        }
      }
      if (!dirty.current) return;
      dirty.current = false;
      renderer.current!.draw(camera.current, BACKGROUND);
      drawOverlay(overlay.current!, camera.current, latest.current);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, []);

  const fit = () => {
    const c = glCanvas.current!;
    const { minX, minY, maxX, maxY } = map.scene.bounds;
    const dpr = window.devicePixelRatio || 1;
    const zoom = Math.min((c.clientWidth * dpr) / (maxX - minX + 160), (c.clientHeight * dpr) / (maxY - minY + 240), 2 * dpr);
    camera.current = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
    onZoom(zoom / dpr);
    dirty.current = true;
  };

  // New map: fresh atlas + palette, fit to view.
  useEffect(() => {
    atlas.current = new TileAtlas();
    renderer.current!.setPalette(map.palette);
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  useEffect(() => {
    if (fitSignal) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal]);

  // Rebuild instances when the map, layer visibility or hover changes.
  useEffect(() => {
    const instances: Instance[] = [];
    const a = atlas.current;
    for (const it of map.scene.items) {
      if (!isVisible(it, visibility)) continue;
      const e = a.get(it.tile);
      if (!e) continue;
      let flags = it.kind === 'shadow' ? InstanceFlag.Shadow : 0;
      if (hover && it.cellX === hover.cellX && it.cellY === hover.cellY && it.kind !== 'shadow') flags |= InstanceFlag.Highlight;
      instances.push({
        x: it.x + e.image.offsetX,
        y: it.y + e.image.offsetY,
        w: e.image.width,
        h: e.image.height,
        u: e.u,
        v: e.v,
        layer: e.layer,
        flags,
      });
    }
    renderer.current!.syncAtlas(a);
    renderer.current!.setInstances(instances);
    dirty.current = true;
  }, [map, visibility, hover]);

  // Input: drag to pan (left or middle button), wheel to zoom around the cursor.
  useEffect(() => {
    const el = overlay.current!;
    let drag: { x: number; y: number } | null = null;
    const dpr = () => window.devicePixelRatio || 1;
    const toWorld = (ev: MouseEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      const cam = camera.current;
      return [
        cam.x + ((ev.clientX - r.left) * dpr() - el.width / 2) / cam.zoom,
        cam.y + ((ev.clientY - r.top) * dpr() - el.height / 2) / cam.zoom,
      ];
    };
    const down = (ev: PointerEvent) => {
      if (ev.button !== 0 && ev.button !== 1) return;
      drag = { x: ev.clientX, y: ev.clientY };
      el.setPointerCapture(ev.pointerId);
      el.style.cursor = 'grabbing';
    };
    const move = (ev: PointerEvent) => {
      if (drag) {
        const cam = camera.current;
        cam.x -= ((ev.clientX - drag.x) * dpr()) / cam.zoom;
        cam.y -= ((ev.clientY - drag.y) * dpr()) / cam.zoom;
        drag = { x: ev.clientX, y: ev.clientY };
        dirty.current = true;
      }
      const [wx, wy] = toWorld(ev);
      const [fx, fy] = worldToCell(wx, wy);
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      const { map: m, hover: h } = latest.current;
      const inside = cx >= 0 && cy >= 0 && cx < m.ds1.width && cy < m.ds1.height;
      if (!inside) {
        if (h) onHover(null);
      } else if (!h || h.cellX !== cx || h.cellY !== cy) {
        onHover({ cellX: cx, cellY: cy });
      }
    };
    const up = (ev: PointerEvent) => {
      drag = null;
      el.releasePointerCapture(ev.pointerId);
      el.style.cursor = '';
    };
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const cam = camera.current;
      const [wx, wy] = toWorld(ev);
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
      const zoom = Math.min(Math.max(cam.zoom * factor, 0.05), 8 * dpr());
      // Keep the world point under the cursor fixed.
      cam.x = wx - (wx - cam.x) * (cam.zoom / zoom);
      cam.y = wy - (wy - cam.y) * (cam.zoom / zoom);
      cam.zoom = zoom;
      onZoom(zoom / dpr());
      dirty.current = true;
    };
    const leave = () => latest.current.hover && onHover(null);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('wheel', wheel);
    };
  }, [onHover, onZoom]);

  return (
    <div className="viewport">
      <canvas ref={glCanvas} className="viewport-canvas" />
      <canvas ref={overlay} className="viewport-canvas viewport-overlay" onContextMenu={(e) => e.preventDefault()} />
    </div>
  );
}

function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, w = 1, h = 1) {
  const [x0, y0] = cellToWorld(cx, cy);
  const [x1, y1] = cellToWorld(cx + w, cy);
  const [x2, y2] = cellToWorld(cx + w, cy + h);
  const [x3, y3] = cellToWorld(cx, cy + h);
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.closePath();
}

function drawOverlay(canvas: HTMLCanvasElement, cam: Camera, s: { map: OpenMap; visibility: Visibility; hover: HoverInfo | null }) {
  const ctx = canvas.getContext('2d')!;
  const { map, visibility: v, hover } = s;
  const { ds1 } = map;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom, 0, 0, cam.zoom, canvas.width / 2 - cam.x * cam.zoom, canvas.height / 2 - cam.y * cam.zoom);
  const px = 1 / cam.zoom; // one device pixel in world units

  if (v.grid) {
    ctx.beginPath();
    for (let y = 0; y <= ds1.height; y++) {
      const [ax, ay] = cellToWorld(0, y);
      const [bx, by] = cellToWorld(ds1.width, y);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    for (let x = 0; x <= ds1.width; x++) {
      const [ax, ay] = cellToWorld(x, 0);
      const [bx, by] = cellToWorld(x, ds1.height);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = px;
    ctx.stroke();
  }

  if (v.groups && ds1.groups.length) {
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    ds1.groups.forEach((g) => {
      ctx.beginPath();
      diamond(ctx, g.x, g.y, g.width, g.height);
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.8)';
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  if (v.specials) {
    ctx.lineWidth = 2 * px;
    ds1.walls.forEach((cells) =>
      cells.forEach((c, i) => {
        if (c.prop1 === 0 || (c.orientation !== Orientation.SpecialTile1 && c.orientation !== Orientation.SpecialTile2)) return;
        const cx = i % ds1.width;
        const cy = Math.floor(i / ds1.width);
        ctx.beginPath();
        diamond(ctx, cx + 0.15, cy + 0.15, 0.7, 0.7);
        ctx.fillStyle = 'rgba(180, 110, 255, 0.25)';
        ctx.strokeStyle = 'rgba(200, 140, 255, 0.9)';
        ctx.fill();
        ctx.stroke();
      }),
    );
  }

  if (v.missing && map.scene.missing.length) {
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = 'rgba(255, 70, 90, 0.85)';
    ctx.fillStyle = 'rgba(255, 70, 90, 0.12)';
    for (const m of map.scene.missing) {
      ctx.beginPath();
      diamond(ctx, m.cellX + 0.08, m.cellY + 0.08, 0.84, 0.84);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (hover) {
    ctx.beginPath();
    diamond(ctx, hover.cellX, hover.cellY);
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = 'rgba(255, 205, 110, 0.95)';
    ctx.stroke();
  }

  if (v.paths) {
    ctx.lineWidth = 1.5 * px;
    for (const o of ds1.objects) {
      if (!o.path.length) continue;
      ctx.beginPath();
      ctx.moveTo(...subTileToWorld(o.x, o.y));
      for (const p of o.path) ctx.lineTo(...subTileToWorld(p.x, p.y));
      ctx.strokeStyle = 'rgba(255, 150, 60, 0.9)';
      ctx.stroke();
      for (const p of o.path) {
        const [x, y] = subTileToWorld(p.x, p.y);
        ctx.fillStyle = 'rgba(255, 150, 60, 0.9)';
        ctx.fillRect(x - 2 * px, y - 2 * px, 4 * px, 4 * px);
      }
    }
  }

  if (v.objects) {
    const r = Math.max(4 * px, 5);
    for (const o of ds1.objects) {
      const [x, y] = subTileToWorld(o.x, o.y);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = o.type === 1 ? 'rgba(240, 80, 80, 0.85)' : 'rgba(80, 160, 255, 0.85)';
      ctx.fill();
      ctx.lineWidth = px;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();
      if (cam.zoom > 0.6) {
        ctx.font = `${11 * px}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillText(`${o.type === 1 ? 'M' : 'O'}${o.id}`, x + r + 2 * px, y + 4 * px);
      }
    }
  }
}
