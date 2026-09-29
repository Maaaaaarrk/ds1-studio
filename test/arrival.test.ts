import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { arrivalProblem } from '../src/game/arrival';

const paint = (d: ReturnType<typeof newDs1>, x0: number, y0: number, x1: number, y1: number) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d.floors[0][y * d.width + x] = { ...d.floors[0][y * d.width + x], prop1: 1, mainIndex: 1, subIndex: 0 };
};

describe('where map portals arrive', () => {
  it('flags a map whose centre room has no floor, and crops it to what is painted', () => {
    const d = newDs1({ width: 150, height: 150, act: 4, floorLayers: 1, wallLayers: 2, tagType: 0, files: [] });
    paint(d, 47, 66, 65, 80); // the test map: just short of the centre room (72-79)
    const p = arrivalProblem(d, () => false)!;
    expect(p.room).toEqual({ x: 72, y: 72 });
    expect(p.crop).toEqual({ left: -45, top: -64, right: -82, bottom: -67 });
    expect(p.cropped).toEqual({ w: 23, h: 19 });
  });

  it('is fine with floor at the centre, a warp tile, or a waypoint', () => {
    const d = newDs1({ width: 150, height: 150, act: 4, floorLayers: 1, wallLayers: 2, tagType: 0, files: [] });
    paint(d, 70, 70, 80, 80);
    expect(arrivalProblem(d, () => false)).toBeNull();
    const e = newDs1({ width: 150, height: 150, act: 4, floorLayers: 1, wallLayers: 2, tagType: 0, files: [] });
    paint(e, 10, 10, 20, 20);
    e.walls[0][15 * e.width + 15] = { ...e.walls[0][15 * e.width + 15], prop1: 1, orientation: 10, mainIndex: 1, subIndex: 0 };
    expect(arrivalProblem(e, () => false)).toBeNull();
    const w = newDs1({ width: 150, height: 150, act: 4, floorLayers: 1, wallLayers: 2, tagType: 0, files: [] });
    w.objects.push({ type: 2, id: 119, x: 50, y: 50, flags: 0, path: [] });
    expect(arrivalProblem(w, (t, id) => id === 119)).toBeNull();
  });
});
