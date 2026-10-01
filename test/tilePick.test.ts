import { describe, expect, it } from 'vitest';
import { parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1, type Dt1Record } from '../src/formats/dt1Write';
import { TileLibrary } from '../src/game/GameData';

/** A floor tile 1/0 with this rarity, told apart by its flags. */
const tile = (mark: number, rarity = 0): Dt1Record => {
  const r = blockerRecord(1, 0, new Uint8Array(25).fill(mark));
  new DataView(r.header.buffer).setInt32(32, rarity, true);
  return r;
};
const mark = (lib: TileLibrary, seed = 0) => lib.pick(0, 1, 0, seed)!.subTileFlags[0];

describe('which of several same-numbered tiles is shown (as the game and WinDS1 do)', () => {
  it('with no rarities: the last one of the DT1 loaded first, not a later DT1', () => {
    const lib = new TileLibrary();
    lib.add('first.dt1', parseDt1(buildDt1([tile(1), tile(2)])));
    lib.add('second.dt1', parseDt1(buildDt1([tile(3)])));
    expect(mark(lib)).toBe(2);
  });
  it('with rarities: only tiles that have one, from any DT1', () => {
    const lib = new TileLibrary();
    lib.add('first.dt1', parseDt1(buildDt1([tile(1, 0)])));
    lib.add('second.dt1', parseDt1(buildDt1([tile(3, 5)])));
    for (let s = 0; s < 20; s++) expect(mark(lib, s)).toBe(3);
  });
});
