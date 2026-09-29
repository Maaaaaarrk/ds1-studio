import { describe, expect, it } from 'vitest';
import { parseTxtTable, serializeTxtTable } from '../src/formats/txtTable';
import { applyAutomapEdits, findRule, parseAutomap, setAutomapCel } from '../src/game/automap';
import { invalidAutomapRows, validateAutomapSave } from '../src/game/automapSafety';
import { directorySaveTarget } from '../src/vfs/save';
import { explainCrash } from '../src/game/crashLog';

const header = 'LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\tType2\tCel2\tCel3\tType4\tCel4\n';
const doc = (rows: string) => parseTxtTable(new TextEncoder().encode(header + rows));
const row = (start: number, end: number, cel = 25, style = 0) => `59\tfl\t${style}\t${start}\t${end}\tDS1 Studio\t${cel}\t\t-1\t-1\t\t-1\n`;
const celAt = (d: ReturnType<typeof doc>, sub: number) => findRule(parseAutomap(d), '59', 0, 0, sub)?.cels.map(c => c.cel);

describe('game-safe automap clearing', () => {
  it('removes the empty rule instead of writing Cel1=-1, including after serialization', () => {
    const before = doc(row(24,24));
    const after = setAutomapCel(before,'59',0,0,24,-1,'seq').doc;
    expect(celAt(after,24)).toBeUndefined();
    expect(invalidAutomapRows(parseTxtTable(serializeTxtTable(after)))).toEqual([]);
    expect(celAt(before,24)).toEqual([25]);
  });
  it('splits every overlapping range and preserves neighbours and other levels', () => {
    const before = doc(row(20,28)+row(22,25,40)+row(24,24).replace('59','60'));
    const after = setAutomapCel(before,'59',0,0,24,-1,'seq').doc;
    expect(celAt(after,24)).toBeUndefined();
    for(const sub of [20,23,25,28]) expect(celAt(after,sub)).toEqual([25]);
    expect(findRule(parseAutomap(after),'60',0,0,24)?.cels[0].cel).toBe(25);
    expect(invalidAutomapRows(after)).toEqual([]);
  });
  it('batch clearing removes existing original rules, is repeatable, and preserves new pieces', () => {
    const before = doc(row(20,28).replace('DS1 Studio','Original'));
    const edits = [{orientation:0,style:0,sub:24,cels:[]}, {orientation:0,style:0,sub:25,cels:[2,3,4,5]}];
    const after = applyAutomapEdits(before,'59',edits).doc;
    expect(celAt(after,24)).toBeUndefined();
    expect(celAt(after,25)).toEqual([2,3,4,5]);
    const again = applyAutomapEdits(after,'59',edits).doc;
    expect(serializeTxtTable(again)).toEqual(serializeTxtTable(after));
    expect(invalidAutomapRows(again)).toEqual([]);
  });
  it('clears an entire style but refuses unsafe wildcard splitting without changing the input', () => {
    const before = doc(row(-1,-1));
    expect(() => setAutomapCel(before,'59',0,0,24,-1,'seq')).toThrow('wildcard');
    expect(setAutomapCel(before,'59',0,0,24,-1,'style').doc.rows.filter(r=>r[1])).toHaveLength(0);
    expect(celAt(before,24)).toEqual([25]);
  });
  it('reads and writes named cel columns when Type3 is absent', () => {
    const before = doc(row(24,24).replace('25\t\t-1\t-1\t\t-1','25\tsecond\t26\t27\tfourth\t28'));
    expect(celAt(before,24)).toEqual([25,26,27,28]);
    const after = applyAutomapEdits(before,'59',[{orientation:0,style:0,sub:24,cels:[30,31,32,33]}]).doc;
    expect(after.columns).toEqual(before.columns);
    expect(celAt(parseTxtTable(serializeTxtTable(after)),24)).toEqual([30,31,32,33]);
    expect(after.rows[0]).toHaveLength(12);
  });
  it('rejects invalid cels at the editing and save boundaries, before accessing the filesystem', async () => {
    const bad = doc(row(24,24,-1));
    const bytes = serializeTxtTable(bad);
    expect(() => validateAutomapSave('data\\global\\excel\\AutoMap.txt',bytes)).toThrow('line(s) 2');
    await expect(directorySaveTarget({name:'fixture'} as FileSystemDirectoryHandle).save('data/global/excel/automap.txt',bytes)).rejects.toThrow('not saved');
    expect(() => applyAutomapEdits(doc(''),'59',[{orientation:0,style:0,sub:24,cels:[-1,25]}])).toThrow('valid automap');
    expect(invalidAutomapRows(doc('Expansion\n'+row(24,24,0)))).toEqual([]);
  });
  it('recognises the verified PD2 empty-rule assertion', () => {
    expect(explainCrash({kind:'halt',line:1310,address:0x6fdbd027,failedFiles:[],what:''})).toMatchObject({known:true,title:'AutoMap.txt has a rule without a valid picture'});
  });
});
