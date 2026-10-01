import { DEFAULT_THEME, type Theme } from './themes';
import { useCallback, useState } from 'react';

/** App preferences, remembered on this computer. */
export interface Prefs {
  /** Save the open map automatically before opening another one (else ask: save, discard or cancel). */
  saveOnSwitch: boolean;
  /** Show every map in the Act 0 colours (unless a palette was picked for it in View → Colours). */
  act0View: boolean;
  /** In the Act 0 colours, mark colours that change between acts in magenta (else show them in the map's own act). */
  act0Magenta: boolean;
  /** Pasting stacks onto existing tiles by default (Alt then replaces); off: pasting replaces (Alt stacks). */
  pasteStack: boolean;
  /** What New map starts with. `folder` is under data/global/tiles (its first part follows the act). */
  newMap: { width: number; height: number; act: number; floorLayers: number; wallLayers: number; folder: string };
  /** Seconds between autosaves of unsaved work (0 = off). */
  autosaveSeconds: number;
  /** Ask before deleting several objects at once, or a preset. */
  confirmBulkDelete: boolean;
  /** What a map opens with. */
  showWalkArea: boolean;
  showGrid: boolean;
  showMinimap: boolean;
  /** Object names on the map (off: only for the object under the cursor or selected). */
  objectLabels: boolean;
  /** Mouse-wheel zoom speed (1 = normal). */
  zoomSpeed: number;
  /** What Shift+wheel does: step through layers (Alt+wheel zooms) or zoom (Alt+wheel steps layers). */
  shiftWheel: 'layers' | 'zoom';
  /** How many maps Recent keeps. */
  recentCount: number;
  /** Run the Compatibility check after saving a map / after Add to game (it opens when it finds problems). */
  checkAfterSave: boolean;
  checkAfterAddToGame: boolean;
  /** When saving a map whose tile libraries changed: also update its LvlTypes slots and LvlPrest Dt1Mask. */
  syncTablesOnSave: boolean;
  /** Arrow-key panning speed (1 = normal). */
  arrowSpeed: number;
  /** Appearance (as in PD2 Filter Forge): a built-in or custom theme's id, the accent colour, and your own themes. */
  theme: string;
  accent: string;
  customThemes: Theme[];
}

export const DEFAULT_PREFS: Prefs = {
  saveOnSwitch: true,
  act0View: true,
  act0Magenta: false,
  pasteStack: false,
  newMap: { width: 150, height: 150, act: 4, floorLayers: 1, wallLayers: 2, folder: 'expansion/Custom' },
  autosaveSeconds: 20,
  confirmBulkDelete: true,
  showWalkArea: true,
  showGrid: false,
  showMinimap: true,
  objectLabels: true,
  zoomSpeed: 1,
  shiftWheel: 'layers',
  recentCount: 12,
  checkAfterSave: false,
  checkAfterAddToGame: false,
  syncTablesOnSave: true,
  arrowSpeed: 1,
  theme: DEFAULT_THEME,
  accent: '#d4a84f',
  customThemes: [],
};

const KEY = 'ds1studio.prefs';

/** The saved preferences (for code that runs before the app's state exists). */
export function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return { ...DEFAULT_PREFS, ...saved, newMap: { ...DEFAULT_PREFS.newMap, ...(saved.newMap ?? {}) } };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // per-computer convenience only
      }
      return next;
    });
  }, []);
  return [prefs, update];
}
