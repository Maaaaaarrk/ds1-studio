import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { EMPTY_CELL, withTile, writeDs1 } from '../src/formats/ds1';
import { GameData, TileLibrary } from '../src/game/GameData';
import { suggestionGroups, suggestPresets } from '../src/game/presets';
import { LayeredFs, LooseSource } from '../src/vfs/vfs';
import { parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1 } from '../src/formats/dt1Write';

function fixture() {
  const path = 'data/global/tiles/tree.dt1';
  const records = [14, 13].map((o) => { const r = blockerRecord(2, 0, new Uint8Array(25)); new DataView(r.header.buffer).setInt32(20, o, true); return r; });
  const bytes = buildDt1(records), lib = new TileLibrary(); lib.add(path, parseDt1(bytes));
  const ds1 = newDs1({ width: 7, height: 3, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [path] });
  const tree = (i: number) => { ds1.walls[0][i] = { ...withTile(EMPTY_CELL, 2, 0, 0x81), orientation: 14, orientationHigh: 0 }; };
  const shadow = (i: number) => { ds1.shadows[0][i] = withTile(EMPTY_CELL, 2, 0, 0x81); };
  return { path, bytes, lib, ds1, tree, shadow };
}
describe('combined preset suggestions', () => {
  it('suggests a single-cell tree with its shadow without bringing the ground along', async () => {
    const f = fixture(); f.tree(8); f.shadow(8);
    f.ds1.floors[0][8] = withTile(EMPTY_CELL, 30, 0, 0x81);
    const files = new Map([[f.path, async () => f.bytes], ['data/global/tiles/test.ds1', async () => writeDs1(f.ds1)]]);
    const gd = await GameData.load(new LayeredFs([new LooseSource('test', files)]));
    const result = await suggestPresets(gd, { path: 'data/global/tiles/test.ds1', lib: f.lib, dt1Paths: [f.path] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ width: 1, height: 1, name: 'Trees 1×1' });
    expect(result[0].layers.map((l) => l.kind)).toEqual(['wall', 'shadow']);
  });
  it('keeps an offset matching shadow with the tree, without joining a neighbouring tree', () => {
    const f = fixture(); f.tree(8); f.tree(12); f.shadow(9);
    const groups = suggestionGroups(f.ds1, f.lib);
    expect(groups).toEqual([[8, 9], [12]]);
  });
  it('keeps different shadow combinations as separate suggestions', async () => {
    const f = fixture(); f.tree(8); f.shadow(8);
    const other = structuredClone(f.ds1);
    other.shadows[0][8] = withTile(EMPTY_CELL, 2, 1, 0x81);
    const parsed = parseDt1(f.bytes);
    f.lib.add('data/global/tiles/shadow-variant.dt1', { ...parsed, tiles: [{ ...parsed.tiles[1], subIndex: 1 }] });
    const files = new Map([[f.path, async () => f.bytes], ['data/global/tiles/a.ds1', async () => writeDs1(f.ds1)], ['data/global/tiles/b.ds1', async () => writeDs1(other)]]);
    const gd = await GameData.load(new LayeredFs([new LooseSource('test', files)]));
    const result = await suggestPresets(gd, { path: 'data/global/tiles/a.ds1', lib: f.lib, dt1Paths: [f.path] });
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.occurrences)).toEqual([1, 1]);
  });
  it('does not guess when an offset shadow is equally close to two structures', () => {
    const f = fixture(); f.tree(8); f.tree(12); f.shadow(10);
    expect(suggestionGroups(f.ds1, f.lib)).toEqual([[8], [12]]);
  });
  it('does not absorb a nearby shadow with a different tile identity', () => {
    const f = fixture(); f.tree(8); f.ds1.shadows[0][9] = withTile(EMPTY_CELL, 7, 3, 0x81);
    expect(suggestionGroups(f.ds1, f.lib)).toEqual([[8]]);
  });
});
