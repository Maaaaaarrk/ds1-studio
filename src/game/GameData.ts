import { loadSpriteAnimation, type SpriteAnimation } from './spriteAnim';
import { ds1FileToDt1Path, type Ds1 } from '../formats/ds1';
import { parseDt1, type Dt1, type Dt1Tile } from '../formats/dt1';
import { OLD_ACT5_PALETTE, parsePalette, palettePath, type Palette } from '../formats/palette';
import { parseTxt, type TxtTable } from '../formats/txt';
import { normalizePath, type LayeredFs } from '../vfs/vfs';
import { loadObjectSprite, type Sprite, type SpriteSpec } from './sprites';
import { buildCatalog, findObjectPresets, GAME_BINARIES } from './objectCatalog';

export interface LvlTypeInfo {
  id: number;
  name: string;
  /** 1-based act from LvlTypes.txt "Act" (0 when unknown). */
  act: number;
  files: string[]; // "File 1".."File 32", "" when unused
}

export interface PresetInfo {
  def: number;
  name: string;
  levelId: number;
  dt1Mask: number;
}

export type Dt1Source = 'lvlprest' | 'guessed' | 'embedded' | 'manual';

export interface Dt1Resolution {
  source: Dt1Source;
  lvlType: LvlTypeInfo | null;
  preset: PresetInfo | null;
  paths: string[];
}

/** Game tables + caches shared by all open maps. */
export class GameData {
  private palettes = new Map<number, Promise<Palette>>();
  private dt1s = new Map<string, Promise<Dt1 | null>>();
  private presetsByFile = new Map<string, PresetInfo>();
  private levelTypeById = new Map<number, number>();
  readonly lvlTypes: LvlTypeInfo[] = [];
  readonly warnings: string[] = [];
  /** "act:type:id" -> name and sprite recipe, from the game's own tables (acts 1-based; see objectCatalog). */
  private objRows = new Map<string, { name: string; spec: SpriteSpec | null }>();
  private sprites = new Map<string, Promise<Sprite | null>>();
  /** MonPreset.txt "Place" per act (1-based), indexed by NPC id. */
  private monPresets = new Map<number, string[]>();

  private constructor(readonly fs: LayeredFs) {}

  static async load(fs: LayeredFs): Promise<GameData> {
    const gd = new GameData(fs);
    const table = async (name: string): Promise<TxtTable | null> => {
      const bytes = await fs.read(`data/global/excel/${name}`);
      if (!bytes) gd.warnings.push(`${name} not found; DT1s will come from each DS1's embedded file list.`);
      return bytes ? parseTxt(bytes) : null;
    };
    const optional = (name: string) => fs.read(`data/global/excel/${name}`).then((b) => (b ? parseTxt(b) : null));
    const [prest, types, levels, monPreset, objects, monStats, monStats2, superUniques] = await Promise.all([
      table('LvlPrest.txt'),
      table('LvlTypes.txt'),
      table('Levels.txt'),
      optional('MonPreset.txt'),
      optional('objects.txt'),
      optional('MonStats.txt'),
      optional('MonStats2.txt'),
      optional('SuperUniques.txt'),
    ]);
    for (const row of monPreset?.rows ?? []) {
      const act = Number(row['Act']);
      if (!gd.monPresets.has(act)) gd.monPresets.set(act, []);
      gd.monPresets.get(act)!.push(row['Place']);
    }
    // The object id table is in the game's program file (mod's first); without it objects are listed by number only.
    let presets: Int32Array[] | null = null;
    for (const bin of GAME_BINARIES) {
      const bytes = await fs.read(bin);
      presets = bytes ? findObjectPresets(bytes) : null;
      if (presets) break;
    }
    gd.objectTable = !!presets;
    if (!presets) gd.warnings.push('The object table wasn’t found in D2Common.dll or Game.exe; objects are shown by number.');
    for (const e of buildCatalog(presets, { objects, monPreset, monStats, monStats2, superUniques })) {
      gd.objRows.set(`${e.act}:${e.type}:${e.id}`, { name: e.name, spec: e.spec });
    }

    for (const row of types?.rows ?? []) {
      const id = Number(row['Id']);
      if (!Number.isFinite(id) || row['Name'] === 'Expansion') continue;
      const files: string[] = [];
      for (let i = 1; i <= 32; i++) {
        const f = row[`File ${i}`] ?? '';
        files.push(f && f !== '0' ? f : '');
      }
      gd.lvlTypes.push({ id, name: row['Name'], act: Number(row['Act']) || 0, files });
    }
    for (const row of levels?.rows ?? []) {
      const id = Number(row['Id']);
      if (Number.isFinite(id)) gd.levelTypeById.set(id, Number(row['LevelType']));
    }
    for (const row of prest?.rows ?? []) {
      const info: PresetInfo = {
        def: Number(row['Def']),
        name: row['Name'],
        levelId: Number(row['LevelId']),
        dt1Mask: Number(row['Dt1Mask']) >>> 0,
      };
      for (let i = 1; i <= 6; i++) {
        const f = row[`File${i}`];
        if (f && f !== '0') {
          const key = normalizePath(`data/global/tiles/${f}`);
          if (!gd.presetsByFile.has(key)) gd.presetsByFile.set(key, info);
        }
      }
    }
    return gd;
  }

