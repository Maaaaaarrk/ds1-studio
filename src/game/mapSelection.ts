import { hitTest, sameItem, stackAt, type DrawItem, type Scene } from '../render/scene';
import type { LayerRef } from './MapDocument';
import { inSelection, type CellSelection } from './clipboard';

export interface TileStack { items: DrawItem[]; index: number; anchor?: [number, number] }

export function combinedCellAt(scene: Scene, world: [number, number], grid: [number, number], visible: (item: DrawItem) => boolean): [number, number] {
  const hit = hitTest(scene, ...world, visible);
  return hit && hit.kind !== 'floor' && hit.kind !== 'shadow' ? [hit.cellX, hit.cellY] : grid;
}

/** Selected artwork stays gold; a separate hover preview shows every visible layer of the next cell. */
export function tileEmphasis(
  item: DrawItem,
  selection: CellSelection | null,
  focus: DrawItem | null,
  hover: [number, number] | null,
  /** An area selection narrowed to one layer (Shift+scroll): only that layer's tiles are selected. */
  areaLayer: { kind: 'floor' | 'wall' | 'shadow'; index: number } | null = null,
): 'selected' | 'hover' | null {
  const layerOk = !areaLayer || ((item.kind === 'floor' ? 'floor' : item.kind === 'shadow' ? 'shadow' : 'wall') === areaLayer.kind && item.layer === areaLayer.index);
  if (focus ? sameItem(item, focus) : selection && inSelection(selection, item.cellX, item.cellY) && layerOk) return 'selected';
  return hover && item.cellX === hover[0] && item.cellY === hover[1] ? 'hover' : null;
}

/** Only an explicit Shift gesture enters individual-tile selection. */
export function cycleWithWheel(shift: boolean, trackedShift: boolean, ctrl: boolean, deltaX = 0, deltaY = 0): boolean {
  // Windows can translate Shift+wheel into horizontal scrolling without a modifier.
  // Only that horizontal event needs the tracked key: a plain vertical wheel always zooms.
  return !ctrl && (shift || (trackedShift && deltaX !== 0 && deltaY === 0));
}

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
