import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { decodeCell, isEmptyCell } from '../formats/ds1';
import { decodeTile, Orientation } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import { TileLibrary, type GameData } from '../game/GameData';
import type { Preset, SuggestProgress } from '../game/presets';
import { tilesAt } from '../render/scene';
import { normalizePath } from '../vfs/vfs';
import { ContextMenu, type MenuEntry } from './ContextMenu';

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

/** The picture of a preset with this library and palette (rendered once, then cached). */
function presetPicture(preset: Preset, lib: TileLibrary, palette: Palette): string | null {
  const key = `${preset.id}:${preset.foundIn ?? ''}`;
  const cache = thumbsFor(lib, palette);
  if (!cache.has(key)) cache.set(key, renderPreset(preset, lib, palette));
  return cache.get(key) ?? null;
}

/**
 * An enlarged view of a preset while the pointer rests on its card, beside the side panel: the picture at up to its
 * real size (crisp pixels), and what the preset holds.
 */
function PresetPreview({ p, lib, palette, rect, missing }: { p: Preset; lib: TileLibrary; palette: Palette; rect: DOMRect; missing: string[] }) {
  const url = presetPicture(p, lib, palette);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  }, [url]);
  const maxW = Math.min(560, window.innerWidth * 0.5);
  const maxH = Math.min(460, window.innerHeight - 160);
  const scale = size ? Math.min(2, maxW / size.w, maxH / size.h) : 1;
  const w = Math.max(240, (size ? size.w * scale : 200) + 20);
  const lines = [
    `${p.width}×${p.height} cells · ${p.category}${p.objects.length ? ` · ${p.objects.length} object${p.objects.length === 1 ? '' : 's'}` : ''}${p.occurrences ? ` · found ×${p.occurrences}` : ''}`,
    `Tiles from: ${p.dt1s.map((d) => d.replace(/^data\/global\/tiles\//i, '')).join(', ') || '—'}`,
    ...(p.foundIn ? [`Found in ${p.foundIn.replace(/^data\/global\/tiles\//i, '')}`] : []),
    ...(missing.length ? [`Needs ${missing.length} tile ${missing.length === 1 ? 'library' : 'libraries'} this map doesn't load`] : []),
  ];
  const h = (size ? size.h * scale : 60) + 36 + lines.length * 18;
  const left = rect.left - w - 12 >= 8 ? rect.left - w - 12 : Math.max(8, Math.min(rect.right + 12, window.innerWidth - w - 8));
  const top = Math.min(Math.max(8, rect.top + rect.height / 2 - h / 2), window.innerHeight - h - 8);
  return createPortal(
    <div className="tile-preview preset-preview" style={{ left, top, width: w }}>
      <div className="tile-preview-title">{p.name}</div>
      {url ? (
        size && <img src={url} alt="" width={Math.round(size.w * scale)} height={Math.round(size.h * scale)} className="tile-preview-img" />
      ) : (
        <div className="muted small">No picture (its tiles aren't in the loaded libraries)</div>
      )}
      {lines.map((l) => (
        <div key={l} className="tile-preview-line">
          {l}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Thumbnails waiting to be drawn: one per slice of idle time, so opening the panel never waits for all of them. */
const thumbQueue: (() => void)[] = [];
let thumbTimer = 0;
function queueThumb(job: () => void): () => void {
  thumbQueue.push(job);
  if (!thumbTimer) thumbTimer = window.setTimeout(drainThumbs, 0);
  return () => {
    const i = thumbQueue.indexOf(job);
    if (i >= 0) thumbQueue.splice(i, 1);
  };
}
function drainThumbs() {
  const until = performance.now() + 12;
  while (thumbQueue.length && performance.now() < until) thumbQueue.shift()!();
  thumbTimer = thumbQueue.length ? window.setTimeout(drainThumbs, 0) : 0;
}

export const PresetThumb = memo(function PresetThumb({ preset, lib, palette }: { preset: Preset; lib: TileLibrary | null; palette: Palette }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = `${preset.id}:${preset.foundIn ?? ''}`;
  const cached = lib ? thumbsFor(lib, palette).get(key) : undefined;
  const [url, setUrl] = useState<string | null | undefined>(cached);
  useEffect(() => {
    if (!lib) return;
    const cache = thumbsFor(lib, palette);
    if (cache.has(key)) {
      setUrl(cache.get(key));
      return;
    }
    // Drawn once the card is on screen, between frames.
    let cancel = () => {};
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      cancel = queueThumb(() => {
        if (!cache.has(key)) cache.set(key, renderPreset(preset, lib, palette));
        setUrl(cache.get(key));
      });
    });
    io.observe(ref.current!);
    return () => {
      io.disconnect();
      cancel();
    };
  }, [preset, lib, palette, key]);
  return <div ref={ref} className={`preset-img${url === undefined ? ' loading' : ''}`} style={url ? { backgroundImage: `url(${url})` } : undefined} />;
});

/** Each preset's own tile library (its DT1s), loaded once and shared, so its thumbnail is drawn once. */
const presetLibs = new WeakMap<GameData, Map<string, Promise<TileLibrary>>>();
function presetLibrary(gd: GameData, p: Preset): Promise<TileLibrary> {
  let m = presetLibs.get(gd);
  if (!m) presetLibs.set(gd, (m = new Map()));
  const key = `${p.id}|${p.dt1s.join('|')}`;
  let lib = m.get(key);
  if (!lib) {
    lib = Promise.all(p.dt1s.map(async (path) => ({ path, dt1: await gd.dt1(path) }))).then((sources) => {
      const own = new TileLibrary();
      for (const { path, dt1 } of sources) own.add(path, dt1);
      return own;
    });
    m.set(key, lib);
  }
  return lib;
}

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
  /** Saved presets: rename / recategorise (a changed copy replaces it), duplicate, delete. */
  onUpdate: (p: Preset, change: { name?: string; category?: string }) => void;
  onDuplicate: (p: Preset) => void;
  onDelete: (p: Preset) => void;
  /** Ask before deleting a preset (Preferences). */
  confirmDelete?: boolean;
}

function Card({ p, lib, gd, palette, missing, onPlace, onSave, onAddDt1s, onMenu }: { p: Preset; lib: TileLibrary; gd: GameData; palette: Palette; missing: string[]; onPlace: () => void; onSave?: () => void; onAddDt1s: () => void; onMenu?: (x: number, y: number) => void }) {
  // The preset's own libraries (shared between openings of the panel); drawn with nothing until they're loaded.
  const [previewLib, setPreviewLib] = useState<TileLibrary | null>(null);
  useEffect(() => {
    let live = true;
    presetLibrary(gd, p).then(
      (own) => live && setPreviewLib(own),
      () => live && setPreviewLib(lib),
    );
    return () => {
      live = false;
    };
  }, [p, gd, lib]);
  // The enlarged preview after the pointer rests on the card a moment.
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const timer = useRef<number | null>(null);
  const endHover = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setHoverRect(null);
  };
  useEffect(() => endHover, []);
  return (
    <div
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setHoverRect(el.getBoundingClientRect()), 300);
      }}
      onMouseLeave={endHover}
      onMouseDown={endHover}
      className={`preset-card${missing.length ? ' needs' : ''}`}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}>
      <button className="preset-main" onClick={onPlace}>
        <PresetThumb preset={p} lib={previewLib} palette={palette} />
        <span className="preset-name">{p.name}</span>
        <span className="preset-meta muted small">
          {p.category}
          {p.occurrences ? ` · ×${p.occurrences}` : ''}
          {p.objects.length ? ` · ${p.objects.length} obj` : ''}
        </span>
      </button>
      {hoverRect && previewLib && <PresetPreview p={p} lib={previewLib} palette={palette} rect={hoverRect} missing={missing} />}
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
  const [menu, setMenu] = useState<{ p: Preset; x: number; y: number; saved: boolean } | null>(null);
  const categories = useMemo(() => [...new Set(saved.map((p) => p.category))].sort(), [saved]);
  const menuEntries = (m: { p: Preset; saved: boolean }): (MenuEntry | null)[] =>
    m.saved
      ? [
          { label: 'Place', onClick: () => onPlace(m.p) },
          null,
          {
            label: 'Rename…',
            disabled: !canSave,
            onClick: () => {
              const name = window.prompt('Preset name', m.p.name)?.trim();
              if (name && name !== m.p.name) props.onUpdate(m.p, { name });
            },
          },
          {
            label: 'Move to category',
            disabled: !canSave,
            children: [
              ...categories.filter((c) => c !== m.p.category).map((c) => ({ label: c, onClick: () => props.onUpdate(m.p, { category: c }) })),
              {
                label: 'New category…',
                onClick: () => {
                  const category = window.prompt('Category', m.p.category)?.trim();
                  if (category && category !== m.p.category) props.onUpdate(m.p, { category });
                },
              },
            ],
          },
          { label: 'Duplicate', disabled: !canSave, onClick: () => props.onDuplicate(m.p) },
          null,
          {
            label: 'Delete…',
            disabled: !canSave,
            title: 'Removes the preset from the mod (its file is kept aside as a backup)',
            onClick: () => {
              if (props.confirmDelete === false || window.confirm(`Delete the preset "${m.p.name}"?`)) props.onDelete(m.p);
            },
          },
        ]
      : [
          { label: 'Place', onClick: () => onPlace(m.p) },
          { label: 'Save to mod', disabled: !canSave, onClick: () => onSavePreset(m.p) },
        ];
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
            <div className="preset-cat">
              <span>{cat}</span>
              <span className="preset-cat-count">{list.length}</span>
            </div>
            <div className="preset-grid">
              {list.map((p) => (
                <Card key={p.id} p={p} lib={lib} gd={props.gd} palette={palette} missing={missingOf(p)} onPlace={() => onPlace(p)} onAddDt1s={() => onPlace(p)} onMenu={(x, y) => setMenu({ p, x, y, saved: true })} />
              ))}
            </div>
          </div>
        ))}
        {!saved.length && <p className="muted small">No saved presets yet. Select cells (V) and choose “Save selection…”, or save one of the suggestions.</p>}
        {suggested && (
          <>
            <div className="preset-cat">
              <span>Suggested for this map</span>
              <span className="preset-cat-count">{suggested.length}</span>
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
                  onMenu={(x, y) => setMenu({ p, x, y, saved: false })}
                />
              ))}
            </div>
          </>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.p.name} entries={menuEntries(menu)} onClose={() => setMenu(null)} />}
    </section>
  );
}
