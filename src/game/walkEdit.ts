import { DEFAULT_PROP1, EMPTY_CELL, isEmptyCell, withFields, withTile, type Ds1, type TileCell, type WallCell } from '../formats/ds1';
import { Orientation, type Dt1Tile } from '../formats/dt1';
import { blockerRecord, buildDt1, changedRecord, dt1Records, recordInfo, type Dt1Record } from '../formats/dt1Write';
import { normalizePath } from '../vfs/vfs';
import type { TileLibrary } from './GameData';
import type { LayerRef } from './MapDocument';
import { isBuiltinPath } from './specialTiles';

/**
 * Editing a map's walkability sub-tile by sub-tile, for this map only (no shared DT1 changes). How the game builds a
 * room's collision (D2Common, as reimplemented by D2MOO): every floor, wall and roof tile placed in it adds its 25
 * sub-tile flags (hidden tiles too: they are only skipped when drawing), and a cell whose DS1 word has bit 17
 * ("unwalkable", prop3 & 2) blocks walking on all its sub-tiles. Flags only ever add up, so:
 *
 * - Blocking puts a hidden floor tile with no graphics and just those flags into a free floor layer of the cell, like
 *   the game's own blockers (Tal Rasha's tomb has floor tiles with no blocks and every sub-tile "block walk").
 * - Clearing a sub-tile another tile blocks swaps that tile, in this cell only, for a copy with those flags removed
 *   (same graphics and variants, a free sub index); a north-corner wall's other half is copied with it.
 *
 * Both live in one DT1 made for the map (`<map>_walk.dt1` next to it). Its tiles are only ever added, so undoing the
 * map's edits never leaves a cell pointing at a tile that is gone.
 */

export { COLLISION_FLAGS as WALK_FLAGS } from './collisionFlags';

/** Overlay order (row by row from the cell's top corner, as the walkability overlay uses) ↔ DT1 file order. */
export const fileIndex = (k: number) => (4 - Math.floor(k / 5)) * 5 + (k % 5);

/** Where the map's walkability DT1 goes: `<map folder>/<map>_walk.dt1`. */
export function walkDt1Path(mapPath: string): string {
  return mapPath.replace(/\.ds1$/i, '_walk.dt1');
}

export interface WalkPaint {
  mode: 'block' | 'clear' | 'replace';
  /** Flag bits to set or clear (WALK_FLAGS). */
  bits: number;
  /** Cell index (y * width + x) → the sub-tiles painted in it, as a 25-bit mask in overlay order. */
  cells: Map<number, number>;
}

export interface WalkPlan {
  /** Floor layers the map needs (more than it has when a blocker needs a second floor layer). */
  floors: number;
  edits: { layer: LayerRef; x: number; y: number; cell: TileCell | WallCell }[];
  /** The map's walkability DT1 with any new tiles (null when it doesn't change). */
  dt1: Uint8Array | null;
  /** Sub-tiles whose flags changed. */
  changed: number;
  /** Cells that couldn't be changed, and why. */
  skipped: string[];
}

interface Contributor {
  layer: LayerRef;
  cell: TileCell | WallCell;
  /** The tile keys this cell places (a north-corner wall places both halves). */
  keys: { o: number; m: number; s: number }[];
}

const keyStr = (o: number, m: number, s: number) => `${o}|${m}|${s}`;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Works out a paint stroke: the cell edits, blockers and copies it needs. `read` gives a DT1's bytes (to copy tiles
 * byte for byte); `walk` is the map's walkability DT1 as it is now (null = none yet).
 */
