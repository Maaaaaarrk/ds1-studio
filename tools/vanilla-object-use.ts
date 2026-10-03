// Regenerates src/data/vanillaObjectUse.json: which object ids (per act, 0-based, 0-149) the game's own DS1 maps
// place. The Custom object tool takes these from here instead of reading ~2000 maps from the archives each time.
//   npx tsx tools/vanilla-object-use.ts
import { writeFileSync } from 'node:fs';
import { parseDs1 } from '../src/formats/ds1';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from './nodeAccess';
import { D2_DIR } from './testdata';

const fs = new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))));
const used: Set<number>[] = [0, 1, 2, 3, 4].map(() => new Set());
let maps = 0;
for (const p of fs.list((p) => p.endsWith('.ds1') && p.startsWith('data/global/tiles/'))) {
  let ds1;
  try {
    ds1 = parseDs1((await fs.read(p))!);
  } catch {
    continue;
  }
  maps++;
  for (const o of ds1.objects) {
    if (o.type !== 2) continue;
    let act = ds1.act, n = o.id;
    while (n < 0) (act--, (n += 150));
    while (n >= 150) (act++, (n -= 150));
    if (act >= 0 && act < 5) used[act].add(n);
  }
}
const out = Object.fromEntries(used.map((s, a) => [String(a), [...s].sort((x, y) => x - y)]));
writeFileSync('src/data/vanillaObjectUse.json', JSON.stringify(out) + '\n');
console.log(`${maps} maps; ids used per act:`, used.map((s) => s.size).join(' / '));
