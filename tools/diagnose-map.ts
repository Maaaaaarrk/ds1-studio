// Diagnoses a map's tile loading: resolution, libraries, missing tiles.  npx tsx tools/diagnose-map.ts <path.ds1>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { GameData } from '../src/game/GameData';
import { openMap } from '../src/game/openMap';
import { buildScene } from '../src/render/scene';
import { LayeredFs, LooseSource, MpqSource, type FileSource } from '../src/vfs/vfs';
import { NodeFileAccess } from './nodeAccess';
import { binarySource, MOD_DATA, D2_DIR } from './testdata';

const files = new Map<string, () => Promise<Uint8Array>>();
const MOD = MOD_DATA.replace(/[\\/]data$/i, '');
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ds1|dt1|txt|dat|dc6|dcc|cof)$/i.test(n)) files.set(relative(MOD, p).split(sep).join('/'), async () => new Uint8Array(readFileSync(p)));
  }
};
walk(MOD_DATA);
const srcs: FileSource[] = [new LooseSource('mod', files), binarySource()];
for (const m of ['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq']) srcs.push(await MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)));
const gd = await GameData.load(new LayeredFs(srcs));
const map = await openMap(gd, process.argv[2]);
const scene = buildScene(map.ds1, map.lib);
console.log('size', map.ds1.width, 'x', map.ds1.height, 'v', map.ds1.version, 'act', map.ds1.act, 'layers walls', map.ds1.walls.length, 'floors', map.ds1.floors.length);
console.log('resolution', map.resolution.source, 'type', map.resolution.lvlType?.id, map.resolution.lvlType?.name, 'preset', map.resolution.preset?.name, 'mask', map.resolution.preset?.dt1Mask);
console.log('embedded files:', map.ds1.files.join(' | '));
console.log('loaded:', map.lib.loaded.map((l) => `${l.path.replace('data/global/tiles/', '')}${l.found ? '' : ' (NOT FOUND)'}`).join(' | '));
console.log('items', scene.items.length, 'missing', scene.missing.length, 'specials', scene.specials.length);
const byKey = new Map<string, number>();
for (const m of scene.missing) {
  const k = `${m.kind} L${m.layer} o${m.orientation} ${m.main}/${m.sub}`;
  byKey.set(k, (byKey.get(k) ?? 0) + 1);
}
console.log('missing kinds:', [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${k} ×${n}`).join(', '));
// Floors skipped as "void" (main >= 30) and whether any loaded or game DT1 has them.
const voids = new Map<string, number>();
for (const f of map.ds1.floors) for (const c of f) if (c.prop1 && c.mainIndex >= 30) voids.set(`${c.mainIndex}/${c.subIndex}`, (voids.get(`${c.mainIndex}/${c.subIndex}`) ?? 0) + 1);
console.log('void floors (main>=30):', [...voids].map(([k, n]) => `${k}×${n}`).join(', ') || 'none');
for (const k of [...voids.keys()].slice(0, 5)) {
  const [m, s] = k.split('/').map(Number);
  console.log(' ', k, 'in loaded libs:', map.lib.variants(0, m, s).length);
}
const t = gd.lvlType(map.resolution.lvlType?.id ?? -1);
console.log('level type files:', t?.files.map((f, i) => (f ? `${i + 1}:${f}` : '')).filter(Boolean).join(' | '));
// Hidden (prop4 & 0x80) tiles per layer.
const hid: string[] = [];
map.ds1.floors.forEach((f, i) => { const n = f.filter((c) => c.prop1 && c.hidden).length; if (n) hid.push(`floor${i + 1}:${n}`); });
map.ds1.walls.forEach((w, i) => {
  const cells = w.filter((c) => c.prop1 && c.hidden);
  if (cells.length) {
    const kinds = new Map<string, number>();
    for (const c of cells) kinds.set(`o${c.orientation} ${c.mainIndex}/${c.subIndex}`, (kinds.get(`o${c.orientation} ${c.mainIndex}/${c.subIndex}`) ?? 0) + 1);
    hid.push(`wall${i + 1}:${cells.length} [${[...kinds].slice(0, 6).map(([k, n]) => `${k}×${n}`).join(', ')}]`);
  }
});
console.log('hidden tiles:', hid.join(' | ') || 'none');