  /** An act palette (0-4), or OLD_ACT5_PALETTE for d2data.mpq's own Act 5 palette (shadowed by d2exp.mpq in LoD). */
  palette(act: number): Promise<Palette> {
    let p = this.palettes.get(act);
    if (!p) {
      if (act === OLD_ACT5_PALETTE) {
        const d2data = this.fs.baseSources.find((s) => /d2data\.mpq$/i.test(s.label));
        p = (d2data ? d2data.read(palettePath(4)) : Promise.resolve(null)).then((b) => (b ? parsePalette(b) : this.palette(4)));
        this.palettes.set(act, p);
        return p;
      }
      p = this.fs.readOrThrow(palettePath(act)).then(parsePalette);
      this.palettes.set(act, p);
    }
    return p;
  }

  dt1(path: string): Promise<Dt1 | null> {
    const key = normalizePath(path);
    let p = this.dt1s.get(key);
    if (!p) {
      p = this.fs.read(key).then((b) => (b ? parseDt1(b) : null));
      this.dt1s.set(key, p);
    }
    return p;
  }

  /**
   * Display name of a DS1 object, from the object catalogue (normalising ids that spill into the next act the way
   * WinDS1 does: 60 NPC / 150 object ids per act), then MonPreset.txt for NPCs, else "type,id".
   */
  objectName(act0: number, type: number, id: number): string {
    const name = this.objRow(act0, type, id)?.name;
    if (name) return name;
    const preset = type === 1 ? this.monPresets.get(act0 + 1)?.[id] : undefined;
    return preset ?? `${type === 1 ? 'NPC' : 'Object'} ${id}`;
  }

  private objRow(act0: number, type: number, id: number) {
    let act = act0 + 1;
    const exact = this.objRows.get(`${act}:${type}:${id}`);
    if (exact) return exact;
    const per = type === 1 ? 60 : 150;
    let n = id;
    while (n < 0) {
      act--;
      n += per;
    }
    while (n >= per) {
      act++;
      n -= per;
    }
    return this.objRows.get(`${act}:${type}:${n}`) ?? null;
  }

  /** Sprite recipe of an object, if any. */
  objectSpec(act0: number, type: number, id: number): SpriteSpec | null {
    return this.objRow(act0, type, id)?.spec ?? null;
  }

  /** Still frame of an object's sprite (cached), or null when obj.txt has no recipe or the files are missing. */
  /** All frames of an object's/NPC's default animation (for animating them on the map), or null. */
  objectAnimation(act0: number, type: number, id: number): Promise<SpriteAnimation | null> {
    const spec = this.objRow(act0, type, id)?.spec;
    return spec ? loadSpriteAnimation(this.fs, spec) : Promise.resolve(null);
  }

  objectSprite(act0: number, type: number, id: number): Promise<Sprite | null> {
    const key = `${act0}:${type}:${id}`;
    let p = this.sprites.get(key);
    if (!p) {
      const spec = this.objRow(act0, type, id)?.spec;
      p = spec ? loadObjectSprite(this.fs, spec) : Promise.resolve(null);
      this.sprites.set(key, p);
    }
    return p;
  }

