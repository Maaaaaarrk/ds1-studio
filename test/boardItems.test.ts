import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { buildDt1, dt1Records, recordInfo } from '../src/formats/dt1Write';
import { freeSub } from '../src/formats/dt1Blocks';
import { paintEdits, rectCells, stackPaintEdits } from '../src/game/editTools';
import { MapDocument, type LayerRef } from '../src/game/MapDocument';
import { allLayersShown, DEFAULT_VISIBILITY, isSolo, soloLayer } from '../src/ui/state';
import { stepAtOrBelow, stepZoom, WheelSteps, ZOOM_STEPS } from '../src/ui/zoomSteps';

describe('zoom steps (#10)', () => {
  it('goes through the sharp steps and comes back to exactly 100%', () => {
    let z = 1;
    for (let i = 0; i < 30; i++) z = stepZoom(z, -1);
    expect(z).toBe(ZOOM_STEPS[0]);
    for (let i = 0; i < 30; i++) z = stepZoom(z, 1);
    expect(z).toBe(8);
    expect(stepZoom(1, 1)).toBe(2);
    expect(stepZoom(1, -1)).toBe(0.75);
  });

  it('from an amount between steps, goes to the neighbouring steps', () => {
    expect(stepZoom(0.96, 1)).toBe(1);
    expect(stepZoom(0.96, -1)).toBe(0.75);
    expect(stepAtOrBelow(0.96)).toBe(0.75);
    expect(stepAtOrBelow(1.37)).toBe(1);
    expect(stepAtOrBelow(0.001)).toBe(ZOOM_STEPS[0]);
  });

  it('a wheel notch is one step; small touchpad movements add up', () => {
    const w = new WheelSteps();
    expect(w.take(-100, 1, 0)).toBe(1);
    expect(w.take(100, 1, 10)).toBe(-1);
    let n = 0;
    for (let i = 0; i < 10; i++) n += w.take(-10, 1, 1000 + i);
    expect(n).toBe(1);
  });
});

describe('showing one layer alone (#7)', () => {
  const v = { ...DEFAULT_VISIBILITY, walls: [true, false, true, true] };
  it('shows only a floor, a wall layer or a wall group, and tells when it is alone', () => {
    const f = soloLayer(v, { floor: 1 });
    expect(f.floors).toEqual([false, true]);
    expect(f.walls).toEqual([false, false, false, false]);
    expect(f.shadows || f.roofs || f.specials).toBe(false);
    expect(isSolo(f, { floor: 1 })).toBe(true);
    expect(isSolo(v, { floor: 1 })).toBe(false);

    const w = soloLayer(v, { wall: 2 });
    expect(w.walls).toEqual([false, false, true, false]);
    expect(w.upperWalls && w.lowerWalls && w.roofs).toBe(true);

    const r = soloLayer(v, 'roofs');
    expect(r.walls.every(Boolean)).toBe(true);
    expect([r.roofs, r.upperWalls, r.lowerWalls, r.floors[0]]).toEqual([true, false, false, false]);
    expect(isSolo(r, 'roofs')).toBe(true);
  });

  it('show all turns every layer on and keeps the rest of the view', () => {
    const a = allLayersShown({ ...soloLayer(v, 'shadows'), grid: true, objectsLayer: false });
    expect(a.objectsLayer).toBe(true);
    expect(a.floors.every(Boolean) && a.walls.every(Boolean) && a.roofs && a.specials).toBe(true);
    expect(a.grid).toBe(true);
  });
});

describe('Alt + brush: the first free layer (#8)', () => {
  const W0: LayerRef = { kind: 'wall', index: 0 };
  const wall = (main: number) => ({ orientation: 1, main, sub: 0 });
  const doc = () => new MapDocument('t.ds1', newDs1({ width: 4, height: 2, act: 0, floorLayers: 1, wallLayers: 2, tagType: 0, files: [] }));

  it('stacks onto taken cells, adds a layer when needed, and repaints a cell where it went', () => {
    const d = doc();
    d.apply(paintEdits(d, W0, rectCells({ x0: 0, y0: 0, x1: 1, y1: 0 }), [wall(5)]));
    d.apply(paintEdits(d, { kind: 'wall', index: 1 }, [[0, 0]], [wall(6)]));
    const placed = new Map<string, number>();
    const st = stackPaintEdits(d, W0, [[0, 0], [1, 0], [2, 0]], [wall(7)], placed);
    // (0,0): walls 1 and 2 taken: a third layer. (1,0): wall 2 free. (2,0): its own layer.
    expect(st.edits.map((e) => [e.x, e.layer.index])).toEqual([[0, 2], [1, 1], [2, 0]]);
    expect(st.walls).toBe(3);
    expect(st.replaced).toBe(0);
    // Going over (1,0) again in the same stroke paints it on the same layer, not a new one.
    expect(stackPaintEdits(d, W0, [[1, 0]], [wall(8)], placed).edits[0].layer.index).toBe(1);
  });

  it('replaces on the active layer when all four wall layers are taken', () => {
    const d = new MapDocument('t.ds1', newDs1({ width: 1, height: 1, act: 0, floorLayers: 1, wallLayers: 4, tagType: 0, files: [] }));
    for (let i = 0; i < 4; i++) d.apply(paintEdits(d, { kind: 'wall', index: i }, [[0, 0]], [wall(i + 1)]));
    const st = stackPaintEdits(d, { kind: 'wall', index: 2 }, [[0, 0]], [wall(9)], new Map());
    expect(st.edits[0].layer.index).toBe(2);
    expect(st.replaced).toBe(1);
  });
});

describe('new tile numbers avoid the other DT1s (#11)', () => {
  it('freeSub skips numbers taken elsewhere', () => {
    const one = dt1Records(buildDt1([]));
    expect(one).toEqual([]);
    expect(freeSub([], 2, 4)).toBe(0);
    expect(freeSub([], 1, 4, new Set(['1|4|0', '1|4|1']))).toBe(2);
    // A corner needs the number free for both halves.
    expect(freeSub([], 3, 4, new Set(['4|4|0']))).toBe(1);
    void recordInfo;
  });
});
