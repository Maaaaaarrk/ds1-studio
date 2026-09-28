import { useCallback, useEffect, useState } from 'react';

/** Every command that can have a keyboard shortcut. */
export const ACTIONS = [
  { id: 'tool.select', label: 'Select tool', group: 'Tools', key: 'V' },
  { id: 'tool.paint', label: 'Paint tool (freehand)', group: 'Tools', key: 'B' },
  { id: 'tool.rect', label: 'Paint / erase a rectangle', group: 'Tools', key: 'U' },
  { id: 'tool.fill', label: 'Flood fill / erase a connected area', group: 'Tools', key: 'L' },
  { id: 'tool.erase', label: 'Erase tool', group: 'Tools', key: 'E' },
  { id: 'tool.pick', label: 'Pick tool', group: 'Tools', key: 'I' },
  { id: 'tool.object', label: 'Objects tool', group: 'Tools', key: 'O' },
  { id: 'tool.toggleObjects', label: 'Toggle tiles / objects editing (like WinDS1)', group: 'Tools', key: 'Tab' },
  { id: 'edit.undo', label: 'Undo', group: 'Edit', key: 'Ctrl+Z' },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', key: 'Ctrl+Y' },
  { id: 'edit.redo2', label: 'Redo (alternative)', group: 'Edit', key: 'Ctrl+Shift+Z' },
  { id: 'file.save', label: 'Save', group: 'File', key: 'Ctrl+S' },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', key: 'Ctrl+C' },
  { id: 'edit.cut', label: 'Cut', group: 'Edit', key: 'Ctrl+X' },
  { id: 'edit.paste', label: 'Paste', group: 'Edit', key: 'Ctrl+V' },
  { id: 'edit.selectAll', label: 'Select all', group: 'Edit', key: 'Ctrl+A' },
  { id: 'edit.cancel', label: 'Cancel / drop the tile on the cursor / deselect', group: 'Edit', key: 'Escape' },
  { id: 'edit.delete', label: 'Delete (active layer / object)', group: 'Edit', key: 'Delete' },
  { id: 'edit.deleteAll', label: 'Delete everything (all layers + objects)', group: 'Edit', key: 'Shift+Delete' },
  { id: 'edit.replace', label: 'Find & replace tiles', group: 'Edit', key: 'Ctrl+H' },
  { id: 'view.fit', label: 'Fit map', group: 'View', key: 'F' },
  { id: 'view.game', label: 'Game view (what the character sees)', group: 'View', key: 'Z' },
  { id: 'view.grid', label: 'Grid', group: 'View', key: 'G' },
  { id: 'view.rooms', label: 'Game rooms (8×8)', group: 'View', key: 'R' },
  { id: 'view.walkable', label: 'Walkability view', group: 'View', key: 'W' },
  { id: 'view.automap', label: 'Automap view', group: 'View', key: 'A' },
  { id: 'view.markers', label: 'Object markers', group: 'View', key: 'M' },
  { id: 'view.sprites', label: 'Object sprites', group: 'View', key: 'N' },
  { id: 'view.paths', label: 'NPC paths', group: 'View', key: 'P' },
  { id: 'view.minimap', label: 'Minimap', group: 'View', key: 'K' },
  { id: 'view.pops', label: 'Roof hiding view', group: 'View', key: 'H' },
  { id: 'view.popsInside', label: 'Show roofs as hidden (as if inside)', group: 'View', key: 'Shift+H' },
  { id: 'view.light', label: 'Level light view', group: 'View', key: 'Shift+L' },
  { id: 'view.snapshot', label: 'Copy the map view as a picture (paste it anywhere)', group: 'View', key: 'PrintScreen' },
  { id: 'layer.floor1', label: 'Floor 1', group: 'Layers', key: '1' },
  { id: 'layer.floor2', label: 'Floor 2', group: 'Layers', key: '2' },
  { id: 'layer.wall1', label: 'Wall 1', group: 'Layers', key: '3' },
  { id: 'layer.wall2', label: 'Wall 2', group: 'Layers', key: '4' },
  { id: 'layer.wall3', label: 'Wall 3', group: 'Layers', key: '5' },
  { id: 'layer.wall4', label: 'Wall 4', group: 'Layers', key: '6' },
  { id: 'layer.shadows', label: 'Shadows', group: 'Layers', key: '7' },
  { id: 'layer.roofs', label: 'Roofs', group: 'Layers', key: '8' },
  { id: 'layer.lowerWalls', label: 'Lower walls', group: 'Layers', key: '9' },
  { id: 'layer.specials', label: 'Special tiles', group: 'Layers', key: '0' },
] as const;

export type ActionId = (typeof ACTIONS)[number]['id'];
export type Bindings = Record<ActionId, string>;

const STORAGE_KEY = 'ds1studio.keybindings';

export const DEFAULT_BINDINGS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.key])) as Bindings;

const KEY_NAMES: Record<string, string> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Esc: 'Escape', Del: 'Delete' };

/** "Ctrl+Shift+Z" style name for a key event; null for a lone modifier key. */
export function comboOf(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  let key = KEY_NAMES[e.key] ?? e.key;
  if (key.length === 1) key = key.toUpperCase();
  // Shifted digits/symbols report the symbol; use the physical key instead so Shift+1 is "Shift+1".
  if (e.shiftKey && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  const mods = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean);
  return [...mods, key].join('+');
}

function load(): Bindings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Bindings>;
    return { ...DEFAULT_BINDINGS, ...saved };
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

/** Current shortcuts (defaults + the user's changes, remembered on this computer). */
export function useKeybindings() {
  const [bindings, setBindings] = useState<Bindings>(load);
  useEffect(() => {
    try {
      const changed = Object.fromEntries(Object.entries(bindings).filter(([id, k]) => DEFAULT_BINDINGS[id as ActionId] !== k));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(changed));
    } catch {
      // per-viewer convenience only
    }
  }, [bindings]);
  /** Binds `combo` to `id`; an action that had it loses it (so every shortcut stays unique). */
  const bind = useCallback((id: ActionId, combo: string) => {
    setBindings((b) => {
      const next = { ...b };
      for (const k of Object.keys(next) as ActionId[]) if (next[k] === combo) next[k] = '';
      next[id] = combo;
      return next;
    });
  }, []);
  const reset = useCallback(() => setBindings({ ...DEFAULT_BINDINGS }), []);
  const actionFor = useCallback((combo: string) => (Object.keys(bindings) as ActionId[]).find((id) => bindings[id] === combo) ?? null, [bindings]);
  return { bindings, bind, reset, actionFor };
}
