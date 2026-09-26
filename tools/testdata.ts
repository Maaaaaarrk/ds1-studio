import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Local classic D2 install used for integration tests (read-only). Override with D2_DIR / D2_MOD_DATA. */
export const D2_DIR = process.env.D2_DIR ?? 'C:/Program Files/Diablo II';
export const MOD_DATA = process.env.D2_MOD_DATA ?? `${D2_DIR}/ProjectD2/data`;
export const hasD2 = existsSync(`${D2_DIR}/d2data.mpq`);
export const hasMod = existsSync(MOD_DATA);

/** WinDS1's obj.txt: D2_OBJ_TXT, else `winds1Dir` from the (git-ignored) ds1studio.local.json. */
export const WINDS1_OBJ_TXT: string =
  process.env.D2_OBJ_TXT ??
  (() => {
    try {
      const dir = (JSON.parse(readFileSync('ds1studio.local.json', 'utf8')) as { winds1Dir?: string }).winds1Dir;
      return dir ? `${dir}/Data/obj.txt` : '';
    } catch {
      return '';
    }
  })();

export function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (name.toLowerCase().endsWith(ext)) out.push(p);
  }
  return out;
}
