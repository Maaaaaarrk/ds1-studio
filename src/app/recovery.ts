/**
 * Autosave: copies of maps with unsaved changes, kept in the browser's IndexedDB (in the app's own storage, never in
 * the game or mod folders) so a crash or a closed window doesn't lose work. A copy is removed once the map is saved
 * or the changes are discarded. If IndexedDB is unavailable, autosave silently does nothing.
 */

export interface Recovery {
  /** Game path of the map (the key). */
  path: string;
  /** When it was autosaved (ms since epoch). */
  time: number;
  /** The DS1 as it would be saved. */
  bytes: Uint8Array;
}

const DB = 'ds1studio';
const STORE = 'recovery';

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const key = (path: string) => path.toLowerCase();

export async function saveRecovery(path: string, bytes: Uint8Array): Promise<void> {
  await run('readwrite', (s) => s.put({ key: key(path), path, time: Date.now(), bytes: bytes.slice() }));
}

export async function getRecovery(path: string): Promise<Recovery | null> {
  return (await run<Recovery | undefined>('readonly', (s) => s.get(key(path)))) ?? null;
}

export async function deleteRecovery(path: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key(path)));
}

export async function listRecoveries(): Promise<Recovery[]> {
  const all = (await run<Recovery[]>('readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.time - a.time);
}
