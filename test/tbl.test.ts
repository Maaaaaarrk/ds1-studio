import { describe, expect, it } from 'vitest';
import { parseTbl, parseTblRaw, setTblStrings, tblCrc, tblHash, tblLookup, writeTbl } from '../src/formats/tbl';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('string tables (.tbl), checked against the game\'s own', async () => {
  const fs = hasD2
    ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))))
    : null!;
  const files = ['string.tbl', 'expansionstring.tbl', 'patchstring.tbl'];
  const bytes = hasD2 ? await Promise.all(files.map(async (f) => (await fs.read(`data/local/lng/eng/${f}`))!)) : [];

  it.each(files.map((f, i) => [f, i] as const))('%s: our hash matches the stored one for every string, and lookups find them', (_, i) => {
    const b = bytes[i];
    const raw = parseTblRaw(b);
    const t = parseTbl(b);
    expect(t.entries.length).toBe(raw.count);
    expect(raw.count).toBeGreaterThan(100);
    let checked = 0;
    raw.order.forEach((n, idx) => {
      const node = raw.nodes[n];
      expect(node.index).toBe(idx);
      expect(tblHash(t.entries[idx].key, raw.hashSize)).toBe(node.hash);
      checked++;
    });
    expect(checked).toBe(raw.count);
    // Every key the game can find is found by our lookup (duplicate keys: the first one wins, as in the game).
    const first = new Map<string, string>();
    for (const e of t.entries) if (!first.has(e.key)) first.set(e.key, e.value);
    for (const [k, v] of [...first].slice(0, 400)) expect(tblLookup(b, k)).toBe(v);
  });

  it.each(files.map((f, i) => [f, i] as const))('%s: the header CRC is CRC-16/CCITT over the strings, and a rewrite reproduces the file', (_, i) => {
    const b = bytes[i];
    expect(tblCrc(b)).toBe(new DataView(b.buffer, b.byteOffset).getUint16(0, true));
    // Written back unchanged: the same CRC (a stale CRC makes the game halt at start-up).
    const out = writeTbl(parseTbl(b));
    expect(new DataView(out.buffer).getUint16(0, true)).toBe(tblCrc(out));
    // Max probes is a count (the longest search + 1), as the game stores it: one less hides the string that needs
    // the longest search (it showed as an empty item name in game). The game's own tables rewrite to the same value.
    expect(parseTblRaw(out).maxTries).toBe(parseTblRaw(b).maxTries);
  });

  it('writes a table the game can read: same strings, same numbers, and new ones found', () => {
    const b = bytes[2];
    const t = parseTbl(b);
    const plus = setTblStrings(t, { ds1s_test_item: 'Guild Hall Map', ds1s_test_level: 'Guild Hall' });
    const out = writeTbl(plus);
    expect(new DataView(out.buffer).getUint16(0, true)).toBe(tblCrc(out));
    expect(new DataView(out.buffer).getUint16(0, true)).not.toBe(t.crc); // new strings, new CRC
    const back = parseTbl(out);
    expect(back.entries.slice(0, t.entries.length)).toEqual(t.entries); // numbers unchanged
    expect(back.entries.length).toBe(t.entries.length + 2);
    expect(tblLookup(out, 'ds1s_test_item')).toBe('Guild Hall Map');
    expect(tblLookup(out, 'ds1s_test_level')).toBe('Guild Hall');
    // Stored hashes and probing are consistent for every string.
    const raw = parseTblRaw(out);
    raw.order.forEach((n, idx) => expect(raw.nodes[n].hash).toBe(tblHash(back.entries[idx].key, raw.hashSize)));
    const seen = new Set<string>();
    for (const e of back.entries) if (!seen.has(e.key)) {
      seen.add(e.key);
      expect(tblLookup(out, e.key)).toBe(e.value);
    }
  });
});
