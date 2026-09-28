import { describe, expect, it } from 'vitest';
import type { SpriteFrame } from '../src/formats/dc6';
import { DEFAULT_AUTOMAP_STYLE, kindOfCode, normalizeAutomapStyle, paintAutomap } from '../src/game/automapStyle';

const frame = (w: number, h: number, px: number[]): SpriteFrame => ({ width: w, height: h, offsetX: 0, offsetY: -h, pixels: Uint8Array.from(px) }) as SpriteFrame;
const palette = new Uint8Array(256 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 256));

describe('automap look', () => {
  it('sorts tile codes into walls, floors, objects and the rest', () => {
    expect(['wl', 'wtlr', 'wld', 'ls'].map(kindOfCode)).toEqual(['walls', 'walls', 'walls', 'walls']);
    expect([kindOfCode('fl'), kindOfCode('tr'), kindOfCode('co'), kindOfCode('rf'), kindOfCode('sh')]).toEqual(['floors', 'objects', 'objects', 'other', 'other']);
  });

  it('draws pieces in their kind colour, thicker, at the chosen opacity, and leaves hidden kinds out', () => {
    const cels = [frame(1, 1, [7])];
    const pieces = [
      { cellX: 0, cellY: 0, orientation: 1, cel: 0 }, // a wall
      { cellX: 2, cellY: 0, orientation: 0, cel: 0 }, // a floor
    ];
    const count = (d: Uint8ClampedArray, rgb: [number, number, number]) => {
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] && d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) n++;
      return n;
    };
    const gold: [number, number, number] = [0xff, 0xd2, 0x4a];
    const blue: [number, number, number] = [0x4f, 0xc3, 0xf7];
    const thin = paintAutomap(4, 4, pieces, cels, palette, { ...DEFAULT_AUTOMAP_STYLE, thickness: 0 });
    expect([count(thin.data, gold), count(thin.data, blue)]).toEqual([1, 1]);
    // Thickness 1 grows a lone pixel into a plus of 5.
    const thick = paintAutomap(4, 4, pieces, cels, palette, { ...DEFAULT_AUTOMAP_STYLE, thickness: 1, opacity: 0.5 });
    expect(count(thick.data, gold)).toBe(5);
    expect(Math.max(...[...thick.data].filter((_, i) => i % 4 === 3))).toBe(128);
    const noFloors = paintAutomap(4, 4, pieces, cels, palette, { ...DEFAULT_AUTOMAP_STYLE, thickness: 0, kinds: { ...DEFAULT_AUTOMAP_STYLE.kinds, floors: { show: false, colour: '#4fc3f7' } } });
    expect(count(noFloors.data, blue)).toBe(0);
    // Game colours: the palette entry of the pixel.
    const game = paintAutomap(4, 4, pieces, cels, palette, { ...DEFAULT_AUTOMAP_STYLE, thickness: 0, colours: 'game' });
    expect(count(game.data, [palette[28], palette[29], palette[30]])).toBe(2);
  });

  it('takes stored settings safely, filling in anything missing or wrong', () => {
    expect(normalizeAutomapStyle(null)).toEqual(DEFAULT_AUTOMAP_STYLE);
    const s = normalizeAutomapStyle({ colours: 'game', opacity: 9, thickness: 2.4, kinds: { walls: { show: false, colour: 'red' } } });
    expect(s).toMatchObject({ colours: 'game', opacity: 1, thickness: 2 });
    expect(s.kinds.walls).toEqual({ show: false, colour: '#ffd24a' });
    expect(s.kinds.floors).toEqual(DEFAULT_AUTOMAP_STYLE.kinds.floors);
  });
});
