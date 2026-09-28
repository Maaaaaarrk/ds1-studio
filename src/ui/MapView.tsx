import { useEffect, useMemo, useRef, useState } from 'react';
import type { Ds1Object } from '../formats/ds1';
import type { Dt1Tile } from '../formats/dt1';
import type { Sprite } from '../game/sprites';
import type { ResizeDelta } from '../formats/ds1ops';
import { cellKey, type CellRect, type CellSelection } from '../game/clipboard';
import type { OpenMap } from '../game/openMap';
import { TileAtlas } from '../render/atlas';
import { blendFlag, InstanceFlag, MapRenderer, type Camera, type Instance } from '../render/MapRenderer';
import type { SpriteAnimation } from '../game/spriteAnim';
import { AUTOMAP_SCALE, automapCellOrigin, type AutomapPiece } from '../game/automap';
import type { SpriteFrame } from '../formats/dc6';
import { cellToWorld, SubTileFlag, subTileToWorld, walkability, worldToCell, worldToSubTile, sameItem, type DrawItem, type Scene } from '../render/scene';
import type { Tool, Visibility } from './state';
import { specialTileInfo } from '../game/specialTiles';
import { Minimap } from './Minimap';
import { hideRect, popTargets, triggerRect, type PopArea } from '../game/pops';
import type { Ds1 } from '../formats/ds1';

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
  ctrl: boolean;
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
  /** Object animations by "type:id" (drawn instead of the still sprite while animation is on). */
  animations?: Map<string, SpriteAnimation>;
  /** Cells to call out (e.g. problems found by the compatibility check). */
  marks?: { x: number; y: number }[];
  /** Show edge handles that resize the map by dragging. */
  resizeMode: boolean;
  onResize: (delta: ResizeDelta) => void;
  selection: CellSelection | null;
  /** Footprint of a pending paste, drawn as an outline. */
  pasteRect: CellRect | null;
  onHover: (h: HoverInfo | null) => void;
  onZoom: (zoom: number) => void;
  /** Tool strokes in cell coordinates; `cells` are all cells crossed since the last event, `world` is the cursor. */
  onStroke: (phase: StrokePhase, cells: [number, number][], world: [number, number], mods?: StrokeMods) => void;
  /** Bumped by the parent to request "fit map to view". */
  fitSignal: number;
  /**
   * Game view: when `signal` changes, zoom so the game's 800×600 screen fills the viewport (centred on `center`, a
   * world point, when given); while `on`, everything outside that screen is shaded.
   */
  gameView?: { on: boolean; signal: number; center?: [number, number] | null; width: number; height: number };
  /** One tile of a stack of overlapping tiles, chosen with Shift+wheel: highlighted and outlined. */
  focus: { item: DrawItem; index: number; count: number; label: string } | null;
  /** The in-game automap drawn over the map (dimmed underneath). */
  automap?: { pieces: AutomapPiece[]; cels: SpriteFrame[]; palette: Uint8Array } | null;
  /** Shift+wheel over the map: step through the tiles under the cursor (+1 = further back). */
  onCycle: (dir: 1 | -1, world: [number, number]) => void;
  /** When `signal` changes, centre the view on this world point (zooming in if far out). */
  centerOn?: { x: number; y: number; signal: number } | null;
  /** Label of a special tile (e.g. where a warp leads); defaults to what the tile is. */
  specialLabel?: (main: number, sub: number) => string;
  /**
   * Roof/wall hide areas ("pops"): drawn when `show`; with `inside`, the tiles they hide are left out, as the game
   * shows them while a player is inside. `hidden` = "wallLayer:x:y" of those tiles.
   */
  pops?: { areas: PopArea[]; popPad: number; show: boolean; inside: boolean; hidden: Set<string> };
  /** Sub-tiles being painted in walkability mode (keys sy * 65536 + sx), and whether they get blocked or cleared. */
  walkMarks?: { keys: ReadonlySet<number>; mode: 'block' | 'clear' } | null;
  /**
   * Walkability mode's brush: the cursor shows its footprint on the sub-tile grid instead of a whole cell, and strokes
   * report every new sub-tile the cursor reaches (not just new cells).
   */
  walkBrush?: { size: 1 | 3 | 5 | 'cell'; mode: 'block' | 'clear' } | null;
  /** Draw the map in this light (multiplies every colour), or as stored when null. */
  light?: [number, number, number] | null;
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
  const popsInside = props.pops?.inside ? props.pops.hidden : null;
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const atlas = useRef(new TileAtlas());
  const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  /** Arrow keys currently held ('Shift' too while one is). */
  const arrows = useRef(new Set<string>());
  const dirty = useRef(true);
  const minimapDraw = useRef<(() => void) | null>(null);
  const [frame, setFrame] = useState(0);
  const automapImage = useMemo(() => (props.automap ? renderAutomap(map.ds1.width, map.ds1.height, props.automap) : null), [props.automap, map]);
  // Built once per scene, not per frame: a 150×150 map has 562,500 sub-tiles.
  const walk = useMemo(() => (visibility.walkable ? walkPaths(walkability(map.ds1, scene, map.lib), map.ds1.width, map.ds1.height) : null), [visibility.walkable, map, scene]);
  const resizeDrag = useRef<{ side: Side; delta: ResizeDelta } | null>(null);
  /** The sub-tile under the cursor in walkability mode (drawn as the brush's footprint). */
  const walkCursor = useRef<[number, number] | null>(null);
  const latest = useRef({ ...props, walk, resizeDrag, automapImage, walkCursor });
  latest.current = { ...props, walk, resizeDrag, automapImage, walkCursor };

  // Animation clock in game ticks (25 per second, like the game). Animated floors advance every 2.5 ticks (10 fps);
  // objects at their own rate. Without animated objects the clock only needs the floors' 10 fps.
  const animations = props.animations;
  const hasObjectAnims = useMemo(() => visibility.sprites && [...(animations?.values() ?? [])].some((an) => an.parts.length > 1), [animations, visibility.sprites]);
  useEffect(() => {
    if (!visibility.animate || (!scene.animated && !hasObjectAnims)) return;
    const ms = hasObjectAnims ? 40 : 100;
    const t = setInterval(() => setFrame((f) => f + ms / 40), ms);
    return () => clearInterval(t);
  }, [scene.animated, visibility.animate, hasObjectAnims]);
  const floorFrame = Math.floor(frame / 2.5);

  // One renderer per canvas; redraw on demand.
  useEffect(() => {
    renderer.current = new MapRenderer(glCanvas.current!);
    let raf = 0;
    let last = performance.now();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dpr = window.devicePixelRatio || 1;
      // Arrow keys pan smoothly while held (Shift = faster), at a steady on-screen speed whatever the zoom.
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = arrows.current;
      const dx = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
      const dy = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0);
      if (dx || dy) {
        const speed = (k.has('Shift') ? 1800 : 700) * dpr * dt / camera.current.zoom;
        camera.current.x += dx * speed;
        camera.current.y += dy * speed;
        dirty.current = true;
      }
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
      renderer.current!.light = latest.current.light ?? [1, 1, 1];
      renderer.current!.draw(camera.current, BACKGROUND);
      drawOverlay(overlay.current!, camera.current, latest.current);
      minimapDraw.current?.();
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

  useEffect(() => {
    const c = props.centerOn;
    if (!c?.signal) return;
    const dpr = window.devicePixelRatio || 1;
    const zoom = Math.max(camera.current.zoom, 0.6 * dpr);
    camera.current = { x: c.x, y: c.y, zoom };
    latest.current.onZoom(zoom / dpr);
    dirty.current = true;
  }, [props.centerOn?.signal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const g = props.gameView;
    if (!g?.signal) return;
    const c = glCanvas.current!;
    const dpr = window.devicePixelRatio || 1;
    // Exactly 100% (one game pixel per screen pixel, as in game) when the screen fits; smaller only when it doesn't.
    const zoom = Math.min(dpr, (c.clientWidth * dpr) / (g.width + 40), (c.clientHeight * dpr) / (g.height + 40));
    const cam = camera.current;
    camera.current = { x: g.center?.[0] ?? cam.x, y: g.center?.[1] ?? cam.y, zoom };
    latest.current.onZoom(zoom / dpr);
    dirty.current = true;
  }, [props.gameView?.signal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    dirty.current = true;
  }, [props.gameView?.on, props.gameView?.width, props.gameView?.height]);

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
        // Drawn like the game: solid layers plus translucent / glowing ones with their own blend. Animated objects
        // show their current frame (each starts at its own phase so they don't move in step); otherwise frame 0.
        const anim = animations?.get(`${o.type}:${o.id}`);
        const [wx, wy] = subTileToWorld(o.x, o.y);
        const flags = i === selectedObject ? InstanceFlag.Highlight : 0;
        const parts = anim?.parts.length
          ? anim.parts[visibility.animate ? Math.floor((frame / 25) * anim.fps + i * 7) % anim.parts.length : 0]
          : [{ image: sprite, blend: -1 }];
        for (const part of parts) {
          const e = a.getImage(part.image, part.image);
          if (!e) continue;
          const img = part.image;
          instances.push({ x: wx + img.offsetX, y: wy + 4 + img.offsetY, w: img.width, h: img.height, u: e.u, v: e.v, layer: e.layer, flags: flags | blendFlag(part.blend) });
        }
      }
    };
    for (const it of scene.items) {
      if (it.kind === 'wall') flushObjects(it.cellX + it.cellY - 1);
      else if (it.kind === 'roof' || it.kind === 'special') flushObjects(Infinity);
      if (!isVisible(it, visibility)) continue;
      if (popsInside && (it.kind === 'wall' || it.kind === 'roof' || it.kind === 'lowerWall') && popsInside.has(`${it.layer}:${it.cellX}:${it.cellY}`)) continue;
      let flags = it.kind === 'shadow' ? InstanceFlag.Shadow : it.kind === 'floor' ? InstanceFlag.Floor : 0;
      if (focus) {
        if (sameItem(it, focus.item)) flags |= InstanceFlag.Highlight;
      } else if (hover && tool !== 'object' && !props.walkBrush && it.cellX === hover.cellX && it.cellY === hover.cellY && it.kind !== 'shadow' && !ghost.length) flags |= InstanceFlag.Highlight;
      const tile = it.frames && visibility.animate ? it.frames[floorFrame % it.frames.length] : it.tile;
      push(tile, it.x, it.y, flags);
    }
    flushObjects(Infinity);
    for (const g of ghost) push(g.tile, g.x, g.y, InstanceFlag.Ghost);
    renderer.current!.syncAtlas(a);
    renderer.current!.setInstances(instances);
    dirty.current = true;
  }, [scene, visibility, hover, ghost, hasObjectAnims ? frame : floorFrame, tool, sprites, animations, selectedObject, focus, popsInside, !!props.walkBrush]);

  useEffect(() => {
    dirty.current = true;
  }, [selection, pasteRect, selectedObject, objectLabel, walk, props.resizeMode, props.marks, focus, automapImage, props.sprites, props.animations, hover, props.specialLabel, props.pops, props.walkMarks, props.walkBrush, props.light]);

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
        latest.current.onStroke('start', [stroke], toWorld(ev), { alt: ev.altKey, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey });
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
      if (latest.current.walkBrush) {
        // Walkability: follow the cursor sub-tile by sub-tile (the brush footprint, and strokes within a cell).
        const [fx, fy] = worldToSubTile(...toWorld(ev));
        const sub: [number, number] = [Math.round(fx), Math.round(fy)];
        const was = walkCursor.current;
        if (!was || was[0] !== sub[0] || was[1] !== sub[1]) {
          walkCursor.current = sub;
          dirty.current = true;
          if (stroke) latest.current.onStroke('move', [[cx, cy]], toWorld(ev));
        }
        if (stroke) stroke = [cx, cy];
      } else if (stroke && (cx !== stroke[0] || cy !== stroke[1])) {
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
      if (pan && ev.button === 2) {
        // The context menu for this right-click fires after pointerup, wherever the cursor ended up: swallow it.
        const swallow = (e: Event) => e.preventDefault();
        window.addEventListener('contextmenu', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('contextmenu', swallow, { capture: true }), 400);
      }
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
    const leave = () => {
      if (walkCursor.current) {
        walkCursor.current = null;
        dirty.current = true;
      }
      if (latest.current.hover) latest.current.onHover(null);
    };
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
    const keydown = (ev: KeyboardEvent) => {
      if (ev.key.startsWith('Arrow') && !typing(ev.target) && !document.querySelector('.modal-backdrop') && !ev.ctrlKey && !ev.altKey) {
        arrows.current.add(ev.key);
        if (ev.shiftKey) arrows.current.add('Shift');
        ev.preventDefault();
      }
      if (ev.key === 'Shift' && arrows.current.size) arrows.current.add('Shift');
      if (ev.code === 'Space' && !(ev.target instanceof HTMLInputElement)) {
        space = true;
        setCursor();
        ev.preventDefault();
      }
    };
    const keyup = (ev: KeyboardEvent) => {
      arrows.current.delete(ev.key);
      if (ev.key === 'Shift') arrows.current.delete('Shift');
      if (![...arrows.current].some((a) => a.startsWith('Arrow'))) arrows.current.clear();
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
    const blur = () => arrows.current.clear(); // no stuck keys after Alt+Tab
    window.addEventListener('blur', blur);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
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
      {visibility.minimap && (
        <Minimap
          scene={scene}
          palette={map.palette}
          width={map.ds1.width}
          height={map.ds1.height}
          drawRef={minimapDraw}
          view={{
            camera: () => camera.current,
            viewport: () => [glCanvas.current?.width ?? 0, glCanvas.current?.height ?? 0],
            moveTo: (x, y) => {
              camera.current = { ...camera.current, x, y };
              dirty.current = true;
            },
          }}
        />
      )}
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

/** Colours for hide areas, one per group (areas of a group hide together). */
const POP_COLORS = ['110, 220, 255', '255, 170, 90', '150, 255, 140', '255, 120, 200', '200, 170, 255', '255, 230, 110'];

/**
 * Roof/wall hide areas: the trigger area (where the player must stand, PopPad included) filled, the area whose tiles
 * can hide outlined, the tiles that hide marked, and a label.
 */
function drawPops(ctx: CanvasRenderingContext2D, pops: NonNullable<Props['pops']>, ds1: Ds1, px: number) {
  for (const a of pops.areas) {
    const c = POP_COLORS[(a.group - 1 + POP_COLORS.length) % POP_COLORS.length];
    const t = triggerRect(a, pops.popPad);
    ctx.fillStyle = `rgba(${c}, 0.14)`;
    ctx.strokeStyle = `rgba(${c}, 0.95)`;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    diamond(ctx, t.x, t.y, t.w, t.h);
    ctx.fill();
    ctx.stroke();
    const h = hideRect(a);
    ctx.setLineDash([6 * px, 5 * px]);
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    diamond(ctx, h.x0, h.y0, h.x1 - h.x0 + 1, h.y1 - h.y0 + 1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(${c}, 0.8)`;
    ctx.beginPath();
    for (const tile of popTargets(ds1, a)) diamond(ctx, tile.x + 0.3, tile.y + 0.3, 0.4, 0.4);
    ctx.stroke();
    const [x, y] = cellToWorld(a.x0 + t.w / 2, a.y0 + t.h / 2);
    const size = Math.max(12 * px, 15);
    ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const text = `Hide area ${a.main}: tiles #${a.target} fade${a.markers.length !== 2 ? ` (${a.markers.length} markers!)` : ''}`;
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(0, 10, 20, 0.85)';
    ctx.strokeText(text, x, y - size);
    ctx.fillStyle = `rgba(${c}, 1)`;
    ctx.fillText(text, x, y - size);
    ctx.textAlign = 'start';
  }
}

interface WalkChunk {
  /** World-space bounds. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  noJump: Path2D;
  noWalk: Path2D;
}

interface WalkPaths {
  chunks: WalkChunk[];
  /** World bounds of the whole map. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** Low-resolution raster for zoomed-out views, built on first use; one canvas pixel = `scale` world pixels. */
  raster: { canvas: HTMLCanvasElement; scale: number } | null;
}

const WALK_CHUNK = 16; // cells per chunk side

/**
 * The walkability overlay as paths in 16×16-cell chunks (only visible chunks are drawn), one parallelogram per run of
 * same-class sub-tiles along each sub-tile row (a diamond's top-right edge runs the same way as the row, so a run of
 * diamonds is one parallelogram).
 */
function walkPaths(walk: Uint8Array, width: number, height: number): WalkPaths {
  const classOf = (sx: number, sy: number) => {
    const f = walk[(Math.floor(sy / 5) * width + Math.floor(sx / 5)) * 25 + (sy % 5) * 5 + (sx % 5)];
    return f & SubTileFlag.BlockJump ? 2 : f & (SubTileFlag.BlockWalk | SubTileFlag.BlockPlayerWalk) ? 1 : 0;
  };
  const chunks: WalkChunk[] = [];
  for (let cy0 = 0; cy0 < height; cy0 += WALK_CHUNK)
    for (let cx0 = 0; cx0 < width; cx0 += WALK_CHUNK) {
      const cx1 = Math.min(width, cx0 + WALK_CHUNK);
      const cy1 = Math.min(height, cy0 + WALK_CHUNK);
      const noJump = new Path2D();
      const noWalk = new Path2D();
      let any = false;
      for (let sy = cy0 * 5; sy < cy1 * 5; sy++) {
        for (let sx = cx0 * 5; sx < cx1 * 5; ) {
          const c = classOf(sx, sy);
          let end = sx + 1;
          while (end < cx1 * 5 && classOf(end, sy) === c) end++;
          if (c) {
            any = true;
            const target = c === 2 ? noJump : noWalk;
            const [x0, y0] = subTileToWorld(sx, sy);
            const [xn, yn] = subTileToWorld(end - 1, sy);
            target.moveTo(x0, y0 - 8);
            target.lineTo(xn + 16, yn);
            target.lineTo(xn, yn + 8);
            target.lineTo(x0 - 16, y0);
            target.closePath();
          }
          sx = end;
        }
      }
      if (!any) continue;
      // Chunk corners in world space: north (cx0,cy0), east (cx1,cy0), south (cx1,cy1), west (cx0,cy1).
      const [, ny] = cellToWorld(cx0, cy0);
      const [ex] = cellToWorld(cx1, cy0);
      const [, sy2] = cellToWorld(cx1, cy1);
      const [wx] = cellToWorld(cx0, cy1);
      chunks.push({ x0: wx - 16, y0: ny - 8, x1: ex + 16, y1: sy2 + 8, noJump, noWalk });
    }
  const [, top] = cellToWorld(0, 0);
  const [right] = cellToWorld(width, 0);
  const [, bottom] = cellToWorld(width, height);
  const [left] = cellToWorld(0, height);
  return { chunks, bounds: { x0: left - 16, y0: top - 8, x1: right + 16, y1: bottom + 8 }, raster: null };
}

const WALK_COLORS = { noJump: 'rgba(255, 60, 70, 0.38)', noWalk: 'rgba(255, 176, 40, 0.34)' };

function drawWalk(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, cam: Camera, w: WalkPaths) {
  const view = {
    x0: cam.x - canvas.width / 2 / cam.zoom,
    y0: cam.y - canvas.height / 2 / cam.zoom,
    x1: cam.x + canvas.width / 2 / cam.zoom,
    y1: cam.y + canvas.height / 2 / cam.zoom,
  };
  const visible = w.chunks.filter((c) => c.x1 >= view.x0 && c.x0 <= view.x1 && c.y1 >= view.y0 && c.y0 <= view.y1);
  // Zoomed out, many chunks are visible and each diamond is a pixel or two: draw the pre-rendered raster instead.
  const worldW = w.bounds.x1 - w.bounds.x0;
  const worldH = w.bounds.y1 - w.bounds.y0;
  const scale = Math.max(2, Math.ceil(Math.max(worldW / 4096, worldH / 4096)));
  if (visible.length > 12 && cam.zoom * scale <= 2) {
    if (!w.raster || w.raster.scale !== scale) {
      const r = document.createElement('canvas');
      r.width = Math.ceil(worldW / scale);
      r.height = Math.ceil(worldH / scale);
      const rc = r.getContext('2d')!;
      rc.setTransform(1 / scale, 0, 0, 1 / scale, -w.bounds.x0 / scale, -w.bounds.y0 / scale);
      for (const c of w.chunks) {
        rc.fillStyle = WALK_COLORS.noJump;
        rc.fill(c.noJump);
        rc.fillStyle = WALK_COLORS.noWalk;
        rc.fill(c.noWalk);
      }
      w.raster = { canvas: r, scale };
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(w.raster.canvas, w.bounds.x0, w.bounds.y0, w.raster.canvas.width * scale, w.raster.canvas.height * scale);
    return;
  }
  for (const c of visible) {
    ctx.fillStyle = WALK_COLORS.noJump;
    ctx.fill(c.noJump);
    ctx.fillStyle = WALK_COLORS.noWalk;
    ctx.fill(c.noWalk);
  }
}

interface AutomapImage {
  canvas: HTMLCanvasElement;
  /** World position of the canvas's top-left corner. */
  x: number;
  y: number;
  /** Cells whose wall has no automap entry. */
  missing: [number, number][];
  /** Cells showing a suggested (unsaved) piece. */
  suggested: [number, number][];
}

/** The automap at its own resolution (one cel pixel = 10 world pixels), drawn scaled up by the overlay. */
function renderAutomap(width: number, height: number, a: NonNullable<Props['automap']>): AutomapImage {
  const ox = height * 8 + 16;
  const oy = 40;
  const W = (width + height) * 8 + 32;
  const H = (width + height) * 4 + 56;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const missing: [number, number][] = [];
  const suggested: [number, number][] = [];
  const pal = a.palette;
  for (const p of a.pieces) {
    if (p.suggested) suggested.push([p.cellX, p.cellY]);
    if (p.cel === null) {
      if (p.layer === 'wall' && !p.rule) missing.push([p.cellX, p.cellY]);
      continue;
    }
    const f = a.cels[p.cel];
    if (!f) continue;
    const [ax, ay] = automapCellOrigin(p.cellX, p.cellY);
    // A cel's origin is the cell's west corner, 8 px below its north corner.
    const x0 = ox + ax - 8 + f.offsetX;
    const y0 = oy + ay + 8 + f.offsetY;
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        const c = f.pixels[y * f.width + x];
        if (!c) continue;
        const X = x0 + x;
        const Y = y0 + y;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const o = (Y * W + X) * 4;
        img.data[o] = pal[c * 4];
        img.data[o + 1] = pal[c * 4 + 1];
        img.data[o + 2] = pal[c * 4 + 2];
        img.data[o + 3] = 255;
      }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, x: -ox * AUTOMAP_SCALE, y: -oy * AUTOMAP_SCALE, missing, suggested };
}

type OverlayState = Props & {
  automapImage: AutomapImage | null;
  walk: WalkPaths | null;
  resizeDrag: { current: { side: Side; delta: ResizeDelta } | null };
  walkCursor: { current: [number, number] | null };
};

function drawOverlay(canvas: HTMLCanvasElement, cam: Camera, s: OverlayState) {
  const ctx = canvas.getContext('2d')!;
  const { map, scene, visibility: v, hover, tool, selection, pasteRect, walk, objectLabel, selectedObject } = s;
  const { ds1 } = map;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom, 0, 0, cam.zoom, canvas.width / 2 - cam.x * cam.zoom, canvas.height / 2 - cam.y * cam.zoom);
  const px = 1 / cam.zoom; // one device pixel in world units

  if (s.automapImage) {
    // The automap as the game draws it, over a dimmed map; walls without an automap entry outlined.
    const am = s.automapImage;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.beginPath();
    diamond(ctx, 0, 0, ds1.width, ds1.height);
    ctx.fill();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(am.canvas, am.x, am.y, am.canvas.width * AUTOMAP_SCALE, am.canvas.height * AUTOMAP_SCALE);
    if (am.missing.length) {
      ctx.strokeStyle = 'rgba(255, 90, 200, 0.9)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      for (const [cx, cy] of am.missing) diamond(ctx, cx, cy);
      ctx.stroke();
    }
    if (am.suggested.length) {
      ctx.strokeStyle = 'rgba(110, 230, 255, 0.85)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      for (const [cx, cy] of am.suggested) diamond(ctx, cx, cy);
      ctx.stroke();
    }
  }

  // Red = blocks jumping/teleport too; amber = blocks walking.
  if (walk) drawWalk(ctx, canvas, cam, walk);
  // Sub-tiles a walkability stroke is painting: filled in the colour they are getting.
  if (s.walkMarks?.keys.size) {
    ctx.beginPath();
    for (const k of s.walkMarks.keys) {
      const [x, y] = subTileToWorld(k % 65536, Math.floor(k / 65536));
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x + 16, y);
      ctx.lineTo(x, y + 8);
      ctx.lineTo(x - 16, y);
      ctx.closePath();
    }
    ctx.fillStyle = s.walkMarks.mode === 'block' ? 'rgba(255, 150, 30, 0.55)' : 'rgba(90, 220, 120, 0.5)';
    ctx.fill();
    ctx.lineWidth = 1 * px;
    ctx.strokeStyle = s.walkMarks.mode === 'block' ? 'rgba(255, 190, 90, 0.9)' : 'rgba(150, 255, 170, 0.9)';
    ctx.stroke();
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

  if (s.pops?.show) drawPops(ctx, s.pops, ds1, px);

  // Special tiles (warps, entry points…): invisible in game, so marked and labelled here (at any zoom).
  if (v.specials && scene.specials.length) {
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = 'rgba(200, 140, 255, 0.9)';
    for (const sp of scene.specials) {
      ctx.fillStyle = sp.drawn ? 'rgba(180, 110, 255, 0.1)' : 'rgba(180, 110, 255, 0.25)';
      ctx.beginPath();
      diamond(ctx, sp.cellX + 0.1, sp.cellY + 0.1, 0.8, 0.8);
      ctx.fill();
      ctx.stroke();
      const [x, y] = cellToWorld(sp.cellX + 0.5, sp.cellY + 0.5);
      const text = s.specialLabel?.(sp.main, sp.sub) ?? specialTileInfo(sp.main, sp.sub).label;
      const size = Math.max(11 * px, 14);
      ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = 'rgba(20, 0, 40, 0.85)';
      ctx.strokeText(text, x, y + size * 0.35);
      ctx.fillStyle = 'rgba(235, 215, 255, 1)';
      ctx.fillText(text, x, y + size * 0.35);
      ctx.textAlign = 'start';
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = 'rgba(200, 140, 255, 0.9)';
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
    const cells = 'cells' in rect ? rect.cells : undefined;
    ctx.beginPath();
    if (cells) for (const k of cells) diamond(ctx, k % 65536, Math.floor(k / 65536));
    else diamond(ctx, rect.x0, rect.y0, rect.x1 - rect.x0 + 1, rect.y1 - rect.y0 + 1);
    ctx.fillStyle = fill;
    ctx.fill();
    // An irregular selection is outlined along its outer edges only.
    if (cells) {
      ctx.beginPath();
      const edge = (a: [number, number], b: [number, number]) => {
        const [ax, ay] = cellToWorld(...a);
        const [bx, by] = cellToWorld(...b);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      };
      for (const k of cells) {
        const x = k % 65536;
        const y = Math.floor(k / 65536);
        if (!cells.has(cellKey(x, y - 1))) edge([x, y], [x + 1, y]);
        if (!cells.has(cellKey(x + 1, y))) edge([x + 1, y], [x + 1, y + 1]);
        if (!cells.has(cellKey(x, y + 1))) edge([x, y + 1], [x + 1, y + 1]);
        if (!cells.has(cellKey(x - 1, y))) edge([x, y], [x, y + 1]);
      }
    }
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

  if (s.gameView?.on) {
    // What the character sees: the game's screen centred on the view; shade the rest.
    const { width: GAME_W, height: GAME_H } = s.gameView;
    const x0 = cam.x - GAME_W / 2;
    const y0 = cam.y - GAME_H / 2;
    const big = 1e6;
    ctx.fillStyle = 'rgba(5, 6, 9, 0.62)';
    ctx.beginPath();
    ctx.rect(-big, -big, 2 * big, 2 * big);
    ctx.rect(x0 + GAME_W, y0, -GAME_W, GAME_H); // counter-clockwise hole
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255, 215, 130, 0.9)';
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(x0, y0, GAME_W, GAME_H);
    ctx.font = `${12 * px}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255, 215, 130, 0.95)';
    ctx.fillText(`In-game screen (${GAME_W}×${GAME_H}) · the character stands at the centre`, x0 + 6 * px, y0 - 6 * px);
    ctx.beginPath();
    ctx.moveTo(cam.x - 8 * px, cam.y);
    ctx.lineTo(cam.x + 8 * px, cam.y);
    ctx.moveTo(cam.x, cam.y - 8 * px);
    ctx.lineTo(cam.x, cam.y + 8 * px);
    ctx.stroke();
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

  const wc = s.walkCursor.current;
  if (s.walkBrush && wc) {
    // The brush's footprint on the sub-tile grid: one diamond per sub-tile it paints, outlined as one shape.
    const { width: W, height: Hh } = ds1;
    const cells: [number, number][] = [];
    if (s.walkBrush.size === 'cell') {
      const [bx, by] = [Math.floor(wc[0] / 5) * 5, Math.floor(wc[1] / 5) * 5];
      for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) cells.push([bx + dx, by + dy]);
    } else {
      const r = (s.walkBrush.size - 1) / 2;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) cells.push([wc[0] + dx, wc[1] + dy]);
    }
    const inMap = cells.filter(([x, y]) => x >= 0 && y >= 0 && x < W * 5 && y < Hh * 5);
    if (inMap.length) {
      const set = new Set(inMap.map(([x, y]) => y * 65536 + x));
      const color = s.walkBrush.mode === 'block' ? [255, 176, 40] : [110, 230, 140];
      ctx.beginPath();
      for (const [x, y] of inMap) {
        const [cx, cy] = subTileToWorld(x, y);
        ctx.moveTo(cx, cy - 8);
        ctx.lineTo(cx + 16, cy);
        ctx.lineTo(cx, cy + 8);
        ctx.lineTo(cx - 16, cy);
        ctx.closePath();
      }
      ctx.fillStyle = `rgba(${color.join(',')}, 0.28)`;
      ctx.fill();
      // Outline: the edges of the footprint only (a sub-tile's corners are at ±16/±8 from its centre).
      ctx.beginPath();
      for (const [x, y] of inMap) {
        const [cx, cy] = subTileToWorld(x, y);
        const [n, e, so, w] = [[cx, cy - 8], [cx + 16, cy], [cx, cy + 8], [cx - 16, cy]] as const;
        const edge = (a: readonly number[], b: readonly number[]) => {
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        };
        if (!set.has((y - 1) * 65536 + x)) edge(n, e);
        if (!set.has(y * 65536 + x + 1)) edge(e, so);
        if (!set.has((y + 1) * 65536 + x)) edge(so, w);
        if (!set.has(y * 65536 + x - 1)) edge(w, n);
      }
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = `rgba(${color.join(',')}, 0.95)`;
      ctx.stroke();
    }
  } else if (hover && tool !== 'object') {
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
    const full = Math.max(4 * px, 5);
    ds1.objects.forEach((o, i) => {
      const [x, y] = subTileToWorld(o.x, o.y);
      const selected = i === selectedObject;
      // Objects drawn with their real sprite don't need a marker on top (the map should look like the game): only
      // when hovered or selected, or as a small dot in object mode. Invisible objects keep their full marker.
      const key = `${o.type}:${o.id}`;
      const drawn = v.sprites && (s.sprites.has(key) || !!s.animations?.get(key)?.parts.length);
      const hovered = !!hover && Math.floor(o.x / 5) === hover.cellX && Math.floor(o.y / 5) === hover.cellY;
      if (drawn && tool !== 'object' && !selected && !hovered) return;
      const r = drawn && !selected ? full * 0.6 : full;
      const showLabel = selected || hovered || (cam.zoom > 0.45 && (!drawn || tool === 'object'));
      ctx.beginPath();
      ctx.arc(x, y, selected ? r * 1.5 : r, 0, Math.PI * 2);
      ctx.fillStyle = o.type === 1 ? 'rgba(240, 80, 80, 0.9)' : 'rgba(80, 160, 255, 0.9)';
      ctx.fill();
      ctx.lineWidth = (selected ? 2.5 : 1) * px;
      ctx.strokeStyle = selected ? 'rgba(255, 225, 150, 1)' : 'rgba(0,0,0,0.8)';
      ctx.stroke();
      if (showLabel) {
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
