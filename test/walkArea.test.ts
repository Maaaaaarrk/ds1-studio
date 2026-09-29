import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { TileLibrary } from '../src/game/GameData';
import { areaColour, walkableArea } from '../src/game/walkArea';
import { buildScene } from '../src/render/scene';

describe('walkable area', () => {
  it('counts tiles² a player can stand on: no floor means blocked', () => {
    const d = newDs1({ width: 10, height: 10, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] });
    expect(walkableArea(d, buildScene(d, new TileLibrary()))).toBe(0);
  });

  it('colours by size: grey, green to orange, orange to red, then redder', () => {
    expect(areaColour(3000).band).toBe('small');
    expect(areaColour(3300)).toEqual({ rgb: [60, 200, 90], band: 'green' });
    expect(areaColour(3799).band).toBe('green');
    expect(areaColour(3800)).toEqual({ rgb: [255, 150, 40], band: 'orange' });
    expect(areaColour(4300)).toEqual({ rgb: [255, 80, 40], band: 'red' });
    const deeper = areaColour(4800).rgb;
    expect(deeper[1]).toBeLessThan(80);
    expect(areaColour(9000).rgb).toEqual([200, 20, 20]);
  });
});
