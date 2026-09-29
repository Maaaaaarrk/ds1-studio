import { describe, expect, it } from 'vitest';
import { isVisible } from '../src/ui/MapView';
import { DEFAULT_VISIBILITY } from '../src/ui/state';
import type { DrawItem } from '../src/render/scene';

const item = (kind: DrawItem['kind'], layer = 0) => ({ kind, layer } as DrawItem);
describe('map layer visibility', () => {
  it('hides upper walls without hiding lower walls, roofs or floors', () => {
    const v = { ...DEFAULT_VISIBILITY, upperWalls: false };
    expect(isVisible(item('wall'), v)).toBe(false);
    for (const kind of ['floor', 'lowerWall', 'roof', 'shadow'] as const) expect(isVisible(item(kind), v)).toBe(true);
  });
  it('combines wall-layer and tile-category toggles', () => {
    const v = { ...DEFAULT_VISIBILITY, walls: [false, true] };
    for (const kind of ['wall', 'lowerWall', 'roof'] as const) {
      expect(isVisible(item(kind), v)).toBe(false);
      expect(isVisible(item(kind, 1), v)).toBe(true);
    }
    expect(isVisible(item('roof', 1), { ...v, roofs: false })).toBe(false);
    expect(isVisible(item('lowerWall', 1), { ...v, lowerWalls: false })).toBe(false);
    expect(isVisible(item('floor'), v)).toBe(true);
  });
});
