import { describe, expect, it } from 'vitest';
import { parseDs1, withTile, writeDs1 } from '../src/formats/ds1';
import { embeddedFileName, newDs1, resizeDs1 } from '../src/formats/ds1ops';

function sample() {
  const ds1 = newDs1({ width: 4, height: 3, act: 1, floorLayers: 1, wallLayers: 1, tagType: 1, files: [] });
  ds1.floors[0][1 * 4 + 2] = withTile(ds1.floors[0][1 * 4 + 2], 5, 6, 0xc2); // cell (2,1)
  ds1.walls[0][0] = { ...withTile(ds1.walls[0][0], 7, 1, 0x81), orientation: 1 }; // cell (0,0)
  ds1.tags[0][2 * 4 + 3] = 42; // cell (3,2)
  ds1.objects.push({ type: 1, id: 3, x: 12, y: 7, flags: 0, path: [{ x: 14, y: 8, action: 1 }] }); // in cell (2,1)
  ds1.objects.push({ type: 2, id: 9, x: 1, y: 1, flags: 0, path: [] }); // in cell (0,0)
  ds1.groups.push({ x: 1, y: 1, width: 2, height: 2, unknown: 0 });
  return ds1;
}

describe('ds1 map operations', () => {
  it('grows a map on the left/top, shifting cells, tags, objects, paths and groups', () => {
    const r = resizeDs1(sample(), { left: 2, top: 1, right: 0, bottom: 3 });
    expect([r.width, r.height]).toEqual([6, 7]);
    expect(r.floors[0][2 * 6 + 4]).toMatchObject({ mainIndex: 5, subIndex: 6 });
    expect(r.walls[0][1 * 6 + 2]).toMatchObject({ mainIndex: 7, orientation: 1 });
    expect(r.tags[0][3 * 6 + 5]).toBe(42);
    expect(r.objects[0]).toMatchObject({ x: 22, y: 12, path: [{ x: 24, y: 13 }] });
    expect(r.groups[0]).toMatchObject({ x: 3, y: 2, width: 2, height: 2 });
    expect(r.floors[0][0].prop1).toBe(0);
  });

  it('shrinks a map, dropping content that falls off and clipping groups', () => {
    const r = resizeDs1(sample(), { left: -1, top: -1, right: 0, bottom: 0 });
    expect([r.width, r.height]).toEqual([3, 2]);
    expect(r.objects.map((o) => o.id)).toEqual([3]); // the object in cell (0,0) is gone
    expect(r.floors[0][0 * 3 + 1]).toMatchObject({ mainIndex: 5 });
    expect(r.groups[0]).toMatchObject({ x: 0, y: 0, width: 2, height: 2 });
    expect(() => resizeDs1(sample(), { left: -4, top: 0, right: 0, bottom: 0 })).toThrow();
  });

  it('creates blank maps that survive a write/parse round trip', () => {
    const ds1 = newDs1({ width: 8, height: 5, act: 2, floorLayers: 2, wallLayers: 3, tagType: 0, files: [embeddedFileName('data/global/tiles/ACT3/Kurast/floor.dt1')] });
    const back = parseDs1(writeDs1(ds1));
    expect(back).toMatchObject({ version: 18, width: 8, height: 5, act: 2, trailing: 0 });
    expect(back.floors.length).toBe(2);
    expect(back.walls.length).toBe(3);
    expect(back.files).toEqual(['/d2/data/global/tiles/ACT3/Kurast/floor.tg1']);
    const tagged = parseDs1(writeDs1(resizeDs1(sample(), { left: 1, top: 1, right: 1, bottom: 1 })));
    expect(tagged.groups[0]).toMatchObject({ x: 2, y: 2 });
    expect(tagged.tags[0][3 * 6 + 4]).toBe(42);
  });
});
