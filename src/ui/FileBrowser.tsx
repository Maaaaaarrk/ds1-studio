import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ContextMenu } from './ContextMenu';

interface Props {
  /** A button that folds the list away, shown first in its header. */
  collapse?: ReactNode;
  files: string[]; // original-case paths under data/global/tiles/
  current: string | null;
  loading: string | null;
  onOpen: (path: string) => void;
  onDelete?: (path: string) => void;
}

const PREFIX = 'data/global/tiles/';

const PINS_KEY = 'ds1studio.pinnedMaps';

/** Pinned maps (game paths, lower case), remembered on this computer: a shortcut list, the files stay where they are. */
function loadPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const dirOf = (f: string) => {
  const rel = f.slice(PREFIX.length);
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(0, slash) : '(root)';
};

/** Folder-grouped, filterable list of every DS1 known to the file system. Folders start collapsed. */
export function FileBrowser({ files, current, loading, onOpen, onDelete, collapse }: Props) {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pins, setPins] = useState<string[]>(loadPins);
  const [pinsOpen, setPinsOpen] = useState(true);
  const isPinned = (f: string) => pins.includes(f.toLowerCase());
  const setPinned = (f: string, on: boolean) =>
    setPins((p) => {
      const k = f.toLowerCase();
      const next = on ? (p.includes(k) ? p : [...p, k]) : p.filter((x) => x !== k);
      try {
        localStorage.setItem(PINS_KEY, JSON.stringify(next));
      } catch {
        // per-computer convenience only
      }
      return next;
    });
  // The pinned maps that exist, in the order they were pinned (and matching the filter).
  const pinned = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byKey = new Map(files.map((f) => [f.toLowerCase(), f]));
    return pins.map((k) => byKey.get(k)).filter((f): f is string => !!f && (!q || f.slice(PREFIX.length).toLowerCase().includes(q)));
  }, [pins, files, query]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, string[]>();
    for (const f of files) {
      if (q && !f.slice(PREFIX.length).toLowerCase().includes(q)) continue;
      const dir = dirOf(f);
      let list = map.get(dir);
      if (!list) map.set(dir, (list = []));
      list.push(f);
    }
    return [...map].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [files, query]);

  // Keep the open map's folder visible.
  useEffect(() => {
    if (current) setExpanded((s) => (s.has(dirOf(current)) ? s : new Set(s).add(dirOf(current))));
  }, [current]);

  const toggle = (dir: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const filtering = query.trim().length > 0;
  const allOpen = groups.length > 0 && groups.every(([d]) => expanded.has(d));

  return (
    <div className="browser">
      <div className="panel-header static">
        <span className="browser-title">
          {collapse}
          Presets
        </span>
        <span className="browser-tools">
          <span className="muted small">{files.length.toLocaleString()}</span>
          <button
            className="icon-btn"
            title={allOpen ? 'Collapse all folders' : 'Expand all folders'}
            onClick={() => setExpanded(allOpen ? new Set() : new Set(groups.map(([d]) => d)))}
          >
            {allOpen ? '⊟' : '⊞'}
          </button>
        </span>
      </div>
      <input className="search" placeholder="Filter… (e.g. act1/town)" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="browser-list">
        {pinned.length > 0 && (
          <div className="browser-group browser-pinned">
            <button className="browser-dir" onClick={() => setPinsOpen(!pinsOpen)} title="Maps you pinned (right-click a map to pin or unpin it). They stay in their folders too.">
              <span className="chev">{pinsOpen ? '▾' : '▸'}</span>
              <span className="browser-dir-name">📌 Pinned</span>
              <span className="muted small">{pinned.length}</span>
            </button>
            {pinsOpen &&
              pinned.map((f) => (
                <button
                  key={`pin:${f}`}
                  className={`browser-file${f === current ? ' active' : ''}${f === loading ? ' loading' : ''}`}
                  onClick={() => onOpen(f)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ path: f, x: e.clientX, y: e.clientY }); }}
                  title={f}
                >
                  {f.slice(f.lastIndexOf('/') + 1)} <span className="muted small">{dirOf(f)}</span>
                </button>
              ))}
          </div>
        )}
        {groups.map(([dir, list]) => {
          const open = filtering || expanded.has(dir);
          return (
            <div key={dir} className="browser-group">
              <button className="browser-dir" onClick={() => toggle(dir)}>
                <span className="chev">{open ? '▾' : '▸'}</span>
                <span className="browser-dir-name">{dir}</span>
                <span className="muted small">{list.length}</span>
              </button>
              {open &&
                list.map((f) => (
                  <button
                    key={f}
                    className={`browser-file${f === current ? ' active' : ''}${f === loading ? ' loading' : ''}`}
                    onClick={() => onOpen(f)}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ path: f, x: e.clientX, y: e.clientY }); }}
                    title={f}
                  >
                    {f.slice(f.lastIndexOf('/') + 1)}
                    {isPinned(f) && <span className="browser-pin" title="Pinned">📌</span>}
                  </button>
                ))}
            </div>
          );
        })}
        {groups.length === 0 && <div className="muted small pad">No matches.</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.path.split('/').pop()} onClose={() => setMenu(null)}
        entries={[{ label: 'Open map', onClick: () => onOpen(menu.path) },
          isPinned(menu.path)
            ? { label: 'Unpin', title: 'Take it off the Pinned list (the file stays where it is)', onClick: () => setPinned(menu.path, false) }
            : { label: 'Pin to the top', title: 'Show it in the Pinned list at the top for quick access (the file stays where it is)', onClick: () => setPinned(menu.path, true) },
          null,
          { label: 'Delete DS1…', disabled: !onDelete, title: 'Remove the loose file and keep a recoverable backup.', onClick: () => onDelete?.(menu.path) }]} />}
    </div>
  );
}
