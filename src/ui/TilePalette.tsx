import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { decodeTile, Orientation, type Dt1Tile } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import type { TileLibrary } from '../game/GameData';
import type { Brush, LayerKind } from '../game/MapDocument';
import { Splitter, usePersistentSize } from './Splitter';
import { specialTileInfo } from '../game/specialTiles';
import { ORIENTATION_NAMES } from './state';

interface Props {
  lib: TileLibrary;
  palette: Palette;
  layerKind: LayerKind;
  brush: Brush | null;
  /** Extra tiles painted at random together with the brush (Ctrl+click adds). */
  mix?: Brush[];
  focus: PaletteFocus | null;
  /** `add`: Ctrl/Shift+click, add to (or remove from) the random mix instead of replacing the brush. */
  onPick: (b: Brush, add?: boolean) => void;
  /** Recently used and pinned tiles of this map's tile set, shown above the grid. */
  recent?: Brush[];
  favourites?: Brush[];
  onToggleFavourite?: (b: Brush) => void;
}

const sameBrush = (a: Brush, b: Brush) => a.orientation === b.orientation && a.main === b.main && a.sub === b.sub;

/** A strip of small tile buttons (recent / favourite tiles). */
function TileStrip({ label, list, lib, palette, layerKind, brush, onPick, onToggleFavourite, favourites }: { label: string; list: Brush[]; lib: TileLibrary; palette: Palette; layerKind: LayerKind; brush: Brush | null; onPick: Props['onPick']; onToggleFavourite?: (b: Brush) => void; favourites: Brush[] }) {
  const shown = list.filter((b) => fitsLayer(layerKind, b.orientation)).map((b) => ({ b, tile: lib.pick(b.orientation, b.main, b.sub, 0) })).filter((x) => x.tile);
  const [preview, hover] = usePreview();
  if (!shown.length) return null;
  return (
    <div className="tile-strip">
      <span className="tile-strip-label muted small">{label}</span>
      <div className="tile-strip-row">
        {shown.map(({ b, tile }) => (
          <button
            key={`${b.orientation}:${b.main}:${b.sub}`}
            className={`thumb mini${brush && sameBrush(brush, b) ? ' active' : ''}`}
            {...hover(() => ({
              tile: tile!,
              title: `${ORIENTATION_NAMES[b.orientation] ?? `o${b.orientation}`} · main ${b.main} · sub ${b.sub}`,
              lines: [`Click: paint · Ctrl+click: add to the mix · right-click: ${favourites.some((f) => sameBrush(f, b)) ? 'unpin' : 'pin'}`],
            }))}
            onClick={(e) => onPick(b, e.ctrlKey || e.metaKey || e.shiftKey)}
            onContextMenu={(e) => {
              e.preventDefault();
              onToggleFavourite?.(b);
            }}
          >
            <Thumb tile={tile!} palette={palette} />
          </button>
        ))}
      </div>
      {preview && <TilePreview p={preview} palette={palette} />}
    </div>
  );
}

type WallFilter = 'all' | 'walls' | 'objects' | 'roofs' | 'lower' | 'special';

const WALL_FILTERS: { id: WallFilter; label: string; test: (o: number) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'walls', label: 'Walls', test: (o) => o >= 1 && o <= 9 },
  { id: 'objects', label: 'Objects', test: (o) => o === Orientation.PillarsColumnsAndStandaloneObjects || o === Orientation.Tree },
  { id: 'roofs', label: 'Roofs', test: (o) => o === Orientation.Roof },
  { id: 'lower', label: 'Lower', test: (o) => o >= 16 },
  { id: 'special', label: 'Special', test: (o) => o === Orientation.SpecialTile1 || o === Orientation.SpecialTile2 },
];

function fitsLayer(kind: LayerKind, o: number): boolean {
  if (kind === 'floor') return o === Orientation.Floor;
  if (kind === 'shadow') return o === Orientation.Shadow;
  // The orientation-4 half of a north corner is drawn automatically with orientation 3.
  return o !== Orientation.Floor && o !== Orientation.Shadow && o !== Orientation.LeftPartOfNorthCornerWall;
}

