import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { expect, it } from 'vitest';
import { EMPTY_CELL } from '../src/formats/ds1';
import { decodeTile } from '../src/formats/dt1';
import { GameData } from '../src/game/GameData';
import { openMap } from '../src/game/openMap';
import { planWalkEdit, walkDt1Path } from '../src/game/walkEdit';
import { buildScene, walkability, type Scene } from '../src/render/scene';
import { LayeredFs, LooseSource, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, MOD_DATA, hasD2, walk } from '../tools/testdata';

it.runIf(hasD2 && existsSync(`${MOD_DATA}/global/tiles/expansion/Map/guild1.ds1`))('guild1: clearing red collision preserves every rendered tile picture', async () => {
  const files = new Map<string, () => Promise<Uint8Array>>();
  for (const ext of ['.ds1', '.dt1', '.txt']) for (const abs of walk(MOD_DATA, ext)) {
    files.set(`data/${relative(MOD_DATA, abs).replace(/\\/g, '/')}`, async () => new Uint8Array(readFileSync(abs)));
  }
  const archives = await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map(m => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`))));
  const fs = new LayeredFs([new LooseSource('mod', files), ...archives]);
  const map = await openMap(await GameData.load(fs), 'data/global/tiles/expansion/map/guild1.ds1');
  const beforeScene = buildScene(map.ds1, map.lib), before = walkability(map.ds1, beforeScene, map.lib);
  const pictures = (scene: Scene) => scene.items.map(it => {
    const image = decodeTile(it.tile);
    return [it.cellX, it.cellY, it.kind, it.layer, it.tile.orientation, image?.width, image?.height,
      image ? createHash('sha256').update(image.pixels).digest('hex') : null].join('|');
  }).sort();
  const originalPictures = pictures(beforeScene);
  const cells = new Map<number, number>();
  for (let i = 0; i < map.ds1.width * map.ds1.height && cells.size < 12; i++) {
    const k = before.slice(i * 25, i * 25 + 25).findIndex(f => !!(f & 4));
    if (k >= 0) cells.set(i, 1 << k);
  }
  expect(cells.size).toBeGreaterThan(0);
  const path = walkDt1Path(map.path);
  const plan = await planWalkEdit({ ds1: map.ds1, lib: map.lib, read: p => fs.read(p), walkPath: path, walk: await fs.read(path), paint: { mode: 'clear', bits: 13, cells } });
  expect(plan.skipped).toEqual([]);
  expect(plan.changed).toBe(cells.size);
  while (map.ds1.floors.length < plan.floors) map.ds1.floors.push(Array.from({ length: map.ds1.width * map.ds1.height }, () => EMPTY_CELL));
  for (const e of plan.edits) (e.layer.kind === 'floor' ? map.ds1.floors : map.ds1.walls)[e.layer.index][e.y * map.ds1.width + e.x] = e.cell as never;
  // Rebuild, rather than add duplicate variants for an existing library.
  const next = await GameData.load(fs);
  if (plan.dt1) fs.remember(path, plan.dt1, 'edited');
  next.forgetDt1(path);
  const loaded = await openMap(next, map.path, { source: 'manual', paths: [...new Set([...map.resolution.paths, path])], lvlType: map.resolution.lvlType }, map.ds1);
  const scene = buildScene(loaded.ds1, loaded.lib), after = walkability(loaded.ds1, scene, loaded.lib);
  expect(pictures(scene)).toEqual(originalPictures);
  for (let i = 0; i < before.length; i++) {
    const painted = (cells.get(Math.floor(i / 25)) ?? 0) & (1 << (i % 25));
    expect(after[i], `sub-tile ${i}`).toBe(painted ? before[i] & ~13 : before[i]);
  }
}, 30000);
