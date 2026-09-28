import { parseTbl, setTblStrings, tblLookup, writeTbl } from '../formats/tbl';
import type { LayeredFs } from '../vfs/vfs';
import { PATCH_STRINGS } from './cubeRecipe';
import type { TableWrite } from './levelTables';

/**
 * The name an object shows when a player points at it comes from its objects.txt Name, a string-table key the game
 * looks up in patchstring.tbl, then expansionstring.tbl, then string.tbl. Some keys have no text there — the cut guild
 * objects ("Guild Vault", "Steeg Stone") are only spaces — so the game shows an empty box. The mod's patchstring.tbl
 * is read first, so a string added there fixes it without touching the game's files.
 */

export const STRING_TABLES = ['data/local/lng/eng/patchstring.tbl', 'data/local/lng/eng/expansionstring.tbl', 'data/local/lng/eng/string.tbl'];

/** How the game finds `key`: its text, "" when it is only spaces, or null when no table has it. */
export function lookupString(tables: Uint8Array[], key: string): string | null {
  for (const b of tables) {
    const v = tblLookup(b, key);
    if (v !== null) return v.trim();
  }
  return null;
}

export interface BlankName {
  key: string;
  /** The key has a string but it's blank (true), or no table has it (false). */
  blank: boolean;
  /** How many of the map's objects show it. */
  count: number;
  /** What to write: the key made readable ("Guild Vault" stays as it is). */
  suggested: string;
}

/** The names the map's objects would show as empty boxes. */
export function blankObjectNames(tables: Uint8Array[], keys: string[]): BlankName[] {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const out: BlankName[] = [];
  for (const [key, count] of counts) {
    const v = lookupString(tables, key);
    if (v) continue;
    out.push({ key, blank: v === '', count, suggested: key.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** Reads the string tables the way the game layers them (missing ones are skipped). */
export async function readStringTables(fs: LayeredFs): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const p of STRING_TABLES) {
    const b = await fs.read(p);
    if (b) out.push(b);
  }
  return out;
}

/** The write that gives these keys their text in the mod's patchstring.tbl. */
export async function nameStringsWrite(fs: LayeredFs, strings: Record<string, string>): Promise<TableWrite | null> {
  const b = await fs.read(PATCH_STRINGS);
  if (!b) return null;
  return {
    table: 'patchstring.tbl',
    path: PATCH_STRINGS,
    bytes: writeTbl(setTblStrings(parseTbl(b), strings)),
    summary: Object.entries(strings).map(([k, v]) => `String "${k}" = "${v}"`),
  };
}
