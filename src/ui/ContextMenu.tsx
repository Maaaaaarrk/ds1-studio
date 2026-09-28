import { useEffect, useRef, useState } from 'react';

export interface MenuEntry {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  shortcut?: string;
  /** A submenu: clicking the entry shows these instead (with a way back). */
  children?: (MenuEntry | null)[];
  /** Shown on hover. */
  title?: string;
}

/** A menu at a screen point (the map's right-click menu); `null` entries are separators. Closes on any outside click or Esc. */
export function ContextMenu({ x, y, title, entries, onClose }: { x: number; y: number; title?: string; entries: (MenuEntry | null)[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<MenuEntry | null>(null);
  const shown: (MenuEntry | null)[] = sub ? [{ label: '← Back', onClick: () => setSub(null) }, null, ...(sub.children ?? [])] : entries;
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
  const rows = shown.length;
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - rows * 28 - 40);
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {(sub ? sub.label : title) && <div className="ctx-title muted small">{sub ? sub.label : title}</div>}
      {shown.map((e, i) =>
        e ? (
          <button
            key={`${sub?.label ?? ''}${i}`}
            className="ctx-item"
            role="menuitem"
            disabled={e.disabled}
            title={e.title}
            onClick={() => {
              if (e.children) return setSub(e);
              if (e.label === '← Back' && sub) return e.onClick?.();
              onClose();
              e.onClick?.();
            }}
          >
            <span>{e.label}</span>
            {e.children ? <span className="muted">▸</span> : e.shortcut && <kbd>{e.shortcut}</kbd>}
          </button>
        ) : (
          <div key={i} className="ctx-sep" />
        ),
      )}
    </div>
  );
}
