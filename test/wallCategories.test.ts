import { describe, expect, it } from 'vitest';
import { readWallCategories, wallCategory } from '../src/game/wallCategories';
import { isVisible } from '../src/ui/MapView';
import { DEFAULT_VISIBILITY } from '../src/ui/state';
import type { DrawItem } from '../src/render/scene';
import type { Dt1Tile } from '../src/formats/dt1';

describe('DT1 wall categories', () => {
  const path='data/global/tiles/guild/outdoors/cliff.dt1';
  const tile={orientation:1,width:160,height:-480} as Dt1Tile;
  const cliff=(layer:number):DrawItem=>({kind:'wall',layer,sourcePath:path,tile,cellX:0,cellY:0,x:0,y:0});
  it('uses DT1 orientation rather than height or a DS1 storage-layer number by default', () => {
    expect(wallCategory(tile.orientation,path)).toBe('upper');
    expect(wallCategory(16,path)).toBe('lower');
    expect(wallCategory(15,path)).toBeNull();
    expect(isVisible(cliff(0),{...DEFAULT_VISIBILITY,upperWalls:false})).toBe(false);
    expect(isVisible(cliff(1),{...DEFAULT_VISIBILITY,upperWalls:false})).toBe(false);
  });
  it('assigns cliff artwork in any wall layer to Lower without moving it or changing other DT1s', () => {
    const v={...DEFAULT_VISIBILITY,upperWalls:false,wallCategories:{[path]:'lower' as const}};
    for(const layer of [0,1,2,3]) {
      expect(isVisible(cliff(layer),v)).toBe(true);
      expect(isVisible(cliff(layer),{...v,lowerWalls:false})).toBe(false);
      expect(isVisible({...cliff(layer),sourcePath:'other.dt1'},v)).toBe(false);
    }
    expect(isVisible(cliff(1),{...v,walls:[true,false]})).toBe(false);
    expect(tile.orientation).toBe(1);
    expect(wallCategory(0,path,v.wallCategories)).toBeNull();
    expect(wallCategory(15,path,v.wallCategories)).toBeNull();
  });
  it('validates saved preferences and normalizes DT1 path spelling', () => {
    expect(readWallCategories('{"Guild\\\\Outdoors\\\\Cliff.DT1":"lower","bad":"roof"}')).toEqual({'guild/outdoors/cliff.dt1':'lower'});
    expect(readWallCategories('bad json')).toEqual({});
    expect(readWallCategories('[]')).toEqual({});
    expect(wallCategory(1,'GUILD/OUTDOORS/CLIFF.DT1',{'guild/outdoors/cliff.dt1':'lower'})).toBe('lower');
  });
});
