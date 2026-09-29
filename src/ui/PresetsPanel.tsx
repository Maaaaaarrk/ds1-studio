import { memo, useEffect, useMemo, useState } from 'react';
import { decodeCell, isEmptyCell } from '../formats/ds1';
import { decodeTile, Orientation } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import { TileLibrary, type GameData } from '../game/GameData';
import type { Preset, SuggestProgress } from '../game/presets';
import { tilesAt } from '../render/scene';
import { normalizePath } from '../vfs/vfs';

/** Thumbnails per map (tile library + palette): the same preset looks different with another map's DT1s. */
const thumbCache = new WeakMap<TileLibrary, WeakMap<Palette, Map<string, string | null>>>();
function thumbsFor(lib: TileLibrary, palette: Palette): Map<string, string | null> {
  let byPal = thumbCache.get(lib);
  if (!byPal) thumbCache.set(lib, (byPal = new WeakMap()));
  let m = byPal.get(palette);
  if (!m) byPal.set(palette, (m = new Map()));
  return m;
}

/** Renders a preset's tiles (floors, then walls back to front) into a small image. */
function renderPreset(p: Preset, lib: TileLibrary, palette: Palette): string | null {
  const draws: { tile: ReturnType<typeof tilesAt>[number]; depth: number; order: number; shadow: boolean }[] = [];
  for (const l of p.layers) {
    l.cells.forEach((v, i) => {
      const c = decodeCell(v);
      if (isEmptyCell(c) || c.hidden) return;
      const o = l.kind === 'wall' ? (l.orientations?.[i] ?? 0) : l.kind === 'shadow' ? Orientation.Shadow : Orientation.Floor;
      const cx = i % p.width;
      const cy = Math.floor(i / p.width);
      for (const t of tilesAt(lib, o, c.mainIndex, c.subIndex, cx, cy)) draws.push({ tile: t, depth: cx + cy, order: l.kind === 'floor' ? 0 : l.kind === 'shadow' ? 1 : o === Orientation.Roof ? 3 : 2, shadow: l.kind === 'shadow' });
    });
  }
  draws.sort((a, b) => a.order - b.order || a.depth - b.depth);
  const imgs = draws.map((d) => ({ d, img: decodeTile(d.tile.tile) })).filter((x) => x.img && x.img.width > 0);
  if (!imgs.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { d, img } of imgs) {
    minX = Math.min(minX, d.tile.x + img!.offsetX);
    minY = Math.min(minY, d.tile.y + img!.offsetY);
    maxX = Math.max(maxX, d.tile.x + img!.offsetX + img!.width);
    maxY = Math.max(maxY, d.tile.y + img!.offsetY + img!.height);
  }
  const w = Math.ceil(maxX - minX);
  const h = Math.ceil(maxY - minY);
  if (w <= 0 || h <= 0 || w * h > 4096 * 4096) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(w, h);
  for (const { d, img } of imgs) {
    const ox = Math.round(d.tile.x + img!.offsetX - minX);
    const oy = Math.round(d.tile.y + img!.offsetY - minY);
    for (let y = 0; y < img!.height; y++)
      for (let x = 0; x < img!.width; x++) {
        const idx = img!.pixels[y * img!.width + x];
        if (!idx) continue;
        const o = ((oy + y) * w + ox + x) * 4;
        if (d.shadow) {
          const previous = data.data[o + 3] / 255, alpha = 0.45 + previous * 0.55;
          for (let ch = 0; ch < 3; ch++) data.data[o + ch] = data.data[o + ch] * previous * 0.55 / alpha;
          data.data[o + 3] = alpha * 255;
        } else data.data.set(palette.subarray(idx * 4, idx * 4 + 4), o);
      }
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL();
}

export const PresetThumb = memo(function PresetThumb({ preset, lib, palette }: { preset: Preset; lib: TileLibrary; palette: Palette }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const key = `${preset.id}:${preset.foundIn ?? ''}`;
    const cache = thumbsFor(lib, palette);
    if (!cache.has(key)) cache.set(key, renderPreset(preset, lib, palette));
    setUrl(cache.get(key));
  }, [preset, lib, palette]);
  return <div className="preset-img" style={url ? { backgroundImage: `url(${url})` } : undefined} />;
});

interface Props {
  gd: GameData;
  isPrepared: (p: Preset) => boolean;
  saved: Preset[];
  suggested: Preset[] | null;
  suggesting: SuggestProgress | null;
  lib: TileLibrary;
  palette: Palette;
  /** Loaded DT1 paths of the map, to flag presets that need other libraries. */
  dt1Paths: string[];
  hasSelection: boolean;
  canSave: boolean;
  onPlace: (p: Preset) => void;
  onSaveSelection: () => void;
  onSavePreset: (p: Preset) => void;
  onSuggest: () => void;
  onBuild: () => void;
}

