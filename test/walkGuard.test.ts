import { describe, expect, it } from 'vitest';
import { EMPTY_CELL, type TileCell, type WallCell } from '../src/formats/ds1';
import type { CellEdit } from '../src/game/MapDocument';
import { unresolvedEdits } from '../src/game/walkEdit';

const floor = (main: number, sub: number): TileCell => ({ ...EMPTY_CELL, prop1: 1, mainIndex: main, subIndex: sub });
const wall = (o: number, main: number, sub: number): WallCell => ({ ...EMPTY_CELL, prop1: 1, mainIndex: main, subIndex: sub, orientation: o, orientationHigh: 0 });
const edit = (kind: 'floor' | 'wall', cell: TileCell | WallCell, x = 0): CellEdit => ({ layer: { kind, index: 0 }, x, y: 0, cell });

describe('walkability safeguard', () => {
  const have = new Set(['0|2|0', '1|5|0', '0|60|1']);
  const has = (o: number, m: number, s: number) => have.has(`${o}|${m}|${s}`);

  it('finds edited cells whose tile nothing provides (tile copies and blockers alike)', () => {
    const edits = [edit('floor', floor(2, 0)), edit('floor', floor(2, 9), 1), edit('wall', wall(1, 5, 0), 2), edit('wall', wall(1, 5, 4), 3), edit('floor', floor(60, 1), 4), edit('floor', floor(61, 0), 5)];
    expect(unresolvedEdits(edits, has).map((e) => e.x)).toEqual([1, 3, 5]);
  });

  it('ignores cleared cells, special tiles and cells whose tile the edit keeps', () => {
    const special = edit('wall', wall(10, 8, 46));
    const cleared = edit('floor', EMPTY_CELL);
    // Already missing before (same tile number): not this edit's doing.
    const kept = edit('floor', floor(7, 7));
    expect(unresolvedEdits([special, cleared, kept], has, () => floor(7, 7))).toEqual([]);
    expect(unresolvedEdits([kept], has, () => floor(2, 0))).toEqual([kept]);
  });
});
