import { describe, expect, it } from 'vitest';
import { EMPTY_CELL, withFields, encodeCell, decodeCell } from '../src/formats/ds1';
import { newDs1 } from '../src/formats/ds1ops';
import { parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1 } from '../src/formats/dt1Write';
import { missingForPaste, pasteEdits, type Clipboard } from '../src/game/clipboard';
import { TileLibrary } from '../src/game/GameData';
import { MapDocument } from '../src/game/MapDocument';
import { preparePresetLibrary, resolvePresetSources } from '../src/game/presetLibrary';
import { presetFromClipboard, presetToClipboard, serializePreset, parsePreset } from '../src/game/presets';

const source = 'data/global/tiles/tree.dt1', dest = 'data/global/tiles/studio/test.dt1';
const record = (orientation: number, main: number, sub = 0, frame?: number) => {
  const r = blockerRecord(main, sub, new Uint8Array(25).fill(7));
  const view = new DataView(r.header.buffer); view.setInt32(20, orientation, true);
  if (frame !== undefined) { r.header[7] = 1; view.setInt32(32, frame, true); }
  return r;
};
const bytes = buildDt1([record(14, 1), record(13, 1), record(3, 2), record(4, 2), record(0, 5, 0, 0), record(0, 5, 0, 1), record(14, 9)]);
const read = async (p: string) => p === source ? bytes : null;
const cell = (main: number, orientation: number) => ({ ...withFields(EMPTY_CELL, { prop1: 1, main }), orientation, orientationHigh: 0 });
const clip: Clipboard = { width: 1, height: 1, dt1s: [source], layers: [{ layer: { kind: 'wall', index: 3 }, cells: [cell(1, 14)] }, { layer: { kind: 'shadow', index: 0 }, cells: [cell(1, 13)] }] };

describe('portable preset libraries', () => {
  it('persists per-tile sources and notices same-number artwork from another DT1', async () => {
    const lib = new TileLibrary(); lib.add(source, parseDt1(bytes));
    const p = presetFromClipboard(clip, lib, 'Tree', 'Nature');
    const saved = presetToClipboard(parsePreset(serializePreset(p))!);
    expect(saved.tileSources?.['14|1|0']).toBe(source);
    const target = new TileLibrary(); target.add('other.dt1', parseDt1(bytes));
    expect(missingForPaste(saved, target).different).toBe(2);
    expect((await resolvePresetSources(clip, read)).tileSources?.['13|1|0']).toBe(source);
  });
  it('copies just the tree and shadow, renumbers collisions and leaves the saved preset untouched', async () => {
    const target = new TileLibrary(); target.add('other.dt1', parseDt1(bytes));
    const before = JSON.stringify(clip);
    const result = await preparePresetLibrary(clip, target, dest, read);
    expect(parseDt1(result.bytes!).tiles).toHaveLength(2);
    expect(result.plan.renumbered).toHaveLength(2);
    target.add(dest, parseDt1(result.bytes!));
    expect(missingForPaste(result.clip, target)).toMatchObject({ tiles: 0, different: 0 });
    for (const l of result.clip.layers) for (const c of l.cells) expect(decodeCell(encodeCell(c)).mainIndex).toBe(c.mainIndex);
    expect(JSON.stringify(clip)).toBe(before);
    expect(parseDt1(result.bytes!).tiles[0].flags).toEqual(parseDt1(bytes).tiles[0].flags);
  });
  it('keeps corner partners and all animation frames, excluding unrelated records', async () => {
    const c: Clipboard = { ...clip, layers: [{ layer: { kind: 'wall', index: 0 }, cells: [cell(2, 3)] }, { layer: { kind: 'floor', index: 0 }, cells: [cell(5, 0)] }] };
    const result = await preparePresetLibrary(c, new TileLibrary(), dest, read);
    expect(parseDt1(result.bytes!).tiles.map(t => t.orientation)).toEqual([3, 4, 0, 0]);
  });
  it('does not create a file when the correct libraries are already available', async () => {
    const target = new TileLibrary(); target.add(source, parseDt1(bytes));
    const result = await preparePresetLibrary(clip, target, dest, read);
    expect(result.bytes).toBeNull();
    expect(result.plan.records).toHaveLength(0);
  });
  it('fails visibly if a source is missing rather than substituting destination artwork', async () => {
    await expect(preparePresetLibrary(clip, new TileLibrary(), dest, async () => null)).rejects.toThrow('missing');
  });
  it('preserves higher layers for insertion while retaining legacy pasteEdits behavior', () => {
    const doc = new MapDocument('test', newDs1({ width: 20, height: 20, act: 0, wallLayers: 1, floorLayers: 1, tagType: 0, files: [] }));
    expect(pasteEdits(doc, clip, 5, 6)).toHaveLength(1);
    const edits = pasteEdits(doc, clip, 5, 6, true);
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ layer: { kind: 'wall', index: 3 }, x: 5, y: 6 });
  });
});
