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

describe('clipboard', async () => {
  const { clearEdits, copyRect, fillEdits, pasteEdits, clampRect } = await import('../src/game/clipboard');
  const floor = { kind: 'floor' as const, index: 0 };
  const wall = { kind: 'wall' as const, index: 0 };

  it('copies a block and pastes it transparently elsewhere as one undo step', () => {
    const doc = new MapDocument('x.ds1', blankDs1(6, 6));
    doc.apply(fillEdits(doc, { x0: 0, y0: 0, x1: 1, y1: 1 }, floor, { orientation: 0, main: 2, sub: 7 }));
    doc.apply([{ layer: wall, x: 1, y: 1, cell: MapDocument.painted(wall, doc.cell(wall, 1, 1), { orientation: 1, main: 4, sub: 0 }) }]);
    // Destination already has a floor tile under where the empty wall cells will land.
    doc.apply([{ layer: floor, x: 4, y: 4, cell: MapDocument.painted(floor, doc.cell(floor, 4, 4), { orientation: 0, main: 9, sub: 9 }) }]);
    const clip = copyRect(doc, { x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(clip.width).toBe(2);
    doc.apply(pasteEdits(doc, clip, 4, 4));
    expect(doc.cell(floor, 4, 4)).toMatchObject({ mainIndex: 2, subIndex: 7 });
    expect(doc.cell(wall, 5, 5)).toMatchObject({ mainIndex: 4, orientation: 1 });
    expect(doc.cell(wall, 4, 4).prop1).toBe(0);
    doc.undo();
    expect(doc.cell(floor, 4, 4)).toMatchObject({ mainIndex: 9, subIndex: 9 });
    expect(doc.cell(wall, 5, 5).prop1).toBe(0);
  });

  it('clips pastes at the map edge and clears only the requested layers', () => {
    const doc = new MapDocument('x.ds1', blankDs1(3, 3));
    doc.apply(fillEdits(doc, { x0: 0, y0: 0, x1: 2, y1: 2 }, floor, { orientation: 0, main: 1, sub: 1 }));
    doc.apply(fillEdits(doc, { x0: 0, y0: 0, x1: 2, y1: 2 }, wall, { orientation: 2, main: 1, sub: 1 }));
    expect(pasteEdits(doc, copyRect(doc, { x0: 0, y0: 0, x1: 2, y1: 2 }), 2, 2).length).toBe(2); // one cell x 2 layers
    doc.apply(clearEdits(doc, { x0: 0, y0: 0, x1: 0, y1: 2 }, [wall]));
    expect(doc.cell(wall, 0, 1).prop1).toBe(0);
    expect(doc.cell(floor, 0, 1).prop1).not.toBe(0);
    expect(clampRect({ x0: -2, y0: 1, x1: 9, y1: 1 }, 3, 3)).toEqual({ x0: 0, y0: 1, x1: 2, y1: 1 });
    expect(clampRect({ x0: 5, y0: 5, x1: 9, y1: 9 }, 3, 3)).toBeNull();
  });
});

describe('structural edits', async () => {
  const { resizeDs1 } = await import('../src/formats/ds1ops');
  it('resize is undoable and redoable', () => {
    const doc = new MapDocument('x.ds1', blankDs1(4, 4));
    const ds1 = doc.ds1;
    doc.mutate((d) => resizeDs1(d, { left: 1, top: 0, right: 2, bottom: 0 }));
    expect(doc.ds1).toBe(ds1); // same object, so views holding it stay valid
    expect(doc.ds1.width).toBe(7);
    doc.undo();
    expect(doc.ds1.width).toBe(4);
    expect(doc.ds1.floors[0].length).toBe(16);
    doc.redo();
    expect(doc.ds1.width).toBe(7);
    expect(doc.ds1.walls[0].length).toBe(28);
  });
});
