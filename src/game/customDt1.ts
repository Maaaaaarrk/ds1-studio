import { Orientation } from '../formats/dt1';
import { buildDt1, changedRecord, dt1Records, recordInfo, type Dt1Record } from '../formats/dt1Write';
import { recolorDt1 } from '../formats/dt1Edit';
import { MAX_TILE_PATH } from './addToGame';
import type { AutomapEdit, AutomapTable } from './automap';
import { findRule } from './automap';

/**
 * A custom tile library built from single tiles of other DT1s. Each tile is copied byte for byte (pixels, sub-tile
 * flags = walkability, sound/material, roof height, rarity), and keeps its number unless that would clash: the game
 * picks a cell's tile by orientation + main + sub among every DT1 its level loads, so a tile sharing its number with
 * one already loaded (or with another pick) would be mixed with it at random. Those get the first free number instead.
 *
 * Tiles that belong together come along: the two halves of a north corner wall (orientations 3 and 4 share a number
 * and are drawn together) and every frame of an animated tile (same number, frame = rarity).
 */

/** A tile picked in a library: its DT1 and its index there (file order). */
export interface TilePick {
  dt1: string;
  index: number;
}

/** A DS1 cell holds main 0-63 and sub 0-255. */
export const MAX_MAIN = 63;
export const MAX_SUB = 255;

export interface PlannedTile {
  from: TilePick;
  orientation: number;
  main: number;
  sub: number;
  newMain: number;
  newSub: number;
  /** Added because a picked tile needs it (corner-wall half or animation frame). */
  partner: boolean;
}

export interface CustomDt1Plan {
  records: Dt1Record[];
  tiles: PlannedTile[];
  /** Tile groups given a new number, as "from → to" lines. */
  renumbered: string[];
  /** Picks left out, with why. */
  skipped: string[];
}

const keyOf = (o: number, m: number, s: number) => `${o}|${m}|${s}`;
/** Corner-wall halves are one tile to the game (a cell of orientation 3 draws the 4 with the same number too). */
const family = (o: number) => (o === Orientation.LeftPartOfNorthCornerWall ? Orientation.RightPartOfNorthCornerWall : o);

/**
 * Plans the custom DT1. `sources` gives each picked DT1's bytes; `taken` holds the keys (orientation|main|sub) of the
 * tiles the map's level already loads.
 */
