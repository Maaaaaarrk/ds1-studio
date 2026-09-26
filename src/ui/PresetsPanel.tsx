import { memo, useEffect, useMemo, useState } from 'react';
import { decodeCell, isEmptyCell } from '../formats/ds1';
import { decodeTile, Orientation } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import type { TileLibrary } from '../game/GameData';
import type { Preset, SuggestProgress } from '../game/presets';
import { tilesAt } from '../render/scene';
import { normalizePath } from '../vfs/vfs';

const thumbCache = new Map<string, string | null>();

/** Renders a preset's tiles (floors, then walls back to front) into a small image. */
function renderPreset(p: Preset, lib: TileLibrary, palette: Palette): string | null {
  const draws: { tile: ReturnType<typeof tilesAt>[number]; depth: number; order: number }[] = [];
  for (const l of p.layers) {
    if (l.kind === 'shadow') continue;
    l.cells.forEach((v, i) => {
      const c = decodeCell(v);
      if (isEmptyCell(c) || c.hidden) return;
      const o = l.kind === 'wall' ? (l.orientations?.[i] ?? 0) : Orientation.Floor;
      const cx = i % p.width;
      const cy = Math.floor(i / p.width);
      for (const t of tilesAt(lib, o, c.mainIndex, c.subIndex, cx, cy)) draws.push({ tile: t, depth: cx + cy, order: l.kind === 'floor' ? 0 : o === Orientation.Roof ? 2 : 1 });
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
        data.data.set(palette.subarray(idx * 4, idx * 4 + 4), o);
      }
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL();
}

const PresetThumb = memo(function PresetThumb({ preset, lib, palette }: { preset: Preset; lib: TileLibrary; palette: Palette }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const key = `${preset.id}:${preset.foundIn ?? ''}`;
    if (!thumbCache.has(key)) thumbCache.set(key, renderPreset(preset, lib, palette));
    setUrl(thumbCache.get(key));
  }, [preset, lib, palette]);
  return <div className="preset-img" style={url ? { backgroundImage: `url(${url})` } : undefined} />;
});

interface Props {
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
  onAddDt1s: (paths: string[]) => void;
}

function Card({ p, lib, palette, missing, onPlace, onSave, onAddDt1s }: { p: Preset; lib: TileLibrary; palette: Palette; missing: string[]; onPlace: () => void; onSave?: () => void; onAddDt1s: () => void }) {
  return (
    <div className={`preset-card${missing.length ? ' needs' : ''}`} title={`${p.name} · ${p.width}×${p.height} cells${p.objects.length ? ` · ${p.objects.length} objects` : ''}\nTiles from: ${p.dt1s.map((d) => d.replace('data/global/tiles/', '')).join(', ')}${p.foundIn ? `\nFound in ${p.foundIn}` : ''}`}>
      <button className="preset-main" onClick={onPlace} disabled={missing.length > 0}>
        <PresetThumb preset={p} lib={lib} palette={palette} />
        <span className="preset-name">{p.name}</span>
        <span className="preset-meta muted small">
          {p.category}
          {p.occurrences ? ` · ×${p.occurrences}` : ''}
          {p.objects.length ? ` · ${p.objects.length} obj` : ''}
        </span>
      </button>
      {missing.length > 0 && (
        <button className="link small" onClick={onAddDt1s} title={missing.join('\n')}>
          needs {missing.length} DT1 — add
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
  const { saved, suggested, suggesting, lib, palette, dt1Paths, hasSelection, canSave, onPlace, onSaveSelection, onSavePreset, onSuggest, onAddDt1s } = props;
  const [query, setQuery] = useState('');
  const have = useMemo(() => new Set(dt1Paths.map(normalizePath)), [dt1Paths]);
  const missingOf = (p: Preset) => p.dt1s.filter((d) => !have.has(normalizePath(d)));
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
          <button className="btn" disabled={!hasSelection || !canSave} onClick={onSaveSelection} title={canSave ? 'Save the selected cells (all layers + objects) as a preset' : 'No writable mod folder'}>
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
                <Card key={p.id} p={p} lib={lib} palette={palette} missing={missingOf(p)} onPlace={() => onPlace(p)} onAddDt1s={() => onAddDt1s(missingOf(p))} />
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
                  palette={palette}
                  missing={missingOf(p)}
                  onPlace={() => onPlace(p)}
                  onSave={canSave ? () => onSavePreset(p) : undefined}
                  onAddDt1s={() => onAddDt1s(missingOf(p))}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
