import { useEffect, useRef, useState } from 'react';

/** A size (px) remembered on this computer. */
export function usePersistentSize(key: string, initial: number, min: number, max: number): [number, (v: number) => void] {
  const [size, setSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem(`ds1studio.size.${key}`));
      return v ? Math.min(max, Math.max(min, v)) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`ds1studio.size.${key}`, String(size));
    } catch {
      // per-viewer convenience only
    }
  }, [key, size]);
  return [size, (v: number) => setSize(Math.round(Math.min(max, Math.max(min, v))))];
}

interface Props {
  /** Which way dragging changes the size: 'x' for widths, 'y' for heights. */
  axis: 'x' | 'y';
  /** +1 if dragging right/down grows the size, -1 if it shrinks it. */
  direction: 1 | -1;
  size: number;
  onResize: (size: number) => void;
  className?: string;
  title?: string;
}

/** A drag handle that resizes a pane. Double-click resets nothing; sizes are clamped by the owner. */
export function Splitter({ axis, direction, size, onResize, className, title }: Props) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  return (
    <div
      className={`splitter ${axis === 'x' ? 'splitter-x' : 'splitter-y'} ${className ?? ''}`}
      title={title ?? 'Drag to resize'}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { pos: axis === 'x' ? e.clientX : e.clientY, size };
        document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const pos = axis === 'x' ? e.clientX : e.clientY;
        onResize(start.current.size + direction * (pos - start.current.pos));
      }}
      onPointerUp={(e) => {
        start.current = null;
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        document.body.classList.remove('resizing-x', 'resizing-y');
      }}
    />
  );
}
