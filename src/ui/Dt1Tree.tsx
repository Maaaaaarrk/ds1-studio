import { useMemo, useState } from 'react';
import { normalizePath } from '../vfs/vfs';

interface Folder {
  name: string;
  key: string;
  folders: Map<string, Folder>;
  files: string[];
}

const TILES = /^data\/global\/tiles\//i;

function buildTree(paths: string[]): Folder {
  const root: Folder = { name: '', key: '', folders: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.replace(TILES, '').split('/');
    let f = root;
    for (const part of parts.slice(0, -1)) {
      const k = part.toLowerCase();
      let next = f.folders.get(k);
      if (!next) f.folders.set(k, (next = { name: part, key: `${f.key}/${k}`, folders: new Map(), files: [] }));
      f = next;
    }
    f.files.push(p);
  }
  return root;
}

function count(f: Folder): number {
  let n = f.files.length;
  for (const c of f.folders.values()) n += count(c);
  return n;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const fileName = (p: string) => p.split('/').pop()!;

interface Props {
  /** Every DT1 available (game + mods). */
  all: string[];
  /** The DT1s the open map loads (listed first). */
  inMap: string[];
  /** Libraries picked in a chooser (marked in the tree). */
  chosen?: string[];
  selected: string;
  onSelect: (path: string) => void;
}

/** Tile libraries as a tree: the map's own first, then every DT1 by folder (collapsible), with a search box. */
export function Dt1Tree({ all, inMap, chosen = [], selected, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => {
    // Start with the selected library's folders open.
    const s = new Set<string>();
    const parts = selected.replace(TILES, '').toLowerCase().split('/').slice(0, -1);
    parts.forEach((_, i) => s.add(`/${parts.slice(0, i + 1).join('/')}`));
    return s;
  });
  const q = query.trim().toLowerCase();
  const tree = useMemo(() => buildTree(all.filter((p) => !q || p.replace(TILES, '').toLowerCase().includes(q))), [all, q]);
  const inMapSet = useMemo(() => new Set(inMap.map(normalizePath)), [inMap]);
  const chosenSet = useMemo(() => new Set(chosen.map(normalizePath)), [chosen]);
  const sel = normalizePath(selected);

  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const file = (p: string, label = fileName(p)) => (
    <button key={p} className={`dtt-file${normalizePath(p) === sel ? ' active' : ''}`} onClick={() => onSelect(p)} title={p.replace(TILES, '')}>
      {label}
      {inMapSet.has(normalizePath(p)) && <span className="dtt-badge" title="Loaded by this map">map</span>}
      {chosenSet.has(normalizePath(p)) && <span className="dtt-badge chosen" title="Chosen to add">chosen</span>}
    </button>
  );

  const renderFolder = (f: Folder, depth: number) => {
    // While searching every matching folder is open.
    const isOpen = !!q || open.has(f.key);
    return (
      <div key={f.key} className="dtt-folder">
        <button className="dtt-folder-row" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => toggle(f.key)}>
          <span className="dtt-caret">{isOpen ? '▾' : '▸'}</span>
          {f.name}
          <span className="dtt-count">{count(f)}</span>
        </button>
        {isOpen && (
          <div>
            {[...f.folders.values()].sort((a, b) => byName(a.name, b.name)).map((c) => renderFolder(c, depth + 1))}
            <div style={{ paddingLeft: 18 + depth * 12 }}>{[...f.files].sort((a, b) => byName(fileName(a), fileName(b))).map((p) => file(p))}</div>
          </div>
        )}
      </div>
    );
  };

  const folders = [...tree.folders.values()].sort((a, b) => byName(a.name, b.name));
  const mapLibs = inMap.filter((p) => !q || p.replace(TILES, '').toLowerCase().includes(q));
  return (
    <div className="dtt">
      <input className="search small-input" placeholder="Search tile libraries…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="dtt-scroll">
        {mapLibs.length > 0 && (
          <>
            <div className="dtt-section">In this map</div>
            {mapLibs.map((p) => file(p, p.replace(TILES, '')))}
          </>
        )}
        <div className="dtt-section">
          All tile libraries <span className="dtt-count">{count(tree)}</span>
          {!q && (
            <button className="link small" onClick={() => setOpen(open.size ? new Set() : new Set(allKeys(tree)))}>
              {open.size ? 'collapse all' : 'expand all'}
            </button>
          )}
        </div>
        {folders.map((f) => renderFolder(f, 0))}
        {tree.files.map((p) => file(p))}
        {!folders.length && !tree.files.length && <p className="muted small">No tile libraries match.</p>}
      </div>
    </div>
  );
}

function allKeys(f: Folder): string[] {
  return [...f.folders.values()].flatMap((c) => [c.key, ...allKeys(c)]);
}
