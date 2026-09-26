import { BlobAccess, HttpRangeAccess } from '../util/RandomAccess';
import { CLASSIC_MPQS, LayeredFs, LooseSource, MpqSource, RELEVANT_EXT, type FileSource } from './vfs';

interface ManifestSource {
  id: string;
  kind: 'mpq' | 'loose';
  label: string;
}

/** Dev mode: game data served by the Vite plugin at /__d2. Returns null when unavailable. */
export async function loadFromDevServer(): Promise<LayeredFs | null> {
  let manifest: ManifestSource[];
  try {
    const res = await fetch('/__d2/manifest');
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    manifest = await res.json();
  } catch {
    return null;
  }
  if (manifest.length === 0) return null;

  const sources: FileSource[] = [];
  for (const s of manifest) {
    const base = `/__d2/file/${encodeURIComponent(s.id)}`;
    if (s.kind === 'mpq') {
      sources.push(await MpqSource.open(s.label, await HttpRangeAccess.open(base)));
    } else {
      const files: string[] = await (await fetch(`/__d2/list/${encodeURIComponent(s.id)}`)).json();
      const index = new Map<string, () => Promise<Uint8Array>>();
      for (const f of files) {
        const url = `${base}/${f.split('/').map(encodeURIComponent).join('/')}`;
        index.set(f, async () => new Uint8Array(await (await fetch(url)).arrayBuffer()));
      }
      sources.push(new LooseSource(s.label, index));
    }
  }
  return new LayeredFs(sources);
}

async function indexDirectory(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  index: Map<string, () => Promise<Uint8Array>>,
): Promise<void> {
  // @ts-expect-error: entries() is not yet in TS's DOM lib for all targets
  for await (const [name, handle] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (handle.kind === 'directory') {
      await indexDirectory(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, index);
    } else if (RELEVANT_EXT.test(name)) {
      const fh = handle as FileSystemFileHandle;
      index.set(prefix + name, async () => new Uint8Array(await (await fh.getFile()).arrayBuffer()));
    }
  }
}

async function tryGetDir(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

/**
 * Builds sources from a folder the user picked (File System Access API).
 * A loose `data/` tree wins over any .mpq files in the same folder; base-game MPQs are ordered patch > exp > data.
 */
export async function sourcesFromDirectory(dir: FileSystemDirectoryHandle, includeModMpqs: boolean): Promise<FileSource[]> {
  const sources: FileSource[] = [];
  const data = await tryGetDir(dir, 'data');
  if (data) {
    const index = new Map<string, () => Promise<Uint8Array>>();
    await indexDirectory(data, 'data/', index);
    sources.push(new LooseSource(`${dir.name}/data`, index));
  }

  const mpqs = new Map<string, FileSystemFileHandle>();
  // @ts-expect-error: see above
  for await (const [name, handle] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (handle.kind === 'file' && /\.mpq$/i.test(name)) mpqs.set(name.toLowerCase(), handle as FileSystemFileHandle);
  }
  const base = CLASSIC_MPQS.filter((m) => mpqs.has(m));
  const isGameDir = mpqs.has('d2data.mpq');
  const extra = [...mpqs.keys()].filter((m) => !CLASSIC_MPQS.includes(m) && !/^d2(char|music|sfx|speech|video|xmusic|xtalk|xvideo)\.mpq$/.test(m));
  const order = isGameDir ? base : includeModMpqs ? [...extra.sort(), ...base] : [];
  for (const m of order) {
    const file = await mpqs.get(m)!.getFile();
    sources.push(await MpqSource.open(`${dir.name}/${m}`, new BlobAccess(file)));
  }
  return sources;
}

export const canPickFolders = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