function Card({ p, lib, gd, palette, missing, onPlace, onSave, onAddDt1s }: { p: Preset; lib: TileLibrary; gd: GameData; palette: Palette; missing: string[]; onPlace: () => void; onSave?: () => void; onAddDt1s: () => void }) {
  const [previewLib, setPreviewLib] = useState(lib);
  useEffect(() => {
    let live = true;
    void Promise.all(p.dt1s.map(async path => ({ path, dt1: await gd.dt1(path) }))).then(sources => {
      const own = new TileLibrary();
      for (const { path, dt1 } of sources) own.add(path, dt1);
      if (live) setPreviewLib(own);
    }).catch(() => { if (live) setPreviewLib(lib); });
    return () => { live = false; };
  }, [p, gd, lib]);
  return (
    <div className={`preset-card${missing.length ? ' needs' : ''}`} title={`${p.name} · ${p.width}×${p.height} cells${p.objects.length ? ` · ${p.objects.length} objects` : ''}\nTiles from: ${p.dt1s.map((d) => d.replace('data/global/tiles/', '')).join(', ')}${p.foundIn ? `\nFound in ${p.foundIn}` : ''}`}>
      <button className="preset-main" onClick={onPlace}>
        <PresetThumb preset={p} lib={previewLib} palette={palette} />
        <span className="preset-name">{p.name}</span>
        <span className="preset-meta muted small">
          {p.category}
          {p.occurrences ? ` · ×${p.occurrences}` : ''}
          {p.objects.length ? ` · ${p.objects.length} obj` : ''}
        </span>
      </button>
      {missing.length > 0 && (
        <button className="link small" onClick={onAddDt1s} title={missing.join('\n')}>
          needs tiles — review import
        </button>
      )}
      {onSave && (
        <button className="link small" onClick={onSave}>
          Save to mod
        </button>
      )}
    </div>
  );
}

/** Saved presets (mod folder) and suggestions; click one to place it like a paste. */
export function PresetsPanel(props: Props) {
  const { saved, suggested, suggesting, lib, palette, dt1Paths, hasSelection, canSave, onPlace, onSaveSelection, onSavePreset, onSuggest, onBuild } = props;
  const [query, setQuery] = useState('');
  const have = useMemo(() => new Set(dt1Paths.map(normalizePath)), [dt1Paths]);
  const missingOf = (p: Preset) => props.isPrepared(p) ? [] : p.dt1s.filter((d) => !have.has(normalizePath(d)));
  const match = (p: Preset) => !query.trim() || `${p.name} ${p.category}`.toLowerCase().includes(query.trim().toLowerCase());
  const groups = useMemo(() => {
    const m = new Map<string, Preset[]>();
    for (const p of saved.filter(match)) (m.get(p.category) ?? m.set(p.category, []).get(p.category)!).push(p);
    return [...m];
  }, [saved, query]);

  return (
    <section className="panel presets-panel">
      <div className="presets-sticky">
        <div className="panel-header static">
          <span>Presets</span>
          <span className="muted small">{saved.length} saved</span>
        </div>
        <div className="button-grid">
          <button className="btn" disabled={!canSave} onClick={onBuild}>Preset builder…</button>
          <button className="btn" disabled={!hasSelection || !canSave} onClick={onSaveSelection} title={canSave ? 'Save the selected cells as a preset (you choose what it keeps)' : 'No writable mod folder'}>
            Save selection…
          </button>
          <button className="btn" disabled={!!suggesting} onClick={onSuggest} title="Find recurring structures in maps that use these tile libraries">
            {suggesting ? `${suggesting.phase === 'scan' ? 'Scanning maps' : 'Analysing'} ${suggesting.done}/${suggesting.total}…` : 'Suggest presets'}
          </button>
        </div>
        <input className="search small-input preset-search" placeholder="Filter presets…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="panel-body">
        {groups.map(([cat, list]) => (
          <div key={cat}>
            <div className="field-label">{cat}</div>
            <div className="preset-grid">
              {list.map((p) => (
                <Card key={p.id} p={p} lib={lib} gd={props.gd} palette={palette} missing={missingOf(p)} onPlace={() => onPlace(p)} onAddDt1s={() => onPlace(p)} />
              ))}
            </div>
          </div>
        ))}
        {!saved.length && <p className="muted small">No saved presets yet. Select cells (V) and choose “Save selection…”, or save one of the suggestions.</p>}
        {suggested && (
          <>
            <div className="field-label">
              Suggested for this map <span className="muted small">{suggested.length}</span>
            </div>
            <div className="preset-grid">
              {suggested.filter(match).map((p) => (
                <Card
                  key={`${p.id}`}
                  p={p}
                  lib={lib}
                  gd={props.gd}
                  palette={palette}
                  missing={missingOf(p)}
                  onPlace={() => onPlace(p)}
                  onSave={canSave ? () => onSavePreset(p) : undefined}
                  onAddDt1s={() => onPlace(p)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
