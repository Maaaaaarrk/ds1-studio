import { useEffect, useState } from 'react';
import { Modal } from './Dialogs';
import { ACTIONS, comboOf, DEFAULT_BINDINGS, type ActionId, type Bindings } from './keybindings';

interface Props {
  bindings: Bindings;
  onBind: (id: ActionId, combo: string) => void;
  onReset: () => void;
  onClose: () => void;
}

/** Lists every shortcut; click one and press the new key combination. */
export function ShortcutsDialog({ bindings, onBind, onReset, onClose }: Props) {
  const [capturing, setCapturing] = useState<ActionId | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey) return setCapturing(null);
      if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey) {
        onBind(capturing, '');
        return setCapturing(null);
      }
      const combo = comboOf(e);
      if (!combo) return;
      onBind(capturing, combo);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, onBind]);

  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  return (
    <Modal title="Keyboard shortcuts" onClose={() => !capturing && onClose()} wide>
      <p className="muted small">
        Click a shortcut, then press the new key or combination (Esc cancels, Backspace clears). A key can only do one thing: taking it from another
        command unbinds that one. Shortcuts are remembered on this computer.
      </p>
      <div className="shortcut-groups">
        {groups.map((g) => (
          <div key={g}>
            <div className="field-label">{g}</div>
            {ACTIONS.filter((a) => a.group === g).map((a) => (
              <div key={a.id} className="shortcut-row">
                <span>{a.label}</span>
                <button className={`kbd-btn${capturing === a.id ? ' capturing' : ''}${bindings[a.id] !== DEFAULT_BINDINGS[a.id] ? ' changed' : ''}`} onClick={() => setCapturing(a.id)}>
                  {capturing === a.id ? 'Press keys…' : bindings[a.id] || '—'}
                </button>
              </div>
            ))}
          </div>
        ))}
        <div>
          <div className="field-label">Mouse &amp; navigation (fixed)</div>
          {FIXED.map(([what, how]) => (
            <div key={what} className="shortcut-row">
              <span>{what}</span>
              <span className="kbd-btn fixed">{how}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onReset}>
          Reset to defaults
        </button>
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

/** Controls that aren't rebindable, listed for reference (the README's table is generated from the same list). */
export const FIXED: [string, string][] = [
  ['Pan the map', 'Arrow keys (Shift = faster)'],
  ['Pan the map', 'Space + drag, middle or right drag'],
  ['Zoom', 'Mouse wheel'],
  ['Step through stacked tiles', 'Shift + wheel'],
  ['Stack a paste / preset onto existing tiles', 'Alt + click'],
  ['Zoom tile / object thumbnails', 'Ctrl + wheel over the panel'],
  ['Select a range of tiles (DT1 editor)', 'Shift + click'],
];