  /**
   * Every placeable object/NPC known for an act (0-based): the catalogue's rows for that act, plus MonPreset.txt NPC
   * ids it doesn't cover. Sorted by type, then id.
   */
  objectList(act0: number): { type: number; id: number; name: string; hasSprite: boolean }[] {
    const act = act0 + 1;
    const out: { type: number; id: number; name: string; hasSprite: boolean }[] = [];
    const seen = new Set<string>();
    for (const [key, row] of this.objRows) {
      const [a, type, id] = key.split(':').map(Number);
      if (a !== act) continue;
      seen.add(`${type}:${id}`);
      out.push({ type, id, name: row.name || `${type === 1 ? 'NPC' : 'Object'} ${id}`, hasSprite: !!row.spec });
    }
    (this.monPresets.get(act) ?? []).forEach((place, id) => {
      if (!place || seen.has(`1:${id}`)) return;
      out.push({ type: 1, id, name: place, hasSprite: false });
    });
    return out.sort((a, b) => a.type - b.type || a.id - b.id);
  }

  /** True when the object id table was found (object names and sprites available). */
  get hasObjectNames(): boolean {
    return this.objectTable;
  }
  private objectTable = false;

  lvlType(id: number): LvlTypeInfo | null {
    return this.lvlTypes.find((t) => t.id === id) ?? null;
  }

  /** DT1 paths selected from a LvlTypes row by a LvlPrest Dt1Mask (bit i selects "File i+1"). */
  static dt1sFor(type: LvlTypeInfo, mask: number): string[] {
    return type.files
      .map((f, i) => (f && (mask >>> i) & 1 ? normalizePath(`data/global/tiles/${f}`) : ''))
      .filter(Boolean);
  }

  /**
   * Works out which DT1 libraries a DS1 uses, like the game: LvlPrest (by file name) -> Levels.LevelType -> LvlTypes,
   * filtered by Dt1Mask. Presets shared by many levels have LevelId 0; for those, pick the LvlType whose files best
   * match the DS1's embedded file list. Falls back to the embedded list itself.
   */
  resolveDt1s(ds1Path: string, ds1: Ds1): Dt1Resolution {
    const embedded = ds1.files.map(ds1FileToDt1Path).filter((p): p is string => !!p).map(normalizePath);
    const preset = this.presetsByFile.get(normalizePath(ds1Path)) ?? null;

    if (preset && this.lvlTypes.length) {
      let type: LvlTypeInfo | null = null;
      if (preset.levelId > 0) type = this.lvlType(this.levelTypeById.get(preset.levelId) ?? -1);
      if (!type) type = this.bestTypeForFiles(embedded, preset.dt1Mask);
      if (type) return { source: 'lvlprest', lvlType: type, preset, paths: GameData.dt1sFor(type, preset.dt1Mask) };
    }
    // Not referenced by LvlPrest (custom, unused or test presets). If the DS1's own file list is complete, use it as is,
    // like WinDS1 does; otherwise use the LvlType sharing the most files with it.
    if (embedded.length && embedded.every((p) => this.fs.locate(p))) {
      return { source: 'embedded', lvlType: null, preset, paths: embedded };
    }
    const guess = this.bestTypeForFiles(embedded, 0xffffffff);
    if (guess) {
      const paths = GameData.dt1sFor(guess, 0xffffffff);
      for (const p of embedded) if (!paths.includes(p)) paths.push(p);
      return { source: 'guessed', lvlType: guess, preset, paths };
    }
    return { source: 'embedded', lvlType: null, preset, paths: embedded };
  }

  private bestTypeForFiles(files: string[], mask: number): LvlTypeInfo | null {
    const wanted = new Set(files);
    let best: LvlTypeInfo | null = null;
    let bestScore = 0;
    for (const t of this.lvlTypes) {
      const score = GameData.dt1sFor(t, mask).filter((f) => wanted.has(f)).length;
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }
    return best;
  }
}

/** Fast lookup of DT1 tiles by (orientation, main, sub), with the game's rarity-based variant choice. */
export class TileLibrary {
  private byKey = new Map<number, Dt1Tile[]>();
  readonly loaded: { path: string; found: boolean; tiles: number }[] = [];

