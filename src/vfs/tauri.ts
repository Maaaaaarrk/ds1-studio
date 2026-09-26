import { invoke } from '@tauri-apps/api/core';
import type { RandomAccess } from '../util/RandomAccess';
import type { SaveTarget } from './save';
import { CLASSIC_MPQS, LayeredFs, LooseSource, MpqSource, type FileSource } from './vfs';

/** True when running inside the Tauri desktop shell. */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Folders the desktop app works with (persisted by the native side). */
export interface DesktopConfig {
  gameDir?: string | null;
  modDirs: string[];
  modMpqs: boolean;
  winds1Dir?: string | null;
  saveDir?: string | null;
}

export const getConfig = () => invoke<DesktopConfig>('get_config');
export const setConfig = (config: DesktopConfig) => invoke<void>('set_config', { config });

const join = (dir: string, rel: string) => `${dir.replace(/[\\/]+$/, '')}/${rel}`;

async function readFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('read_file', { path }));
}

/** Random access to a local file through the native side (MPQs are read piecemeal). */
class NativeFileAccess implements RandomAccess {
  private constructor(
    private readonly path: string,
    readonly size: number,
  ) {}

  static async open(path: string): Promise<NativeFileAccess> {
    return new NativeFileAccess(path, await invoke<number>('file_size', { path }));
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    return new Uint8Array(await invoke<ArrayBuffer>('read_range', { path: this.path, offset, length }));
  }
}

async function looseData(label: string, root: string): Promise<LooseSource | null> {
  const files = await invoke<string[]>('list_data_files', { root });
  if (!files.length) return null;
  return new LooseSource(label, new Map(files.map((f) => [f, () => readFile(join(root, f))])));
}

async function exists(path: string): Promise<boolean> {
  try {
    await invoke<number>('file_size', { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mounts the configured folders in priority order, like the dev server: mod data folders (and their MPQs if enabled),
 * WinDS1 data, the game's loose data folder, then patch_d2 > d2exp > d2data > d2char.
 */
export async function loadFromTauri(config: DesktopConfig): Promise<LayeredFs> {
  const sources: FileSource[] = [];
  for (const mod of config.modDirs) {
    const loose = await looseData(`${mod}/data`, mod);
    if (loose) sources.push(loose);
    if (config.modMpqs) {
      const mpqs = (await invoke<string[]>('list_mpqs', { dir: mod })).filter((m) => !CLASSIC_MPQS.includes(m.toLowerCase())).sort();
      for (const m of mpqs) sources.push(await MpqSource.open(`${mod}/${m}`, await NativeFileAccess.open(join(mod, m))));
    }
  }
  if (config.winds1Dir) {
    const files = new Map<string, () => Promise<Uint8Array>>();
    for (const name of ['obj.txt', 'ds1edit.dt1']) {
      const path = join(config.winds1Dir, `Data/${name}`);
      if (await exists(path)) files.set(`winds1/${name}`, () => readFile(path));
    }
    if (files.size) sources.push(new LooseSource(`${config.winds1Dir}/Data`, files));
  }
  if (config.gameDir) {
    const loose = await looseData(`${config.gameDir}/data`, config.gameDir);
    if (loose) sources.push(loose);
    const present = new Set((await invoke<string[]>('list_mpqs', { dir: config.gameDir })).map((m) => m.toLowerCase()));
    for (const m of CLASSIC_MPQS) {
      if (present.has(m)) sources.push(await MpqSource.open(m, await NativeFileAccess.open(join(config.gameDir, m))));
    }
  }
  return new LayeredFs(sources);
}

/** Saves into the mod folder (or `saveDir`) through the native side. */
export function tauriSaveTarget(config: DesktopConfig): SaveTarget | null {
  const root = config.saveDir ?? config.modDirs[0];
  if (!root) return null;
  return {
    label: root,
    async save(path, bytes) {
      const r = await invoke<{ written: string; backup: string | null }>('save_file', bytes.slice(), { headers: { 'x-path': encodeURIComponent(path) } });
      return r.backup ? `Saved ${r.written} (original kept as ${r.backup})` : `Saved ${r.written}`;
    },
  };
}

/** Native folder picker. */
export async function pickFolder(title: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, title });
  return typeof picked === 'string' ? picked : null;
}
