import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../vfs/tauri';

/** One of the game's daily logs (D2YYMMDD.txt in the mod or game folder), which get its crash reports. */
export interface CrashLogFile {
  path: string;
  /** Milliseconds since 1970. */
  modified: number;
}

/**
 * The game's logs, newest first. Empty when there are none or the folders can't be listed (the browser build working
 * on a picked folder can't see them).
 */
export async function listCrashLogs(): Promise<CrashLogFile[]> {
  try {
    if (isTauri) return await invoke<CrashLogFile[]>('list_crash_logs');
    const res = await fetch('/__d2/crash-logs');
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function readCrashLog(path: string): Promise<string> {
  if (isTauri) return new TextDecoder('latin1').decode(new Uint8Array(await invoke<ArrayBuffer>('read_file', { path })));
  const res = await fetch(`/__d2/crash-log?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Couldn't read ${path} (${res.status})`);
  return new TextDecoder('latin1').decode(await res.arrayBuffer());
}
