import { describe, expect, it } from 'vitest';
import { mergeAutomapRows, namesByNumber, readAutomapRows } from '../src/game/automapImport';

const enc = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n') + '\r\n');
const HEAD = 'LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\tType2\tCel2\tType2\tCel3\tType4\tCel4';

describe('importing AutoMap rows from another mod', () => {
  // The sender's rows name their Guild level type 46; in the receiving mod 46 is Poisoned Well and the map's type is 58.
  const sent = enc([HEAD, '46\twr\t2\t0\t3\tStn_WR a\t11\tStn_WR b\t12\t\t-1\t\t-1', '46\twl\t2\t0\t3\tStn_WL a\t13\tStn_WL b\t14\t\t-1\t\t-1', '46\tfl\t0\t54\t54\tWaypoint\t307\t\t-1\t\t-1\t\t-1']);
  const mine = enc([HEAD, '46\tfl\t0\t0\t9\tPoison floor\t5\t\t-1\t\t-1\t\t-1', '58\twl\t2\t0\t3\tStn_WL a\t13\tStn_WL b\t14\t\t-1\t\t-1']);

  it('reads the LevelNames with their rows, and sees that the mod numbers its level types', () => {
    const src = readAutomapRows(sent)!;
    expect(src.levels).toEqual([{ name: '46', rows: 3, codes: ['wr', 'wl', 'fl'] }]);
    expect(namesByNumber(mine)).toBe(true);
    expect(readAutomapRows(enc(['Name\tId', 'x\t1']))).toBeNull();
  });

  it('adds the rows under the chosen level type, skipping ones already there and leaving 46 alone', () => {
    const src = readAutomapRows(sent)!;
    const res = mergeAutomapRows(mine, src, { '46': '58' });
    expect(res).toMatchObject({ added: 2, already: 1 });
    const lines = new TextDecoder().decode(res.bytes).split('\r\n').filter(Boolean);
    expect(lines.filter((l) => l.startsWith('58\t')).length).toBe(3);
    expect(lines.filter((l) => l.startsWith('46\t'))).toEqual(['46\tfl\t0\t0\t9\tPoison floor\t5\t\t-1\t\t-1\t\t-1']);
    expect(mergeAutomapRows(mine, src, { '46': null }).added).toBe(0);
  });
});
