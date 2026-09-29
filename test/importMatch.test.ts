import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { importedDt1Path, matchDt1s, neededDt1s } from '../src/game/importMatch';

describe('importing a map with its tile libraries', () => {
  const ds1 = newDs1({ width: 4, height: 4, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] });
  ds1.files = [
    '\\d2\\data\\global\\tiles\\guild\\outdoors\\floor.tg1',
    '\\d2\\data\\global\\tiles\\guild\\cottages\\floor.tg1',
    '\\d2\\data\\global\\tiles\\act1\\outdoors\\treegroups.tg1',
    '\\d2\\data\\global\\tiles\\guild\\outdoors\\floor.tg1', // listed twice
    'DS1EDIT_WRKSPC_ZOOM=0',
  ];
  const needs = neededDt1s(ds1, (p) => p.includes('act1/'));

  it('lists what the map expects and what is already there', () => {
    expect(needs.map((n) => [n.rel, n.found])).toEqual([
      ['guild/outdoors/floor.dt1', false],
      ['guild/cottages/floor.dt1', false],
      ['act1/outdoors/treegroups.dt1', true],
    ]);
  });

  it('matches picked files by name, telling same-named files apart by their folders', () => {
    const picked = [
      { name: 'Floor.dt1', folder: 'mypack/guild/cottages', ok: true },
      { name: 'floor.dt1', folder: 'mypack/guild/outdoors', ok: true },
      { name: 'treegroups.dt1', folder: '', ok: true },
      { name: 'other.dt1', folder: '', ok: true },
    ];
    expect(matchDt1s(needs, picked)).toEqual([1, 0, 2]);
    // One floor.dt1 only: it goes to one need, the other stays unmatched.
    expect(matchDt1s(needs, [{ name: 'floor.dt1', folder: 'x/outdoors', ok: true }])).toEqual([0, null, null]);
    // Unreadable files are never used.
    expect(matchDt1s(needs, [{ name: 'floor.dt1', folder: 'outdoors', ok: false }])).toEqual([null, null, null]);
  });

  it('places imported libraries under PD2assets, keeping the path the map names', () => {
    expect(importedDt1Path('guild_test', 'guild/outdoors/floor.dt1')).toBe('data/global/tiles/PD2assets/guild_test/guild/outdoors/floor.dt1');
    expect(importedDt1Path('guild_test', 'my stuff/x.dt1')).toBe('data/global/tiles/PD2assets/guild_test/my_stuff/x.dt1');
  });

  it('prefers the file itself over a spare copy with the same name (a picked house1 folder with og/int.dt1)', () => {
    const needs = [{ path: 'data/global/tiles/guild/house1/int.dt1', rel: 'guild/house1/int.dt1', found: false }];
    // The picked folder is house1 itself: og/int.dt1 is listed first, as Windows lists it.
    const picked = [
      { name: 'int.dt1', folder: 'og', ok: true },
      { name: 'int.dt1', folder: '', ok: true },
    ];
    expect(matchDt1s(needs, picked)).toEqual([1]);
    expect(matchDt1s(needs, [{ name: 'int.dt1', folder: 'old', ok: true }])).toEqual([0]);
  });
});
