import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { columnHelp } from '../data/columnHelp';

/** A small "?" that explains something on hover (or keyboard focus). The popup floats above everything. */
export function HelpTip({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.min(r.left, window.innerWidth - 340), y: r.bottom + 6 });
  };
  return (
    <span
      ref={ref}
      className="help-tip"
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
      onClick={(e) => e.stopPropagation()}
    >
      ?
      {pos &&
        createPortal(
          <span className="help-pop" style={{ left: pos.x, top: pos.y }}>
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** "?" for a .txt column, e.g. <ColHelp table="LvlPrest" col="Dt1Mask" />; renders nothing when there is no help. */
export function ColHelp({ table, col }: { table: string; col: string }) {
  const text = columnHelp(table, col);
  return text ? <HelpTip text={`${table}.txt · ${col}: ${text}`} /> : null;
}
