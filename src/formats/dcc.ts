import { BinaryReader } from '../util/BinaryReader';
import type { SpriteFrame } from './dc6';

/**
 * DCC = compressed animation (one file per unit component/mode). Each direction is a
 * bitstream: frame headers, then five sub-streams (equal cells, pixel masks, encoding
 * types, raw pixel codes, pixel codes + displacements) that rebuild frames 4x4 cell by cell,
 * each cell reusing the previous frame's cell where possible. Follows Paul Siramy's DCC docs.
 */

export interface Dcc {
  directions: number;
  framesPerDir: number;
  /** Byte offset of each direction's bitstream. */
  directionOffsets: number[];
  bytes: Uint8Array;
}

export interface DccFrameHeader {
  width: number;
  height: number;
  xOffset: number;
  yOffset: number;
  optionalBytes: number;
  codedBytes: number;
  bottomUp: boolean;
}

export interface DccDirection {
  /** Bounding box of all frames, relative to the sprite origin. */
  box: Box;
  frames: { header: DccFrameHeader; image: SpriteFrame }[];
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 4-bit field width codes -> actual bit counts. */
const BIT_WIDTHS = [0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 26, 28, 30, 32];
/** Number of set bits in a 4-bit pixel mask. */
const MASK_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

export function parseDcc(bytes: Uint8Array): Dcc {
  const r = new BinaryReader(bytes);
  const signature = r.u8();
  if (signature !== 0x74) throw new Error(`bad DCC signature 0x${signature.toString(16)}`);
  r.u8(); // version (6)
  const directions = r.u8();
  const framesPerDir = r.u32();
  r.skip(8); // tag (1) + total coded size
  const directionOffsets: number[] = [];
  for (let i = 0; i < directions; i++) directionOffsets.push(r.u32());
  return { directions, framesPerDir, directionOffsets, bytes };
}

/** LSB-first bit reader over a byte range. */
class BitReader {
  constructor(
    private readonly bytes: Uint8Array,
    public pos: number, // in bits
    private readonly end: number = bytes.length * 8,
  ) {}

  bit(): number {
    if (this.pos >= this.end) throw new RangeError(`DCC bitstream overrun at bit ${this.pos}`);
    const v = (this.bytes[this.pos >> 3] >> (this.pos & 7)) & 1;
    this.pos++;
    return v;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v += this.bit() * 2 ** i;
    return v;
  }

