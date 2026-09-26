import { ds1FileToDt1Path, type Ds1 } from '../formats/ds1';
import { parseDt1, type Dt1, type Dt1Tile } from '../formats/dt1';
import { parsePalette, palettePath, type Palette } from '../formats/palette';
import { parseTxt, type TxtTable } from '../formats/txt';
import { normalizePath, type LayeredFs } from '../vfs/vfs';

export interface LvlTypeInfo {
  id: number;
  name: string;
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

  private constructor(readonly fs: LayeredFs) {}

  static async load(fs: LayeredFs): Promise<GameData> {
    const gd = new GameData(fs);
    const table = async (name: string): Promise<TxtTable | null> => {
      const bytes = await fs.read(`data/global/excel/${name}`);
      if (!bytes) gd.warnings.push(`${name} not found; DT1s will come from each DS1's embedded file list.`);
      return bytes ? parseTxt(bytes) : null;
    };
    const [prest, types, levels] = await Promise.all([table('LvlPrest.txt'), table('LvlTypes.txt'), table('Levels.txt')]);

    for (const row of types?.rows ?? []) {
      const id = Number(row['Id']);
      if (!Number.isFinite(id) || row['Name'] === 'Expansion') continue;
      const files: string[] = [];
      for (let i = 1; i <= 32; i++) {
        const f = row[`File ${i}`] ?? '';
        files.push(f && f !== '0' ? f : '');
      }
      gd.lvlTypes.push({ id, name: row['Name'], files });
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

  palette(act: number): Promise<Palette> {
    let p = this.palettes.get(act);
    if (!p) {
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
    // Not referenced by LvlPrest (unused/test presets): use the LvlType sharing the most files with the embedded list.
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

  add(path: string, dt1: Dt1 | null): void {
    this.loaded.push({ path, found: !!dt1, tiles: dt1?.tiles.length ?? 0 });
    for (const t of dt1?.tiles ?? []) {
      const k = TileLibrary.key(t.orientation, t.mainIndex, t.subIndex);
      let list = this.byKey.get(k);
      if (!list) this.byKey.set(k, (list = []));
      list.push(t);
    }
  }

  /** Every distinct (orientation, main, sub) with its variants, in a stable order. */
  entries(): { orientation: number; main: number; sub: number; tiles: Dt1Tile[] }[] {
    return [...this.byKey]
      .sort(([a], [b]) => a - b)
      .map(([k, tiles]) => ({ orientation: k >>> 16, main: (k >>> 8) & 0xff, sub: k & 0xff, tiles }));
  }

  variants(orientation: number, main: number, sub: number): Dt1Tile[] {
    return this.byKey.get(TileLibrary.key(orientation, main, sub)) ?? [];
  }

  /** Picks a variant deterministically from a per-cell seed, weighted by rarity (like the game's random pick). */
  pick(orientation: number, main: number, sub: number, seed: number): Dt1Tile | null {
    const list = this.variants(orientation, main, sub);
    if (list.length <= 1) return list[0] ?? null;
    // Animated tiles use "rarity" as a frame index; show frame 0.
    if (list[0].animated) return list.find((t) => t.rarity === 0) ?? list[0];
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
