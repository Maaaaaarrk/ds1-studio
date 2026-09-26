import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { copyRect, pasteEdits, pasteObjects } from '../src/game/clipboard';
import { findTile, floodRegion, keyOf, objectInRect, paintEdits, rectCells, replaceEdits, rerollEdits } from '../src/game/editTools';
import { MapDocument, type LayerRef } from '../src/game/MapDocument';

const FLOOR: LayerRef = { kind: 'floor', index: 0 };
const tile = (main: number, sub: number) => ({ orientation: 0, main, sub });

/** A 6×4 map: floor 0/0 everywhere, with a wall of 1/0 floors down column 3. */
function makeDoc() {
  const doc = new MapDocument('test.ds1', newDs1({ width: 6, height: 4, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] }));
  doc.apply(paintEdits(doc, FLOOR, rectCells({ x0: 0, y0: 0, x1: 5, y1: 3 }), [tile(0, 0)]));
  doc.apply(paintEdits(doc, FLOOR, rectCells({ x0: 3, y0: 0, x1: 3, y1: 3 }), [tile(1, 0)]));
  return doc;
}

describe('edit tools', () => {
  it('flood fill stops at other tiles and at the selection', () => {
    const doc = makeDoc();
    expect(floodRegion(doc, FLOOR, 0, 0)).toHaveLength(12); // columns 0-2
    expect(floodRegion(doc, FLOOR, 5, 1)).toHaveLength(8); // columns 4-5
    expect(floodRegion(doc, FLOOR, 0, 0, { x0: 0, y0: 0, x1: 1, y1: 1 })).toHaveLength(4);
    expect(floodRegion(doc, FLOOR, 9, 9)).toEqual([]);
  });

  it('paints a random mix and replaces tiles', () => {
    const doc = makeDoc();
    let n = 0;
    const alternate = () => (n++ % 2 ? 0.9 : 0.1);
    doc.apply(paintEdits(doc, FLOOR, [[0, 0], [1, 0]], [tile(2, 0), tile(2, 1)], alternate));
    expect(keyOf(FLOOR, doc.cell(FLOOR, 0, 0))).toEqual(tile(2, 0));
    expect(keyOf(FLOOR, doc.cell(FLOOR, 1, 0))).toEqual(tile(2, 1));
    expect(findTile(doc, [FLOOR], tile(1, 0))).toHaveLength(4);
    doc.apply(replaceEdits(doc, [FLOOR], tile(1, 0), tile(4, 7)));
    expect(findTile(doc, [FLOOR], tile(1, 0))).toHaveLength(0);
    expect(findTile(doc, [FLOOR], tile(4, 7))).toHaveLength(4);
    // Limited to an area.
    expect(replaceEdits(doc, [FLOOR], tile(4, 7), tile(0, 0), { x0: 0, y0: 0, x1: 5, y1: 0 })).toHaveLength(1);
  });

  it('re-rolls only among tiles of the same group already in the selection', () => {
    const doc = makeDoc();
    doc.apply(paintEdits(doc, FLOOR, [[0, 0]], [tile(0, 5)]));
    const r = { x0: 0, y0: 0, x1: 2, y1: 3 };
    const edits = rerollEdits(doc, r, [FLOOR], () => 0); // always the first of the pool: 0/5
    expect(edits.length).toBe(12);
    for (const e of edits) expect(keyOf(FLOOR, e.cell)).toEqual(tile(0, 5));
    // A group with a single tile (column 3's 1/0) is left alone.
    expect(rerollEdits(doc, { x0: 3, y0: 0, x1: 3, y1: 3 }, [FLOOR])).toEqual([]);
  });

  it('moves objects with a cut and paste of everything', () => {
    const doc = makeDoc();
    doc.setObjects([{ type: 2, id: 5, x: 7, y: 2, flags: 0, path: [] }]); // cell (1, 0)
    const r = { x0: 0, y0: 0, x1: 5, y1: 3 };
    expect(objectInRect(doc.ds1.objects[0], r)).toBe(true);
    const clip = copyRect(doc, r);
    expect(clip.objects).toHaveLength(1);
    const pasted = pasteObjects(doc, clip, 0, 1);
    expect(pasted[0]).toMatchObject({ x: 7, y: 7 });
    expect(pasteEdits(doc, clip, 0, 1).length).toBeGreaterThan(0);
  });
});

describe('history', () => {
  it('names steps and jumps back and forth', () => {
    const doc = makeDoc();
    const base = doc.history().done.length;
    doc.apply(paintEdits(doc, FLOOR, [[0, 0]], [tile(9, 9)]), 'Paint on Floor 1');
    doc.beginStroke('Erase on Floor 1');
    doc.apply(paintEdits(doc, FLOOR, [[1, 0], [2, 0]], null));
    doc.endStroke();
    const h = doc.history();
    expect(h.done.slice(base).map((s) => s.label)).toEqual(['Paint on Floor 1 (1 cell)', 'Erase on Floor 1 (2 cells)']);
    doc.goTo(base);
    expect(keyOf(FLOOR, doc.cell(FLOOR, 0, 0))).toEqual(tile(0, 0));
    expect(doc.history().undone).toHaveLength(2);
    doc.goTo(base + 2);
    expect(keyOf(FLOOR, doc.cell(FLOOR, 0, 0))).toEqual(tile(9, 9));
    expect(keyOf(FLOOR, doc.cell(FLOOR, 1, 0))).toBeNull();
  });

  it('is unsaved only while it differs from the last save', () => {
    const doc = makeDoc();
    doc.markSaved();
    expect(doc.dirty).toBe(false);
    doc.apply(paintEdits(doc, FLOOR, [[0, 0]], [tile(9, 9)]));
    expect(doc.dirty).toBe(true);
    doc.undo();
    expect(doc.dirty).toBe(false);
    doc.redo();
    expect(doc.dirty).toBe(true);
    doc.markSaved();
    doc.undo();
    expect(doc.dirty).toBe(true);
    doc.markUnsaved();
    doc.redo();
    expect(doc.dirty).toBe(true);
  });
});
