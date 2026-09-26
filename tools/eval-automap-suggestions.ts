// Evaluates automap suggestions against vanilla AutoMap.txt: hide rows, suggest, compare with what Blizzard wrote.
//   npx tsx tools/eval-automap-suggestions.ts [act3/jungle] [style|level]
import { parseTxtTable } from '../src/formats/txtTable';
import {
  AUTOMAP_CODES,
  AUTOMAP_DC6,
  AUTOMAP_TXT,
  automapColors,
  automapLevelFor,
  automapPieces,
  parseAutomap,
  parseAutomapCels,
  referenceTiles,
  suggestAutomap,
  usualCels,
} from '../src/game/automap';
import { GameData } from '../src/game/GameData';
import { openMap } from '../src/game/openMap';
import { LayeredFs, MpqSource, type FileSource } from '../src/vfs/vfs';
import { NodeFileAccess } from './nodeAccess';

const [folder = 'act3/jungle', mode = 'style'] = process.argv.slice(2);
const D2 = 'C:/Program Files/Diablo II';
const srcs: FileSource[] = [];
for (const m of ['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq']) srcs.push(await MpqSource.open(m, new NodeFileAccess(`${D2}/${m}`)));
const fs = new LayeredFs(srcs);
const gd = await GameData.load(fs);
const doc0 = parseTxtTable((await fs.read(AUTOMAP_TXT))!);
const t0 = parseAutomap(doc0);
const cels = parseAutomapCels((await fs.read(AUTOMAP_DC6))!);
const re = new RegExp(`${folder}/.*\\.ds1$`, 'i');
const maps = fs.list((p) => re.test(p)).slice(0, 12);

const blue = (c: [number, number, number] | null) => !!c && c[2] > c[0] * 1.25 && c[2] > c[1] * 1.1;
let total = 0;
let okNew = 0;
let okOld = 0;
let badNew = 0;
let badOld = 0;
const extraCache = new Map<string, Awaited<ReturnType<typeof referenceTiles>>>();
for (const path of maps) {
  const map = await openMap(gd, path);
  const level = automapLevelFor(t0, map.resolution.lvlType?.name, map.ds1.act + 1, map.resolution.lvlType?.id);
  if (!level) continue;
  const all = automapPieces(map.ds1, t0, level);
  const truth = new Map<string, Set<number> | 'none'>();
  for (const p of all) truth.set(`${p.orientation}|${p.main}|${p.sub}`, p.rule?.cels.length ? new Set(p.rule.cels.map((c) => c.cel)) : 'none');
  const col = automapColors(map.lib, cels, map.palette);
  const groups = mode === 'level' ? [null] : [...new Set(all.map((p) => `${p.orientation}|${p.main}`))];
  for (const g of groups) {
    const [o, main] = g ? g.split('|').map(Number) : [-1, -1];
    const code = g ? AUTOMAP_CODES[o] : '';
    const hidden = (r: string[]) => (r[0] ?? '').trim() === level && (!g || ((r[1] ?? '').trim() === code && Number(r[2]) === main));
    const t2 = parseAutomap({ ...doc0, rows: doc0.rows.filter((r) => !hidden(r)) });
    const these = all.filter((p) => !g || (p.orientation === o && p.main === main)).map((p) => ({ ...p, rule: null }));
    if (mode === 'level' && !extraCache.has(level))
      extraCache.set(level, await referenceTiles({ table: t2, types: gd.lvlTypes, levels: (l) => l !== level, loadDt1: (p) => gd.dt1(p), palette: (a) => gd.palette(a) }));
    const out: { leaveOff?: Set<string> } = {};
    const s = suggestAutomap(t2, level, these, { floors: true, colors: { ...automapColors(map.lib, cels, map.palette, { table: t2, types: gd.lvlTypes }), extraRefs: extraCache.get(level) } }, out);
    const got = new Map<string, number | 'none'>();
    for (const x of s) for (const q of x.seqs) got.set(`${x.orientation}|${x.style}|${q}`, x.cel);
    for (const k of out.leaveOff ?? []) got.set(k, 'none');
    // v0.1.3's behaviour: the level's (or act's) most used piece for the code.
    const usual = usualCels(t2, level);
    for (const p of these) {
      const k = `${p.orientation}|${p.main}|${p.sub}`;
      const tr = truth.get(k)!;
      total++;
      const judge = (v: number | 'none' | undefined) => {
        const ok = v === undefined ? tr === 'none' : v === 'none' ? tr === 'none' : tr !== 'none' && tr.has(v);
        // Water on land or land on water: a blue piece where the truth isn't blue (or nothing), or the reverse.
        const vb = typeof v === 'number' && blue(col.cel(v));
        const tb = tr !== 'none' && [...tr].some((c) => blue(col.cel(c)));
        return { ok, bad: !ok && vb !== tb };
      };
      const a = judge(got.get(k));
      const b = judge(usual.get(AUTOMAP_CODES[p.orientation]));
      if (a.ok) okNew++;
      if (b.ok) okOld++;
      if (a.bad) badNew++;
      if (b.bad) badOld++;
    }
  }
}
const pct = (n: number) => `${((100 * n) / total).toFixed(0)}%`;
console.log(`${folder}, rows hidden per ${mode}: ${total} tile kinds`);
console.log(`  new:     right ${okNew} (${pct(okNew)}), water/land mix-ups ${badNew} (${pct(badNew)})`);
console.log(`  v0.1.3:  right ${okOld} (${pct(okOld)}), water/land mix-ups ${badOld} (${pct(badOld)})`);
