import { useEffect, useRef } from 'react';
import { Orientation, type Dt1Tile } from '../formats/dt1';
import type { OpenMap } from '../game/openMap';
import { TileAtlas } from '../render/atlas';
import { InstanceFlag, MapRenderer, type Camera, type Instance } from '../render/MapRenderer';
import { cellToWorld, subTileToWorld, worldToCell, type DrawItem, type Scene } from '../render/scene';
import type { Tool, Visibility } from './state';

export interface HoverInfo {
  cellX: number;
  cellY: number;
}

/** A tile drawn translucently as a brush preview. */
export interface GhostTile {
  tile: Dt1Tile;
  x: number;
  y: number;
}

export type StrokePhase = 'start' | 'move' | 'end';

interface Props {
  map: OpenMap;
  scene: Scene;
  visibility: Visibility;
  hover: HoverInfo | null;
  tool: Tool;
  ghost: GhostTile[];
  onHover: (h: HoverInfo | null) => void;
  onZoom: (zoom: number) => void;
  /** Tool strokes in cell coordinates; `cells` are all cells crossed since the last event, `world` is the cursor. */
  onStroke: (phase: StrokePhase, cells: [number, number][], world: [number, number]) => void;
  /** Bumped by the parent to request "fit map to view". */
  fitSignal: number;
}

const BACKGROUND: [number, number, number] = [0.043, 0.047, 0.059];

export function isVisible(it: DrawItem, v: Visibility): boolean {
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

/** Cells on the grid line from a to b (inclusive), so fast drags don't skip cells. */
function cellLine([x0, y0]: [number, number], [x1, y1]: [number, number]): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export function MapView({ map, scene, visibility, hover, tool, ghost, onHover, onZoom, onStroke, fitSignal }: Props) {
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const atlas = useRef(new TileAtlas());
  const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const dirty = useRef(true);
  const latest = useRef({ map, scene, visibility, hover, tool, onHover, onZoom, onStroke });
  latest.current = { map, scene, visibility, hover, tool, onHover, onZoom, onStroke };

  // One renderer per canvas; redraw on demand.
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
    const { minX, minY, maxX, maxY } = latest.current.scene.bounds;
    const dpr = window.devicePixelRatio || 1;
    const zoom = Math.min((c.clientWidth * dpr) / (maxX - minX + 160), (c.clientHeight * dpr) / (maxY - minY + 240), 2 * dpr);
    camera.current = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
    latest.current.onZoom(zoom / dpr);
    dirty.current = true;
  };

  // New map: fresh atlas + palette, fit to view.
  useEffect(() => {
    atlas.current = new TileAtlas();
    renderer.current!.setPalette(map.palette);
    fit();
  }, [map]);

  useEffect(() => {
    if (fitSignal) fit();
  }, [fitSignal]);

  // Rebuild instances when the scene, layer visibility, hover or brush preview changes.
  useEffect(() => {
    const instances: Instance[] = [];
    const a = atlas.current;
    const push = (tile: Dt1Tile, x: number, y: number, flags: number) => {
      const e = a.get(tile);
      if (!e) return;
      instances.push({ x: x + e.image.offsetX, y: y + e.image.offsetY, w: e.image.width, h: e.image.height, u: e.u, v: e.v, layer: e.layer, flags });
    };
    for (const it of scene.items) {
      if (!isVisible(it, visibility)) continue;
      let flags = it.kind === 'shadow' ? InstanceFlag.Shadow : 0;
      if (hover && it.cellX === hover.cellX && it.cellY === hover.cellY && it.kind !== 'shadow' && !ghost.length) flags |= InstanceFlag.Highlight;
      push(it.tile, it.x, it.y, flags);
    }
    for (const g of ghost) push(g.tile, g.x, g.y, InstanceFlag.Ghost);
    renderer.current!.syncAtlas(a);
    renderer.current!.setInstances(instances);
    dirty.current = true;
  }, [scene, visibility, hover, ghost]);

  // Input.
  useEffect(() => {
    const el = overlay.current!;
    let pan: { x: number; y: number } | null = null;
    let stroke: [number, number] | null = null;
    let space = false;
    const dpr = () => window.devicePixelRatio || 1;
    const toWorld = (ev: MouseEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      const cam = camera.current;
      return [cam.x + ((ev.clientX - r.left) * dpr() - el.width / 2) / cam.zoom, cam.y + ((ev.clientY - r.top) * dpr() - el.height / 2) / cam.zoom];
    };
    const toCell = (ev: MouseEvent): [number, number] => {
      const [fx, fy] = worldToCell(...toWorld(ev));
      return [Math.floor(fx), Math.floor(fy)];
    };
    const setCursor = () => {
      const t = latest.current.tool;
      el.style.cursor = pan ? 'grabbing' : space || t === 'select' ? 'grab' : t === 'pick' ? 'copy' : 'crosshair';
    };
    const down = (ev: PointerEvent) => {
      el.setPointerCapture(ev.pointerId);
      const toolDrag = ev.button === 0 && !space && latest.current.tool !== 'select';
      if (toolDrag) {
        stroke = toCell(ev);
        latest.current.onStroke('start', [stroke], toWorld(ev));
      } else if (ev.button <= 2) {
        pan = { x: ev.clientX, y: ev.clientY };
      }
      setCursor();
    };
    const move = (ev: PointerEvent) => {
      if (pan) {
        const cam = camera.current;
        cam.x -= ((ev.clientX - pan.x) * dpr()) / cam.zoom;
        cam.y -= ((ev.clientY - pan.y) * dpr()) / cam.zoom;
        pan = { x: ev.clientX, y: ev.clientY };
        dirty.current = true;
      }
      const [cx, cy] = toCell(ev);
      if (stroke && (cx !== stroke[0] || cy !== stroke[1])) {
        latest.current.onStroke('move', cellLine(stroke, [cx, cy]).slice(1), toWorld(ev));
        stroke = [cx, cy];
      }
      const { map: m, hover: h, onHover: hov } = latest.current;
      const inside = cx >= 0 && cy >= 0 && cx < m.ds1.width && cy < m.ds1.height;
      if (!inside) {
        if (h) hov(null);
      } else if (!h || h.cellX !== cx || h.cellY !== cy) {
        hov({ cellX: cx, cellY: cy });
      }
    };
    const up = (ev: PointerEvent) => {
      if (stroke) latest.current.onStroke('end', [], toWorld(ev));
      stroke = null;
      pan = null;
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      setCursor();
    };
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const cam = camera.current;
      const r = el.getBoundingClientRect();
      const wx = cam.x + ((ev.clientX - r.left) * dpr() - el.width / 2) / cam.zoom;
      const wy = cam.y + ((ev.clientY - r.top) * dpr() - el.height / 2) / cam.zoom;
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
      const zoom = Math.min(Math.max(cam.zoom * factor, 0.05), 8 * dpr());
      // Keep the world point under the cursor fixed.
      cam.x = wx - (wx - cam.x) * (cam.zoom / zoom);
      cam.y = wy - (wy - cam.y) * (cam.zoom / zoom);
      cam.zoom = zoom;
      latest.current.onZoom(zoom / dpr());
      dirty.current = true;
    };
    const leave = () => latest.current.hover && latest.current.onHover(null);
    const keydown = (ev: KeyboardEvent) => {
      if (ev.code === 'Space' && !(ev.target instanceof HTMLInputElement)) {
        space = true;
        setCursor();
        ev.preventDefault();
      }
    };
    const keyup = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') {
        space = false;
        setCursor();
      }
    };
    setCursor();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    };
  }, []);

  // Keep the cursor in sync with the tool.
  useEffect(() => {
    const el = overlay.current!;
    el.style.cursor = tool === 'select' ? 'grab' : tool === 'pick' ? 'copy' : 'crosshair';
  }, [tool]);

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

