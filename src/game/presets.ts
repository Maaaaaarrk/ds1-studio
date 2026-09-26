import { decodeCell, encodeCell, isEmptyCell, parseDs1, type Ds1, type Ds1Object, type WallCell } from '../formats/ds1';
import { Orientation } from '../formats/dt1';
import { normalizePath } from '../vfs/vfs';
import type { CellRect, Clipboard } from './clipboard';
import type { GameData, TileLibrary } from './GameData';
import type { LayerKind, LayerRef, MapDocument } from './MapDocument';
import { isBuiltinPath } from './specialTiles';

/** Where presets live: inside the mod, so they travel with it (and with exported map packages). */
export const PRESET_DIR = 'data/ds1studio/presets/';

/** A reusable block of cells (all tile layers) plus the objects/NPCs standing on it. */
export interface Preset {
  format: 'ds1studio-preset';
  version: 1;
  id: string;
  name: string;
  category: string;
  width: number;
  height: number;
  /** Tile libraries the preset's tiles come from (normalized game paths). */
  dt1s: string[];
  layers: { kind: LayerKind; index: number; cells: number[]; orientations?: number[] }[];
  /** Objects with sub-tile coordinates relative to the preset's top-left cell. */
  objects: Ds1Object[];
  /** For suggestions: how many times the structure occurs across the analysed maps. */
  occurrences?: number;
  /** For suggestions: a map it was found in. */
  foundIn?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'preset';

export function presetPath(p: Preset): string {
  return `${PRESET_DIR}${slug(p.name)}-${p.id}.json`;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** The DT1s that provide a set of cells' tiles. */
function dt1sOf(lib: TileLibrary, layers: Preset['layers']): string[] {
  const out = new Set<string>();
  for (const l of layers)
    l.cells.forEach((v, i) => {
      const c = decodeCell(v);
      if (isEmptyCell(c)) return;
      const o = l.kind === 'wall' ? (l.orientations?.[i] ?? 0) : l.kind === 'floor' ? Orientation.Floor : Orientation.Shadow;
      const t = lib.pick(o, c.mainIndex, c.subIndex, 0);
      const src = t && lib.sourceOf(t);
      if (src && !isBuiltinPath(src.path)) out.add(normalizePath(src.path));
    });
  return [...out].sort();
}

/**
 * Captures cells of a map as a preset. `mask` (optional, row-major over the rect) limits which cells are included, so
 * irregular structures don't carry the surrounding ground along.
 */
export function capturePreset(ds1: Ds1, lib: TileLibrary, r: CellRect, name: string, category: string, mask?: boolean[]): Preset {
  const width = r.x1 - r.x0 + 1;
  const height = r.y1 - r.y0 + 1;
  const take = <T>(cells: T[], empty: T): T[] => {
    const out: T[] = [];
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        const k = (y - r.y0) * width + (x - r.x0);
        out.push(mask && !mask[k] ? empty : cells[y * ds1.width + x]);
      }
    return out;
  };
  const layers: Preset['layers'] = [
    ...ds1.floors.map((l, index) => ({ kind: 'floor' as const, index, cells: take(l.map(encodeCell), 0) })),
    ...ds1.walls.map((l, index) => ({
      kind: 'wall' as const,
      index,
      cells: take(l.map(encodeCell), 0),
      orientations: take(l.map((c) => c.orientation), 0),
    })),
    ...ds1.shadows.map((l, index) => ({ kind: 'shadow' as const, index, cells: take(l.map(encodeCell), 0) })),
  ].filter((l) => l.cells.some((v) => v !== 0));
  const x0 = r.x0 * 5;
  const y0 = r.y0 * 5;
  const inside = (o: { x: number; y: number }) => {
    const cx = Math.floor(o.x / 5);
    const cy = Math.floor(o.y / 5);
    return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1 && (!mask || mask[(cy - r.y0) * width + (cx - r.x0)]);
  };
  const objects = ds1.objects.filter(inside).map((o) => ({
    ...o,
    x: o.x - x0,
    y: o.y - y0,
    path: o.path.map((p) => ({ ...p, x: p.x - x0, y: p.y - y0 })),
    pathOrder: undefined,
  }));
  return { format: 'ds1studio-preset', version: 1, id: newId(), name, category, width, height, dt1s: dt1sOf(lib, layers), layers, objects };
}

/** Selection → preset, from an open document. */
export function presetFromSelection(doc: MapDocument, lib: TileLibrary, r: CellRect, name: string, category: string): Preset {
  return capturePreset(doc.ds1, lib, r, name, category);
}

/** A preset as a clipboard for the paste tool (cells + objects). */
export function presetToClipboard(p: Preset): Clipboard {
  return {
    width: p.width,
    height: p.height,
    layers: p.layers.map((l) => ({
      layer: { kind: l.kind, index: l.index } as LayerRef,
      cells: l.cells.map((v, i) => {
        const c = decodeCell(v);
        return l.kind === 'wall' ? ({ ...c, orientation: l.orientations?.[i] ?? 0, orientationHigh: 0 } as WallCell) : c;
      }),
    })),
    objects: p.objects,
    dt1s: p.dt1s,
  };
}

export function parsePreset(bytes: Uint8Array): Preset | null {
  try {
    const p = JSON.parse(new TextDecoder().decode(bytes)) as Preset;
    return p.format === 'ds1studio-preset' && Array.isArray(p.layers) ? p : null;
  } catch {
    return null;
  }
}

export function serializePreset(p: Preset): Uint8Array {
  const { occurrences: _o, foundIn: _f, ...stored } = p;
  return new TextEncoder().encode(JSON.stringify(stored, null, 1));
}

/** Loads every saved preset from the mod folder. */
export async function loadPresets(gd: GameData): Promise<Preset[]> {
  const files = gd.fs.list((p) => p.startsWith(PRESET_DIR) && p.endsWith('.json'));
  const loaded = await Promise.all(files.map(async (f) => parsePreset((await gd.fs.read(f)) ?? new Uint8Array())));
  return loaded.filter((p): p is Preset => !!p).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------------------------
// Suggestions: recurring structures found in the maps that share this map's tile libraries.

const baseName = (p: string) => p.split('/').pop()!.replace(/\.dt1$/i, '');

function describe(p: Preset, orientations: Set<number>): { name: string; category: string } {
  const lib = p.dt1s.map(baseName);
  const main = lib.find((n) => !/^floor$/i.test(n)) ?? lib[0] ?? 'tiles';
  const size = `${p.width}×${p.height}`;
  const has = (...o: number[]) => o.some((x) => orientations.has(x));
  let kind = 'Structure';
  if (has(Orientation.Tree) && !has(1, 2, 3, 4, 5, 6, 7, 8, 9)) kind = 'Trees';
  else if (has(Orientation.Roof)) kind = 'Building';
  else if (has(8, 9)) kind = 'Wall with door';
  else if (has(1, 2) && (p.width === 1 || p.height === 1)) kind = 'Wall run';
  else if (has(3, 4, 5, 6, 7)) kind = 'Walls';
  else if (has(Orientation.PillarsColumnsAndStandaloneObjects)) kind = 'Props';
  else if (has(16, 17, 18, 19)) kind = 'Cliff / lower wall';
  return { name: `${kind} ${size}`, category: main };
}

export interface SuggestProgress {
  phase: 'scan' | 'analyse';
  done: number;
  total: number;
}

/**
 * Finds structures worth reusing: connected groups of wall-layer tiles (walls, objects, trees, roofs...) in every map
 * whose tile libraries overlap this one's, keeping those that are fully drawable with the current libraries.
 * Identical structures are merged and ranked by how often they occur.
 */
export async function suggestPresets(
  gd: GameData,
  current: { path: string; lib: TileLibrary; dt1Paths: string[] },
  onProgress?: (p: SuggestProgress) => void,
  limit = 60,
): Promise<Preset[]> {
  const have = new Set(current.dt1Paths.map(normalizePath));
  const candidates: string[] = [];
  const all = gd.fs.list((p) => p.startsWith('data/global/tiles/') && p.endsWith('.ds1'));
  for (const [i, p] of all.entries()) {
    if (i % 50 === 0) onProgress?.({ phase: 'scan', done: i, total: all.length });
    const bytes = await gd.fs.read(p);
    if (!bytes) continue;
    let ds1: Ds1;
    try {
      ds1 = parseDs1(bytes);
    } catch {
      continue;
    }
    const paths = gd.resolveDt1s(p, ds1).paths.map(normalizePath);
    const shared = paths.filter((x) => have.has(x)).length;
    if (shared && shared >= Math.min(2, paths.length)) candidates.push(p);
  }

  const found = new Map<string, Preset>();
  let done = 0;
  for (const path of candidates) {
    onProgress?.({ phase: 'analyse', done: done++, total: candidates.length });
    const ds1 = parseDs1((await gd.fs.read(path))!);
    const { width: w, height: h } = ds1;
    // Structure cells: any drawable wall-layer tile (special tiles are markers, not structure).
    const solid = new Uint8Array(w * h);
    for (const layer of ds1.walls)
      layer.forEach((c, i) => {
        if (!isEmptyCell(c) && c.orientation !== Orientation.SpecialTile1 && c.orientation !== Orientation.SpecialTile2) solid[i] = 1;
      });
    const seen = new Uint8Array(w * h);
    for (let start = 0; start < w * h; start++) {
      if (!solid[start] || seen[start]) continue;
      // Flood fill (8-connected) one structure.
      const cells: number[] = [];
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        cells.push(i);
        const x = i % w;
        const y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = ny * w + nx;
            if (solid[n] && !seen[n]) {
              seen[n] = 1;
              stack.push(n);
            }
          }
      }
      const xs = cells.map((i) => i % w);
      const ys = cells.map((i) => (i / w) | 0);
      const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const pw = r.x1 - r.x0 + 1;
      const ph = r.y1 - r.y0 + 1;
      // Skip single tiles (the Tiles panel has those) and map-spanning borders.
      if (cells.length < 2 || pw > 16 || ph > 16) continue;
      const mask = new Array<boolean>(pw * ph).fill(false);
      for (const i of cells) mask[(((i / w) | 0) - r.y0) * pw + ((i % w) - r.x0)] = true;
      const preset = capturePreset(ds1, current.lib, r, '', '', mask);
      // Only keep structures every tile of which the current map can draw.
      const drawable = preset.layers.every((l) =>
        l.cells.every((v, i) => {
          const c = decodeCell(v);
          if (isEmptyCell(c)) return true;
          const o = l.kind === 'wall' ? (l.orientations?.[i] ?? 0) : l.kind === 'floor' ? Orientation.Floor : Orientation.Shadow;
          return o === Orientation.SpecialTile1 || o === Orientation.SpecialTile2 || (o === Orientation.Floor && c.mainIndex >= 30) || current.lib.variants(o, c.mainIndex, c.subIndex).length > 0;
        }),
      );
      if (!drawable) continue;
      // Identity ignores prop1 flags and objects (so the same building with other NPCs merges).
      const key = JSON.stringify([pw, ph, preset.layers.filter((l) => l.kind === 'wall').map((l) => l.cells.map((v, i) => `${(v >>> 8) & 0xffffff}:${l.orientations?.[i]}`))]);
      const prev = found.get(key);
      if (prev) prev.occurrences = (prev.occurrences ?? 1) + 1;
      else {
        const orientations = new Set(preset.layers.flatMap((l) => l.orientations ?? []).filter((o) => o > 0));
        const { name, category } = describe(preset, orientations);
        found.set(key, { ...preset, name, category, occurrences: 1, foundIn: path });
      }
    }
  }
  onProgress?.({ phase: 'analyse', done: candidates.length, total: candidates.length });
  return [...found.values()]
    .sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0) || b.width * b.height - a.width * a.height)
    .slice(0, limit);
}