  static key(orientation: number, main: number, sub: number): number {
    return (orientation << 16) | (main << 8) | sub;
  }

  private sources = new Map<Dt1Tile, { path: string; index: number }>();
  private byPath = new Map<string, Dt1Tile[]>();

  add(path: string, dt1: Dt1 | null): void {
    this.loaded.push({ path, found: !!dt1, tiles: dt1?.tiles.length ?? 0 });
    if (dt1) this.byPath.set(path, dt1.tiles);
    dt1?.tiles.forEach((t, index) => this.sources.set(t, { path, index }));
    for (const t of dt1?.tiles ?? []) {
      const k = TileLibrary.key(t.orientation, t.mainIndex, t.subIndex);
      let list = this.byKey.get(k);
      if (!list) this.byKey.set(k, (list = []));
      // Newest first, like the game's tile lists: when a key has no random variants (all rarity 0) the tile loaded last
      // is the one used, so a DT1 later in LvlTypes replaces same-numbered tiles of earlier ones (mods rely on this).
      list.unshift(t);
    }
  }

  /** The DT1 a tile was loaded from, and its index in that file. */
  sourceOf(tile: Dt1Tile): { path: string; index: number } | null {
    return this.sources.get(tile) ?? null;
  }

  /** Tiles of one loaded DT1, in file order. */
  tilesOf(path: string): Dt1Tile[] {
    return this.byPath.get(path) ?? [];
  }

  /** Every distinct (orientation, main, sub) with its variants, in a stable order. */
  entries(): { orientation: number; main: number; sub: number; tiles: Dt1Tile[] }[] {
    return [...this.byKey]
      .sort(([a], [b]) => a - b)
      .map(([k, tiles]) => ({ orientation: k >>> 16, main: (k >>> 8) & 0xff, sub: k & 0xff, tiles }));
  }

  /** Adds tiles only for keys no loaded DT1 provides (the built-in special tiles yield to game tiles). */
  addFallback(path: string, dt1: Dt1): void {
    const fresh = dt1.tiles.filter((t) => !this.byKey.has(TileLibrary.key(t.orientation, t.mainIndex, t.subIndex)));
    this.add(path, { ...dt1, tiles: fresh });
    for (const t of fresh) this.sources.set(t, { path, index: dt1.tiles.indexOf(t) });
  }

  variants(orientation: number, main: number, sub: number): Dt1Tile[] {
    return this.byKey.get(TileLibrary.key(orientation, main, sub)) ?? [];
  }

  /**
   * Animation frames for an animated tile: its variants ordered by frame index (the "rarity" field). Only a real frame
   * sequence counts: every variant flagged animated and the rarities distinct, starting at 0 (water, lava). Some DT1s
   * (e.g. Act 5's snow) flag plain random variations as animated with repeated rarity weights; the game doesn't
   * animate those, so they get no frames.
   */
  frames(orientation: number, main: number, sub: number): Dt1Tile[] {
    const list = this.variants(orientation, main, sub);
    return TileLibrary.isAnimation(list) ? [...list].sort((a, b) => a.rarity - b.rarity) : [];
  }

  static isAnimation(list: Dt1Tile[]): boolean {
    if (list.length < 2 || !list.every((t) => t.animated)) return false;
    const r = list.map((t) => t.rarity);
    return new Set(r).size === r.length && Math.min(...r) === 0;
  }

  /** Picks a variant deterministically from a per-cell seed, weighted by rarity (like the game's random pick). */
  pick(orientation: number, main: number, sub: number, seed: number): Dt1Tile | null {
    const list = this.variants(orientation, main, sub);
    if (list.length <= 1) return list[0] ?? null;
    // Animated tiles use "rarity" as a frame index; show frame 0.
    if (TileLibrary.isAnimation(list)) return list.find((t) => t.rarity === 0) ?? list[0];
    const total = list.reduce((s, t) => s + Math.max(t.rarity, 0), 0);
    if (total === 0) return list[0];
    let r = hash(seed) % total;
    for (const t of list) {
      r -= Math.max(t.rarity, 0);
      if (r < 0) return t;
    }
    return list[0];
  }
}

function hash(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}
