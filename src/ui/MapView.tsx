import { useEffect, useMemo, useRef, useState } from 'react';
import type { Ds1Object } from '../formats/ds1';
import type { Dt1Tile } from '../formats/dt1';
import type { Sprite } from '../game/sprites';
import type { ResizeDelta } from '../formats/ds1ops';
import type { CellRect } from '../game/clipboard';
import type { OpenMap } from '../game/openMap';
import { TileAtlas } from '../render/atlas';
import { InstanceFlag, MapRenderer, type Camera, type Instance } from '../render/MapRenderer';
import { cellToWorld, SubTileFlag, subTileToWorld, walkability, worldToCell, sameItem, type DrawItem, type Scene } from '../render/scene';
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
/** Modifier keys held when the stroke started. */
export interface StrokeMods {
  alt: boolean;
  shift: boolean;
}

interface Props {
  map: OpenMap;
  scene: Scene;
  visibility: Visibility;
  hover: HoverInfo | null;
  tool: Tool;
  ghost: GhostTile[];
  /** Display name for an object marker. */
  objectLabel: (o: Ds1Object) => string;
  selectedObject: number | null;
  /** Object sprites by "type:id". */
  sprites: Map<string, Sprite>;
  /** Cells to call out (e.g. problems found by the compatibility check). */
  marks?: { x: number; y: number }[];
  /** Show edge handles that resize the map by dragging. */
  resizeMode: boolean;
  onResize: (delta: ResizeDelta) => void;
  selection: CellRect | null;
  /** Footprint of a pending paste, drawn as an outline. */
  pasteRect: CellRect | null;
  onHover: (h: HoverInfo | null) => void;
  onZoom: (zoom: number) => void;
  /** Tool strokes in cell coordinates; `cells` are all cells crossed since the last event, `world` is the cursor. */
  onStroke: (phase: StrokePhase, cells: [number, number][], world: [number, number], mods?: StrokeMods) => void;
  /** Bumped by the parent to request "fit map to view". */
  fitSignal: number;
  /** One tile of a stack of overlapping tiles, chosen with Shift+wheel: highlighted and outlined. */
  focus: { item: DrawItem; index: number; count: number; label: string } | null;
  /** Shift+wheel over the map: step through the tiles under the cursor (+1 = further back). */
  onCycle: (dir: 1 | -1, world: [number, number]) => void;
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
    case 'special':
      return v.specials;
  }
}

type Side = keyof ResizeDelta;
const SIDES: Side[] = ['left', 'top', 'right', 'bottom'];

/** Midpoint of a map edge, in cell coordinates. */
function sideAnchor(side: Side, w: number, h: number): [number, number] {
  return side === 'left' ? [0, h / 2] : side === 'right' ? [w, h / 2] : side === 'top' ? [w / 2, 0] : [w / 2, h];
}

