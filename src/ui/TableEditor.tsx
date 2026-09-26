import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { appendRow, cloneRow, deleteRow, setCell } from '../formats/txtTable';
import type { TxtTableDoc } from '../formats/txtTable';
import './tableEditor.css';

export interface TableEditorProps {
  title: string;
  doc: TxtTableDoc;
  onChange(doc: TxtTableDoc): void;
  onSave(): void;
  dirty: boolean;
  /** Data-row index (0-based, excluding the header) to reveal and select. */
  highlightRow?: number;
}

const ROW_H = 24;
const HEADER_H = 28;
const IDX_W = 56;
const CHAR_W = 7;
const OVERSCAN_ROWS = 6;
const OVERSCAN_PX = 200;

interface Pos { r: number; c: number }
interface Editing extends Pos { value: string }

/** Rough per-column pixel widths from the header and a sample of rows. */
function measureColumns(doc: TxtTableDoc): number[] {
  const n = doc.columns.length;
  const chars = doc.columns.map((c) => Math.max(c.length, 3));
  const step = Math.max(1, Math.floor(doc.rows.length / 300));
  for (let i = 0; i < doc.rows.length; i += step) {
    const row = doc.rows[i];
    for (let c = 0; c < n && c < row.length; c++) if (row[c].length > chars[c]) chars[c] = row[c].length;
  }
  return chars.map((len, c) => Math.min(c === 0 ? 240 : 260, Math.max(c === 0 ? 120 : 48, len * CHAR_W + 18)));
}

