export interface Visibility {
  floors: boolean[];
  walls: boolean[];
  shadows: boolean;
  roofs: boolean;
  lowerWalls: boolean;
  specials: boolean;
  objects: boolean;
  paths: boolean;
  groups: boolean;
  missing: boolean;
  grid: boolean;
}

export const DEFAULT_VISIBILITY: Visibility = {
  floors: [true, true],
  walls: [true, true, true, true],
  shadows: true,
  roofs: true,
  lowerWalls: true,
  specials: false,
  objects: true,
  paths: true,
  groups: false,
  missing: true,
  grid: false,
};

export const ORIENTATION_NAMES: Record<number, string> = {
  0: 'Floor',
  1: 'Left wall',
  2: 'Right wall',
  3: 'North corner (right)',
  4: 'North corner (left)',
  5: 'Left end wall',
  6: 'Right end wall',
  7: 'South corner',
  8: 'Left wall + door',
  9: 'Right wall + door',
  10: 'Special tile',
  11: 'Special tile',
  12: 'Pillar / standalone',
  13: 'Shadow',
  14: 'Tree',
  15: 'Roof',
  16: 'Lower wall (left)',
  17: 'Lower wall (right)',
  18: 'Lower wall (north)',
  19: 'Lower wall (south)',
};
