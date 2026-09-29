/** Read-only integration scan of the configured local test installation. */
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { GameData } from '../src/game/GameData';
import { scanAssetUsage } from '../src/game/assetUsage';
import { LayeredFs, LooseSource, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from './nodeAccess';
import { D2_DIR, MOD_DATA, hasMod, walk } from './testdata';
const mods = hasMod ? [new LooseSource(MOD_DATA, new Map(walk(MOD_DATA, '').map(p => [
  'data/' + relative(MOD_DATA, p).replace(/\\/g, '/'), async () => new Uint8Array(await readFile(p)),
])))] : [];
const fs = new LayeredFs([...mods, ...await Promise.all(['patch_d2.mpq','d2exp.mpq','d2data.mpq'].map(m => MpqSource.open(m, new NodeFileAccess(D2_DIR + '/' + m))))]);
const started = Date.now();
const result = await scanAssetUsage(await GameData.load(fs), null);
console.log(JSON.stringify({
  seconds: (Date.now() - started) / 1000, maps: result.mapsScanned, libraries: result.assets.length,
  unusedFiles: result.assets.filter(a => !a.maps.length && !a.error).length,
  unusedTiles: result.assets.reduce((n,a) => n + a.unusedIndices.length,0),
  unreadableLibraries: result.assets.filter(a => a.error).map(a => ({path:a.path,error:a.error})),
  errors: result.errors, warnings: result.warnings.length,
},null,2));
