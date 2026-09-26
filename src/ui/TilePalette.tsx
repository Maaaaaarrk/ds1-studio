import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  focus: PaletteFocus | null;
  onPick: (b: Brush) => void;
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

/** Tile thumbnails, cached per palette. */
const thumbCache = new WeakMap<Palette, WeakMap<Dt1Tile, string | null>>();

function thumbnail(tile: Dt1Tile, palette: Palette): string | null {
  let byTile = thumbCache.get(palette);
  if (!byTile) thumbCache.set(palette, (byTile = new WeakMap()));
  if (byTile.has(tile)) return byTile.get(tile)!;
  const img = decodeTile(tile);
  let url: string | null = null;
  if (img && img.width > 0 && img.height > 0) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.createImageData(img.width, img.height);
    for (let i = 0; i < img.pixels.length; i++) {
      const p = img.pixels[i] * 4;
      data.data.set(palette.subarray(p, p + 4), i * 4);
    }
    ctx.putImageData(data, 0, 0);
    url = canvas.toDataURL();
  }
  byTile.set(tile, url);
  return url;
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

export function TilePalette({ lib, palette, layerKind, brush, focus, onPick }: Props) {
  const [filter, setFilter] = useState<WallFilter>('all');
  const [query, setQuery] = useState('');
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
      <div
        className="thumb-grid"
        ref={grid}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumb + 14}px, 1fr))`, ['--thumb-h' as string]: `${thumb}px`, maxHeight: gridH, height: gridH }}
        title="Ctrl + scroll to zoom the thumbnails"
      >
        {entries.map((e) => {
          const active = brush && brush.orientation === e.orientation && brush.main === e.main && brush.sub === e.sub;
          const src = e.index === undefined ? null : `${shortPath(dt1)} #${e.index}`;
          const variants = e.tiles.length > 1 ? ` · ${e.tiles.length} variants` : '';
          const rarity = e.index !== undefined ? ` · ${e.tiles[0].animated ? 'frame' : 'rarity'} ${e.tiles[0].rarity}` : '';
          // Special tiles are invisible in game (and often have no picture): name what they do.
          const special = e.orientation === Orientation.SpecialTile1 || e.orientation === Orientation.SpecialTile2 ? specialTileInfo(e.main, e.sub) : null;
          return (
            <button
              key={e.index !== undefined ? `i${e.index}` : `${e.orientation}:${e.main}:${e.sub}`}
              className={`thumb${active ? ' active' : ''}${isFocused(e) ? ' focused' : ''}`}
              title={`${src ? `${src} · ` : ''}${ORIENTATION_NAMES[e.orientation] ?? `o${e.orientation}`} · main ${e.main} · sub ${e.sub}${variants}${rarity}${special ? `
${special.label}: ${special.help}` : ''}`}
              onClick={() => onPick({ orientation: e.orientation, main: e.main, sub: e.sub })}
            >
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
    </div>
  );
}