  signed(n: number): number {
    if (n === 0) return 0;
    const v = this.bits(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }

  /** A reader for the next `n` bits; this reader skips past them. */
  take(n: number): BitReader {
    const sub = new BitReader(this.bytes, this.pos, this.pos + n);
    this.pos += n;
    return sub;
  }
}

interface Cell {
  x: number; // relative to the direction box
  y: number;
  w: number;
  h: number;
}

interface BufferCell {
  lastW: number;
  lastH: number;
  lastX: number;
  lastY: number;
}

interface PixelBufferEntry {
  value: [number, number, number, number];
  frame: number;
  frameCell: number;
}

/** Splits `size` pixels starting at `offset` (relative to the 4-aligned direction grid) into cell sizes. */
function cellSizes(offset: number, size: number): number[] {
  const first = 4 - (offset % 4);
  if (size - first <= 1) return [size];
  const tmp = size - first - 1;
  const count = 2 + Math.floor(tmp / 4) - (tmp % 4 === 0 ? 1 : 0);
  const sizes = [first];
  for (let i = 1; i < count - 1; i++) sizes.push(4);
  sizes.push(size - first - 4 * (count - 2));
  return sizes;
}

/** Decodes every frame of one direction. */
export function decodeDccDirection(dcc: Dcc, direction: number): DccDirection {
  const start = dcc.directionOffsets[direction];
  if (start === undefined) throw new Error(`DCC has no direction ${direction}`);
  const end = direction + 1 < dcc.directions ? dcc.directionOffsets[direction + 1] : dcc.bytes.length;
  const bs = new BitReader(dcc.bytes, start * 8, end * 8);

  bs.bits(32); // outsize coded
  const compression = bs.bits(2);
  const variable0Bits = BIT_WIDTHS[bs.bits(4)];
  const widthBits = BIT_WIDTHS[bs.bits(4)];
  const heightBits = BIT_WIDTHS[bs.bits(4)];
  const xOffsetBits = BIT_WIDTHS[bs.bits(4)];
  const yOffsetBits = BIT_WIDTHS[bs.bits(4)];
  const optionalBits = BIT_WIDTHS[bs.bits(4)];
  const codedBytesBits = BIT_WIDTHS[bs.bits(4)];

  // Frame headers and bounding boxes.
  const headers: DccFrameHeader[] = [];
  const boxes: Box[] = [];
  for (let f = 0; f < dcc.framesPerDir; f++) {
    bs.bits(variable0Bits);
    const h: DccFrameHeader = {
      width: bs.bits(widthBits),
      height: bs.bits(heightBits),
      xOffset: bs.signed(xOffsetBits),
      yOffset: bs.signed(yOffsetBits),
      optionalBytes: bs.bits(optionalBits),
      codedBytes: bs.bits(codedBytesBits),
      bottomUp: bs.bit() === 1,
    };
    if (h.width * h.height > 1 << 22) throw new Error(`implausible DCC frame ${h.width}x${h.height}`);
    headers.push(h);
    // yOffset is the frame's bottom line (top line for bottom-up frames).
    const top = h.bottomUp ? h.yOffset : h.yOffset - h.height + 1;
    boxes.push({ left: h.xOffset, top, width: h.width, height: h.height });
  }

  // Optional per-frame data is byte-aligned and unused.
  const optionalTotal = headers.reduce((s, h) => s + h.optionalBytes, 0);
  if (optionalTotal > 0) {
    bs.pos = Math.ceil(bs.pos / 8) * 8;
    bs.pos += optionalTotal * 8;
  }

  const equalCellsSize = compression & 2 ? bs.bits(20) : 0;
  const pixelMaskSize = bs.bits(20);
  const encodingTypeSize = compression & 1 ? bs.bits(20) : 0;
  const rawPixelSize = compression & 1 ? bs.bits(20) : 0;

  // Pixel values key: which palette indices this direction uses.
  const pixelValues: number[] = [];
  for (let i = 0; i < 256; i++) if (bs.bit()) pixelValues.push(i);

  const equalCells = bs.take(equalCellsSize);
  const pixelMask = bs.take(pixelMaskSize);
  const encodingType = bs.take(encodingTypeSize);
  const rawPixels = bs.take(rawPixelSize);
  const codes = bs; // pixel codes and displacements: the rest of the direction

  // Direction box.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.left);
    minY = Math.min(minY, b.top);
    maxX = Math.max(maxX, b.left + b.width);
    maxY = Math.max(maxY, b.top + b.height);
  }
  if (!boxes.length) return { box: { left: 0, top: 0, width: 0, height: 0 }, frames: [] };
  const box: Box = { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  const dirCellsX = 1 + Math.floor((box.width - 1) / 4);
  const dirCellsY = 1 + Math.floor((box.height - 1) / 4);

  // Frame cell grids, aligned to the direction's 4x4 grid.
  const frameCells = boxes.map((b) => {
    const ox = b.left - box.left;
    const oy = b.top - box.top;
    const ws = cellSizes(ox, b.width);
    const hs = cellSizes(oy, b.height);
    const cells: Cell[] = [];
    let y = oy;
    for (const h of hs) {
      let x = ox;
      for (const w of ws) {
        cells.push({ x, y, w, h });
        x += w;
      }
      y += h;
    }
    return { cells, cellsX: ws.length, cellsY: hs.length, originX: Math.floor(ox / 4), originY: Math.floor(oy / 4) };
  });

  // Stage 1: fill the pixel buffer (up to 4 colours per changed cell).
  const pixelBuffer: PixelBufferEntry[] = [];
  const cellBuffer: (PixelBufferEntry | null)[] = new Array(dirCellsX * dirCellsY).fill(null);
  frameCells.forEach((fc, frameIndex) => {
    for (let cy = 0; cy < fc.cellsY; cy++) {
      for (let cx = 0; cx < fc.cellsX; cx++) {
        const cellIndex = fc.originX + cx + (fc.originY + cy) * dirCellsX;
        const old = cellBuffer[cellIndex];
        let mask = 0x0f;
        if (old) {
          if (equalCellsSize > 0 && equalCells.bit()) continue; // same as previous frame
          mask = pixelMask.bits(4);
        }
        const stack = [0, 0, 0, 0];
        let last = 0;
        let decoded = 0;
        const count = MASK_BITS[mask];
        const raw = count !== 0 && encodingTypeSize > 0 ? encodingType.bit() : 0;
        for (let i = 0; i < count; i++) {
          if (raw) {
            stack[i] = rawPixels.bits(8);
          } else {
            let d = codes.bits(4);
            stack[i] = last + d;
            while (d === 15) {
              d = codes.bits(4);
              stack[i] += d;
            }
          }
          if (stack[i] === last) {
            stack[i] = 0;
            break;
          }
          last = stack[i];
          decoded++;
        }
        const value: [number, number, number, number] = [0, 0, 0, 0];
        let cur = decoded - 1;
        for (let i = 0; i < 4; i++) {
          if (mask & (1 << i)) value[i] = cur >= 0 ? stack[cur--] : 0;
          else value[i] = old!.value[i];
        }
        const entry = { value, frame: frameIndex, frameCell: cx + cy * fc.cellsX };
        pixelBuffer.push(entry);
        cellBuffer[cellIndex] = entry;
      }
    }
  });
  // Map pixel-value keys to palette indices (a separate pass: entries above were chained by key).
  for (const e of pixelBuffer) for (let i = 0; i < 4; i++) e.value[i] = pixelValues[e.value[i]] ?? 0;

  // Stage 2: rebuild frames on a direction-sized canvas.
  const bw = box.width;
  const canvas = new Uint8Array(bw * box.height);
  const bufferCells: BufferCell[] = Array.from({ length: dirCellsX * dirCellsY }, () => ({ lastW: -1, lastH: -1, lastX: 0, lastY: 0 }));
  let pb = 0;
  const frames = frameCells.map((fc, frameIndex) => {
    const b = boxes[frameIndex];
    const frameX = b.left - box.left;
    const frameY = b.top - box.top;
    const pixels = new Uint8Array(b.width * b.height);
    const blitToFrame = (c: Cell) => {
      for (let y = 0; y < c.h; y++)
        for (let x = 0; x < c.w; x++) pixels[(c.y - frameY + y) * b.width + c.x - frameX + x] = canvas[(c.y + y) * bw + c.x + x];
    };
    fc.cells.forEach((c, ci) => {
      const buf = bufferCells[Math.floor(c.x / 4) + Math.floor(c.y / 4) * dirCellsX];
      const e = pixelBuffer[pb];
      if (!e || e.frame !== frameIndex || e.frameCell !== ci) {
        // Equal cell: reuse the previous frame's cell if its size matches, else it's transparent.
        if (c.w !== buf.lastW || c.h !== buf.lastH) {
          for (let y = 0; y < c.h; y++) canvas.fill(0, (c.y + y) * bw + c.x, (c.y + y) * bw + c.x + c.w);
        } else {
          for (let y = 0; y < c.h; y++) canvas.copyWithin((c.y + y) * bw + c.x, (buf.lastY + y) * bw + buf.lastX, (buf.lastY + y) * bw + buf.lastX + c.w);
          blitToFrame(c);
        }
      } else {
        if (e.value[0] === e.value[1]) {
          for (let y = 0; y < c.h; y++) canvas.fill(e.value[0], (c.y + y) * bw + c.x, (c.y + y) * bw + c.x + c.w);
        } else {
          const n = e.value[1] === e.value[2] ? 1 : 2;
          for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) canvas[(c.y + y) * bw + c.x + x] = e.value[codes.bits(n)];
        }
        blitToFrame(c);
        pb++;
      }
      buf.lastW = c.w;
      buf.lastH = c.h;
      buf.lastX = c.x;
      buf.lastY = c.y;
    });
    const image: SpriteFrame = { width: b.width, height: b.height, offsetX: b.left, offsetY: b.top, pixels };
    return { header: headers[frameIndex], image };
  });
  return { box, frames };
}

/** Decodes a single frame (still needs to replay the direction up to it). */
export function decodeDccFrame(dcc: Dcc, direction: number, frame: number): SpriteFrame | null {
  return decodeDccDirection(dcc, direction).frames[frame]?.image ?? null;
}