/** The delta produced by dragging `side` to fractional cell (fx, fy). Keeps at least one cell. */
function dragDelta(side: Side, fx: number, fy: number, w: number, h: number): ResizeDelta {
  const d: ResizeDelta = { left: 0, top: 0, right: 0, bottom: 0 };
  if (side === 'left') d.left = Math.min(-Math.round(fx), w - 1);
  if (side === 'right') d.right = Math.max(Math.round(fx) - w, 1 - w);
  if (side === 'top') d.top = Math.min(-Math.round(fy), h - 1);
  if (side === 'bottom') d.bottom = Math.max(Math.round(fy) - h, 1 - h);
  return d;
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

export function MapView(props: Props) {
  const { map, scene, visibility, hover, tool, ghost, selection, pasteRect, objectLabel, selectedObject, sprites, fitSignal, focus } = props;
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const atlas = useRef(new TileAtlas());
  const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const dirty = useRef(true);
  const [frame, setFrame] = useState(0);
  const walk = useMemo(() => (visibility.walkable ? walkability(map.ds1, scene) : null), [visibility.walkable, map, scene]);
  const resizeDrag = useRef<{ side: Side; delta: ResizeDelta } | null>(null);
  const latest = useRef({ ...props, walk, resizeDrag });
  latest.current = { ...props, walk, resizeDrag };

  // Animated floors run at 10 fps, like the game.
  useEffect(() => {
    if (!scene.animated || !visibility.animate) return;
    const t = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(t);
  }, [scene.animated, visibility.animate]);

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

  // New map: fresh atlas, fit to view. (Re-resolving tiles or switching palettes keeps the same DS1 and camera.)
  useEffect(() => {
    atlas.current = new TileAtlas();
    fit();
  }, [map.ds1]);

  // The atlas holds palette indices, so a palette change only swaps the palette texture.
  useEffect(() => {
    renderer.current!.setPalette(map.palette);
    dirty.current = true;
  }, [map.palette]);

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
    // Object sprites are interleaved with the walls in depth order: an object draws after the walls of its own
    // cell diagonal and before those further forward (WinDS1 draws objects right after each row's walls).
    const objs = visibility.sprites
      ? map.ds1.objects
          .map((o, i) => ({ o, i, sprite: sprites.get(`${o.type}:${o.id}`), depth: Math.floor(o.x / 5) + Math.floor(o.y / 5) }))
          .filter((x): x is typeof x & { sprite: Sprite } => !!x.sprite)
          .sort((a, b) => a.depth - b.depth || a.o.x + a.o.y - (b.o.x + b.o.y))
      : [];
    let next = 0;
    const flushObjects = (maxDepth: number) => {
      for (; next < objs.length && objs[next].depth <= maxDepth; next++) {
        const { o, i, sprite } = objs[next];
        const e = a.getImage(sprite, sprite);
        if (!e) continue;
        const [wx, wy] = subTileToWorld(o.x, o.y);
        const flags = i === selectedObject ? InstanceFlag.Highlight : 0;
        instances.push({ x: wx + sprite.offsetX, y: wy + 4 + sprite.offsetY, w: sprite.width, h: sprite.height, u: e.u, v: e.v, layer: e.layer, flags });
      }
    };
    for (const it of scene.items) {
      if (it.kind === 'wall') flushObjects(it.cellX + it.cellY - 1);
      else if (it.kind === 'roof' || it.kind === 'special') flushObjects(Infinity);
      if (!isVisible(it, visibility)) continue;
      let flags = it.kind === 'shadow' ? InstanceFlag.Shadow : 0;
      if (focus) {
        if (sameItem(it, focus.item)) flags |= InstanceFlag.Highlight;
      } else if (hover && tool !== 'object' && it.cellX === hover.cellX && it.cellY === hover.cellY && it.kind !== 'shadow' && !ghost.length) flags |= InstanceFlag.Highlight;
      const tile = it.frames && visibility.animate ? it.frames[frame % it.frames.length] : it.tile;
      push(tile, it.x, it.y, flags);
    }
    flushObjects(Infinity);
    for (const g of ghost) push(g.tile, g.x, g.y, InstanceFlag.Ghost);
    renderer.current!.syncAtlas(a);
    renderer.current!.setInstances(instances);
    dirty.current = true;
  }, [scene, visibility, hover, ghost, frame, tool, sprites, selectedObject, focus]);

  useEffect(() => {
    dirty.current = true;
  }, [selection, pasteRect, selectedObject, objectLabel, walk, props.resizeMode, props.marks, focus]);

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
      el.style.cursor = pan ? 'grabbing' : space ? 'grab' : t === 'pick' ? 'copy' : t === 'select' ? 'default' : 'crosshair';
    };
    const down = (ev: PointerEvent) => {
      el.setPointerCapture(ev.pointerId);
      // Resize handles take precedence over tools.
      if (ev.button === 0 && latest.current.resizeMode) {
        const { width: w, height: h } = latest.current.map.ds1;
        const [wx, wy] = toWorld(ev);
        const reach = 14 / camera.current.zoom * dpr();
        const side = SIDES.find((sd) => {
          const [ax, ay] = cellToWorld(...sideAnchor(sd, w, h));
          return Math.hypot(ax - wx, ay - wy) < reach;
        });
        if (side) {
          resizeDrag.current = { side, delta: { left: 0, top: 0, right: 0, bottom: 0 } };
          dirty.current = true;
          return;
        }
      }
      const toolDrag = ev.button === 0 && !space;
      if (toolDrag) {
        stroke = toCell(ev);
        latest.current.onStroke('start', [stroke], toWorld(ev), { alt: ev.altKey, shift: ev.shiftKey });
      } else if (ev.button <= 2) {
        pan = { x: ev.clientX, y: ev.clientY };
      }
      setCursor();
    };
    const move = (ev: PointerEvent) => {
      if (resizeDrag.current) {
        const { width: w, height: h } = latest.current.map.ds1;
        const [fx, fy] = worldToCell(...toWorld(ev));
        resizeDrag.current = { side: resizeDrag.current.side, delta: dragDelta(resizeDrag.current.side, fx, fy, w, h) };
        dirty.current = true;
        return;
      }
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
      if (resizeDrag.current) {
        const { delta } = resizeDrag.current;
        resizeDrag.current = null;
        dirty.current = true;
        if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
        if (delta.left || delta.top || delta.right || delta.bottom) latest.current.onResize(delta);
        return;
      }
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
      if (ev.shiftKey) {
        // Shift+wheel picks one tile out of a stack instead of zooming (Windows turns it into a horizontal scroll).
        const d = ev.deltaY || ev.deltaX;
        if (d) latest.current.onCycle(d > 0 ? 1 : -1, [wx, wy]);
        return;
      }
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
    el.style.cursor = tool === 'pick' ? 'copy' : tool === 'select' ? 'default' : 'crosshair';
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

type OverlayState = Props & { walk: Uint8Array | null; resizeDrag: { current: { side: Side; delta: ResizeDelta } | null } };

function drawOverlay(canvas: HTMLCanvasElement, cam: Camera, s: OverlayState) {
  const ctx = canvas.getContext('2d')!;
  const { map, scene, visibility: v, hover, tool, selection, pasteRect, walk, objectLabel, selectedObject } = s;
  const { ds1 } = map;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom, 0, 0, cam.zoom, canvas.width / 2 - cam.x * cam.zoom, canvas.height / 2 - cam.y * cam.zoom);
  const px = 1 / cam.zoom; // one device pixel in world units

  if (walk) {
    // Red = blocks jumping/teleport too; amber = blocks walking.
    const noJump = new Path2D();
    const noWalk = new Path2D();
    for (let cy = 0; cy < ds1.height; cy++)
      for (let cx = 0; cx < ds1.width; cx++)
        for (let k = 0; k < 25; k++) {
          const f = walk[(cy * ds1.width + cx) * 25 + k];
          if (!f) continue;
          const target = f & SubTileFlag.BlockJump ? noJump : f & (SubTileFlag.BlockWalk | SubTileFlag.BlockPlayerWalk) ? noWalk : null;
          if (!target) continue;
          const [x, y] = subTileToWorld(cx * 5 + (k % 5), cy * 5 + Math.floor(k / 5));
          target.moveTo(x, y - 8);
          target.lineTo(x + 16, y);
          target.lineTo(x, y + 8);
          target.lineTo(x - 16, y);
          target.closePath();
        }
    ctx.fillStyle = 'rgba(255, 60, 70, 0.38)';
    ctx.fill(noJump);
    ctx.fillStyle = 'rgba(255, 176, 40, 0.34)';
    ctx.fill(noWalk);
  }

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

  // The game builds the level out of 8x8-tile rooms (streamed in and out as players move), cut from the map's origin.
  if (v.rooms) {
    const R = 8;
    const cols = Math.ceil(ds1.width / R);
    const rows = Math.ceil(ds1.height / R);
    for (let ry = 0; ry < rows; ry++)
      for (let rx = 0; rx < cols; rx++) {
        const x0 = rx * R;
        const y0 = ry * R;
        const w = Math.min(R, ds1.width - x0);
        const h = Math.min(R, ds1.height - y0);
        const partial = w < R || h < R;
        ctx.beginPath();
        diamond(ctx, x0, y0, w, h);
        ctx.fillStyle = (rx + ry) % 2 ? 'rgba(90, 200, 255, 0.07)' : 'rgba(90, 200, 255, 0.02)';
        ctx.fill();
        ctx.setLineDash(partial ? [8 * px, 5 * px] : []);
        ctx.lineWidth = 2 * px;
        ctx.strokeStyle = partial ? 'rgba(255, 190, 90, 0.85)' : 'rgba(90, 200, 255, 0.85)';
        ctx.stroke();
        ctx.setLineDash([]);
        if (cam.zoom > 0.12) {
          const [cx, cy] = cellToWorld(x0 + w / 2, y0 + h / 2);
          ctx.font = `600 ${12 * px}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          const label = `Room ${ry * cols + rx}  (${rx},${ry})${partial ? ` · ${w}×${h}` : ''}`;
          ctx.lineWidth = 3 * px;
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.strokeText(label, cx, cy);
          ctx.fillStyle = partial ? 'rgba(255, 215, 150, 1)' : 'rgba(190, 235, 255, 1)';
          ctx.fillText(label, cx, cy);
          ctx.textAlign = 'start';
        }
      }
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

  // Special tiles without a graphic (no WinDS1 ds1edit.dt1 configured, or an unknown code).
  if (v.specials && scene.unmarkedSpecials.length) {
    ctx.lineWidth = 2 * px;
    ctx.fillStyle = 'rgba(180, 110, 255, 0.25)';
    ctx.strokeStyle = 'rgba(200, 140, 255, 0.9)';
    for (const sp of scene.unmarkedSpecials) {
      ctx.beginPath();
      diamond(ctx, sp.cellX + 0.15, sp.cellY + 0.15, 0.7, 0.7);
      ctx.fill();
      ctx.stroke();
      if (cam.zoom > 0.5) {
        const [x, y] = cellToWorld(sp.cellX + 0.5, sp.cellY + 0.5);
        ctx.font = `${11 * px}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(235, 215, 255, 0.95)';
        ctx.textAlign = 'center';
        ctx.fillText(`${sp.main}/${sp.sub}`, x, y + 4 * px);
        ctx.textAlign = 'start';
      }
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

  for (const [rect, fill, stroke] of [
    [selection, 'rgba(212, 168, 79, 0.10)', 'rgba(255, 205, 110, 0.95)'],
    [pasteRect, 'rgba(110, 190, 255, 0.08)', 'rgba(130, 200, 255, 0.95)'],
  ] as const) {
    if (!rect) continue;
    ctx.beginPath();
    diamond(ctx, rect.x0, rect.y0, rect.x1 - rect.x0 + 1, rect.y1 - rect.y0 + 1);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (s.focus) {
    // Outline the chosen tile and say which of the stack it is.
    const { item, index, count, label } = s.focus;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of item.tile.blocks) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + 32);
      maxY = Math.max(maxY, b.y + (b.format === 1 ? 15 : 32));
    }
    if (minX < maxX) {
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = 'rgba(120, 230, 255, 0.95)';
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.strokeRect(item.x + minX, item.y + minY, maxX - minX, maxY - minY);
      ctx.setLineDash([]);
      const text = `${label} · ${index + 1} of ${count}`;
      ctx.font = `${12 * px}px system-ui, sans-serif`;
      const w = ctx.measureText(text).width + 8 * px;
      ctx.fillStyle = 'rgba(10, 20, 30, 0.85)';
      ctx.fillRect(item.x + minX, item.y + minY - 18 * px, w, 16 * px);
      ctx.fillStyle = 'rgb(160, 235, 255)';
      ctx.fillText(text, item.x + minX + 4 * px, item.y + minY - 6 * px);
    }
  }

  if (s.marks?.length) {
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(255, 120, 60, 0.95)';
    ctx.fillStyle = 'rgba(255, 120, 60, 0.18)';
    for (const m of s.marks) {
      ctx.beginPath();
      diamond(ctx, m.x, m.y);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (s.resizeMode) {
    const { width: w, height: h } = ds1;
    const drag = s.resizeDrag.current;
    if (drag) {
      const d = drag.delta;
      ctx.beginPath();
      diamond(ctx, -d.left, -d.top, w + d.left + d.right, h + d.top + d.bottom);
      ctx.setLineDash([8 * px, 5 * px]);
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = 'rgba(130, 200, 255, 0.95)';
      ctx.stroke();
      ctx.setLineDash([]);
      const [lx, ly] = cellToWorld(...sideAnchor(drag.side, w, h));
      ctx.font = `600 ${13 * px}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(200, 230, 255, 1)';
      ctx.fillText(`${w + d.left + d.right} × ${h + d.top + d.bottom}`, lx + 14 * px, ly - 10 * px);
    }
    for (const side of SIDES) {
      const [ax, ay] = cellToWorld(...sideAnchor(side, w, h));
      const r = 7 * px;
      ctx.fillStyle = drag?.side === side ? 'rgba(130, 200, 255, 1)' : 'rgba(212, 168, 79, 1)';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.rect(ax - r, ay - r, 2 * r, 2 * r);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (hover && tool !== 'object') {
    ctx.beginPath();
    diamond(ctx, hover.cellX, hover.cellY);
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = tool === 'erase' ? 'rgba(255, 90, 110, 0.95)' : 'rgba(255, 205, 110, 0.95)';
    ctx.stroke();
  }

  const showObjects = v.objects || tool === 'object';
  if (v.paths || tool === 'object') {
    ds1.objects.forEach((o, i) => {
      if (!o.path.length) return;
      const selected = i === selectedObject;
      if (!v.paths && !selected) return;
      // The NPC walks to point 0, then along the points, looping back to point 0.
      ctx.beginPath();
      ctx.moveTo(...subTileToWorld(o.x, o.y));
      for (const p of o.path) ctx.lineTo(...subTileToWorld(p.x, p.y));
      ctx.lineTo(...subTileToWorld(o.path[0].x, o.path[0].y));
      ctx.lineWidth = (selected ? 2 : 1.5) * px;
      ctx.strokeStyle = selected ? 'rgba(255, 190, 90, 1)' : 'rgba(255, 150, 60, 0.85)';
      ctx.stroke();
      o.path.forEach((p, n) => {
        const [x, y] = subTileToWorld(p.x, p.y);
        const r = (selected ? 4 : 2) * px;
        ctx.fillStyle = selected ? 'rgba(255, 205, 110, 1)' : 'rgba(255, 150, 60, 0.9)';
        ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
        if (selected && cam.zoom > 0.4) {
          ctx.font = `${10 * px}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.fillText(`${n}${p.action !== 1 ? ` a${p.action}` : ''}`, x + 6 * px, y - 4 * px);
        }
      });
    });
  }

  if (showObjects) {
    const r = Math.max(4 * px, 5);
    ds1.objects.forEach((o, i) => {
      const [x, y] = subTileToWorld(o.x, o.y);
      const selected = i === selectedObject;
      ctx.beginPath();
      ctx.arc(x, y, selected ? r * 1.5 : r, 0, Math.PI * 2);
      ctx.fillStyle = o.type === 1 ? 'rgba(240, 80, 80, 0.9)' : 'rgba(80, 160, 255, 0.9)';
      ctx.fill();
      ctx.lineWidth = (selected ? 2.5 : 1) * px;
      ctx.strokeStyle = selected ? 'rgba(255, 225, 150, 1)' : 'rgba(0,0,0,0.8)';
      ctx.stroke();
      if (cam.zoom > 0.45 || selected) {
        ctx.font = `${selected ? 600 : 400} ${11 * px}px ui-sans-serif, system-ui, sans-serif`;
        const label = objectLabel(o);
        const tx = x + r + 3 * px;
        const ty = y + 4 * px;
        ctx.lineWidth = 3 * px;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fillText(label, tx, ty);
      }
    });
  }
}