/**
 * The game's palettes are dark (the game lights tiles up at run time), so the palette's tiles are shown brighter: a
 * gamma lift of each channel. Only these pictures change; the map and the files don't.
 */
const LIFT = (() => {
  const t = new Uint8Array(256);
  for (let v = 0; v < 256; v++) t[v] = Math.min(255, Math.round(255 * Math.pow(v / 255, 0.72)));
  return t;
})();

/** Tile pictures (brightened), cached per palette. */
const thumbCache = new WeakMap<Palette, WeakMap<Dt1Tile, { url: string; width: number; height: number } | null>>();

function tilePicture(tile: Dt1Tile, palette: Palette): { url: string; width: number; height: number } | null {
  let byTile = thumbCache.get(palette);
  if (!byTile) thumbCache.set(palette, (byTile = new WeakMap()));
  if (byTile.has(tile)) return byTile.get(tile)!;
  const img = decodeTile(tile);
  let pic: { url: string; width: number; height: number } | null = null;
  if (img && img.width > 0 && img.height > 0) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.createImageData(img.width, img.height);
    for (let i = 0; i < img.pixels.length; i++) {
      const p = img.pixels[i] * 4;
      data.data[i * 4] = LIFT[palette[p]];
      data.data[i * 4 + 1] = LIFT[palette[p + 1]];
      data.data[i * 4 + 2] = LIFT[palette[p + 2]];
      data.data[i * 4 + 3] = palette[p + 3];
    }
    ctx.putImageData(data, 0, 0);
    pic = { url: canvas.toDataURL(), width: img.width, height: img.height };
  }
  byTile.set(tile, pic);
  return pic;
}

const thumbnail = (tile: Dt1Tile, palette: Palette) => tilePicture(tile, palette)?.url ?? null;

/** What the hover preview shows: the tile, where it sits on screen, and lines about it. */
interface PreviewState {
  tile: Dt1Tile;
  rect: DOMRect;
  title: string;
  lines: string[];
}

/**
 * An enlarged view of a tile while the pointer rests on it in the palette, beside the side panel: the picture up to 3×
 * (crisp pixels), and what the tile is.
 */
