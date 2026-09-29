import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { MapDocument } from '../src/game/MapDocument';
import { parseTxtTable, serializeTxtTable } from '../src/formats/txtTable';
import { setAutomapCel, parseAutomap, findRule } from '../src/game/automap';

describe('automap undo with persisted tables', () => {
  const setup = () => {
    const doc = new MapDocument('test.ds1', newDs1({ width: 2, height: 2, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] }));
    const before = new TextEncoder().encode('LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\nTown\tfl\t1\t0\t0\t\t12\n');
    const after = serializeTxtTable(setAutomapCel(parseTxtTable(before), 'Town', 0, 1, 0, -1, 'seq').doc);
    return { doc, before, after, path: 'data/global/excel/AutoMap.txt' };
  };
  it('restores the actual automap table on undo and clears it again on redo', async () => {
    const { doc, before, after, path } = setup();
    let stored = after;
    const write = async (p: string, bytes: Uint8Array, expected: Uint8Array) => { expect(p).toBe(path); expect(stored).toEqual(expected); stored = bytes; };
    doc.recordFileChange({ path, before, after }, 'Clear automap piece');
    expect(doc.undo()).toBe(false); // Synchronous callers cannot silently discard the table edit.
    expect(await doc.undoWithFiles(write)).toBe(true);
    expect(stored).toEqual(before);
    expect(findRule(parseAutomap(parseTxtTable(stored)), 'Town', 0, 1, 0)?.cels[0].cel).toBe(12);
    expect(await doc.redoWithFiles(write)).toBe(true);
    expect(stored).toEqual(after);
  });
  it('keeps failed writes in history and can retry them', async () => {
    const { doc, before, after, path } = setup();
    doc.recordFileChange({ path, before, after }, 'Clear');
    await expect(doc.undoWithFiles(async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(doc.history().done).toHaveLength(1);
    expect(doc.canRedo).toBe(false);
    expect(await doc.undoWithFiles(async () => {})).toBe(true);
  });
  it('undoes a selected-area map change and its table in one step, preserving earlier edits', async () => {
    const { doc, before, after, path } = setup();
    doc.mutate((d) => { d.act = 1; }, 'Earlier edit');
    doc.mutate((d) => { d.files.push('isolated.dt1'); d.act = 2; }, 'Clear selected pieces', { path, before, after });
    expect(await doc.undoWithFiles(async (_, b) => { expect(b).toEqual(before); })).toBe(true);
    expect(doc.ds1.act).toBe(1);
    expect(doc.ds1.files).toEqual([]);
    expect(await doc.redoWithFiles(async (_, b) => { expect(b).toEqual(after); })).toBe(true);
    expect(doc.ds1.files).toEqual(['isolated.dt1']);
    expect(doc.ds1.act).toBe(2);
  });
});