export function planCustomDt1(picks: TilePick[], sources: Map<string, Uint8Array>, taken: Set<string>): CustomDt1Plan {
  const skipped: string[] = [];
  const records = new Map<string, Dt1Record[]>();
  const recordsOf = (dt1: string) => {
    let r = records.get(dt1);
    if (!r) {
      const bytes = sources.get(dt1);
      r = bytes ? dt1Records(bytes) : [];
      records.set(dt1, r);
    }
    return r;
  };
  // Groups: one number to keep or change together (a tile, its corner partner, its animation frames).
  const groups = new Map<string, { dt1: string; family: number; main: number; sub: number; members: { index: number; partner: boolean }[] }>();
  const seen = new Set<string>();
  for (const p of picks) {
    const recs = recordsOf(p.dt1);
    const r = recs[p.index];
    if (!r) {
      skipped.push(`${short(p.dt1)} #${p.index}: not found`);
      continue;
    }
    const info = recordInfo(r);
    if (info.orientation === Orientation.SpecialTile1 || info.orientation === Orientation.SpecialTile2) {
      skipped.push(`${short(p.dt1)} #${p.index}: a special tile (a marker the game uses, not a picture)`);
      continue;
    }
    const gk = `${p.dt1}|${family(info.orientation)}|${info.main}|${info.sub}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { dt1: p.dt1, family: family(info.orientation), main: info.main, sub: info.sub, members: [] }));
    const add = (index: number, partner: boolean) => {
      if (seen.has(`${p.dt1}|${index}`)) return;
      seen.add(`${p.dt1}|${index}`);
      g!.members.push({ index, partner });
    };
    add(p.index, false);
    const animated = r.header[7] !== 0;
    recs.forEach((o, i) => {
      if (i === p.index) return;
      const oi = recordInfo(o);
      if (oi.main !== info.main || oi.sub !== info.sub) return;
      // The other corner half (any variant), and the other frames of an animation.
      if (family(oi.orientation) === family(info.orientation) && oi.orientation !== info.orientation) add(i, true);
      else if (animated && oi.orientation === info.orientation && o.header[7] !== 0) add(i, true);
    });
  }

  const used = new Set(taken);
  const out: PlannedTile[] = [];
  const outRecords: Dt1Record[] = [];
  const renumbered: string[] = [];
  const orientationsOf = (g: { dt1: string; members: { index: number }[] }) => [...new Set(g.members.map((m) => recordInfo(recordsOf(g.dt1)[m.index]).orientation))];
  const fits = (os: number[], m: number, s: number) => os.every((o) => !used.has(keyOf(o, m, s)));
  for (const g of groups.values()) {
    const os = orientationsOf(g);
    let main = g.main;
    let sub = g.sub;
    if (main > MAX_MAIN || sub > MAX_SUB || !fits(os, main, sub)) {
      // The same sub with another main first (keeps a wall's pieces in order), then any free number.
      const free = (): [number, number] | null => {
        if (sub <= MAX_SUB) for (let m = 0; m <= MAX_MAIN; m++) if (fits(os, m, sub)) return [m, sub];
        for (let m = 0; m <= MAX_MAIN; m++) for (let s = 0; s <= MAX_SUB; s++) if (fits(os, m, s)) return [m, s];
        return null;
      };
      const f = free();
      if (!f) {
        skipped.push(`${short(g.dt1)} ${g.main}/${g.sub}: no free tile number left`);
        continue;
      }
      [main, sub] = f;
      renumbered.push(`${short(g.dt1)} ${g.main}/${g.sub} → ${main}/${sub}`);
    }
    for (const o of os) used.add(keyOf(o, main, sub));
    for (const m of g.members) {
      const r = recordsOf(g.dt1)[m.index];
      const info = recordInfo(r);
      outRecords.push(main === g.main && sub === g.sub ? r : changedRecord(r, { main, sub }));
      out.push({ from: { dt1: g.dt1, index: m.index }, orientation: info.orientation, main: info.main, sub: info.sub, newMain: main, newSub: sub, partner: m.partner });
    }
  }
  return { records: outRecords, tiles: out, renumbered, skipped };
}

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

/** Windows device names, which can't be file names in any folder. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Letters, digits and _ only: safe in the game's tables, archives and on every file system. */
export const CUSTOM_NAME_CHARS = /^[A-Za-z0-9_]+$/;
export const RECOMMENDED_NAME_LENGTH = 12;

/** Longest name that still fits the game's tile path limit in `folder` (relative to data/global/tiles). */
export const maxCustomNameLength = (folder: string) => MAX_TILE_PATH - `${folder.replace(/\/+$/, '')}/`.length - '.dt1'.length;

/** Why a name can't be used (null when fine). */
export function customNameProblem(name: string, folder: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the library a name.';
  if (!CUSTOM_NAME_CHARS.test(n)) return 'Use only letters, digits and _ (no spaces, dots, dashes or accents): other characters can break the game’s tables or archives.';
  if (RESERVED.test(n)) return `"${n}" is a name Windows reserves for devices; choose another.`;
  const max = maxCustomNameLength(folder);
  if (n.length > max) return `At most ${max} characters here: the game holds tile paths of up to ${MAX_TILE_PATH} characters (after DATA\\GLOBAL\\TILES\\).`;
  return null;
}

/**
 * The AutoMap.txt pieces for the new tiles: each copies the pieces its original has in the automap of a level type
 * that loads its DT1 (`sourceLevels`), under its new number, for the map's automap level. Tiles with none are left
 * out (the automap editor can add them).
 */
export function customAutomapEdits(plan: CustomDt1Plan, table: AutomapTable, sourceLevels: (dt1: string) => string[]): AutomapEdit[] {
  const edits = new Map<string, AutomapEdit>();
  for (const t of plan.tiles) {
    // The corner's right half has no automap row of its own: the 3 carries it.
    if (t.orientation === Orientation.LeftPartOfNorthCornerWall) continue;
    const k = keyOf(t.orientation, t.newMain, t.newSub);
    if (edits.has(k)) continue;
    for (const level of sourceLevels(t.from.dt1)) {
      const rule = findRule(table, level, t.orientation, t.main, t.sub);
      if (rule?.cels.length) {
        edits.set(k, { orientation: t.orientation, style: t.newMain, sub: t.newSub, cels: rule.cels.map((c) => c.cel) });
        break;
      }
    }
  }
  return [...edits.values()];
}

/**
 * The custom DT1's file. With `remapFor`, each tile's colours are converted too: a DT1 stores palette numbers, and
 * most mean a different colour in each act, so a tile drawn for one act looks wrong in another. `remapFor` gives, for
 * the library a tile came from, the remap that snaps every colour to the nearest one that is the same in every act
 * ("Act 0"), judged by how it looks in the act that library was drawn for (see game/act0Palette.ts); null leaves
 * the tile as it is.
 */
export function buildCustomDt1(plan: CustomDt1Plan, remapFor?: (dt1: string) => Uint8Array | null): Uint8Array {
  let bytes = buildDt1(plan.records);
  if (!remapFor) return bytes;
  const groups = new Map<Uint8Array, number[]>();
  plan.tiles.forEach((t, i) => {
    const r = remapFor(t.from.dt1);
    if (r) (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
  });
  for (const [remap, tiles] of groups) bytes = recolorDt1(bytes, remap, tiles);
  return bytes;
}
