import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { decodeTile, Orientation, type Dt1Tile } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import type { TileLibrary } from '../game/GameData';
import type { Brush, LayerKind } from '../game/MapDocument';
import { ORIENTATION_NAMES } from './state';

interface Props {
  lib: TileLibrary;
  palette: Palette;
  layerKind: LayerKind;
  brush: Brush | null;
  onPick: (b: Brush) => void;
}

type WallFilter = 'all' | 'walls' | 'objects' | 'roofs' | 'lower';

const WALL_FILTERS: { id: WallFilter; label: string; test: (o: number) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'walls', label: 'Walls', test: (o) => o >= 1 && o <= 11 },
  { id: 'objects', label: 'Objects', test: (o) => o === Orientation.PillarsColumnsAndStandaloneObjects || o === Orientation.Tree },
  { id: 'roofs', label: 'Roofs', test: (o) => o === Orientation.Roof },
  { id: 'lower', label: 'Lower', test: (o) => o >= 16 },
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

const Thumb = memo(function Thumb({ tile, palette }: { tile: Dt1Tile; palette: Palette }) {
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

export function TilePalette({ lib, palette, layerKind, brush, onPick }: Props) {
  const [filter, setFilter] = useState<WallFilter>('all');
  const [query, setQuery] = useState('');

  const entries = useMemo(() => {
    const test = layerKind === 'wall' ? WALL_FILTERS.find((f) => f.id === filter)!.test : () => true;
    const q = query.trim();
    return lib
      .entries()
      .filter((e) => fitsLayer(layerKind, e.orientation) && test(e.orientation))
      .filter((e) => !q || `${e.main}/${e.sub}`.startsWith(q) || String(e.main) === q);
  }, [lib, layerKind, filter, query]);

  return (
    <div className="tile-palette">
      <div className="palette-controls">
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
      <div className="thumb-grid">
        {entries.map((e) => {
          const active = brush && brush.orientation === e.orientation && brush.main === e.main && brush.sub === e.sub;
          return (
            <button
              key={`${e.orientation}:${e.main}:${e.sub}`}
              className={`thumb${active ? ' active' : ''}`}
              title={`${ORIENTATION_NAMES[e.orientation] ?? `o${e.orientation}`} · main ${e.main} · sub ${e.sub}${e.tiles.length > 1 ? ` · ${e.tiles.length} variants` : ''}`}
              onClick={() => onPick({ orientation: e.orientation, main: e.main, sub: e.sub })}
            >
              <Thumb tile={e.tiles[0]} palette={palette} />
              <span className="thumb-label">
                {e.main}/{e.sub}
                {layerKind === 'wall' && <span className="thumb-o">o{e.orientation}</span>}
              </span>
            </button>
          );
        })}
        {entries.length === 0 && <div className="muted small pad">No tiles for this layer in the loaded DT1s.</div>}
      </div>
    </div>
  );
}
