import { useState, type ReactNode } from 'react';

export interface RibbonButton {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  active?: boolean;
  /** Large buttons show the icon above the label; small ones sit in a compact column. */
  size?: 'lg' | 'sm';
  /** Keyboard shortcut shown in the tooltip. */
  shortcut?: string;
}

export interface RibbonGroup {
  label: string;
  items: (RibbonButton | { custom: ReactNode })[];
}

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
}

interface Props {
  tabs: RibbonTab[];
  /** Left of the tabs (app name). */
  brand: ReactNode;
  /** Right of the tabs (current file). */
  right?: ReactNode;
}

function Button({ b }: { b: RibbonButton }) {
  const tip = [b.title ?? b.label, b.shortcut && `(${b.shortcut})`].filter(Boolean).join(' ');
  return (
    <button className={`rb-btn ${b.size ?? 'lg'}${b.active ? ' active' : ''}`} onClick={b.onClick} disabled={b.disabled} title={tip}>
      <span className="rb-icon">{b.icon}</span>
      <span className="rb-label">{b.label}</span>
    </button>
  );
}

/** Office-style ribbon: tabs of labelled command groups. */
export function Ribbon({ tabs, brand, right }: Props) {
  const [active, setActive] = useState(tabs[0]?.id);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <header className="ribbon">
      <div className="rb-tabs">
        <div className="brand">{brand}</div>
        {tabs.map((t) => (
          <button key={t.id} className={`rb-tab${t.id === tab?.id ? ' active' : ''}`} onClick={() => setActive(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="rb-right">{right}</div>
      </div>
      <div className="rb-body">
        {tab?.groups.map((g) => {
          // Consecutive small buttons stack in columns of three.
          const cells: ReactNode[] = [];
          let stack: RibbonButton[] = [];
          const flush = () => {
            if (!stack.length) return;
            cells.push(
              <div key={`s${cells.length}`} className="rb-stack">
                {stack.map((b) => (
                  <Button key={b.label} b={b} />
                ))}
              </div>,
            );
            stack = [];
          };
          for (const item of g.items) {
            if ('custom' in item) {
              flush();
              cells.push(
                <div key={`c${cells.length}`} className="rb-custom">
                  {item.custom}
                </div>,
              );
            } else if (item.size === 'sm') {
              stack.push(item);
              if (stack.length === 3) flush();
            } else {
              flush();
              cells.push(<Button key={item.label} b={item} />);
            }
          }
          flush();
          return (
            <div key={g.label} className="rb-group">
              <div className="rb-items">{cells}</div>
              <div className="rb-group-label">{g.label}</div>
            </div>
          );
        })}
      </div>
    </header>
  );
}
