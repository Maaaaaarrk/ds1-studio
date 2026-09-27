import { describe, expect, it } from 'vitest';
import { parseDs1, writeDs1 } from '../src/formats/ds1';
import { applyPopPlan, findPops, planPops, popProblems, popTargets, tilesToHide } from '../src/game/pops';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('pops (roofs that disappear) in vanilla presets', async () => {
  const fs = hasD2
    ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))))
    : null!;
  const load = async (p: string) => parseDs1((await fs.read(`data/global/tiles/${p}`))!);

  it('reads the cottage roof area like the game: corners, target, and every roof inside the grown rectangle', async () => {
    const ds1 = await load('act1/outdoors/cott6.ds1');
    const [a] = findPops(ds1);
    expect(findPops(ds1)).toHaveLength(1);
    expect(a).toMatchObject({ main: 8, target: 46, group: 1, x0: 3, y0: 3, x1: 6, y1: 6 });
    // All of the cottage's main-index-46 roofs hide, none are left outside.
    const all = tilesToHide(ds1, { x0: 0, y0: 0, x1: ds1.width - 1, y1: ds1.height - 1 }, 46);
    expect(popTargets(ds1, a)).toHaveLength(all.length);
    expect(all.length).toBeGreaterThan(10);
  });

  it('keeps separate areas per main index (Lut Gholein has three)', async () => {
    const areas = findPops(await load('act2/town/lutn.ds1'));
    expect(areas.map((a) => `${a.main}/${a.target}`).sort()).toEqual(['12/13', '13/13', '8/8']);
  });

  it("checks every hide area of the game's maps against its 8×8-cell rooms, and moves a corner that is out of reach", async () => {
    const { parseTxtTable, getCell } = await import('../src/formats/txtTable');
    const { popReach } = await import('../src/game/pops');
    const prest = parseTxtTable((await fs.read('data/global/excel/LvlPrest.txt'))!);
    let areas = 0;
    const far: string[] = [];
    for (let r = 0; r < prest.rows.length; r++) {
      if (!(Number(getCell(prest, r, 'Pops')) > 0)) continue;
      for (let f = 1; f <= 6; f++) {
        const file = getCell(prest, r, `File${f}`);
        const b = file && file !== '0' ? await fs.read(`data/global/tiles/${file}`) : null;
        if (!b) continue;
        const ds1 = parseDs1(b);
        for (const a of findPops(ds1)) {
          areas++;
          if (a.markers.length === 2 && popReach(ds1, a, Number(getCell(prest, r, 'PopPad')) || 0)) far.push(`${file} area ${a.main}`);
        }
      }
    }
    expect(areas).toBeGreaterThan(20);
    // Only Travincal's temples are laid out like that in the game (outdoor pieces are split into 8×8 rooms too), so by
    // the same code their far roofs can stay hidden after leaving on the far side.
    expect(far).toEqual(['Act3/Travincal/TravNW.ds1 area 8', 'Act3/Travincal/TravNE.ds1 area 8', 'Act3/Travincal/TravS.ds1 area 8', 'Act3/Travincal/TravSE.ds1 area 12', 'Act3/Travincal/TravSE.ds1 area 10']);
    // A tall roof whose trigger runs a room past it (like the Guild's hall): the south corner moves up two cells.
    const ds1 = await load('act1/outdoors/cott6.ds1');
    const [a] = findPops(ds1);
    const tall = { ...a, y0: 1, y1: 17, markers: [{ ...a.markers[0], y: 1 }, { ...a.markers[1], y: 17 }] };
    const reach = popReach(ds1, tall, 0)!;
    expect(reach.exits.every((e) => e.y >= 16)).toBe(true); // room row 2 (cells 16-23), two rows from the roof
    expect(reach.fix).toMatchObject({ y0: 1, y1: 14 });
  });

  it('flags Pops = 0 and too few Pops', async () => {
    const ds1 = await load('act2/town/lutn.ds1');
    const areas = findPops(ds1);
    expect(popProblems(ds1, areas, 0)[0].severity).toBe('error');
    expect(popProblems(ds1, areas, 2)[0].text).toMatch(/overrun/);
    expect(popProblems(ds1, areas, 3).filter((p) => p.severity === 'error')).toEqual([]);
  });
});

describe('planning a hide area', () => {
  const blank = () => {
    // A 10×10 map with one wall layer holding a roof (main 46) block at 3..5 × 3..5.
    const ds1 = parseDs1(minimalDs1(9, 9)); // stored as size - 1: a 10×10 map
    for (let y = 3; y <= 5; y++)
      for (let x = 3; x <= 5; x++) ds1.walls[0][y * ds1.width + x] = { ...ds1.walls[0][0], prop1: 0x81, prop2: 0, prop3: (46 & 15) << 4, prop4: 46 >> 4, mainIndex: 46, subIndex: 0, hidden: false, orientation: 15, orientationHigh: 0 };
    return ds1;
  };

  it('places a marker pair on a free wall layer, adding one when the corners are taken, and reads back', () => {
    const ds1 = blank();
    const rect = { x0: 3, y0: 3, x1: 5, y1: 5 };
    const plan = planPops(ds1, rect, [46]);
    expect(plan.error).toBeUndefined();
    expect(plan.layers).toEqual([1]); // layer 1 is new: the roof is on layer 0 at both corners
    applyPopPlan(ds1, rect, plan);
    const back = findPops(parseDs1(writeDs1(ds1)));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ main: 8, target: 46, x0: 3, y0: 3, x1: 5, y1: 5 });
    expect(popTargets(ds1, back[0])).toHaveLength(9);
    // A second area goes into a group of its own.
    expect(planPops(ds1, { x0: 7, y0: 7, x1: 8, y1: 8 }, [46]).markers[0].main).toBe(12);
  });
});

/** Bytes of an empty version-18 DS1 with one wall and one floor layer. */
function minimalDs1(w: number, h: number): Uint8Array {
  const cells = (w + 1) * (h + 1);
  const ints = [18, w, h, 0, 0, 0, 1, 1, ...Array(cells * 4).fill(0), 0, 0, 0];
  const b = new Uint8Array(ints.length * 4);
  const v = new DataView(b.buffer);
  ints.forEach((n, i) => v.setInt32(i * 4, n, true));
  return b;
}
