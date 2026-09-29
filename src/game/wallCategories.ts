export type WallCategory = 'upper' | 'lower';
export type WallCategories = Record<string, WallCategory>;
export const wallLibraryKey = (path: string) => path.replace(/\\/g, '/').toLowerCase();

/** Editor visibility grouping only: never changes DT1 orientations or game draw order. */
export function wallCategory(orientation: number, path?: string, overrides: WallCategories = {}): WallCategory | null {
  const category = orientation >= 16 ? 'lower' : ((orientation >= 1 && orientation <= 9) || orientation === 12 || orientation === 14) ? 'upper' : null;
  return category && path ? overrides[wallLibraryKey(path)] ?? category : category;
}

export function readWallCategories(raw: string | null): WallCategories {
  try {
    const value = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([,v]) => v === 'upper' || v === 'lower').map(([k,v]) => [wallLibraryKey(k),v])) as WallCategories;
  } catch { return {}; }
}
