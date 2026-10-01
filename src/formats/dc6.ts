import { BinaryReader } from '../util/BinaryReader';

/**
 * DC6 = uncompressed-ish sprite sheet (RLE per scanline). Used for UI, items and some
 * object/monster overlays. Frames are stored bottom-up unless the flip flag is set.
 */

/** A palette-indexed image (index 0 = transparent) placed relative to the sprite origin (the feet). */
export interface SpriteFrame {
  width: number;
  height: number;
  /** Offset of the image's top-left corner from the sprite origin. */
  offsetX: number;
  offsetY: number;
  pixels: Uint8Array;
}

export interface Dc6FrameHeader {
  flip: boolean;
  width: number;
  height: number;
  /** Raw header offsets: offsetX is the left edge, offsetY the bottom edge relative to the origin. */
  offsetX: number;
  offsetY: number;
  length: number;
}

export interface Dc6 {
  version: number;
  directions: number;
  framesPerDir: number;
  /** frames[dir][frame] */
  frames: { header: Dc6FrameHeader; image: SpriteFrame }[][];
}

export function parseDc6(bytes: Uint8Array): Dc6 {
  const r = new BinaryReader(bytes);
  const version = r.i32();
  if (version !== 6) throw new Error(`unsupported DC6 version ${version}`);
  r.skip(12); // flags, encoding, termination
  const directions = r.u32();
  const framesPerDir = r.u32();
  if (directions > 64 || framesPerDir > 4096) throw new Error(`implausible DC6 counts ${directions}x${framesPerDir}`);
  const pointers: number[] = [];
  for (let i = 0; i < directions * framesPerDir; i++) pointers.push(r.u32());

  const frames: Dc6['frames'] = [];
  for (let d = 0; d < directions; d++) {
    const dir: Dc6['frames'][number] = [];
    for (let f = 0; f < framesPerDir; f++) {
      r.seek(pointers[d * framesPerDir + f]);
      const header: Dc6FrameHeader = {
        flip: r.u32() !== 0,
        width: r.u32(),
        height: r.u32(),
        offsetX: r.i32(),
        offsetY: r.i32(),
        length: (r.skip(8), r.u32()), // skips unknown + nextBlock
      };
      dir.push({ header, image: decodeDc6Frame(header, r.bytesView(header.length)) });
    }
    frames.push(dir);
  }
  return { version, directions, framesPerDir, frames };
}

/** Decodes one frame's RLE scanlines. 0x80 ends a line, 0x80|n skips n pixels, n < 0x80 copies n pixels. */
export function decodeDc6Frame(h: Dc6FrameHeader, data: Uint8Array): SpriteFrame {
  const { width, height } = h;
  if (width * height > 1 << 24) throw new Error(`implausible DC6 frame ${width}x${height}`);
  const pixels = new Uint8Array(width * height);
  let x = 0;
  let y = h.flip ? 0 : height - 1;
  const step = h.flip ? 1 : -1;
  let i = 0;
  while (i < data.length) {
    const b = data[i++];
    if (b === 0x80) {
      x = 0;
      y += step;
    } else if (b & 0x80) {
      x += b & 0x7f;
    } else {
      for (let n = 0; n < b && i < data.length; n++, x++) {
        const v = data[i++];
        if (x < width && y >= 0 && y < height) pixels[y * width + x] = v;
      }
    }
  }
  return { width, height, offsetX: h.offsetX, offsetY: h.offsetY - height, pixels };
}

/** A frame to write: palette indices (0 = transparent), top row first. */
export interface Dc6FrameIn {
  width: number;
  height: number;
  pixels: Uint8Array;
  offsetX?: number;
  offsetY?: number;
}

/**
 * Writes a DC6 (version 6, one direction) the way the game's own UI images are stored: each frame's rows bottom-up,
 * runs of transparent pixels as 0x80|n, runs of pixels as n then the indices (n ≤ 127), 0x80 ending a row (trailing
 * transparency is left out), then the three 0xEE termination bytes.
 */
export function writeDc6(frames: Dc6FrameIn[]): Uint8Array {
  const bodies = frames.map((f) => {
    const out: number[] = [];
    for (let y = f.height - 1; y >= 0; y--) {
      const row = f.pixels.subarray(y * f.width, (y + 1) * f.width);
      let end = row.length;
      while (end > 0 && row[end - 1] === 0) end--;
      let x = 0;
      while (x < end) {
        if (row[x] === 0) {
          let n = 0;
          while (x < end && row[x] === 0 && n < 127) (x++, n++);
          out.push(0x80 | n);
        } else {
          let n = 0;
          while (x + n < end && row[x + n] !== 0 && n < 127) n++;
          out.push(n, ...row.subarray(x, x + n));
          x += n;
        }
      }
      out.push(0x80);
    }
    return Uint8Array.from(out);
  });
  const headerSize = 24 + frames.length * 4;
  const sizes = bodies.map((b) => 32 + b.length + 3);
  const total = headerSize + sizes.reduce((a, b) => a + b, 0);
  const bytes = new Uint8Array(total);
  const v = new DataView(bytes.buffer);
  v.setInt32(0, 6, true);
  v.setInt32(4, 1, true);
  v.setInt32(8, 0, true);
  v.setUint32(12, 0xeeeeeeee, true);
  v.setUint32(16, 1, true);
  v.setUint32(20, frames.length, true);
  let at = headerSize;
  frames.forEach((f, i) => {
    v.setUint32(24 + i * 4, at, true);
    const next = at + sizes[i];
    v.setUint32(at, 0, true); // stored bottom-up
    v.setUint32(at + 4, f.width, true);
    v.setUint32(at + 8, f.height, true);
    v.setInt32(at + 12, f.offsetX ?? 0, true);
    v.setInt32(at + 16, f.offsetY ?? 0, true);
    v.setUint32(at + 20, 0, true);
    v.setUint32(at + 24, next, true);
    v.setUint32(at + 28, bodies[i].length, true);
    bytes.set(bodies[i], at + 32);
    bytes.set([0xee, 0xee, 0xee], at + 32 + bodies[i].length);
    at = next;
  });
  return bytes;
}
