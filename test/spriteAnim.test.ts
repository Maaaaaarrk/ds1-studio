import { describe, expect, it } from 'vitest';
import { animationFps, loadSpriteAnimation } from '../src/game/spriteAnim';
import { GameData } from '../src/game/GameData';
import type { SpriteSpec } from '../src/game/sprites';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { binarySource, D2_DIR, hasD2 } from '../tools/testdata';

describe('animationFps', () => {
  it('maps D2 animation rates to 1..25 fps', () => {
    expect(animationFps(256)).toBe(25);
    expect(animationFps(128)).toBe(12.5);
    expect(animationFps(1024)).toBe(25);
    expect(animationFps(1)).toBe(1);
    expect(animationFps(0)).toBe(25);
    expect(animationFps(-5)).toBe(25);
    expect(animationFps(NaN)).toBe(25);
  });
});

describe.runIf(hasD2)('sprite animations', async () => {
  const fs = hasD2
    ? new LayeredFs([
        binarySource(),
        ...(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq', 'd2char.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))),
      ])
    : null!;
  const gd = hasD2 ? await GameData.load(fs) : null!;
  const spec = (act: number, type: number, id: number): SpriteSpec => {
    const s = gd.objectSpec(act - 1, type, id);
    if (!s) throw new Error(`no sprite for ${act}/${type}/${id}`);
    return s;
  };
  const campfire = () => spec(1, 2, 2); // Act 1 object 2 = objects.txt row 39, the rogue camp fire

  const cases: [string, () => SpriteSpec, number][] = [
    ['warriv', () => spec(1, 1, 7), 2],
    ['campfire', campfire, 2],
    ['waypoint', () => spec(1, 2, 37), 2],
  ];

  it.each(cases)('animates %s', async (name, getSpec, minFrames) => {
    const anim = await loadSpriteAnimation(fs, getSpec());
    expect(anim, name).not.toBeNull();
    const a = anim!;
    console.log(`${name}: ${a.frames.length} frames, ${a.fps} fps, ${a.directions} dirs, ${a.width}x${a.height} @ (${a.offsetX},${a.offsetY})`);
    expect(a.frames.length).toBeGreaterThanOrEqual(minFrames);
    expect(a.fps).toBeGreaterThanOrEqual(1);
    expect(a.fps).toBeLessThanOrEqual(25);
    expect(a.directions).toBeGreaterThan(0);
    for (const f of a.frames) {
      expect(f.width).toBe(a.width);
      expect(f.height).toBe(a.height);
      expect(f.offsetX).toBe(a.offsetX);
      expect(f.offsetY).toBe(a.offsetY);
      expect(f.pixels).toHaveLength(a.width * a.height);
    }
    // Frames actually differ over the animation.
    const first = a.frames[0].pixels;
    expect(a.frames.some((f) => f.pixels.some((p, i) => p !== first[i]))).toBe(true);
  });

  it('keeps glowing / translucent layers as separate parts, like the game draws them', async () => {
    const fire = await loadSpriteAnimation(fs, spec(1, 2, 43)); // Fire, small: flames are a luminance (glow) layer
    expect(fire).not.toBeNull();
    expect(fire!.parts).toHaveLength(fire!.frames.length);
    const blends = new Set(fire!.parts.flat().map((p) => p.blend));
    expect(blends.has(3)).toBe(true);
    // Every part is a real image placed relative to the feet.
    for (const f of fire!.parts) for (const part of f) expect(part.image.width * part.image.height).toBe(part.image.pixels.length);
  });

  it('caches per spec and direction', async () => {
    const s = spec(1, 1, 7);
    const a = await loadSpriteAnimation(fs, s, 0);
    expect(await loadSpriteAnimation(fs, { ...s, parts: { ...s.parts } }, 0)).toBe(a);
    const b = await loadSpriteAnimation(fs, s, 3);
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);
    expect(await loadSpriteAnimation(fs, s, 3)).toBe(b);
  });

  it('returns null for missing or broken sprites', async () => {
    expect(await loadSpriteAnimation(fs, { base: 'Data\\Global\\Objects', token: 'ZZ', mode: 'NU', cls: 'HTH', parts: { TR: 'LIT' } })).toBeNull();
    expect(await loadSpriteAnimation(fs, { base: 'Data\\Global\\Monsters', token: 'WA', mode: 'NU', cls: 'HTH', parts: {} })).toBeNull();
  });
});
