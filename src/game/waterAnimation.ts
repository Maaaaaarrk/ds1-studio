import type { Palette } from '../formats/palette';
import { blockerRecord, buildDt1, changedRecord, recordInfo, type Dt1Record } from '../formats/dt1Write';

export function animationRecords(frames: Dt1Record[], main: number, sub: number): Dt1Record[] {
  if (!Number.isInteger(main) || main < 0 || main > 63 || !Number.isInteger(sub) || sub < 0 || sub > 255) throw new Error('Tile numbers must be main 0–63 and sub 0–255.');
  if (frames.length < 2 || frames.length > 64) throw new Error('Use between 2 and 64 animation frames.');
  return frames.map((frame, index) => {
    if (recordInfo(frame).orientation !== 0) throw new Error('Water animation frames must be floor tiles.');
    const record = changedRecord(frame, { main, sub });
    record.header[7] = 1;
    new DataView(record.header.buffer, record.header.byteOffset, record.header.byteLength).setInt32(32, index, true);
    return record;
  });
}

export function nearestPalette(palette: Palette, rgb: number[]): number {
  let best = 1, distance = Infinity;
  for (let i = 1; i < 256; i++) {
    const d = rgb.reduce((n, v, c) => n + (v - palette[i * 4 + c]) ** 2, 0);
    if (d < distance) { distance = d; best = i; }
  }
  return best;
}
/** A full 5×5 isometric floor with periodic ripples. Output uses only the chosen palette and loops cleanly. */
export function generateWater(palette: Palette, options: { main: number; sub: number; frames: number; dark: string; light: string; blocked: boolean; direction: 'left' | 'right' }): Dt1Record[] {
  if (options.frames < 2 || options.frames > 64 || !Number.isInteger(options.frames)) throw new Error('Frame count must be 2–64.');
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  if (![options.dark, options.light].every(c => /^#[0-9a-f]{6}$/i.test(c))) throw new Error('Choose two water colours.');
  const lo = rgb(options.dark), hi = rgb(options.light);
  const ramp = Array.from({ length: 32 }, (_, n) => nearestPalette(palette, lo.map((v, c) => v + (hi[c] - v) * n / 31)));
  const widths = [4, 8, 12, 16, 20, 24, 28, 32, 28, 24, 20, 16, 12, 8, 4];
  const frames = Array.from({ length: options.frames }, (_, frame) => {
    const record = blockerRecord(options.main, options.sub, new Uint8Array(25).fill(options.blocked ? 1 : 0));
    const h = new DataView(record.header.buffer);
    h.setInt32(80, 25, true);
    const blocks = new Uint8Array(25 * (20 + 256));
    const v = new DataView(blocks.buffer);
    const phase = frame / options.frames * Math.PI * 2 * (options.direction === 'right' ? 1 : -1);
    for (let by = 0; by < 5; by++) for (let bx = 0; bx < 5; bx++) {
      const i = by * 5 + bx, at = i * 20, px = 64 + (bx - by) * 16, py = (bx + by) * 8, offset = 500 + i * 256;
      v.setInt16(at, px, true); v.setInt16(at + 2, py, true);
      blocks[at + 6] = bx; blocks[at + 7] = by;
      v.setInt16(at + 8, 1, true); v.setInt32(at + 10, 256, true); v.setInt32(at + 16, offset, true);
      let pos = offset;
      for (let row = 0; row < 15; row++) for (let x = 0; x < widths[row]; x++) {
        const sx = px + (32 - widths[row]) / 2 + x, sy = py + row;
        // Periodic in both ground coordinates, so adjacent copies meet without a phase discontinuity.
        const u = (sx - 80) / 160 + sy / 80, w = sy / 80 - (sx - 80) / 160;
        const ripple = (Math.sin(u * Math.PI * 8 + phase) + Math.sin(w * Math.PI * 6 - phase) + 0.5 * Math.sin((u + w) * Math.PI * 12 + phase)) / 2.5;
        blocks[pos++] = ramp[Math.max(0, Math.min(31, Math.round(15.5 + 15.5 * ripple)))];
      }
    }
    return { ...record, blocks };
  });
  return animationRecords(frames, options.main, options.sub);
}

/** Replace exactly one floor identity; preserve every unrelated tile/record. */
export function replaceAnimation(records: Dt1Record[], oldKey: [number, number], frames: Dt1Record[]): Uint8Array {
  const next: Dt1Record[] = [];
  let inserted = false;
  for (const record of records) {
    const info = recordInfo(record);
    if (info.orientation === 0 && info.main === oldKey[0] && info.sub === oldKey[1]) {
      if (!inserted) { next.push(...frames); inserted = true; }
    } else next.push(record);
  }
  if (!inserted) throw new Error('The original water tile group is no longer present.');
  return buildDt1(next);
}
