import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { parseDc6, writeDc6 } from '../src/formats/dc6';
import { entryDc6, loadFont, renderEntryText, suggestEntryName } from '../src/game/entryText';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2, MOD_DATA } from '../tools/testdata';

describe('DC6 writing', () => {
  it('reads back what it writes, rows bottom-up with long runs split', () => {
    const w = 300, h = 3;
    const pixels = new Uint8Array(w * h);
    for (let x = 0; x < 200; x++) pixels[x] = 5; // a run longer than 127
    pixels[w + 250] = 9; // a skip longer than 127
    const d = parseDc6(writeDc6([{ width: w, height: h, pixels }]));
    expect(d.frames[0][0].image.pixels).toEqual(pixels);
  });
  it('suggests a free, short file name', () => {
    expect(suggestEntryName("Na-Krul's Abyss", () => false)).toBe('nakrulsaby');
    expect(suggestEntryName('guild5', (n) => n === 'guild5')).toBe('guild52');
  });
});

describe.runIf(hasD2)("the entering text, drawn with the game's font", async () => {
  const fs = hasD2 ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))))) : null!;
  const font = hasD2 ? loadFont(await fs.readOrThrow('data/local/font/latin/font42.dc6'), await fs.readOrThrow('data/local/font/latin/font42.tbl')) : null!;

  it('cuts the line into frames 256 pixels across, glyphs placed by their advance widths', () => {
    const img = renderEntryText(font, 'Entering The Guild Hall');
    expect(img.height).toBe(41);
    expect(img.missing).toEqual([]);
    const d = parseDc6(entryDc6(img));
    expect(d.frames[0].map((f) => f.image.width)).toEqual([256, img.width - 256]);
    const back = new Uint8Array(img.width * img.height);
    let x0 = 0;
    for (const f of d.frames[0]) {
      for (let y = 0; y < f.image.height; y++) back.set(f.image.pixels.subarray(y * f.image.width, (y + 1) * f.image.width), y * img.width + x0);
      x0 += f.image.width;
    }
    expect(back).toEqual(img.pixels);
  });

  // PD2's own entering text (made with txt2dc6): DS1 Studio rebuilds it byte for byte.
  const pd2 = ['pd2data.mpq', 'pd2assets.mpq'].map((m) => `${MOD_DATA.replace(/[\/]data$/i, '')}/${m}`).filter((p) => existsSync(p));
  it.runIf(pd2.length > 0)('matches PD2’s U5L1.dc6 exactly', async () => {
    const mods = await Promise.all(pd2.map((p) => MpqSource.open(p, new NodeFileAccess(p))));
    const ref = await new LayeredFs(mods).read('data/local/ui/eng/expansion/U5L1.dc6');
    expect(ref).not.toBeNull();
    expect(entryDc6(renderEntryText(font, "Entering Na-Krul's Abyss"))).toEqual(ref);
  });
});
