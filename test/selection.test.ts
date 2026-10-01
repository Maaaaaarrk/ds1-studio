import { describe, expect, it } from 'vitest';
import { decodeCell, isEmptyCell, withTile, type Ds1 } from '../src/formats/ds1';
import { addToSelection, cellKey, cellsToSelection, clearEdits, copyRect, fitSelection, inSelection, pasteEdits, removeFromSelection, selectionCount, selectionMask, type CellSelection } from '../src/game/clipboard';
import { objectInRect, rectCells } from '../src/game/editTools';
import { MapDocument } from '../src/game/MapDocument';

function ds1(w: number, h: number): Ds1 {
  const cells = () => Array.from({ length: w * h }, () => decodeCell(0));
  return {
    version: 18, width: w, height: h, act: 0, actRaw: 0, tagType: 0, files: [],
    walls: [cells().map((c) => ({ ...c, orientation: 0, orientationHigh: 0 }))],
    floors: [cells()], shadows: [cells()], tags: [], objects: [], groups: [], groupsHeader: 0, orphanPaths: [], hasPathSection: true, trailing: 0,
  };
}

/** An L shape: a 3×1 row plus the cell below its left end (Shift+drag, then Shift+click). */
const L = (): CellSelection => addToSelection(addToSelection(null, { x0: 1, y0: 1, x1: 3, y1: 1 }), { x0: 1, y0: 2, x1: 1, y1: 2 });

describe('irregular selections (Shift+click / Shift+drag add to the selection)', () => {
  it('adds cells and rectangles, keeping the bounding box, and stays a plain rectangle when the box is full', () => {
    const s = L();
    expect([s.x0, s.y0, s.x1, s.y1]).toEqual([1, 1, 3, 2]);
    expect(selectionCount(s)).toBe(4);
    expect([inSelection(s, 1, 2), inSelection(s, 2, 2), inSelection(s, 0, 1)]).toEqual([true, false, false]);
    expect(selectionMask(s)).toEqual([true, true, true, true, false, false]);
    // Filling the rest of the box makes it a rectangle again.
    const full = addToSelection(s, { x0: 2, y0: 2, x1: 3, y1: 2 });
    expect(full.cells).toBeUndefined();
    expect(selectionCount(full)).toBe(6);
    // Starting from nothing, the first rectangle is the selection; a cell already in it changes nothing.
    expect(addToSelection(null, { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(addToSelection(full, { x0: 2, y0: 2, x1: 2, y1: 2 })).toEqual({ x0: 1, y0: 1, x1: 3, y1: 2 });
    expect(L().cells!.has(cellKey(3, 1))).toBe(true);
  });

  it('copy, cut/delete, fill and objects take only the selected cells; a copy pastes as its shape', () => {
    const doc = new MapDocument('x.ds1', ds1(5, 5));
    for (let i = 0; i < 25; i++) doc.ds1.floors[0][i] = withTile(decodeCell(0), 1, i, 0x81);
    doc.ds1.objects.push({ type: 2, id: 1, x: 2 * 5 + 2, y: 2 * 5 + 2, flags: 0, path: [] } as never, { type: 2, id: 2, x: 1 * 5 + 1, y: 2 * 5 + 1, flags: 0, path: [] } as never);
    const s = L();
    expect(rectCells(s)).toEqual([[1, 1], [2, 1], [3, 1], [1, 2]]);
    expect(doc.ds1.objects.map((o) => objectInRect(o, s))).toEqual([false, true]);
    // Delete: only the four cells.
    const floor = { kind: 'floor' as const, index: 0 };
    expect(clearEdits(doc, s, [floor]).map((e) => [e.x, e.y])).toEqual([[1, 1], [2, 1], [3, 1], [1, 2]]);
    // Copy: the bounding box, with the unselected cells empty (so they don't paste) and only the object inside.
    const clip = copyRect(doc, s);
    expect([clip.width, clip.height]).toEqual([3, 2]);
    expect(clip.layers.find((l) => l.layer.kind === 'floor')!.cells.map((c) => !isEmptyCell(c))).toEqual([true, true, true, true, false, false]);
    expect(clip.objects!.map((o) => o.id)).toEqual([2]);
    const pasted = pasteEdits(doc, clip, 0, 3).filter((e) => e.layer.kind === 'floor');
    expect(pasted.map((e) => [e.x, e.y])).toEqual([[0, 3], [1, 3], [2, 3], [0, 4]]);
  });
});

describe('taking cells out of a selection and fitting it to the map', () => {
  it('removes a cell from a rectangle, leaving an irregular selection', () => {
    const s = removeFromSelection({ x0: 0, y0: 0, x1: 2, y1: 1 }, { x0: 1, y0: 1, x1: 1, y1: 1 })!;
    expect(selectionCount(s)).toBe(5);
    expect(inSelection(s, 1, 1)).toBe(false);
    expect(inSelection(s, 2, 1)).toBe(true);
  });
  it('shrinks the bounding box and returns null when nothing is left', () => {
    const s = removeFromSelection({ x0: 0, y0: 0, x1: 2, y1: 2 }, { x0: 0, y0: 1, x1: 2, y1: 2 })!;
    expect(s).toEqual({ x0: 0, y0: 0, x1: 2, y1: 0 });
    expect(removeFromSelection({ x0: 3, y0: 3, x1: 3, y1: 3 }, { x0: 3, y0: 3, x1: 3, y1: 3 })).toBeNull();
  });
  it('cuts a selection to a smaller map', () => {
    const inside = { x0: 1, y0: 1, x1: 2, y1: 2 };
    expect(fitSelection(inside, 10, 10)).toBe(inside);
    expect(fitSelection({ x0: 5, y0: 5, x1: 12, y1: 6 }, 8, 8)).toEqual({ x0: 5, y0: 5, x1: 7, y1: 6 });
    expect(fitSelection({ x0: 9, y0: 9, x1: 12, y1: 12 }, 8, 8)).toBeNull();
    expect(cellsToSelection(new Set([cellKey(1, 1), cellKey(3, 1)]))).toMatchObject({ x0: 1, y0: 1, x1: 3, y1: 1 });
  });
});

describe('accepted check results', () => {
  it('are recognised across runs whatever the counts in their titles', async () => {
    const { resultKey } = await import('../src/game/compat');
    expect(resultKey({ area: 'Map', title: '97 walls have no automap entry' })).toBe(resultKey({ area: 'Map', title: '12 walls have no automap entry' }));
    expect(resultKey({ area: 'Map', title: '97 walls have no automap entry' })).not.toBe(resultKey({ area: 'Tiles', title: '97 walls have no automap entry' }));
  });
});
