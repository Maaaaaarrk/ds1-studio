import { describe, expect, it } from 'vitest';
import { stackMatchesLayer, stepTileStack, wallClickStack } from '../src/game/mapSelection';
import { worldToCell, type DrawItem, type Scene } from '../src/render/scene';
import { parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1 } from '../src/formats/dt1Write';

const tile = parseDt1(buildDt1([blockerRecord(1, 0, new Uint8Array(25))])).tiles[0];
tile.blocks = [{ x: 0, y: 0, gridX: 0, gridY: 0, format: 2, data: Uint8Array.from(Array.from({ length: 32 }, () => [0, 32, ...Array(32).fill(1), 0, 0]).flat()) }];
const item = (kind: DrawItem['kind'], layer: number): DrawItem => ({ tile, kind, layer, cellX: 2, cellY: 1, x: 0, y: 0 });
const floor = item('floor', 0), wall1 = item('wall', 0), wall2 = item('wall', 1);
const scene = (items = [floor, wall1, wall2]): Scene => ({ items, missing: [], specials: [], animated: false, bounds: { minX: 0, minY: 0, maxX: 500, maxY: 500 } });
const shown = () => true;

describe('wall click and Shift+wheel selection', () => {
  it('selects visible wall artwork at its owning cell, not the floor grid behind it', () => {
    expect(worldToCell(8,8).map(Math.floor)).toEqual([0,0]);
    const stack = wallClickStack(scene(), [8,8], shown)!;
    expect(stack.items[stack.index]).toBe(wall2);
    expect([wall2.cellX,wall2.cellY]).toEqual([2,1]);
  });
  it('keeps ordinary floor and empty clicks available for grid selection', () => {
    expect(wallClickStack(scene([floor]), [8,8], shown)).toBeNull();
    expect(wallClickStack(scene(), [100,100], shown)).toBeNull();
  });
  it('retains each selected wall while switching the active kind and layer, then cycles to the floor', () => {
    let stack = stepTileStack(scene(), null, 1, [8,8], 1, shown)!;
    expect(stack.items[stack.index]).toBe(wall2);
    expect(stackMatchesLayer(stack, { kind:'wall',index:1 })).toBe(true);
    stack = stepTileStack(scene(), stack, 1, [9,8], 1, shown)!;
    expect(stack.items[stack.index]).toBe(wall1);
    expect(stackMatchesLayer(stack, { kind:'wall',index:0 })).toBe(true);
    stack = stepTileStack(scene(), stack, 1, [9,8], 1, shown)!;
    expect(stack.items[stack.index]).toBe(floor);
    expect(stackMatchesLayer(stack, { kind:'floor',index:0 })).toBe(true);
    expect(stackMatchesLayer(stack, { kind:'wall',index:0 })).toBe(false);
  });
  it('cycles backward and wraps without losing the original point', () => {
    const clicked = wallClickStack(scene(), [8,8], shown)!;
    const next = stepTileStack(scene(), clicked, -1, [9,8], 1, shown)!;
    expect(next.items[next.index]).toBe(floor);
    expect(next.anchor).toEqual([8,8]);
    expect(stepTileStack(scene(), next, 1, [9,8], 1, shown)!.items[0]).toBe(wall2);
  });
  it('refreshes rebuilt scenes and excludes layers hidden since the previous scroll', () => {
    const clicked = wallClickStack(scene(), [8,8], shown)!;
    const fresh = scene([ {...floor}, {...wall1}, {...wall2} ]);
    const next = stepTileStack(fresh, clicked, 1, [8,8], 1, shown)!;
    expect(next.items[next.index]).toBe(fresh.items[1]);
    const filtered = stepTileStack(fresh, clicked, 1, [8,8], 1, it => it.layer !== 1)!;
    expect(filtered.items.some(it => it.layer === 1)).toBe(false);
  });
  it('counts corner-wall halves once and starts a fresh stack after moving away', () => {
    const corner = scene([floor, wall1, {...wall1}]);
    expect(wallClickStack(corner, [8,8], shown)!.items).toHaveLength(2);
    expect(stepTileStack(scene(), wallClickStack(scene(), [8,8], shown), 1, [400,400], 1, shown)).toBeNull();
  });
  it('does not cycle through neighbouring floors merely because their transparent padding overlaps the pointer', () => {
    const transparent = { ...tile, blocks: [{...tile.blocks[0],data:Uint8Array.from(Array(32).fill([0,0]).flat())}] };
    const padding = { ...floor, cellX:4, cellY:4, tile:transparent };
    const stack = wallClickStack(scene([padding,floor,wall1,wall2]), [8,8], shown)!;
    expect(stack.items).not.toContain(padding);
    expect(stack.items).toEqual([wall2,wall1,floor]);
  });
});
