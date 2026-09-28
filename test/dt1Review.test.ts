import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { Orientation, parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1 } from '../src/formats/dt1Write';
import { getCell, parseTxtTable } from '../src/formats/txtTable';
import { cellsUsing, mapTileUsage, renameInLvlTypes, tileKey, typesUsing, withoutTile } from '../src/game/dt1Review';

describe('reviewing a map’s tile libraries', () => {
  const ds1 = newDs1({ width: 4, height: 4, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] });
  Object.assign(ds1.floors[0][0], { prop1: 1, mainIndex: 2, subIndex: 5 });
  Object.assign(ds1.floors[0][3], { prop1: 1, mainIndex: 2, subIndex: 5 });
  Object.assign(ds1.walls[0][5], { prop1: 1, mainIndex: 7, subIndex: 1, orientation: Orientation.RightPartOfNorthCornerWall });

  it('counts the tiles the map places, a north corner drawing its other half too', () => {
    const u = mapTileUsage(ds1);
    expect(u.get(tileKey(0, 2, 5))).toBe(2);
    expect(u.get(tileKey(3, 7, 1))).toBe(1);
    expect(u.get(tileKey(4, 7, 1))).toBe(1);
    expect(cellsUsing(ds1, tileKey(0, 2, 5))).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }]);
    expect(cellsUsing(ds1, tileKey(4, 7, 1))).toEqual([{ x: 1, y: 1 }]);
  });

  it('takes one tile out of a DT1 and keeps the others as they were', () => {
    const bytes = buildDt1([1, 2, 3].map((m) => blockerRecord(m, 0, new Uint8Array(25).fill(m))));
    const out = parseDt1(withoutTile(bytes, 1));
    expect(out.tiles.map((t) => [t.mainIndex, t.subTileFlags[0]])).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(() => withoutTile(bytes, 5)).toThrow();
  });

  it('points every level type naming a DT1 at its new name', () => {
    const cols = Array.from({ length: 32 }, (_, i) => `File ${i + 1}`);
    const row = (id: number, name: string, files: string[]) => `${name}\t${id}\t${cols.map((_, i) => files[i] ?? '0').join('\t')}`;
    const types = parseTxtTable(new TextEncoder().encode(`Name\tId\t${cols.join('\t')}\r\n${row(1, 'A', ['Act1/x.dt1', 'PD2assets/custom/Old.dt1'])}\r\n${row(2, 'B', ['pd2assets/CUSTOM/old.dt1'])}\r\n${row(3, 'C', ['Act1/y.dt1'])}\r\n`));
    const { doc, changed } = renameInLvlTypes(types, 'PD2assets/custom/Old.dt1', 'PD2assets/custom/New.dt1');
    expect(changed).toEqual(['1 A', '2 B']);
    expect(getCell(doc, 0, 'File 2')).toBe('PD2assets/custom/New.dt1');
    expect(getCell(doc, 1, 'File 1')).toBe('PD2assets/custom/New.dt1');
    expect(getCell(doc, 0, 'File 1')).toBe('Act1/x.dt1');
    expect(typesUsing([{ id: 1, name: 'A', files: ['Act1/x.dt1'] }, { id: 2, name: 'B', files: ['act1/X.dt1', ''] }], 'data/global/tiles/act1/x.dt1')).toEqual(['1 A', '2 B']);
  });
});