function TilePreview({ p, palette }: { p: PreviewState; palette: Palette }) {
  const pic = tilePicture(p.tile, palette);
  const scale = pic ? Math.max(1, Math.min(3, 300 / pic.width, 280 / pic.height)) : 1;
  const w = Math.max(200, (pic ? pic.width * scale : 0) + 20);
  const h = (pic ? pic.height * scale : 40) + 30 + p.lines.length * 16;
  const left = Math.max(8, p.rect.left - w - 12);
  const top = Math.min(Math.max(8, p.rect.top + p.rect.height / 2 - h / 2), window.innerHeight - h - 8);
  return createPortal(
    <div className="tile-preview" style={{ left, top, width: w }}>
      <div className="tile-preview-title">{p.title}</div>
      {pic ? (
        <img src={pic.url} alt="" width={pic.width * scale} height={pic.height * scale} className="tile-preview-img" />
      ) : (
        <div className="muted small">No picture (invisible in game)</div>
      )}
      {p.lines.map((l) => (
        <div key={l} className="tile-preview-line">
          {l}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Hover handlers that open the preview after a short rest (none while the mouse just passes over). */
function usePreview(): [PreviewState | null, (make: () => Omit<PreviewState, 'rect'>) => { onMouseEnter: (e: ReactMouseEvent) => void; onMouseLeave: () => void }, () => void] {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const timer = useRef<number | null>(null);
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setPreview(null);
  };
  useEffect(() => hide, []);
  const handlers = (make: () => Omit<PreviewState, 'rect'>) => ({
    onMouseEnter: (e: ReactMouseEvent) => {
      const el = e.currentTarget as HTMLElement;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setPreview({ ...make(), rect: el.getBoundingClientRect() }), 250);
    },
    onMouseLeave: hide,
  });
  return [preview, handlers, hide];
}

export const Thumb = memo(function Thumb({ tile, palette }: { tile: Dt1Tile; palette: Palette }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  // Decode lazily, only once the thumbnail scrolls into view.
  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setUrl(thumbnail(tile, palette));
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [tile, palette]);
  return <div ref={ref} className="thumb-img" style={url ? { backgroundImage: `url(${url})` } : undefined} />;
});

/** A tile to reveal in the palette (switches to its DT1 and scrolls to it); `seq` re-triggers for the same tile. */
export interface PaletteFocus {
  tile: Dt1Tile;
  seq: number;
}

interface Entry {
  orientation: number;
  main: number;
  sub: number;
  tiles: Dt1Tile[];
  /** Index in its DT1 (single-DT1 view only). */
  index?: number;
}

const shortPath = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

export function TilePalette({ lib, palette, layerKind, brush, mix = [], focus, onPick, recent = [], favourites = [], onToggleFavourite }: Props) {
  const [filter, setFilter] = useState<WallFilter>('all');
  const [query, setQuery] = useState('');
  const [preview, hover, hidePreview] = usePreview();
  const [dt1, setDt1] = useState<string>('all');
  const grid = useRef<HTMLDivElement>(null);
  /** Set by a focus request until the focused thumbnail has been scrolled into view. */
  const pendingScroll = useRef<{ seq: number; dt1: string | null } | null>(null);
  const [gridH, setGridH] = usePersistentSize('tiles', 340, 120, 1400);
  const [thumb, setThumb] = useState(() => {
    try {
      return Number(localStorage.getItem('ds1studio.thumbSize')) || 52;
    } catch {
      return 52;
    }
  });

  // Ctrl + wheel zooms the thumbnails (a native listener, so the page itself doesn't zoom).
  useEffect(() => {
    const el = grid.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setThumb((t) => {
        const next = Math.round(Math.min(220, Math.max(36, t * Math.exp(-e.deltaY * 0.0015))));
        try {
          localStorage.setItem('ds1studio.thumbSize', String(next));
        } catch {
          // per-viewer convenience only
        }
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // A new map (tile library) starts in the combined view.
  useEffect(() => setDt1('all'), [lib]);

  // Reveal a focused tile: open its DT1, clear filters, then scroll it into view.
  useEffect(() => {
    if (!focus) return;
    const src = lib.sourceOf(focus.tile);
    if (src) setDt1(src.path);
    setFilter('all');
    setQuery('');
    pendingScroll.current = { seq: focus.seq, dt1: src?.path ?? null };
  }, [focus, lib]);

  const dt1s = useMemo(
    () =>
      lib.loaded
        .filter((l) => l.found)
        .map((l) => ({ path: l.path, count: lib.tilesOf(l.path).filter((t) => fitsLayer(layerKind, t.orientation)).length }))
        .filter((l) => l.count > 0),
    [lib, layerKind],
  );

  const entries = useMemo((): Entry[] => {
    const test = layerKind === 'wall' ? WALL_FILTERS.find((f) => f.id === filter)!.test : () => true;
    const q = query.trim();
    const all: Entry[] =
      dt1 === 'all'
        ? lib.entries()
        : lib.tilesOf(dt1).map((t, index) => ({ orientation: t.orientation, main: t.mainIndex, sub: t.subIndex, tiles: [t], index }));
    return all
      .filter((e) => fitsLayer(layerKind, e.orientation) && test(e.orientation))
      .filter((e) => !q || `${e.main}/${e.sub}`.startsWith(q) || String(e.main) === q);
  }, [lib, layerKind, filter, query, dt1]);

  // Scroll once the focused tile is actually rendered: opening its DT1 or switching layer re-renders the grid first.
  useLayoutEffect(() => {
    const want = pendingScroll.current;
    if (!want || (want.dt1 !== null && want.dt1 !== dt1)) return;
    const el = grid.current?.querySelector('.thumb.focused');
    if (!el) return;
    pendingScroll.current = null;
    el.scrollIntoView({ block: 'center' });
  });

  const isFocused = (e: Entry) =>
    !!focus &&
    (e.index !== undefined
      ? e.tiles[0] === focus.tile
      : e.orientation === focus.tile.orientation && e.main === focus.tile.mainIndex && e.sub === focus.tile.subIndex);

  return (
    <div className="tile-palette">
      <div className="palette-controls">
        <select className="dt1-select" value={dt1} onChange={(e) => setDt1(e.target.value)} title="Browse one tile library (DT1) at a time">
          <option value="all">All tile libraries (combined)</option>
          {dt1s.map((d) => (
            <option key={d.path} value={d.path}>
              {shortPath(d.path)} ({d.count})
            </option>
          ))}
        </select>
        {layerKind === 'wall' && (
          <div className="chips">
            {WALL_FILTERS.map((f) => (
              <button key={f.id} className={`chip${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        )}
        <input className="search small-input" placeholder="main/sub…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <TileStrip label="★ Pinned" list={favourites} lib={lib} palette={palette} layerKind={layerKind} brush={brush} onPick={onPick} onToggleFavourite={onToggleFavourite} favourites={favourites} />
      <TileStrip label="Recent" list={recent} lib={lib} palette={palette} layerKind={layerKind} brush={brush} onPick={onPick} onToggleFavourite={onToggleFavourite} favourites={favourites} />
      <div
        className="thumb-grid"
        ref={grid}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumb + 14}px, 1fr))`, ['--thumb-h' as string]: `${thumb}px`, maxHeight: gridH, height: gridH }}
        title="Ctrl + scroll to zoom the thumbnails"
        onScroll={hidePreview}
      >
        {entries.map((e) => {
          const me = { orientation: e.orientation, main: e.main, sub: e.sub };
          const active = brush && sameBrush(brush, me);
          const mixed = !active && mix.some((m) => sameBrush(m, me));
          const pinned = favourites.some((f) => sameBrush(f, me));
          const src = e.index === undefined ? null : `${shortPath(dt1)} #${e.index}`;
          const variants = e.tiles.length > 1 ? ` · ${e.tiles.length} variants` : '';
          const rarity = e.index !== undefined ? ` · ${e.tiles[0].animated ? 'frame' : 'rarity'} ${e.tiles[0].rarity}` : '';
          // Special tiles are invisible in game (and often have no picture): name what they do.
          const special = e.orientation === Orientation.SpecialTile1 || e.orientation === Orientation.SpecialTile2 ? specialTileInfo(e.main, e.sub) : null;
          return (
            <button
              key={e.index !== undefined ? `i${e.index}` : `${e.orientation}:${e.main}:${e.sub}`}
              className={`thumb${active ? ' active' : ''}${mixed ? ' mixed' : ''}${isFocused(e) ? ' focused' : ''}`}
              {...hover(() => {
                const pic = tilePicture(e.tiles[0], palette);
                return {
                  tile: e.tiles[0],
                  title: `${ORIENTATION_NAMES[e.orientation] ?? `o${e.orientation}`} · main ${e.main} · sub ${e.sub}`,
                  lines: [
                    ...(src ? [src] : []),
                    [pic ? `${pic.width}×${pic.height} px` : '', variants.replace(/^ · /, ''), rarity.replace(/^ · /, '')].filter(Boolean).join(' · '),
                    ...(special ? [`${special.label}: ${special.help}`] : []),
                    `Click: paint with it · Ctrl+click: add to a random mix · right-click: ${pinned ? 'unpin' : 'pin to the top'}`,
                  ].filter(Boolean),
                };
              })}
              onClick={(ev) => onPick(me, ev.ctrlKey || ev.metaKey || ev.shiftKey)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                onToggleFavourite?.(me);
              }}
            >
              {pinned && <span className="thumb-pin">★</span>}
              <Thumb tile={e.tiles[0]} palette={palette} />
              {special && <span className="thumb-special">{special.label}</span>}
              <span className="thumb-label">
                {e.index !== undefined && <span className="thumb-o">#{e.index}</span>}
                {e.main}/{e.sub}
                {layerKind === 'wall' && <span className="thumb-o">o{e.orientation}</span>}
              </span>
            </button>
          );
        })}
        {entries.length === 0 && <div className="muted small pad">No tiles for this layer in {dt1 === 'all' ? 'the loaded DT1s' : 'this DT1'}.</div>}
      </div>
      <Splitter axis="y" direction={1} size={gridH} onResize={setGridH} className="pane-handle" title="Drag to make the tiles pane taller or shorter" />
      {preview && <TilePreview p={preview} palette={palette} />}
    </div>
  );
}
