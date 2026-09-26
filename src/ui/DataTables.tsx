import { useEffect, useMemo, useState } from 'react';
import { colIndex, findRows, parseTxtTable, serializeTxtTable, type TxtTableDoc } from '../formats/txtTable';
import type { LayeredFs } from '../vfs/vfs';
import { TableEditor } from './TableEditor';

/** The tables map makers touch most, listed first. */
const FAVOURITES = ['LvlPrest', 'LvlTypes', 'Levels', 'LvlWarp', 'LvlMaze', 'LvlSub', 'Objects', 'ObjGroup', 'MonPreset', 'SuperUniques', 'CubeMain', 'Misc'];

export interface TableTarget {
  table: string;
  /** Value to find in the table's first column (or its Name/Id column) to highlight. */
  key?: string;
}

interface Props {
  fs: LayeredFs;
  initial?: TableTarget | null;
  canSave: boolean;
  /** Writes the table (game path + bytes); resolves with a message. */
  onSave: (path: string, bytes: Uint8Array) => Promise<string>;
  onClose: () => void;
}

const nameOf = (path: string) => path.split('/').pop()!.replace(/\.txt$/i, '');

/** Browse and edit the game's .txt tables inside the studio. */
export function DataTables({ fs, initial, canSave, onSave, onClose }: Props) {
  const tables = useMemo(() => {
    const all = fs.list((p) => p.startsWith('data/global/excel/') && p.endsWith('.txt') && !p.slice(18).includes('/'));
    const rank = (p: string) => {
      const i = FAVOURITES.findIndex((f) => f.toLowerCase() === nameOf(p).toLowerCase());
      return i < 0 ? 100 : i;
    };
    return all.sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b)));
  }, [fs]);
  const [filter, setFilter] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [doc, setDoc] = useState<TxtTableDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [highlight, setHighlight] = useState<number | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);

  const open = async (p: string, key?: string) => {
    if (dirty && !window.confirm(`Discard unsaved changes to ${nameOf(path!)}?`)) return;
    const bytes = await fs.read(p);
    if (!bytes) return;
    const d = parseTxtTable(bytes);
    setPath(p);
    setDoc(d);
    setDirty(false);
    setStatus(`${fs.locate(p) ?? ''}`);
    if (key) {
      const col = ['Name', 'Id', 'LevelName', 'description', 'name'].map((c) => colIndex(d, c)).find((i) => i >= 0) ?? 0;
      setHighlight(findRows(d, col, key)[0]);
    } else setHighlight(undefined);
  };

  useEffect(() => {
    if (!initial) return;
    const p = tables.find((t) => nameOf(t).toLowerCase() === initial.table.replace(/\.txt$/i, '').toLowerCase());
    if (p) void open(p, initial.key);
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!path || !doc) return;
    try {
      setStatus(await onSave(path, serializeTxtTable(doc)));
      setDirty(false);
    } catch (e) {
      setStatus(`Save failed: ${(e as Error).message}`);
    }
  };

  const close = () => {
    if (dirty && !window.confirm('Discard unsaved table changes?')) return;
    onClose();
  };

  const shown = tables.filter((t) => !filter || nameOf(t).toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="modal-backdrop">
      <div className="modal data-tables" role="dialog" aria-label="Data tables">
        <div className="dt-head">
          <div className="modal-title">Data tables</div>
          <span className="muted small">{status}</span>
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
        <div className="dt-body">
          <div className="dt-list">
            <input className="search small-input" placeholder="Filter tables…" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            {shown.map((t) => (
              <button key={t} className={`browser-file${t === path ? ' active' : ''}`} onClick={() => void open(t)} title={fs.locate(t) ?? ''}>
                {nameOf(t)}
              </button>
            ))}
          </div>
          <div className="dt-editor">
            {doc && path ? (
              <TableEditor
                title={`${nameOf(path)}.txt${canSave ? '' : ' (read-only: no mod folder)'}`}
                doc={doc}
                dirty={dirty}
                highlightRow={highlight}
                onChange={(d) => {
                  setDoc(d);
                  setDirty(true);
                }}
                onSave={() => void (canSave && save())}
              />
            ) : (
              <p className="muted pad">Pick a table. Edits are saved into your mod&apos;s data/global/excel folder (the original is kept as .bak the first time).</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
