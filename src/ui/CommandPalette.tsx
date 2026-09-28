import { useEffect, useMemo, useRef, useState } from 'react';
import type { RibbonTab } from './Ribbon';

/** A command the palette can run: every ribbon button and menu item, named by where it lives. */
export interface Command {
  label: string;
  /** Tab › group (› menu). */
  where: string;
  run: () => void;
  disabled?: boolean;
  shortcut?: string;
}

/** Every command of the ribbon, in ribbon order (menus flattened, pure display widgets left out). */
export function ribbonCommands(tabs: RibbonTab[]): Command[] {
  const out: Command[] = [];
  for (const t of tabs)
    for (const g of t.groups)
      for (const item of g.items) {
        if ('custom' in item) continue;
        const where = `${t.label} › ${g.label}`;
        if (item.menu) {
          for (const m of item.menu) out.push({ label: m.label.replace(/^[☐☑]\s*/, ''), where: `${where} › ${item.label}`, run: m.onClick, disabled: item.disabled });
        } else out.push({ label: item.label, where, run: item.onClick, disabled: item.disabled, shortcut: item.shortcut });
      }
  return out;
}

/** How well `c` matches `q` (0 = not at all): every word must appear; words at the start of the label count most. */
function score(c: Command, q: string): number {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const label = c.label.toLowerCase();
  const all = `${label} ${c.where.toLowerCase()}`;
  let s = 1;
  for (const w of words) {
    const i = all.indexOf(w);
    if (i < 0) return 0;
    s += label.startsWith(w) ? 4 : label.includes(w) ? 2 : 1;
  }
  return s;
}

/** Ctrl+K: type any command's name and run it. */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(
    () =>
      commands
        .map((c, order) => ({ c, s: score(c, query), order }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.order - b.order)
        .slice(0, 60)
        .map((x) => x.c),
    [commands, query],
  );
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.cp-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  const run = (c: Command | undefined) => {
    if (!c || c.disabled) return;
    onClose();
    c.run();
  };
  return (
    <div className="modal-backdrop cp-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cp" role="dialog" aria-label="Commands">
        <input
          autoFocus
          className="cp-input"
          placeholder="Type a command… (e.g. roof, export, walkability)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') run(shown[index]);
          }}
        />
        <div className="cp-list" ref={list}>
          {shown.map((c, i) => (
            <button key={`${c.where}|${c.label}`} className={`cp-item${i === index ? ' active' : ''}`} disabled={c.disabled} onMouseEnter={() => setIndex(i)} onClick={() => run(c)}>
              <span className="cp-label">{c.label}</span>
              <span className="cp-where muted small">{c.where}</span>
              {c.shortcut && <kbd>{c.shortcut}</kbd>}
            </button>
          ))}
          {!shown.length && <div className="muted small cp-empty">No command matches.</div>}
        </div>
        <div className="cp-foot muted small">↑↓ to choose · Enter to run · Esc to close</div>
      </div>
    </div>
  );
}
