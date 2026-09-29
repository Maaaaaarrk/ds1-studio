import { hitTest, sameItem, stackAt, type DrawItem, type Scene } from '../render/scene';
import type { LayerRef } from './MapDocument';

export interface TileStack { items: DrawItem[]; index: number; anchor?: [number, number] }

export function stackMatchesLayer(stack: TileStack, layer: LayerRef): boolean {
  const item = stack.items[stack.index];
  if (!item) return true;
  const kind = item.kind === 'floor' ? 'floor' : item.kind === 'shadow' ? 'shadow' : 'wall';
  return kind === layer.kind && item.layer === layer.index;
}

/** A wall's visible artwork can belong to a different cell than the grid behind it. */
export function wallClickStack(scene: Scene, world: [number, number], visible: (item: DrawItem) => boolean): TileStack | null {
  const hit = hitTest(scene, ...world, visible);
  if (!hit || hit.kind === 'floor' || hit.kind === 'shadow') return null;
  const items = stackAt(scene, ...world, visible);
  return { items, index: items.findIndex(item => sameItem(item, hit)), anchor: world };
}

/** Refresh at the original point, preserving the chosen layer across scene rebuilds and small mouse drift. */
export function stepTileStack(scene: Scene, previous: TileStack | null, dir: 1 | -1, world: [number, number], zoom: number, visible: (item: DrawItem) => boolean): TileStack | null {
  const near = previous?.anchor && Math.hypot(world[0] - previous.anchor[0], world[1] - previous.anchor[1]) * zoom < 24;
  const anchor = near ? previous!.anchor! : world;
  const items = stackAt(scene, ...anchor, visible);
  if (!items.length) return null;
  const old = near && previous!.index >= 0 ? previous!.items[previous!.index] : null;
  const current = old ? items.findIndex(item => sameItem(item, old)) : -1;
  const index = current >= 0 ? (current + dir + items.length) % items.length : dir > 0 ? 0 : items.length - 1;
  return { items, index, anchor };
}
