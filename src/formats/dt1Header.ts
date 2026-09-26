/**
 * A DT1 tile's settings — everything Paul Siramy's DT1 Tools put in a tile's `.ini` block — read and written in place
 * (each tile header is 96 bytes at a fixed spot, so editing never touches the pixel data), plus the `.ini` text
 * format itself for exporting to and importing from DT1 Tools.
 *
 * Tile header (offsets inside the 96-byte header): 0 direction i32, 4 roof height i16, 6 sound u8, 7 animated u8,
 * 8 height i32, 12 width i32, 20 orientation i32, 24 main index i32, 28 sub index i32, 32 frame/rarity i32,
 * 36 "unknown" u32, 40 sub-tile flags ×25 (file order: bottom row first — see `iniRowsFromFlags`).
 */

export interface TileSettings {
  direction: number;
  roofHeight: number;
  sound: number;
  animated: boolean;
  orientation: number;
  mainIndex: number;
  subIndex: number;
  /** Rarity (how often this variant is picked), or the frame number for animated tiles ("frame" in the .ini). */
  frame: number;
  unknown: number;
  /** 25 bytes in file order. */
  flags: Uint8Array;
}

const HEADER_SIZE = 96;

function headerOffset(bytes: Uint8Array, index: number): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getInt32(268, true);
  if (index < 0 || index >= count) throw new Error(`tile ${index} out of range (0-${count - 1})`);
  return dv.getInt32(272, true) + index * HEADER_SIZE;
}

export function tileCount(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(268, true);
}

export function readTileSettings(bytes: Uint8Array, index: number): TileSettings {
  const o = headerOffset(bytes, index);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    direction: dv.getInt32(o, true),
    roofHeight: dv.getInt16(o + 4, true),
    sound: dv.getUint8(o + 6),
    animated: dv.getUint8(o + 7) !== 0,
    orientation: dv.getInt32(o + 20, true),
    mainIndex: dv.getInt32(o + 24, true),
    subIndex: dv.getInt32(o + 28, true),
    frame: dv.getInt32(o + 32, true),
    unknown: dv.getUint32(o + 36, true),
    flags: bytes.slice(o + 40, o + 65),
  };
}

/** A copy of the DT1 with some tiles' settings changed (only the given fields). */
export function writeTileSettings(bytes: Uint8Array, changes: Map<number, Partial<TileSettings>>): Uint8Array {
  const out = bytes.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const [index, c] of changes) {
    const o = headerOffset(out, index);
    if (c.direction !== undefined) dv.setInt32(o, c.direction, true);
    if (c.roofHeight !== undefined) dv.setInt16(o + 4, c.roofHeight, true);
    if (c.sound !== undefined) dv.setUint8(o + 6, c.sound & 0xff);
    if (c.animated !== undefined) dv.setUint8(o + 7, c.animated ? 1 : 0);
    if (c.orientation !== undefined) dv.setInt32(o + 20, c.orientation, true);
    if (c.mainIndex !== undefined) dv.setInt32(o + 24, c.mainIndex, true);
    if (c.subIndex !== undefined) dv.setInt32(o + 28, c.subIndex, true);
    if (c.frame !== undefined) dv.setInt32(o + 32, c.frame, true);
    if (c.unknown !== undefined) dv.setUint32(o + 36, c.unknown >>> 0, true);
    if (c.flags) {
      if (c.flags.length !== 25) throw new Error('sub-tile flags must be 25 values');
      out.set(c.flags, o + 40);
    }
  }
  return out;
}

/**
 * The .ini lists the 5×5 flags as five rows top to bottom (`floor_flag1` = the row furthest from the viewer); the file
 * stores the bottom row first. These convert between the two (row r of the .ini = file bytes (4-r)*5 ..).
 */
export function iniRowsFromFlags(flags: Uint8Array): number[][] {
  return [0, 1, 2, 3, 4].map((r) => [...flags.slice((4 - r) * 5, (4 - r) * 5 + 5)]);
}
export function flagsFromIniRows(rows: number[][]): Uint8Array {
  const out = new Uint8Array(25);
  rows.forEach((row, r) => row.forEach((v, c) => (out[(4 - r) * 5 + c] = v & 0xff)));
  return out;
}

const hex8 = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
const hex2 = (n: number) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');

