import { describe, expect, it } from 'vitest';
import type { SpriteFrame } from '../src/formats/dc6';
import { DEFAULT_AUTOMAP_STYLE, isWaterTile, kindOfCode, looksLikeWater, normalizeAutomapStyle, paintAutomap, partOfCode, type AutomapStyle } from '../src/game/automapStyle';

const frame = (w: number, h: number, px: number[]): SpriteFrame => ({ width: w, height: h, offsetX: 0, offsetY: -h, pixels: Uint8Array.from(px) }) as SpriteFrame;
const palette = new Uint8Array(256 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 256));
const withKind = (s: AutomapStyle, k: keyof AutomapStyle['kinds'], patch: Partial<AutomapStyle['kinds']['walls']>): AutomapStyle => ({ ...s, kinds: { ...s.kinds, [k]: { ...s.kinds[k], ...patch } } });

describe('automap look', () => {
  it('sorts tile codes into walls, floors or water, roofs, objects and shadows', () => {
    expect(['wl', 'wtlr', 'wld', 'ls'].map((c) => kindOfCode(c))).toEqual(['walls', 'walls', 'walls', 'walls']);
    expect([kindOfCode('fl'), kindOfCode('fl', true), kindOfCode('tr'), kindOfCode('co'), kindOfCode('rf'), kindOfCode('sh')]).toEqual(['floors', 'water', 'objects', 'objects', 'roofs', 'shadows']);
  });

  it('draws each category in its colour and opacity, thicker, and leaves hidden ones out', () => {
    const cels = [frame(1, 1, [7])];
    const pieces = [
      { cellX: 0, cellY: 0, kind: 'walls' as const, cel: 0 },
      { cellX: 2, cellY: 0, kind: 'water' as const, cel: 0 },
    ];
    const at = (d: Uint8ClampedArray, rgb: [number, number, number]) => {
      const out: number[] = [];
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] && d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) out.push(d[i + 3]);
      return out;
    };
    const gold: [number, number, number] = [0xff, 0xd2, 0x4a];
    const blue: [number, number, number] = [0x3d, 0x8b, 0xff];
    const thin = paintAutomap(4, 4, pieces, cels, palette, { ...DEFAULT_AUTOMAP_STYLE, thickness: 0 });
    expect([at(thin.data, gold).length, at(thin.data, blue).length]).toEqual([1, 1]);
    // Thickness 1 grows a lone pixel into a plus of 5; each category keeps its own opacity.
    const thick = paintAutomap(4, 4, pieces, cels, palette, withKind({ ...DEFAULT_AUTOMAP_STYLE, thickness: 1 }, 'water', { opacity: 0.5 }));
    expect(at(thick.data, gold)).toEqual([255, 255, 255, 255, 255]);
    expect(new Set(at(thick.data, blue))).toEqual(new Set([128]));
    const noWater = paintAutomap(4, 4, pieces, cels, palette, withKind({ ...DEFAULT_AUTOMAP_STYLE, thickness: 0 }, 'water', { show: false }));
    expect(at(noWater.data, blue)).toEqual([]);
    // Game colours: the palette entry of the pixel.
    const game = paintAutomap(4, 4, pieces, cels, palette, { ...DEFAULT_AUTOMAP_STYLE, thickness: 0, colours: 'game' });
    expect(at(game.data, [palette[28], palette[29], palette[30]])).toHaveLength(2);
  });

  it('draws a part (Left walls) in its own look; the rest of the category keeps the category look', () => {
    const cels = [frame(1, 1, [7])];
    const pieces = [
      { cellX: 0, cellY: 0, kind: 'walls' as const, code: 'wl', cel: 0 },
      { cellX: 2, cellY: 0, kind: 'walls' as const, code: 'wr', cel: 0 },
    ];
    const px = (d: Uint8ClampedArray) => {
      const out: string[] = [];
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]) out.push(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`);
      return out.sort();
    };
    const style = { ...DEFAULT_AUTOMAP_STYLE, thickness: 0, parts: { left: { show: true, colour: '#102030', opacity: 0.5 } } };
    expect(px(paintAutomap(4, 4, pieces, cels, palette, style).data)).toEqual(['16,32,48,128', '255,210,74,255']);
    expect(px(paintAutomap(4, 4, pieces, cels, palette, { ...style, parts: { left: { ...style.parts.left, show: false } } }).data)).toEqual(['255,210,74,255']);
    expect(partOfCode('wtll')).toBe('corners');
    expect(partOfCode('fl')).toBeNull();
    expect(normalizeAutomapStyle({ parts: { left: { colour: '#abcdef' }, bogus: {} } }).parts).toEqual({ left: { show: true, colour: '#abcdef', opacity: 1 } });
  });

  it('takes stored settings safely, filling in anything missing or wrong, and carries older ones over', () => {
    expect(normalizeAutomapStyle(null)).toEqual(DEFAULT_AUTOMAP_STYLE);
    const s = normalizeAutomapStyle({ colours: 'game', thickness: 2.4, kinds: { walls: { show: false, colour: 'red', opacity: 9 } } });
    expect(s).toMatchObject({ colours: 'game', thickness: 2 });
    expect(s.kinds.walls).toEqual({ show: false, colour: '#ffd24a', opacity: 1 });
    expect(s.kinds.floors).toEqual(DEFAULT_AUTOMAP_STYLE.kinds.floors);
    // The earlier single opacity and "other" kind.
    const old = normalizeAutomapStyle({ opacity: 0.5, kinds: { other: { show: false, colour: '#123456' } } });
    expect(old.kinds.roofs).toMatchObject({ show: false, opacity: 0.5 });
    expect(old.kinds.walls.opacity).toBe(0.5);
  });
});

describe('water', () => {
  it('tells water from ground by colour', () => {
    // Act 1 river, a lake, Act 3 swamp water: water. Dirt, grass, stone, lava: not.
    expect([[40, 58, 92], [30, 45, 70], [38, 62, 60]].map((c) => looksLikeWater(c as [number, number, number]))).toEqual([true, true, true]);
    expect([[92, 74, 52], [58, 72, 40], [80, 80, 82], [150, 60, 30]].map((c) => looksLikeWater(c as [number, number, number]))).toEqual([false, false, false, false]);
  });

  it('takes unwalkable floors that are dark, grey or bluish for water — not ground, grass or lava', () => {
    const blocked = new Uint8Array(25).fill(1);
    const walkable = new Uint8Array(25);
    // Act 1's river (as the game's palette draws it: almost black, grey), a lake: water.
    expect(isWaterTile(blocked, [11, 11, 11])).toBe(true);
    expect(isWaterTile(blocked, [20, 19, 19])).toBe(true);
    expect(isWaterTile(blocked, [30, 45, 70])).toBe(true);
    // Blocked grass at a map's edge, lava, and any walkable floor: not.
    expect(isWaterTile(blocked, [27, 35, 14])).toBe(false);
    expect(isWaterTile(blocked, [150, 60, 30])).toBe(false);
    expect(isWaterTile(walkable, [11, 11, 11])).toBe(false);
    expect(isWaterTile(blocked, null)).toBe(true);
  });
});
