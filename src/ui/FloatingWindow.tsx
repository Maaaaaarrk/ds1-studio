import { useEffect, useRef, useState, type ReactNode } from 'react';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  title: ReactNode;
  /** Remembers position and size on this computer under this key. */
  storageKey: string;
  initial: Box;
  minW?: number;
  minH?: number;
  onClose: () => void;
  children: ReactNode;
}

function load(key: string, fallback: Box): Box {
  try {
    const v = JSON.parse(localStorage.getItem(`ds1studio.win.${key}`) ?? 'null') as Box | null;
    if (v && [v.x, v.y, v.w, v.h].every(Number.isFinite)) return v;
  } catch {
    // per-viewer convenience only
  }
  return fallback;
}

/** Keeps a window reachable: at least its title bar stays on screen. */
function clampToScreen(b: Box): Box {
  const w = Math.min(b.w, window.innerWidth);
  const h = Math.min(b.h, window.innerHeight);
  return { w, h, x: Math.min(Math.max(b.x, 40 - w), window.innerWidth - 40), y: Math.min(Math.max(b.y, 0), window.innerHeight - 32) };
}

/** A panel floating above everything: drag it by its title bar, resize it from any edge or corner. */
export function FloatingWindow({ title, storageKey, initial, minW = 220, minH = 160, onClose, children }: Props) {
  const [box, setBox] = useState<Box>(() => clampToScreen(load(storageKey, initial)));
  const drag = useRef<{ edge: Edge | 'move'; px: number; py: number; start: Box } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(`ds1studio.win.${storageKey}`, JSON.stringify(box));
    } catch {
      // ignore
    }
  }, [box, storageKey]);

  const begin = (edge: Edge | 'move') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { edge, px: e.clientX, py: e.clientY, start: box };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    const s = d.start;
    if (d.edge === 'move') return setBox(clampToScreen({ ...s, x: s.x + dx, y: s.y + dy }));
    let { x, y, w, h } = s;
    if (d.edge.includes('e')) w = Math.max(minW, s.w + dx);
    if (d.edge.includes('s')) h = Math.max(minH, s.h + dy);
    if (d.edge.includes('w')) {
      w = Math.max(minW, s.w - dx);
      x = s.x + s.w - w;
    }
    if (d.edge.includes('n')) {
      h = Math.max(minH, s.h - dy);
      y = s.y + s.h - h;
    }
    setBox({ x, y, w, h });
  };
  const end = () => {
    drag.current = null;
  };

  return (
    <div className="fw" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <div className="fw-title" onPointerDown={begin('move')} onDoubleClick={() => setBox(clampToScreen(initial))} title="Drag to move · double-click to reset">
        <span className="fw-title-text">{title}</span>
        <button className="icon-btn" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <div className="fw-body">{children}</div>
      {EDGES.map((edge) => (
        <div key={edge} className={`fw-handle fw-${edge}`} onPointerDown={begin(edge)} />
      ))}
    </div>
  );
}
