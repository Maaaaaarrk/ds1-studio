import { describe, expect, it } from 'vitest';
import { parseTbl, writeTbl } from '../src/formats/tbl';
import { blankObjectNames, lookupString, nameStringsWrite, readStringTables } from '../src/game/objectStrings';
import { LayeredFs, LooseSource, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('object names shown in game', async () => {
  const mpqs = hasD2 ? await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))) : [];

  it('finds the names that show as empty boxes (the cut guild objects) and fixes them in patchstring.tbl', async () => {
    const fs = new LayeredFs(mpqs);
    const tables = await readStringTables(fs);
    expect(tables).toHaveLength(3);
    expect(lookupString(tables, 'bank')).toBe('Your Private Stash');
    const blanks = blankObjectNames(tables, ['Guild Vault', 'Steeg Stone', 'Steeg Stone', 'bank', 'no such key here']);
    expect(blanks).toEqual([
      { key: 'Guild Vault', blank: true, count: 1, suggested: 'Guild Vault' },
      { key: 'Steeg Stone', blank: true, count: 2, suggested: 'Steeg Stone' },
      { key: 'no such key here', blank: false, count: 1, suggested: 'no such key here' },
    ]);
    // The fix: the mod's patchstring.tbl gets the names, and the game (patchstring first) now finds them.
    const write = (await nameStringsWrite(fs, { 'Guild Vault': 'Guild Vault', 'Steeg Stone': 'Steeg Stone' }))!;
    expect(write.path).toBe('data/local/lng/eng/patchstring.tbl');
    const mod = new LayeredFs([new LooseSource('mod', new Map([[write.path, async () => write.bytes]])), ...mpqs]);
    const after = await readStringTables(mod);
    expect(blankObjectNames(after, ['Guild Vault', 'Steeg Stone'])).toEqual([]);
    // Nothing else in patchstring.tbl changed.
    const before = parseTbl((await fs.read(write.path))!);
    expect(parseTbl(write.bytes).entries.slice(0, before.entries.length)).toEqual(before.entries);
    expect(writeTbl(parseTbl(write.bytes)).length).toBe(write.bytes.length);
  });
});
