import { useCallback, useState } from 'react';

/** App preferences, remembered on this computer. */
export interface Prefs {
  /** Save the open map automatically before opening another one (else ask: save, discard or cancel). */
  saveOnSwitch: boolean;
}

export const DEFAULT_PREFS: Prefs = { saveOnSwitch: true };

const KEY = 'ds1studio.prefs';

function load(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(load);
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