/** DT1 Tools' name for the image sheet a tile goes in, by kind (floors/shadows "fs", walls "ws", roofs "rf"…). */
export function pcxSheet(orientation: number): string {
  if (orientation === 0 || orientation === 13) return 'fs';
  if (orientation === 15) return 'rf';
  if (orientation >= 16) return 'wd';
  return 'ws';
}

/**
 * The DT1 as a DT1 Tools `.ini`. `pcx_x`/`pcx_y` place each tile in its sheet (160-pixel columns, 5 per row; rows as
 * tall as the tallest tile of that kind) — DS1 Studio doesn't write the .pcx sheets themselves.
 */
export function dt1ToIni(bytes: Uint8Array, sizes: { width: number; height: number }[]): string {
  const n = tileCount(bytes);
  const lines = [`nb_blocks   = ${n}`, ''];
  const sheet = new Map<string, { col: number; y: number; rowH: number }>();
  for (let i = 0; i < n; i++) {
    const t = readTileSettings(bytes, i);
    const name = pcxSheet(t.orientation);
    const pos = sheet.get(name) ?? { col: 0, y: 0, rowH: 0 };
    const h = Math.abs(sizes[i]?.height ?? 80) || 80;
    const x = pos.col * 160;
    const y = pos.y;
    pos.rowH = Math.max(pos.rowH, h);
    pos.col++;
    if (pos.col === 5) {
      pos.col = 0;
      pos.y += pos.rowH;
      pos.rowH = 0;
    }
    sheet.set(name, pos);
    lines.push(
      `block       = ${i}`,
      `pcx_file    = ${name}`,
      `pcx_x       = ${x}`,
      `pcx_y       = ${y}`,
      `direction   = ${hex8(t.direction)}`,
      `roof_y      = ${t.roofHeight}`,
      `tile_sound  = ${t.sound}`,
      `animated    = ${t.animated ? 1 : 0}`,
      `orientation = ${hex8(t.orientation)}`,
      `main_index  = ${hex8(t.mainIndex)}`,
      `sub_index   = ${hex8(t.subIndex)}`,
      `frame       = ${hex8(t.frame)}`,
      `unknown     = ${hex8(t.unknown)}`,
      ...iniRowsFromFlags(t.flags).map((row, r) => `floor_flag${r + 1} = ${row.map(hex2).join(' ')}`),
      '',
    );
  }
  return lines.join('\r\n');
}

export interface IniBlock {
  block: number;
  settings: Partial<TileSettings>;
}

/** Reads a DT1 Tools `.ini` (numbers in the same bases the tools write: hex fields hex, roof_y/sound decimal). */
export function parseDt1Ini(text: string): { blocks: IniBlock[]; count: number | null } {
  const blocks: IniBlock[] = [];
  let count: number | null = null;
  let cur: IniBlock | null = null;
  const rows: number[][] = [];
  const flush = () => {
    if (cur && rows.length === 5) cur.settings.flags = flagsFromIniRows(rows);
    rows.length = 0;
  };
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([a-z_0-9]+)\s*=\s*(.*?)\s*$/i.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    const k = key.toLowerCase();
    const hex = () => parseInt(value, 16) | 0;
    const dec = () => parseInt(value, 10) || 0;
    if (k === 'nb_blocks') count = dec();
    else if (k === 'block') {
      flush();
      cur = { block: dec(), settings: {} };
      blocks.push(cur);
    } else if (!cur) continue;
    else if (k === 'direction') cur.settings.direction = hex();
    else if (k === 'roof_y') cur.settings.roofHeight = dec();
    else if (k === 'tile_sound') cur.settings.sound = dec();
    else if (k === 'animated') cur.settings.animated = dec() !== 0;
    else if (k === 'orientation') cur.settings.orientation = hex();
    else if (k === 'main_index') cur.settings.mainIndex = hex();
    else if (k === 'sub_index') cur.settings.subIndex = hex();
    else if (k === 'frame') cur.settings.frame = hex();
    else if (k === 'unknown') cur.settings.unknown = parseInt(value, 16) >>> 0;
    else if (/^floor_flag[1-5]$/.test(k)) rows[Number(k.slice(-1)) - 1] = value.split(/\s+/).map((v) => parseInt(v, 16) & 0xff);
  }
  flush();
  return { blocks, count };
}
