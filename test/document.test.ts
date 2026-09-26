import { describe, expect, it } from 'vitest';
import { decodeCell, parseDs1, writeDs1, type Ds1 } from '../src/formats/ds1';
import { MapDocument } from '../src/game/MapDocument';

function blankDs1(w: number, h: number): Ds1 {
  const cells = () => Array.from({ length: w * h }, () => decodeCell(0));
  return {
    version: 18,
    width: w,
    height: h,
    act: 0,
    actRaw: 0,
    tagType: 0,
    files: ['/d2/data/global/tiles/act1/town/floor.tg1'],
    walls: [cells().map((c) => ({ ...c, orientation: 0, orientationHigh: 0 }))],
    floors: [cells()],
    shadows: [cells()],
    tags: [],
    objects: [],
    groups: [],
    groupsHeader: 0,
    orphanPaths: [],
    hasPathSection: true,
    trailing: 0,
  };
}

describe('MapDocument', () => {
  const floor = { kind: 'floor' as const, index: 0 };
  const wall = { kind: 'wall' as const, index: 0 };

  it('paints, undoes a stroke as one step, and redoes', () => {
    const doc = new MapDocument('x.ds1', blankDs1(4, 4));
    doc.beginStroke();
    for (let x = 0; x < 3; x++) {
      doc.apply([{ layer: floor, x, y: 1, cell: MapDocument.painted(floor, doc.cell(floor, x, 1), { orientation: 0, main: 37, sub: 5 }) }]);
    }
    doc.endStroke();
    expect(doc.cell(floor, 2, 1)).toMatchObject({ mainIndex: 37, subIndex: 5, prop1: 0xc2 });
    expect(doc.dirty).toBe(true);
    doc.undo();
    expect(doc.cell(floor, 0, 1).prop1).toBe(0);
    expect(doc.cell(floor, 2, 1).prop1).toBe(0);
    expect(doc.canRedo).toBe(true);
    doc.redo();
    expect(doc.cell(floor, 1, 1).mainIndex).toBe(37);
  });

  it('keeps existing flags when repainting and ignores no-op edits', () => {
    const doc = new MapDocument('x.ds1', blankDs1(2, 2));
    doc.ds1.floors[0][0] = { ...decodeCell(0x00000042), prop3: 0x02 };
    const painted = MapDocument.painted(floor, doc.cell(floor, 0, 0), { orientation: 0, main: 3, sub: 1 });
    expect(painted).toMatchObject({ prop1: 0x42, prop3: 0x32, mainIndex: 3 });
    doc.apply([{ layer: floor, x: 0, y: 0, cell: painted }]);
    const rev = doc.revision;
    expect(doc.apply([{ layer: floor, x: 0, y: 0, cell: painted }])).toBe(false);
    expect(doc.revision).toBe(rev);
  });

  it('painted and erased walls survive a write/parse round trip', () => {
    const doc = new MapDocument('x.ds1', blankDs1(3, 3));
    doc.apply([{ layer: wall, x: 1, y: 2, cell: MapDocument.painted(wall, doc.cell(wall, 1, 2), { orientation: 15, main: 20, sub: 3 }) }]);
    doc.apply([{ layer: wall, x: 0, y: 0, cell: MapDocument.painted(wall, doc.cell(wall, 0, 0), { orientation: 1, main: 63, sub: 255 }) }]);
    doc.apply([{ layer: wall, x: 0, y: 0, cell: MapDocument.painted(wall, doc.cell(wall, 0, 0), null) }]);
    const back = parseDs1(writeDs1(doc.ds1));
    expect(back.walls[0][2 * 3 + 1]).toMatchObject({ orientation: 15, mainIndex: 20, subIndex: 3, prop1: 0x81, hidden: false });
    expect(back.walls[0][0]).toMatchObject({ prop1: 0, orientation: 0 });
    expect(back.trailing).toBe(0);
  });
});
