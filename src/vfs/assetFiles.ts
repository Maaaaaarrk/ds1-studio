import { invoke } from '@tauri-apps/api/core';
import { normalizePath } from './vfs';
export interface ManagedAsset { root: string; path: string }
const physicalPath = (p: string) => normalizePath(p).replace(/^\?\//, '').replace(/\/$/, '');
export function findManagedAsset(entries: ManagedAsset[], path: string, source: string | null): ManagedAsset | undefined {
  return entries.find(x => normalizePath(x.path) === normalizePath(path) &&
    [physicalPath(x.root), physicalPath(x.root + '/data')].includes(physicalPath(source ?? '')));
}
export interface RecycledAsset {
  id: string; root: string; path: string; created: number; partial: boolean;
  action: 'delete' | 'unused'; unusedPath: string | null; restored: boolean;
}
export const managedAssets = () => invoke<ManagedAsset[]>('list_managed_assets');
export const recycledAssets = () => invoke<RecycledAsset[]>('list_recycled_assets');
export const restoreAsset = (id: string) => invoke<string>('restore_asset', { id });
export const archiveAsset = (asset: ManagedAsset, expected: Uint8Array, action: 'delete' | 'unused', remaining: Uint8Array | null = null, removed = expected) =>
  invoke<RecycledAsset>('archive_asset', {
    root: asset.root, path: asset.path, expected: Array.from(expected), action,
    remaining: remaining ? Array.from(remaining) : null, removed: Array.from(removed),
  });
