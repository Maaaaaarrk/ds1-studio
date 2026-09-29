import { ds1FileToDt1Path, type Ds1 } from '../formats/ds1';
import { normalizePath } from '../vfs/vfs';

/**
 * Importing a map together with its tile libraries: which DT1s the DS1 expects (its embedded file list), which of
 * them the game or mod already has, and which picked DT1 file provides each missing one.
 */

export interface NeededDt1 {
  /** Game path the DS1 names, e.g. data/global/tiles/guild/outdoors/floor.dt1 (normalized). */
  path: string;
  /** The same, relative to data/global/tiles. */
  rel: string;
  /** Already in the game or mod. */
  found: boolean;
}

export function neededDt1s(ds1: Ds1, exists: (path: string) => boolean): NeededDt1[] {
  const seen = new Set<string>();
  const out: NeededDt1[] = [];
  for (const f of ds1.files) {
    const p = ds1FileToDt1Path(f);
    if (!p) continue;
    const path = normalizePath(p);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, rel: path.replace(/^data\/global\/tiles\//, ''), found: exists(path) });
  }
  return out;
}

const segments = (s: string) => s.toLowerCase().split('/').filter(Boolean);

/** Folder names that hold spare copies (originals kept aside, backups), not the files to use. */
const SPARE_FOLDER = /^(og|orig|original|originals|old|backup|backups|bak|prev|previous|unused)$/i;

/**
 * For every needed DT1, the index of the picked file that provides it (or null): same file name, preferring the file
 * whose folders match more of the needed path's folders from the end (guild/outdoors/floor.dt1 matches
 * .../outdoors/floor.dt1 better than .../cottages/floor.dt1). Each picked file serves one need.
 */
export function matchDt1s(needs: NeededDt1[], picked: { name: string; folder: string; ok: boolean }[]): (number | null)[] {
  const pairs: { need: number; file: number; score: number; depth: number; spare: boolean }[] = [];
  needs.forEach((n, ni) => {
    const want = segments(n.rel);
    const name = want.pop()!;
    picked.forEach((f, fi) => {
      if (!f.ok || f.name.toLowerCase() !== name) return;
      const have = segments(f.folder);
      let score = 0;
      while (score < want.length && score < have.length && want[want.length - 1 - score] === have[have.length - 1 - score]) score++;
      pairs.push({ need: ni, file: fi, score, depth: have.length, spare: have.some((d) => SPARE_FOLDER.test(d)) });
    });
  });
  // Equal matches: the file nearest the top of what was picked, and never a spare copy (og/, old/, backup/…) over the
  // real one: a picked "house1" folder with int.dt1 and og/int.dt1 means int.dt1.
  pairs.sort((a, b) => b.score - a.score || Number(a.spare) - Number(b.spare) || a.depth - b.depth || a.need - b.need || a.file - b.file);
  const out: (number | null)[] = needs.map(() => null);
  const used = new Set<number>();
  for (const p of pairs) {
    if (out[p.need] !== null || used.has(p.file)) continue;
    out[p.need] = p.file;
    used.add(p.file);
  }
  return out;
}

/** Letters, digits, - and _ only (safe in the game's tables). */
export const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'x';

/** Where an imported DT1 for a needed library goes: PD2assets/<folder>/<the path the map names>. */
export function importedDt1Path(folder: string, needRel: string, originalName?: string): string {
  const parts = needRel.split('/');
  const file = originalName ?? parts.pop()!;
  if (originalName) parts.pop();
  return `data/global/tiles/PD2assets/${folder}/${[...parts.map(safeSegment), `${safeSegment(file.replace(/\.dt1$/i, ''))}.dt1`].join('/')}`;
}