function drawOverlay(
  canvas: HTMLCanvasElement,
  cam: Camera,
  s: { map: OpenMap; scene: Scene; visibility: Visibility; hover: HoverInfo | null; tool: Tool },
) {
  const ctx = canvas.getContext('2d')!;
  const { map, scene, visibility: v, hover, tool } = s;
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
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.8)';
    for (const g of ds1.groups) {
      ctx.beginPath();
      diamond(ctx, g.x, g.y, g.width, g.height);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  if (v.specials) {
    ctx.lineWidth = 2 * px;
    ctx.fillStyle = 'rgba(180, 110, 255, 0.25)';
    ctx.strokeStyle = 'rgba(200, 140, 255, 0.9)';
    for (const cells of ds1.walls) {
      cells.forEach((c, i) => {
        if (c.prop1 === 0 || (c.orientation !== Orientation.SpecialTile1 && c.orientation !== Orientation.SpecialTile2)) return;
        ctx.beginPath();
        diamond(ctx, (i % ds1.width) + 0.15, Math.floor(i / ds1.width) + 0.15, 0.7, 0.7);
        ctx.fill();
        ctx.stroke();
      });
    }
  }

  if (v.missing && scene.missing.length) {
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = 'rgba(255, 70, 90, 0.85)';
    ctx.fillStyle = 'rgba(255, 70, 90, 0.12)';
    for (const m of scene.missing) {
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
    ctx.strokeStyle = tool === 'erase' ? 'rgba(255, 90, 110, 0.95)' : 'rgba(255, 205, 110, 0.95)';
    ctx.stroke();
  }

  if (v.paths) {
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = 'rgba(255, 150, 60, 0.9)';
    ctx.fillStyle = 'rgba(255, 150, 60, 0.9)';
    for (const o of ds1.objects) {
      if (!o.path.length) continue;
      ctx.beginPath();
      ctx.moveTo(...subTileToWorld(o.x, o.y));
      for (const p of o.path) ctx.lineTo(...subTileToWorld(p.x, p.y));
      ctx.stroke();
      for (const p of o.path) {
        const [x, y] = subTileToWorld(p.x, p.y);
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
