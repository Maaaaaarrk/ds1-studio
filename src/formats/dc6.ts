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