export function TableEditor({ title, doc, onChange, onSave, dirty, highlightRow }: TableEditorProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 600 });
  const [colQuery, setColQuery] = useState('');
  const [rowQuery, setRowQuery] = useState('');
  const [sel, setSel] = useState<Pos | null>(null);
  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const setEditing = (e: Editing | null) => {
    editingRef.current = e;
    setEditingState(e);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const widths = useMemo(() => measureColumns(doc), [doc.columns]);
  const nameW = widths[0] ?? 120;
  const stickyW = IDX_W + nameW;

  /** Non-sticky columns shown, after the column filter (column 0 is always the sticky name column). */
  const displayCols = useMemo(() => {
    const q = colQuery.trim().toLowerCase();
    const out: number[] = [];
    for (let c = 1; c < doc.columns.length; c++) if (!q || doc.columns[c].toLowerCase().includes(q)) out.push(c);
    return out;
  }, [doc.columns, colQuery]);

  const offsets = useMemo(() => {
    const out = new Array<number>(displayCols.length + 1);
    out[0] = 0;
    for (let k = 0; k < displayCols.length; k++) out[k + 1] = out[k] + widths[displayCols[k]];
    return out;
  }, [displayCols, widths]);
  const scrollW = offsets[displayCols.length];
  const totalW = stickyW + scrollW;

  /** Row indices shown, after the row search. */
  const visibleRows = useMemo(() => {
    const q = rowQuery.trim().toLowerCase();
    const out: number[] = [];
    for (let r = 0; r < doc.rows.length; r++) if (!q || doc.rows[r].join('\t').toLowerCase().includes(q)) out.push(r);
    return out;
  }, [doc.rows, rowQuery]);

  const navCols = useMemo(() => [0, ...displayCols], [displayCols]);

  // Track viewport size.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () =>
      setView((v) => ({ ...v, top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight }));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setView((v) => (v.top === el.scrollTop && v.left === el.scrollLeft ? v : { ...v, top: el.scrollTop, left: el.scrollLeft }));
  };

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });

  /** Scroll so that the given cell is fully visible below the header and right of the sticky columns. */
  const reveal = useCallback(
    (p: Pos) => {
      const el = scrollRef.current;
      if (!el) return;
      const rp = visibleRows.indexOf(p.r);
      if (rp >= 0) {
        const bodyH = el.clientHeight - HEADER_H;
        if (rp * ROW_H < el.scrollTop) el.scrollTop = rp * ROW_H;
        else if ((rp + 1) * ROW_H > el.scrollTop + bodyH) el.scrollTop = (rp + 1) * ROW_H - bodyH;
      }
      const k = displayCols.indexOf(p.c);
      if (k >= 0) {
        const bodyW = el.clientWidth - stickyW;
        const x0 = offsets[k];
        const x1 = offsets[k + 1];
        if (x0 < el.scrollLeft) el.scrollLeft = x0;
        else if (x1 > el.scrollLeft + bodyW) el.scrollLeft = x1 - bodyW;
      }
    },
    [visibleRows, displayCols, offsets, stickyW],
  );

  // Reveal and select an externally requested row (once per new highlightRow value).
  const handledHighlight = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (highlightRow === handledHighlight.current) return;
    if (highlightRow === undefined || highlightRow < 0 || highlightRow >= doc.rows.length) {
      handledHighlight.current = highlightRow;
      return;
    }
    if (!visibleRows.includes(highlightRow)) {
      setRowQuery('');
      return; // re-runs once the search is cleared
    }
    handledHighlight.current = highlightRow;
    const p = { r: highlightRow, c: sel?.c ?? 0 };
    setSel(p);
    reveal(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRow, visibleRows]);

  const pendingReveal = useRef<Pos | null>(null);

  const select = (p: Pos) => {
    setSel(p);
    reveal(p);
  };

  const startEdit = (p: Pos, initial?: string) => {
    setSel(p);
    reveal(p);
    setEditing({ ...p, value: initial ?? doc.rows[p.r]?.[p.c] ?? '' });
  };

  /** Commits the in-progress edit (if any); returns true if there was one. */
  const commit = (): boolean => {
    const e = editingRef.current;
    if (!e) return false;
    setEditing(null);
    if (e.r < doc.rows.length) {
      const next = setCell(doc, e.r, e.c, e.value);
      if (next !== doc) onChange(next);
    }
    return true;
  };

  const cancel = () => setEditing(null);

  /** Moves the selection by whole rows/columns within the filtered view. */
  const move = (dr: number, dc: number, from: Pos | null = sel) => {
    if (!visibleRows.length) return;
    const base = from ?? { r: visibleRows[0], c: 0 };
    let rp = visibleRows.indexOf(base.r);
    let cp = navCols.indexOf(base.c);
    if (rp < 0) rp = 0;
    if (cp < 0) cp = 0;
    rp = Math.max(0, Math.min(visibleRows.length - 1, rp + dr));
    cp = Math.max(0, Math.min(navCols.length - 1, cp + dc));
    select({ r: visibleRows[rp], c: navCols[cp] });
  };

  const pageRows = Math.max(1, Math.floor((view.h - HEADER_H) / ROW_H) - 1);

  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.target !== e.currentTarget) return; // keys inside the cell input are handled there
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (dirty) onSave();
      return;
    }
    let handled = true;
    switch (e.key) {
      case 'ArrowUp': move(mod ? -Infinity : -1, 0); break;
      case 'ArrowDown': move(mod ? Infinity : 1, 0); break;
      case 'ArrowLeft': move(0, mod ? -Infinity : -1); break;
      case 'ArrowRight': move(0, mod ? Infinity : 1); break;
      case 'PageUp': move(-pageRows, 0); break;
      case 'PageDown': move(pageRows, 0); break;
      case 'Home': move(mod ? -Infinity : 0, -Infinity); break;
      case 'End': move(mod ? Infinity : 0, Infinity); break;
      case 'Tab': move(0, e.shiftKey ? -1 : 1); break;
      case 'Enter':
      case 'F2':
        if (sel) startEdit(sel);
        else move(0, 0);
        break;
      case 'Delete':
      case 'Backspace':
        if (sel) {
          const next = setCell(doc, sel.r, sel.c, '');
          if (next !== doc) onChange(next);
        }
        break;
      default:
        if (sel && !mod && !e.altKey && e.key.length === 1) startEdit(sel, e.key);
        else handled = false;
    }
    if (handled) e.preventDefault();
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const cur = editingRef.current;
    if (!cur) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      focusGrid();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commit();
      move(0, e.shiftKey ? -1 : 1, cur);
      focusGrid();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      focusGrid();
    }
  };

  // Toolbar actions.
  const addRow = () => {
    commit();
    const next = appendRow(doc);
    onChange(next);
    setRowQuery('');
    const p = { r: next.rows.length - 1, c: sel?.c ?? 0 };
    setSel(p);
    pendingReveal.current = p;
  };
  const duplicateRow = () => {
    if (!sel) return;
    commit();
    onChange(cloneRow(doc, sel.r));
    const p = { r: sel.r + 1, c: sel.c };
    setSel(p);
    pendingReveal.current = p;
  };
  const removeRow = () => {
    if (!sel) return;
    commit();
    const next = deleteRow(doc, sel.r);
    onChange(next);
    setSel(next.rows.length ? { r: Math.min(sel.r, next.rows.length - 1), c: sel.c } : null);
  };

  // Reveal a row created by a toolbar action once the new doc has arrived.
  useEffect(() => {
    const p = pendingReveal.current;
    if (p && p.r < doc.rows.length) {
      pendingReveal.current = null;
      reveal(p);
      focusGrid();
    }
  }, [doc, reveal]);

  // Drop the edit / selection if the doc shrank underneath us.
  useEffect(() => {
    if (sel && sel.r >= doc.rows.length) setSel(null);
    if (editingRef.current && editingRef.current.r >= doc.rows.length) setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.rows.length]);

  // Visible window.
  const bodyH = Math.max(0, view.h - HEADER_H);
  const r0 = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN_ROWS);
  const r1 = Math.min(visibleRows.length, Math.ceil((view.top + bodyH) / ROW_H) + OVERSCAN_ROWS);
  const leftMin = view.left - OVERSCAN_PX;
  const leftMax = view.left + Math.max(0, view.w - stickyW) + OVERSCAN_PX;
  let c0 = 0;
  while (c0 < displayCols.length && offsets[c0 + 1] < leftMin) c0++;
  let c1 = c0;
  while (c1 < displayCols.length && offsets[c1] < leftMax) c1++;
  // Keep the cell being edited mounted even when scrolled away, so its input is not lost.
  const editRowPos = editing ? visibleRows.indexOf(editing.r) : -1;
  const editColPos = editing ? displayCols.indexOf(editing.c) : -1;
  if (editColPos >= 0) {
    c0 = Math.min(c0, editColPos);
    c1 = Math.max(c1, editColPos + 1);
  }
  const rowPositions: number[] = [];
  for (let p = r0; p < r1; p++) rowPositions.push(p);
  if (editRowPos >= 0 && (editRowPos < r0 || editRowPos >= r1)) rowPositions.push(editRowPos);
  const shownCols = displayCols.slice(c0, c1);
  const leftPad = offsets[c0];

  const renderCell = (r: number, c: number, width: number, extra: string, row: string[]) => {
    const isSel = sel !== null && sel.r === r && sel.c === c;
    const isEdit = editing !== null && editing.r === r && editing.c === c;
    const text = row[c];
    const missing = text === undefined;
    return (
      <div
        key={c}
        className={`te-cell${extra}${isSel ? ' sel' : ''}${missing ? ' missing' : ''}`}
        style={{ width }}
        onMouseDown={(e) => {
          if (isEdit) return;
          if (e.button === 0) {
            commit();
            setSel({ r, c });
          }
        }}
        onDoubleClick={() => !isEdit && startEdit({ r, c })}
        title={text && text.length * CHAR_W + 18 > width ? text : undefined}
      >
        {isEdit ? (
          <input
            className="te-input"
            autoFocus
            spellCheck={false}
            value={editing.value}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            onKeyDown={onInputKey}
            onBlur={() => commit()}
            onFocus={(e) => {
              const v = e.currentTarget.value;
              e.currentTarget.setSelectionRange(v.length, v.length);
            }}
          />
        ) : (
          text
        )}
      </div>
    );
  };

  const selName = sel ? doc.columns[sel.c] : '';
  const selValue = sel ? doc.rows[sel.r]?.[sel.c] : undefined;

  return (
    <div className="te" onKeyDown={(e) => e.stopPropagation()}>
      <div className="te-toolbar">
        <div className="te-title">
          <span className="te-title-name">{title}</span>
          {dirty && <span className="te-dirty" title="Unsaved changes">●</span>}
          <span className="muted small">
            {visibleRows.length === doc.rows.length ? doc.rows.length : `${visibleRows.length} / ${doc.rows.length}`} rows ·{' '}
            {displayCols.length + 1 === doc.columns.length ? doc.columns.length : `${displayCols.length + 1} / ${doc.columns.length}`} cols
          </span>
        </div>
        <input
          className="search te-search"
          placeholder="Filter columns…"
          value={colQuery}
          spellCheck={false}
          onChange={(e) => setColQuery(e.target.value)}
        />
        <input
          className="search te-search"
          placeholder="Search rows…"
          value={rowQuery}
          spellCheck={false}
          onChange={(e) => setRowQuery(e.target.value)}
        />
        <div className="te-actions">
          <button className="btn" onClick={addRow} title="Append an empty row at the end">Add row</button>
          <button className="btn" onClick={duplicateRow} disabled={!sel} title="Insert a copy below the selected row">Duplicate row</button>
          <button className="btn" onClick={removeRow} disabled={!sel} title="Delete the selected row">Delete row</button>
          <button className="btn primary" onClick={onSave} disabled={!dirty} title="Save (Ctrl+S)">Save</button>
        </div>
      </div>

      <div className="te-scroll" ref={scrollRef} tabIndex={0} onScroll={onScroll} onKeyDown={onGridKey}>
        <div className="te-inner" style={{ width: totalW, height: HEADER_H + visibleRows.length * ROW_H }}>
          <div className="te-head" style={{ width: totalW, height: HEADER_H }}>
            <div className="te-cell te-idx te-hcell">#</div>
            <div className="te-cell te-name te-hcell" style={{ width: nameW }} title={doc.columns[0]}>
              {doc.columns[0] || <em className="muted">(blank)</em>}
            </div>
            <div className="te-pad" style={{ width: leftPad }} />
            {shownCols.map((c) => (
              <div
                key={c}
                className={`te-cell te-hcell${sel?.c === c ? ' active' : ''}`}
                style={{ width: widths[c] }}
                title={`${doc.columns[c] || '(blank)'} — column ${c}`}
              >
                {doc.columns[c] || <em className="muted">(blank)</em>}
              </div>
            ))}
          </div>
          <div className="te-body" style={{ height: visibleRows.length * ROW_H }}>
            {rowPositions.map((p) => {
              const r = visibleRows[p];
              const row = doc.rows[r];
              const rowSel = sel?.r === r;
              return (
                <div
                  key={r}
                  className={`te-row${p % 2 ? ' odd' : ''}${rowSel ? ' sel-row' : ''}${highlightRow === r ? ' hl' : ''}`}
                  style={{ top: p * ROW_H, width: totalW, height: ROW_H }}
                >
                  <div className="te-cell te-idx" onMouseDown={() => { commit(); setSel({ r, c: sel?.c ?? 0 }); }}>{r}</div>
                  {renderCell(r, 0, nameW, ' te-name', row)}
                  <div className="te-pad" style={{ width: leftPad }} />
                  {shownCols.map((c) => renderCell(r, c, widths[c], '', row))}
                </div>
              );
            })}
          </div>
          {visibleRows.length === 0 && <div className="te-empty muted">{doc.rows.length ? 'No rows match the search.' : 'Table has no rows.'}</div>}
        </div>
      </div>

      <div className="te-status small">
        {sel ? (
          <>
            <span className="muted">row</span> {sel.r} <span className="muted">·</span> {selName || <em className="muted">(blank)</em>}
            <span className="muted"> ·</span>{' '}
            <span className="te-status-value">{selValue === undefined ? <em className="muted">(missing cell)</em> : selValue}</span>
          </>
        ) : (
          <span className="muted">Click a cell to select · Enter / double-click to edit · Tab moves right · Esc cancels</span>
        )}
      </div>
    </div>
  );
}
