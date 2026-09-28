import { useEffect, useMemo, useState, type ReactNode } from 'react';

interface Props {
  /** A button that folds the list away, shown first in its header. */
  collapse?: ReactNode;
  files: string[]; // original-case paths under data/global/tiles/
  current: string | null;
  loading: string | null;
  onOpen: (path: string) => void;
}

const PREFIX = 'data/global/tiles/';

const dirOf = (f: string) => {
  const rel = f.slice(PREFIX.length);
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(0, slash) : '(root)';
};

/** Folder-grouped, filterable list of every DS1 known to the file system. Folders start collapsed. */
export function FileBrowser({ files, current, loading, onOpen, collapse }: Props) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

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
                    title={f}
                  >
                    {f.slice(f.lastIndexOf('/') + 1)}
                  </button>
                ))}
            </div>
          );
        })}
        {groups.length === 0 && <div className="muted small pad">No matches.</div>}
      </div>
    </div>
  );
}
