import { isEmptyCell, withFields, type WallCell } from '../formats/ds1';
import { parseDt1 } from '../formats/dt1';
import { buildDt1 } from '../formats/dt1Write';
import { normalizePath } from '../vfs/vfs';
import { clipboardSources, type Clipboard } from './clipboard';
import { planCustomDt1, type TilePick } from './customDt1';
import { TileLibrary } from './GameData';

export const tileKey = (o: number, m: number, s: number) => `${o}|${m}|${s}`;
const orientation = (kind: string, c: { orientation?: number }) => kind === 'floor' ? 0 : kind === 'shadow' ? 13 : c.orientation ?? 0;

/** Older presets did not record per-tile sources. Resolve those from their own libraries, never the destination. */
export async function resolvePresetSources(clip: Clipboard, read: (path: string) => Promise<Uint8Array | null>): Promise<Clipboard> {
  if (clip.tileSources) return clip;
  const lib = new TileLibrary();
  for (const path of clip.dt1s ?? []) {
    const bytes = await read(path);
    if (!bytes) throw new Error(`Preset tile library is missing: ${path}`);
    lib.add(normalizePath(path), parseDt1(bytes));
  }
  return { ...clip, ...clipboardSources(clip, lib) };
}

/** Copy only required missing identities, including variants, animation frames and corner partners. */
export async function preparePresetLibrary(clip: Clipboard, target: TileLibrary, path: string, read: (path: string) => Promise<Uint8Array | null>) {
  clip = await resolvePresetSources(clip, read);
  const sources = new Map<string, Uint8Array>();
  const parsed = new Map<string, ReturnType<typeof parseDt1>>();
  const picks: TilePick[] = [];
  const needed = new Map<string, string>();
  const seen = new Set<string>();
  for (const { layer, cells } of clip.layers) for (const c of cells) {
    if (isEmptyCell(c)) continue;
    const o = orientation(layer.kind, c as WallCell), key = tileKey(o, c.mainIndex, c.subIndex);
    if (o === 10 || o === 11 || seen.has(key)) continue;
    seen.add(key);
    const from = clip.tileSources?.[key];
    const variants = target.variants(o, c.mainIndex, c.subIndex);
    if (variants.length && (!from || variants.every(t => normalizePath(target.sourceOf(t)?.path ?? '') === normalizePath(from)))) continue;
    if (!from) throw new Error(`The source of preset tile ${key} is unknown. Re-save this preset from its original map.`);
    const source = normalizePath(from);
    let bytes = sources.get(source);
    if (!bytes) {
      bytes = await read(source) ?? undefined;
      if (!bytes) throw new Error(`Preset tile library is missing: ${source}`);
      sources.set(source, bytes);
      parsed.set(source, parseDt1(bytes));
    }
    const matches = parsed.get(source)!.tiles.flatMap((t, index) => t.orientation === o && t.mainIndex === c.mainIndex && t.subIndex === c.subIndex ? [{ dt1: source, index }] : []);
    if (!matches.length) throw new Error(`Preset tile ${key} no longer exists in ${source}.`);
    picks.push(...matches); needed.set(key, source);
  }
  const plan = planCustomDt1(picks, sources, new Set(target.entries().map(e => tileKey(e.orientation, e.main, e.sub))));
  if (plan.skipped.length) throw new Error(plan.skipped.join('\n'));
  const remap = new Map(plan.tiles.filter(t => needed.get(tileKey(t.orientation, t.main, t.sub)) === t.from.dt1).map(t => [tileKey(t.orientation, t.main, t.sub), t]));
  const tileSources = { ...clip.tileSources };
  const layers = clip.layers.map(({ layer, cells }) => ({ layer, cells: cells.map(c => {
    if (isEmptyCell(c)) return c;
    const o = orientation(layer.kind, c as WallCell), t = remap.get(tileKey(o, c.mainIndex, c.subIndex));
    if (!t) return c;
    tileSources[tileKey(o, t.newMain, t.newSub)] = path;
    return withFields(c, { main: t.newMain, sub: t.newSub });
  }) }));
  const usedSources: Record<string, string> = {};
  for (const { layer, cells } of layers) for (const c of cells) {
    if (isEmptyCell(c)) continue;
    const key = tileKey(orientation(layer.kind, c as WallCell), c.mainIndex, c.subIndex);
    if (tileSources[key]) usedSources[key] = tileSources[key];
  }
  return { plan, bytes: plan.records.length ? buildDt1(plan.records) : null, clip: { ...clip, layers, tileSources: usedSources, dt1s: [...new Set(Object.values(usedSources))] } };
}