export async function planWalkEdit(opts: {
  ds1: Ds1;
  lib: TileLibrary;
  read: (path: string) => Promise<Uint8Array | null>;
  walkPath: string;
  walk: Uint8Array | null;
  paint: WalkPaint;
}): Promise<WalkPlan> {
  const { ds1, lib, paint } = opts;
  const walkKey = normalizePath(opts.walkPath);
  const records: Dt1Record[] = opts.walk ? dt1Records(opts.walk) : [];
  const originalCount = records.length;
  const skipped: string[] = [];
  const edits: WalkPlan['edits'] = [];
  let floors = ds1.floors.length;
  let changed = 0;

  // Keys taken by the map's other tile libraries and by the walkability DT1.
  const taken = new Set<string>();
  for (const e of lib.entries()) taken.add(keyStr(e.orientation, e.main, e.sub));
  for (const r of records) {
    const i = recordInfo(r);
    taken.add(keyStr(i.orientation, i.main, i.sub));
  }

  // Blockers: floor tiles of one main index nobody else uses as a floor (its sub index numbers the patterns).
  const blockerMains = new Set(records.filter((r) => !r.blocks.length && recordInfo(r).orientation === 0).map((r) => recordInfo(r).main));
  let blockMain = blockerMains.size ? [...blockerMains][0] : -1;
  if (blockMain < 0) {
    const floorMains = new Set(lib.entries().filter((e) => e.orientation === Orientation.Floor).map((e) => e.main));
    for (let m = 63; m >= 0 && blockMain < 0; m--) if (!floorMains.has(m)) blockMain = m;
  }
  const isBlocker = (c: TileCell) => !isEmptyCell(c) && c.mainIndex === blockMain && records.some((r) => !r.blocks.length && recordInfo(r).main === blockMain && recordInfo(r).sub === c.subIndex);
  const blockerFlags = (c: TileCell) => records.find((r) => !r.blocks.length && recordInfo(r).orientation === 0 && recordInfo(r).main === blockMain && recordInfo(r).sub === c.subIndex)?.header.slice(40, 65) ?? new Uint8Array(25);
  const freeSub = (pairs: [number, number][]) => {
    for (let s = 0; s < 256; s++) if (pairs.every(([o, m]) => !taken.has(keyStr(o, m, s)))) return s;
    return -1;
  };
  /** The blocker with these flags (file order), added when new. */
  const blockerFor = (flags: Uint8Array): number => {
    const found = records.find((r) => !r.blocks.length && recordInfo(r).orientation === 0 && recordInfo(r).main === blockMain && same(recordInfo(r).flags, flags));
    if (found) return recordInfo(found).sub;
    if (blockMain < 0) throw new Error('No free floor number for a collision blocker.');
    const s = freeSub([[0, blockMain]]);
    if (s < 0) throw new Error('The walkability library is full (256 blocker patterns).');
    records.push(blockerRecord(blockMain, s, flags));
    taken.add(keyStr(0, blockMain, s));
    return s;
  };
  /** A copy of the tiles of `keys` (all variants) with `clear[k]` bits removed per file byte; returns its sub index. */
  const sourceBytes = new Map<string, Dt1Record[] | null>();
  const recordOf = async (t: Dt1Tile): Promise<Dt1Record | null> => {
    const src = lib.sourceOf(t);
    if (!src || isBuiltinPath(src.path)) return null;
    const key = normalizePath(src.path);
    if (key === walkKey) return records[src.index] ?? null;
    if (!sourceBytes.has(key)) {
      const b = await opts.read(src.path);
      sourceBytes.set(key, b ? dt1Records(b) : null);
    }
    return sourceBytes.get(key)?.[src.index] ?? null;
  };
  const forkFor = async (keys: Contributor['keys'], clear: Uint8Array): Promise<number | null> => {
    const copies: { o: number; m: number; rec: Dt1Record }[] = [];
    for (const k of keys)
      // TileLibrary inserts each file record at the front; reverse once to preserve weighted artwork choice.
      for (const t of [...lib.variants(k.o, k.m, k.s)].reverse()) {
        const rec = await recordOf(t);
        if (!rec) return null;
        const flags = recordInfo(rec).flags.map((f, i) => f & ~clear[i]);
        copies.push({ o: k.o, m: k.m, rec: changedRecord(rec, { flags }) });
      }
    if (!copies.length) return null;
    // The same copy made before (same tiles, same flags): reuse it.
    const bySub = new Map<number, Dt1Record[]>();
    for (const r of records) {
      const i = recordInfo(r);
      if (keys.some((k) => k.o === i.orientation && k.m === i.main)) bySub.set(i.sub, [...(bySub.get(i.sub) ?? []), r]);
    }
    const body = (r: Dt1Record) => [...r.header.slice(0, 28), ...r.header.slice(32, 72), ...r.header.slice(84)].join(',') + '|' + r.blocks.join(',');
    const want = copies.map((c) => body(c.rec)).join('#');
    for (const [s, rs] of bySub) if (rs.map(body).join('#') === want) return s;
    const s = freeSub(keys.map((k) => [k.o, k.m]));
    if (s < 0) return null;
    for (const c of copies) {
      records.push(changedRecord(c.rec, { sub: s }));
      taken.add(keyStr(c.o, c.m, s));
    }
    return s;
  };

  for (const [i, mask] of paint.cells) {
    if (!Number.isInteger(i) || i < 0 || i >= ds1.width * ds1.height || !(mask & 0x1ffffff)) continue;
    const startRecords = records.length, startEdits = edits.length, startFloors = floors;
    const startTaken = new Set(taken);
    const clearBits = paint.mode === 'replace' ? (~paint.bits & 255) : paint.bits & 255;
    const x = i % ds1.width;
    const y = Math.floor(i / ds1.width);
    try {
      // What adds flags to this cell: floor layers, then walls (special markers aren't loaded by the game).
      const contributors: Contributor[] = [];
      ds1.floors.forEach((l, index) => {
        const c = l[i];
        if (!isEmptyCell(c)) contributors.push({ layer: { kind: 'floor', index }, cell: c, keys: [{ o: 0, m: c.mainIndex, s: c.subIndex }] });
      });
      ds1.walls.forEach((l, index) => {
        const c = l[i];
        if (isEmptyCell(c) || c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) return;
        const keys = [{ o: c.orientation, m: c.mainIndex, s: c.subIndex }];
        if (c.orientation === Orientation.RightPartOfNorthCornerWall) keys.push({ o: Orientation.LeftPartOfNorthCornerWall, m: c.mainIndex, s: c.subIndex });
        contributors.push({ layer: { kind: 'wall', index }, cell: c, keys });
      });
      const flagsOf = (c: Contributor) => {
        const out = new Uint8Array(25);
        for (const k of c.keys) for (const t of lib.variants(k.o, k.m, k.s)) t.subTileFlags.forEach((f, j) => (out[j] |= f));
        return out;
      };
      const blocker = contributors.find((c) => c.layer.kind === 'floor' && isBlocker(c.cell));
      const others = contributors.filter((c) => c !== blocker);
      const wholeCell = contributors.filter((c) => (c.cell.prop3 & 0x03) !== 0);
      const noFloor = !contributors.some((c) => c.layer.kind === 'floor');
      // Current flags per file byte, without the blocker (the blocker is rebuilt below).
      const base = new Uint8Array(25);
      for (const c of others) flagsOf(c).forEach((f, j) => (base[j] |= f));
      const wholeFlags = wholeCell.reduce((f, c) => f | (c.cell.prop3 & 2 ? 1 : 0) | (c.cell.prop3 & 1 ? 4 : 0), 0);
      if (wholeFlags) base.forEach((_, j) => (base[j] |= wholeFlags));
      if (noFloor) base.forEach((_, j) => (base[j] |= 0x01)); // the game fills an empty cell with a hidden blocking floor
      let want = blocker ? blockerFlags(blocker.cell) : new Uint8Array(25);
      const before = new Uint8Array(25).map((_, j) => base[j] | want[j]);
      const painted = new Uint8Array(25);
      for (let k = 0; k < 25; k++) if (mask & (1 << k)) painted[fileIndex(k)] = 1;

      const desired = before.map((f, j) => !painted[j] ? f : paint.mode === 'block' ? f | paint.bits : paint.mode === 'clear' ? f & ~clearBits : paint.bits);
      if (same(before, desired)) continue;
      // A new floor must preserve the implicit blocker everywhere not explicitly cleared.
      if (noFloor) want = want.map((f, j) => f | (paint.mode !== 'block' && painted[j] && (clearBits & 1) ? 0 : 1));

      if (paint.mode === 'block') {
        want = want.map((f, j) => (painted[j] ? f | (paint.bits & ~base[j]) : f));
      } else {
        want = want.map((f, j) => (painted[j] ? f & ~clearBits : f));
        // An empty cell is blocked because it has no floor; once a (blocker) floor is there, the rest must stay blocked.
        if (noFloor && (clearBits & 1)) want = want.map((f, j) => (painted[j] ? f : f | 0x01));
        // DS1 whole-cell flags become per-subtile flags; merge this with any tile copy below.
        const restored = wholeFlags & clearBits;
        for (const c of wholeCell) {
          const remove = (clearBits & 1 ? 2 : 0) | (clearBits & 4 ? 1 : 0);
          if (!(c.cell.prop3 & remove)) continue;
          c.cell = { ...c.cell, prop3: c.cell.prop3 & ~remove };
          edits.push({ layer: c.layer, x, y, cell: c.cell });
        }
        if (restored) want = want.map((f, j) => painted[j] ? f : f | restored);
        // Tiles blocking painted sub-tiles: this cell gets copies without those flags.
        const clear = new Uint8Array(25).map((_, j) => (painted[j] ? clearBits : 0));
        for (const c of others) {
          if (!flagsOf(c).some((f, j) => f & clear[j])) continue;
          const s = await forkFor(c.keys, clear);
          if (s === null) {
            throw new Error(`its ${c.layer.kind} tile couldn't be copied (no free number, or a tile with no file)`);
          }
          edits.push({ layer: c.layer, x, y, cell: withFields(c.cell, { sub: s }) }); // keeps hidden cells hidden
        }
      }

      if (paint.mode === 'replace') want = want.map((f, j) => painted[j] ? f | (paint.bits & ~(base[j] & ~clearBits)) : f);

      // The blocker: added, changed or removed to hold `want`.
      const hasFlags = want.some((f) => f);
      const needFloor = noFloor && paint.mode !== 'block' && !!(clearBits & 1); // an empty cell made walkable needs a floor there
      if (blocker) {
        if (!hasFlags && !needFloor && !noFloorBesides(contributors, blocker)) edits.push({ layer: blocker.layer, x, y, cell: EMPTY_CELL });
        else if (!same(want, blockerFlags(blocker.cell))) edits.push({ layer: blocker.layer, x, y, cell: hidden(withTile(blocker.cell, blockMain, blockerFor(want), DEFAULT_PROP1.floor)) });
      } else if (hasFlags || needFloor) {
        const free = ds1.floors.findIndex((l) => isEmptyCell(l[i]));
        const index = free >= 0 ? free : ds1.floors.length < 2 ? ds1.floors.length : -1;
        if (index < 0) throw new Error("both floor layers are used, so there's no room for a blocker");
        else {
          if (index >= floors) floors = index + 1;
          edits.push({ layer: { kind: 'floor', index }, x, y, cell: hidden(withTile(EMPTY_CELL, blockMain, blockerFor(want), DEFAULT_PROP1.floor)) });
        }
      }
      // Count what changes (as far as the plan goes; skipped cells stay).
      const after = new Uint8Array(25).map((_, j) => {
        if (paint.mode === 'block') return base[j] | want[j];
        return (base[j] & ~(painted[j] ? clearBits : 0)) | want[j];
      });
      for (let j = 0; j < 25; j++) if (painted[j] && after[j] !== before[j]) changed++;
    } catch (e) {
      records.length = startRecords; edits.length = startEdits; floors = startFloors;
      taken.clear(); for (const key of startTaken) taken.add(key);
      skipped.push(`(${x}, ${y}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { floors, edits, dt1: records.length > originalCount ? buildDt1(records) : null, changed, skipped };
}

/** Whether the cell has a real floor besides its blocker (without one, removing the blocker leaves it empty). */
function noFloorBesides(contributors: Contributor[], blocker: Contributor): boolean {
  return !contributors.some((c) => c !== blocker && c.layer.kind === 'floor');
}

/** A floor cell marked hidden (bit 31): the game loads it for collision but doesn't draw it. */
function hidden<T extends TileCell>(c: T): T {
  return { ...c, prop4: c.prop4 | 0x80, hidden: true };
}
