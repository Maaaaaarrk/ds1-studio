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

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (label: string, key: string) => !q || label.toLowerCase().includes(q) || key.toLowerCase().includes(q);
  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  const changedCount = ACTIONS.filter((a) => bindings[a.id] !== DEFAULT_BINDINGS[a.id]).length;
  return (
    <Modal title="Keyboard shortcuts" onClose={() => !capturing && onClose()} wide>
      <div className="sc-top">
        <input
          className="search small-input sc-search"
          placeholder="Search actions or keys…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setQuery('');
          }}
        />
        <span className="muted small">
          Click a key to change it, then press the new key or combination · <Kbd combo="Escape" /> cancels · <Kbd combo="Backspace" /> clears
        </span>
      </div>
      <div className="sc-grid">
        {groups.map((g) => {
          const rows = ACTIONS.filter((a) => a.group === g && matches(a.label, bindings[a.id] ?? ''));
          if (!rows.length) return null;
          return (
            <section key={g} className="sc-card">
              <div className="sc-card-title">{g}</div>
              {rows.map((a) => {
                const changed = bindings[a.id] !== DEFAULT_BINDINGS[a.id];
                return (
                  <div key={a.id} className={`sc-row${changed ? ' changed' : ''}`}>
                    <span className="sc-label">{a.label}</span>
                    {changed && (
                      <button className="sc-undo" title={`Back to ${DEFAULT_BINDINGS[a.id] || 'none'}`} onClick={() => onBind(a.id, DEFAULT_BINDINGS[a.id])}>
                        ↺
                      </button>
                    )}
                    <button className={`sc-keys${capturing === a.id ? ' capturing' : ''}`} onClick={() => setCapturing(a.id)} title="Click, then press the new shortcut">
                      {capturing === a.id ? <span className="sc-press">Press keys…</span> : bindings[a.id] ? <Kbd combo={bindings[a.id]} /> : <span className="muted">none</span>}
                    </button>
                  </div>
                );
              })}
            </section>
          );
        })}
        {(() => {
          const rows = FIXED.filter(([what, how]) => matches(what, how));
          return rows.length ? (
            <section className="sc-card">
              <div className="sc-card-title">
                Mouse &amp; navigation <span className="muted small">fixed</span>
              </div>
              {rows.map(([what, how], i) => (
                <div key={i} className="sc-row">
                  <span className="sc-label">{what}</span>
                  <span className="sc-fixed">{how}</span>
                </div>
              ))}
            </section>
          ) : null;
        })()}
      </div>
      <div className="modal-actions">
        <span className="muted small sc-foot">
          {changedCount ? `${changedCount} changed from the defaults · ` : ''}A key can only do one thing: giving it to another action takes it from this one. Saved on this
          computer.
        </span>
        <button className="btn" disabled={!changedCount} onClick={onReset}>
          Reset all
        </button>
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

/** A shortcut drawn as key caps: "Ctrl+Shift+Z" → [Ctrl] + [Shift] + [Z]. */
export function Kbd({ combo }: { combo: string }) {
  const parts = combo === '+' ? ['+'] : combo.split('+').filter(Boolean);
  return (
    <span className="kbd-combo">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="kbd-plus">+</span>}
          <kbd>{p}</kbd>
        </span>
      ))}
    </span>
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
