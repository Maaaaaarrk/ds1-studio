import { describe, expect, it } from 'vitest';
import { EMPTY_CELL, withFields } from '../src/formats/ds1';
import { decodeTile, parseDt1 } from '../src/formats/dt1';
import { recolorDt1 } from '../src/formats/dt1Edit';
import { buildDt1, dt1Records } from '../src/formats/dt1Write';
import type { Clipboard } from '../src/game/clipboard';
import { TileLibrary } from '../src/game/GameData';
import { comparePasteTiles, preparePresetLibrary } from '../src/game/presetLibrary';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('pasting tiles the map has from another DT1', async () => {
  const fs = hasD2 ? new LayeredFs(await Promise.all(['d2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))) : null!;
  const game = hasD2 ? await fs.readOrThrow('data/global/tiles/act1/town/fence.dt1') : null!;
  const tiles = hasD2 ? parseDt1(game).tiles : [];
  // Two drawn wall tiles with different numbers.
  const picks = hasD2
    ? tiles
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => t.orientation > 0 && t.orientation < 10 && (decodeTile(t)?.pixels.filter(Boolean).length ?? 0) > 300)
        .filter(({ t }, n, all) => all.findIndex((x) => x.t.orientation === t.orientation && x.t.mainIndex === t.mainIndex && x.t.subIndex === t.subIndex) === n)
        .slice(0, 2)
    : [];
  const records = hasD2 ? dt1Records(game) : [];
  const source = 'data/global/tiles/mine/fence.dt1';
  const srcBytes = hasD2 ? buildDt1(picks.map((p) => records[p.i])) : null!;
  const read = async (p: string) => (p === source ? srcBytes : null);
  const cell = (t: (typeof tiles)[number]) => ({ ...withFields(EMPTY_CELL, { prop1: 1, main: t.mainIndex, sub: t.subIndex }), orientation: t.orientation, orientationHigh: 0 });
  const key = (t: (typeof tiles)[number]) => `${t.orientation}|${t.mainIndex}|${t.subIndex}`;
  const clip = (): Clipboard => ({
    width: 2,
    height: 1,
    dt1s: [source],
    tileSources: Object.fromEntries(picks.map((p) => [key(p.t), source])),
    layers: [{ layer: { kind: 'wall', index: 0 }, cells: picks.map((p) => cell(p.t)) }],
  });
  const mapWith = (bytes: Uint8Array) => {
    const lib = new TileLibrary();
    lib.add('data/global/tiles/other/fence.dt1', parseDt1(bytes));
    return lib;
  };

  it('finds nothing to choose when the map has the same pictures', async () => {
    const r = await comparePasteTiles(clip(), mapWith(srcBytes), read);
    expect(r.clashes).toEqual([]);
    expect(r.same.sort()).toEqual(picks.map((p) => key(p.t)).sort());
    // Nothing to add either.
    expect((await preparePresetLibrary(clip(), mapWith(srcBytes), 'data/global/tiles/studio/t.dt1', read, new Set(r.same))).bytes).toBeNull();
  });

  it('offers the ones that look different, and copies only the pasted versions chosen', async () => {
    // The map's copy of the first tile in other colours.
    const remap = new Uint8Array(256).map((_, c) => (c > 0 && c < 255 ? c + 1 : c));
    const first = dt1Records(recolorDt1(buildDt1([records[picks[0].i]]), remap))[0];
    const mapBytes = buildDt1([first, records[picks[1].i]]);
    const r = await comparePasteTiles(clip(), mapWith(mapBytes), read);
    expect(r.clashes.map((c) => c.key)).toEqual([key(picks[0].t)]);
    expect(r.clashes[0]).toMatchObject({ from: source, cells: 1 });
    expect(r.same).toEqual([key(picks[1].t)]);
    // Pasted version chosen: just that tile goes into the new DT1.
    const pasted = await preparePresetLibrary(clip(), mapWith(mapBytes), 'data/global/tiles/studio/t.dt1', read, new Set(r.same));
    expect(parseDt1(pasted.bytes!).tiles).toHaveLength(1);
    // The map's version chosen: nothing to add.
    const kept = await preparePresetLibrary(clip(), mapWith(mapBytes), 'data/global/tiles/studio/t.dt1', read, new Set([...r.same, r.clashes[0].key]));
    expect(kept.bytes).toBeNull();
  });
});
