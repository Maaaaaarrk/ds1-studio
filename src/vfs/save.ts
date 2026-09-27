/** Where edited files are written. Paths are game-relative, e.g. "data/global/tiles/ACT1/Town/townN1.ds1". */
export interface SaveTarget {
  readonly label: string;
  /** Writes the file; returns a human-readable description of what happened. */
  save(path: string, bytes: Uint8Array): Promise<string>;
}

/** Dev mode: the Vite plugin writes into the configured mod folder. */
export async function devServerSaveTarget(): Promise<SaveTarget | null> {
  try {
    const res = await fetch('/__d2/save-target');
    if (!res.ok) return null;
    const { root } = (await res.json()) as { root: string };
    return {
      label: root,
      async save(path, bytes) {
        const r = await fetch(`/__d2/save/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', body: bytes.slice() });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `save failed (${r.status})`);
        return body.backup ? `Saved ${body.written} (original kept as ${body.backup})` : `Saved ${body.written}`;
      },
    };
  } catch {
    return null;
  }
}

async function childDir(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
  // Game paths are case-insensitive; reuse an existing folder regardless of its case.
  // @ts-expect-error: entries() is not yet in TS's DOM lib for all targets
  for await (const [n, h] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind === 'directory' && n.toLowerCase() === name.toLowerCase()) return h as FileSystemDirectoryHandle;
  }
  return dir.getDirectoryHandle(name, { create: true });
}

async function existingFile(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | null> {
  // @ts-expect-error: see above
  for await (const [n, h] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind === 'file' && n.toLowerCase() === name.toLowerCase()) return h as FileSystemFileHandle;
  }
  return null;
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array<ArrayBuffer> | Blob): Promise<void> {
  const fh = (await existingFile(dir, name)) ?? (await dir.getFileHandle(name, { create: true }));
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

/** A mod folder opened through the File System Access API. */
export function directorySaveTarget(root: FileSystemDirectoryHandle): SaveTarget {
  return {
    label: root.name,
    async save(path, bytes) {
      const perm = await (root as unknown as { requestPermission(o: object): Promise<PermissionState> }).requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('Write permission was not granted for the mod folder.');
      const parts = path.split('/');
      const name = parts.pop()!;
      let dir = root;
      for (const p of parts) dir = await childDir(dir, p);
      let backup = '';
      const existing = await existingFile(dir, name);
      if (existing && !(await existingFile(dir, `${name}.bak`))) {
        await writeFile(dir, `${name}.bak`, await existing.getFile());
        backup = ` (original kept as ${name}.bak)`;
      }
      await writeFile(dir, name, bytes.slice());
      return `Saved ${root.name}/${path}${backup}`;
    },
  };
}

/** Desktop app: native "Save as" dialog. Browser: a download. Returns where it went (or null if cancelled). */
export async function exportBytes(name: string, bytes: Uint8Array): Promise<string | null> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string | null>('export_file', bytes.slice(), { headers: { 'x-name': encodeURIComponent(name) } });
  }
  downloadFile(name, bytes);
  return `Downloads/${name}`;
}

/** Desktop app: native "Open" dialog. Browser: a file input. Resolves null if cancelled. */
export async function importBytes(extension: string): Promise<Uint8Array | null> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    const buf = new Uint8Array(await invoke<ArrayBuffer>('import_file', { extension }));
    return buf.length ? buf : null;
  }
  const [file] = await pickFiles(extension, 'file');
  return file ? new Uint8Array(await file.arrayBuffer()) : null;
}

export interface PickedImport {
  name: string;
  /** Folder path relative to (and starting with) the picked folder it was found in; '' for picked files. */
  folder: string;
  read: () => Promise<Uint8Array>;
}

/**
 * Picks files to import: one file, several files, or folders (every file with `extension` inside them, subfolders
 * included). Desktop: native dialogs, files read raw one by one. Browser: file inputs. [] = cancelled.
 */
export async function importMany(extension: string, mode: 'file' | 'files' | 'folders'): Promise<PickedImport[]> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    const entries = await invoke<{ name: string; folder: string }[]>('pick_import', { extension, mode });
    return entries.map((e, index) => ({ ...e, read: async () => new Uint8Array(await invoke<ArrayBuffer>('read_picked', { index })) }));
  }
  const files = await pickFiles(extension, mode);
  return files
    .filter((f) => f.name.toLowerCase().endsWith(`.${extension}`))
    .map((f) => {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
      return { name: f.name, folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', read: async () => new Uint8Array(await f.arrayBuffer()) };
    });
}

/** Browser: files from a (hidden, attached) file input; [] if cancelled. */
function pickFiles(extension: string, mode: 'file' | 'files' | 'folders'): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (mode === 'folders') (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    else input.accept = extension.split(',').map((e) => `.${e}`).join(','); // 'ds1,zip' offers both
    input.multiple = mode !== 'file';
    input.style.display = 'none';
    // Attached while in use: detached inputs don't reliably report the chosen files in every browser.
    document.body.appendChild(input);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      setTimeout(() => input.remove(), 60_000);
      resolve([...(input.files ?? [])]);
    };
    input.addEventListener('change', done);
    // Some browsers report "cancel" around a programmatic choice too: only give up if no file follows.
    input.addEventListener('cancel', () => setTimeout(done, 1000));
    input.click();
  });
}

/** Like importBytes, but also gives the picked file's name. */
export async function importNamed(extension: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const [f] = await importMany(extension, 'file');
  return f ? { name: f.name, bytes: await f.read() } : null;
}

/** Fallback: hand the file to the user as a download. */
export function downloadFile(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
