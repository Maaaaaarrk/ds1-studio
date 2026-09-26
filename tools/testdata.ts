import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GAME_BINARY_FILES, LooseSource } from '../src/vfs/vfs';

/** Local classic D2 install used for integration tests (read-only). Override with D2_DIR / D2_MOD_DATA. */
export const D2_DIR = process.env.D2_DIR ?? 'C:/Program Files/Diablo II';
export const MOD_DATA = process.env.D2_MOD_DATA ?? `${D2_DIR}/ProjectD2/data`;
export const hasD2 = existsSync(`${D2_DIR}/d2data.mpq`);
export const hasMod = existsSync(MOD_DATA);

/**
 * The program files (D2Common.dll of the mod, then of the game; Game.exe) mounted as `bin/…`, like the app does: the
 * object id table is read from them.
 */
export function binarySource(): LooseSource {
  const files = new Map<string, () => Promise<Uint8Array>>();
  for (const dir of [MOD_DATA.replace(/[\\/]data$/i, ''), D2_DIR]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const key = `bin/${name.toLowerCase()}`;
      if (GAME_BINARY_FILES.some((f) => f.toLowerCase() === name.toLowerCase()) && !files.has(key)) files.set(key, async () => new Uint8Array(readFileSync(join(dir, name))));
    }
  }
  return new LooseSource('program files', files);
}

export function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (name.toLowerCase().endsWith(ext)) out.push(p);
  }
  return out;
}
