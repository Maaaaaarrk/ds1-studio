import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { copyRect } from '../src/game/clipboard';
import { TileLibrary } from '../src/game/GameData';
import { MapDocument } from '../src/game/MapDocument';
import { presetFromClipboard, presetToClipboard } from '../src/game/presets';

describe('presets from the clipboard', () => {
  it('keeps the copied cells (walls with their orientation) and objects, and drops empty layers', () => {
    const ds1 = newDs1({ width: 4, height: 4, act: 0, floorLayers: 2, wallLayers: 2, tagType: 0, files: [] });
    Object.assign(ds1.floors[0][5], { prop1: 0xc2, prop2: 7, prop3: 0x30, mainIndex: 3, subIndex: 7 });
    Object.assign(ds1.walls[0][6], { prop1: 0x81, prop2: 2, prop3: 0x10, mainIndex: 1, subIndex: 2, orientation: 15 });
    ds1.objects.push({ type: 2, id: 5, x: 7, y: 7, flags: 0, path: [] } as never);
    const doc = new MapDocument('data/global/tiles/test.ds1', ds1);
    const clip = copyRect(doc, { x0: 1, y0: 1, x1: 2, y1: 2 });
    const preset = presetFromClipboard(clip, new TileLibrary([]), 'Roof bit', 'Mine');
    expect(preset.layers.map((l) => `${l.kind}${l.index}`)).toEqual(['floor0', 'wall0']);
    expect(preset).toMatchObject({ width: 2, height: 2, name: 'Roof bit', category: 'Mine' });
    expect(preset.objects).toHaveLength(1);
    const back = presetToClipboard(preset);
    const cells = (kind: string) => back.layers.find((l) => l.layer.kind === kind)!.cells;
    expect(cells('floor')[0]).toMatchObject({ mainIndex: 3, subIndex: 7 });
    expect(cells('wall')[1]).toMatchObject({ mainIndex: 1, subIndex: 2, orientation: 15 });
  });
});
