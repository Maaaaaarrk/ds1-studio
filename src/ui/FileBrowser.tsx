import { useMemo, useState } from 'react';

interface Props {
  files: string[]; // original-case paths under data/global/tiles/
  current: string | null;
  loading: string | null;
  onOpen: (path: string) => void;
}

const PREFIX = 'data/global/tiles/';

/** Folder-grouped, filterable list of every DS1 known to the file system. */
export function FileBrowser({ files, current, loading, onOpen }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, string[]>();
    for (const f of files) {
      const rel = f.slice(PREFIX.length);
      if (q && !rel.toLowerCase().includes(q)) continue;
      const slash = rel.lastIndexOf('/');
      const dir = slash >= 0 ? rel.slice(0, slash) : '(root)';
      let list = map.get(dir);
      if (!list) map.set(dir, (list = []));
      list.push(f);
    }
    return [...map].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [files, query]);

  const toggle = (dir: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const filtering = query.trim().length > 0;

  return (
    <div className="browser">
      <div className="panel-header">
        <span>Presets</span>
        <span className="muted small">{files.length.toLocaleString()}</span>
      </div>
      <input className="search" placeholder="Filter… (e.g. act1/town)" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="browser-list">
        {groups.map(([dir, list]) => {
          const open = filtering || !collapsed.has(dir);
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
