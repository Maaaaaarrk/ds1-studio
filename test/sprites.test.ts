import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseCof } from '../src/formats/cof';
import { parseDc6 } from '../src/formats/dc6';
import { decodeDccDirection, parseDcc } from '../src/formats/dcc';
import { parsePalette, type Palette } from '../src/formats/palette';
import { loadObjectSprite, loadSpriteDetailed, parseObjTxt, type Sprite, type SpriteSpec } from '../src/game/sprites';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2, WINDS1_OBJ_TXT } from '../tools/testdata';

/** WinDS1's object table (read-only). Override with D2_OBJ_TXT. */
const OBJ_TXT = WINDS1_OBJ_TXT;
/** Where to drop PNGs for eyeballing; set SPRITE_PNG_DIR to enable. */
const PNG_DIR = process.env.SPRITE_PNG_DIR;
const hasObjTxt = existsSync(OBJ_TXT);

describe.runIf(hasD2)('sprites', async () => {
  const fs = hasD2
    ? new LayeredFs(
        await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq', 'd2char.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))),
      )
    : null!;
  const rows = hasObjTxt ? parseObjTxt(readFileSync(OBJ_TXT, 'latin1')) : [];
  const spec = (act: number, type: number, id: number): SpriteSpec => {
    const row = rows.find((r) => r.act === act && r.type === type && r.id === id);
    if (!row?.spec) throw new Error(`obj.txt has no sprite for ${act}/${type}/${id}`);
    return row.spec;
  };

  it('decodes a DCC', async () => {
    const dcc = parseDcc((await fs.read('data/global/monsters/wa/tr/watrlitnuhth.dcc'))!);
    expect(dcc.directions).toBe(8);
    for (let d = 0; d < dcc.directions; d++) {
      const dir = decodeDccDirection(dcc, d);
      expect(dir.frames).toHaveLength(dcc.framesPerDir);
      const img = dir.frames[0].image;
      expect(img.width).toBeGreaterThan(10);
      expect(img.height).toBeGreaterThan(40);
      expect(img.offsetY).toBeLessThan(0); // drawn above the feet
      expect(img.pixels.some((p) => p !== 0)).toBe(true);
    }
  });

  it('decodes a DC6', async () => {
    const dc6 = parseDc6((await fs.read('data/global/monsters/di/tr/ditrlitdthth.dc6'))!);
    expect(dc6.directions).toBeGreaterThan(0);
    const img = dc6.frames[0][0].image;
    expect(img.width).toBeGreaterThan(10);
    expect(img.height).toBeGreaterThan(10);
    expect(img.pixels.some((p) => p !== 0)).toBe(true);
  });

  it('parses a COF', async () => {
    const cof = parseCof((await fs.read('data/global/monsters/rg/cof/rgnuhth.cof'))!);
    expect(cof.directions).toBe(8);
    expect(cof.layers.length).toBeGreaterThan(3);
    expect(cof.layers.every((l) => l.weaponClass.toUpperCase() === 'HTH')).toBe(true);
    expect(cof.priority).toHaveLength(cof.directions * cof.framesPerDir * cof.layers.length);
  });

  const named: [string, number, number, number][] = [
    ['warriv', 1, 1, 7],
    ['gheed', 1, 1, 0],
    ['akara', 1, 1, 2],
    ['rogue', 1, 1, 4],
    ['bonebrk', 1, 1, 35],
    ['waypoint', 1, 2, 37],
    ['torch', 1, 2, 1],
    ['stash', 1, 2, 102],
  ];
  it.runIf(hasObjTxt).each(named)('composes %s', async (name, act, type, id) => {
    const { sprite, missing } = await loadSpriteDetailed(fs, spec(act, type, id));
    expect(missing).toEqual([]);
    expect(sprite).not.toBeNull();
    const s = sprite!;
    expect(s.width).toBeGreaterThan(10);
    expect(s.height).toBeGreaterThan(10);
    expect(s.width * s.height).toBeLessThan(400 * 400);
    expect(s.pixels.filter((p) => p !== 0).length).toBeGreaterThan(50);
    // The origin (feet) lies within or just below the sprite.
    expect(s.offsetX).toBeLessThanOrEqual(0);
    expect(s.offsetX + s.width).toBeGreaterThan(0);
    if (PNG_DIR) {
      const pal = parsePalette((await fs.read(`data/global/palette/ACT${act}/pal.dat`))!);
      mkdirSync(PNG_DIR, { recursive: true });
      writeFileSync(`${PNG_DIR}/${name}.png`, spritePng(s, pal, 3));
    }
  });

  it('composes a DC6-backed sprite (Diablo death)', async () => {
    const s = await loadObjectSprite(fs, { base: 'Data\\Global\\Monsters', token: 'DI', mode: 'DT', cls: 'HTH', parts: { HD: 'LIT', TR: 'LIT', LG: 'LIT', RA: 'LIT', LA: 'LIT', S1: 'LIT', S2: 'LIT' } });
    expect(s).not.toBeNull();
    expect(s!.pixels.some((p) => p !== 0)).toBe(true);
  });

  it('returns null for missing sprites', async () => {
    expect(await loadObjectSprite(fs, { base: 'Data\\Global\\Objects', token: 'ZZ', mode: 'NU', cls: 'HTH', parts: { TR: 'LIT' } })).toBeNull();
  });

  it.runIf(hasObjTxt)('composes every obj.txt row without parse errors', async () => {
    let ok = 0;
    let empty = 0;
    const errors: string[] = [];
    const missingRows: string[] = [];
    const withSpec = rows.filter((r) => r.spec);
    for (const r of withSpec) {
      const label = `${r.act}/${r.type}/${r.id} ${r.description}`;
      try {
        const { sprite, missing } = await loadSpriteDetailed(fs, r.spec!);
        if (missing.length) missingRows.push(`${label}: ${missing.join(', ')}`);
        if (sprite) ok++;
        else if (!missing.length) empty++;
      } catch (e) {
        errors.push(`${label}: ${(e as Error).message}`);
      }
    }
    const placeholders = rows.filter((r) => !r.spec).length;
    console.log(`obj.txt: ${withSpec.length} sprite rows, ${ok} composed, ${errors.length} errors, ${missingRows.length} with missing files, ${empty} empty; ${placeholders} rows without Token/Mode/Class`);
    console.log(missingRows.join('\n'));
    expect(errors).toEqual([]);
    expect(ok / withSpec.length).toBeGreaterThan(0.95);
  }, 120_000);
});

/** Minimal RGBA PNG encoder, scaled by `scale` (nearest neighbour). */
function spritePng(s: Sprite, pal: Palette, scale: number): Uint8Array {
  const w = s.width * scale;
  const h = s.height * scale;
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    for (let x = 0; x < w; x++) {
      const i = s.pixels[Math.floor(y / scale) * s.width + Math.floor(x / scale)];
      raw.set(i ? pal.subarray(i * 4, i * 4 + 4) : [0, 0, 0, 0], row + 1 + x * 4);
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const chunks = [pngChunk('IHDR', ihdr), pngChunk('IDAT', zlibSync(raw)), pngChunk('IEND', new Uint8Array(0))];
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const out = new Uint8Array(8 + chunks.reduce((n, c) => n + c.length, 0));
  out.set(sig);
  let o = 8;
  for (const c of chunks) (out.set(c, o), (o += c.length));
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
