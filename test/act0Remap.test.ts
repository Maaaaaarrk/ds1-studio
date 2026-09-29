import { describe, expect, it } from 'vitest';
import { act0Remap } from '../src/game/act0Palette';

describe('Act 0 conversion', () => {
  it('snaps each colour to the nearest allowed one by plain RGB distance, ties to the lowest index', () => {
    const pal = new Uint8Array(256 * 4);
    const set = (i: number, r: number, g: number, b: number) => pal.set([r, g, b, 255], i * 4);
    set(1, 12, 12, 8); // allowed
    set(2, 24, 16, 8); // allowed, same RGB distance from slot 3 as slot 1 (a tie)
    set(3, 16, 20, 8); // act-specific
    set(4, 116, 100, 60); // allowed
    set(5, 100, 88, 52); // allowed: nearer by the perceptual measure, farther by plain RGB
    set(6, 112, 92, 52); // act-specific
    const usable = Array.from({ length: 256 }, (_, i) => [1, 2, 4, 5].includes(i));
    const r = act0Remap(pal, usable);
    expect(r[3]).toBe(1);
    expect(r[6]).toBe(4);
    // Allowed colours stay as they are.
    expect([r[1], r[2], r[4], r[5]]).toEqual([1, 2, 4, 5]);
  });
});

describe('the act a tile library was drawn for', () => {
  it('comes from its folder: ACT1-4, expansion, and Guild (Act 1 art)', async () => {
    const { dt1Act } = await import('../src/game/act0Palette');
    expect(dt1Act('data/global/tiles/ACT3/Kurast/huts.dt1')).toBe(2);
    expect(dt1Act('data/global/tiles/expansion/Siege/snow.dt1')).toBe(4);
    expect(dt1Act('data/global/tiles/Guild/outdoors/cliff.dt1')).toBe(0);
    expect(dt1Act('data/global/tiles/PD2assets/cust/int.dt1')).toBeNull();
  });
});
