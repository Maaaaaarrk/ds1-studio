import { useEffect, useRef } from 'react';

export interface MenuEntry {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  shortcut?: string;
}

/** A menu at a screen point (the map's right-click menu); `null` entries are separators. Closes on any outside click or Esc. */
export function ContextMenu({ x, y, title, entries, onClose }: { x: number; y: number; title?: string; entries: (MenuEntry | null)[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  // Keep it on screen.
  const rows = entries.length;
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - rows * 28 - 40);
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="ctx-title muted small">{title}</div>}
      {entries.map((e, i) =>
        e ? (
          <button
            key={i}
            className="ctx-item"
            role="menuitem"
            disabled={e.disabled}
            onClick={() => {
              onClose();
              e.onClick();
            }}
          >
            <span>{e.label}</span>
            {e.shortcut && <kbd>{e.shortcut}</kbd>}
          </button>
        ) : (
          <div key={i} className="ctx-sep" />
        ),
      )}
    </div>
  );
}
