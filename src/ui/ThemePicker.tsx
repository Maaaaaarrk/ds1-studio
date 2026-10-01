// Theme gallery (built-in + your own), the accent colour, and the custom theme builder: as in PD2 Filter Forge.
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Prefs } from './prefs';
import { ACCENTS, applyTheme, BUILTIN_THEMES, DEFAULT_THEME, exportTheme, findTheme, importTheme, isDarkColor, type Theme, type ThemeColors } from './themes';

function Swatch({ t }: { t: Theme }) {
  const c = t.colors;
  return (
    <span className="theme-mini" style={{ background: c.bg, borderColor: c.line }}>
      <span className="theme-mini-rail" style={{ background: c.panel }} />
      <span className="theme-mini-body">
        <span style={{ background: c.panel, borderColor: c.line }}>
          <i style={{ background: c.text }} />
          <i style={{ background: c.text, opacity: 0.45, width: '60%' }} />
        </span>
        <b style={{ background: c.accent }} />
      </span>
    </span>
  );
}

interface Props {
  prefs: Prefs;
  onChange: (patch: Partial<Prefs>) => void;
  notify: (text: string, error?: boolean) => void;
}

export function ThemePicker({ prefs, onChange, notify }: Props) {
  const custom = prefs.customThemes ?? [];
  const [editing, setEditing] = useState<Theme | null>(null);
  const [code, setCode] = useState('');
  const pick = (t: Theme) => onChange({ theme: t.id, accent: t.colors.accent });
  const start = () => {
    const base = findTheme(prefs.theme, custom);
    setEditing({ id: `custom-${Date.now().toString(36)}`, name: 'My theme', dark: base.dark, colors: { ...base.colors, accent: prefs.accent || base.colors.accent }, custom: true });
  };
  const saveCustom = (t: Theme) => {
    const next = custom.some((x) => x.id === t.id) ? custom.map((x) => (x.id === t.id ? t : x)) : [...custom, t];
    onChange({ customThemes: next, theme: t.id, accent: t.colors.accent });
    setEditing(null);
  };
  const remove = (t: Theme) => {
    const fallback = findTheme(DEFAULT_THEME, []);
    onChange({ customThemes: custom.filter((x) => x.id !== t.id), ...(prefs.theme === t.id ? { theme: fallback.id, accent: fallback.colors.accent } : {}) });
  };
  return (
    <div className="theme-picker">
      <div className="theme-grid">
        {[...BUILTIN_THEMES, ...custom].map((t) => (
          <div key={t.id} className={`theme-card${prefs.theme === t.id ? ' on' : ''}`}>
            <button className="theme-card-main" onClick={() => pick(t)}>
              <Swatch t={t} />
              <span className="inline">
                <b>{t.name}</b>
                <span className="small muted">{t.dark ? 'dark' : 'light'}</span>
              </span>
            </button>
            {t.custom && (
              <span className="theme-card-tools">
                <button className="icon-btn" title="Edit" onClick={() => setEditing(t)}>
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-btn"
                  title="Copy a share code for this theme (works in PD2 Filter Forge too)"
                  onClick={() => {
                    void navigator.clipboard.writeText(exportTheme(t)).then(
                      () => notify(`Copied a share code for “${t.name}”.`),
                      () => notify("Couldn't use the clipboard.", true),
                    );
                  }}
                >
                  <Copy size={13} />
                </button>
                <button className="icon-btn danger" title="Delete" onClick={() => remove(t)}>
                  <Trash2 size={13} />
                </button>
              </span>
            )}
          </div>
        ))}
        <button className="theme-card theme-new" onClick={start}>
          <Plus size={20} />
          <b>Make your own</b>
          <span className="small muted">Starts from the current theme</span>
        </button>
      </div>
      <div className="inline small theme-import">
        <input
          className="text-input"
          placeholder="Paste a theme share code (ffthemes:…) to add it"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button
          className="btn small"
          disabled={!code.trim()}
          onClick={() => {
            const t = importTheme(code);
            if (!t) return notify("That isn't a valid theme code.", true);
            onChange({ customThemes: [...custom, t], theme: t.id, accent: t.colors.accent });
            setCode('');
            notify(`Added “${t.name}”.`);
          }}
        >
          Add theme
        </button>
      </div>
      <div className="inline theme-accents">
        <span className="small">
          <b>Accent colour</b>
        </span>
        {ACCENTS.map((c) => (
          <button key={c} className={`accent-swatch${prefs.accent.toLowerCase() === c ? ' on' : ''}`} style={{ background: c }} title={c} onClick={() => onChange({ accent: c })} />
        ))}
        <input type="color" className="accent-custom" value={prefs.accent} onChange={(e) => onChange({ accent: e.target.value })} title="Any colour" />
      </div>
      {editing && <ThemeEditor initial={editing} restore={() => applyTheme(findTheme(prefs.theme, custom), prefs.accent)} onCancel={() => setEditing(null)} onSave={saveCustom} />}
    </div>
  );
}

const FIELDS: { key: keyof ThemeColors; label: string; hint: string }[] = [
  { key: 'bg', label: 'Background', hint: 'Behind everything' },
  { key: 'panel', label: 'Panels', hint: 'Side panels, the ribbon and dialogs' },
  { key: 'text', label: 'Text', hint: 'Main text; muted text is derived from it' },
  { key: 'accent', label: 'Accent', hint: 'Buttons, selections and highlights' },
  { key: 'line', label: 'Lines', hint: 'Borders and dividers' },
];

function ThemeEditor({ initial, restore, onCancel, onSave }: { initial: Theme; restore: () => void; onCancel: () => void; onSave: (t: Theme) => void }) {
  const [t, setT] = useState(initial);
  // Preview live on the whole app; Cancel puts the saved theme back.
  const preview = (next: Theme) => {
    setT(next);
    applyTheme(next);
  };
  const setColor = (k: keyof ThemeColors, v: string) => preview({ ...t, colors: { ...t.colors, [k]: v }, dark: k === 'bg' ? isDarkColor(v) : t.dark });
  const cancel = () => {
    restore();
    onCancel();
  };
  return (
    <div className="modal-backdrop theme-editor-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="modal" role="dialog" aria-label="Theme editor" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), cancel())}>
        <div className="modal-title">{initial.custom && initial.name !== 'My theme' ? `Edit “${initial.name}”` : 'Make your own theme'}</div>
        <label className="form-row">
          <span>Name</span>
          <input className="text-input" maxLength={30} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} onKeyDown={(e) => e.key !== 'Escape' && e.stopPropagation()} />
        </label>
        {FIELDS.map((f) => (
          <label key={f.key} className="theme-field">
            <input type="color" value={t.colors[f.key]} onChange={(e) => setColor(f.key, e.target.value)} />
            <span className="theme-field-text">
              <b>{f.label}</b>
              <span className="small muted"> — {f.hint}</span>
            </span>
            <span className="mono small muted">{t.colors[f.key]}</span>
          </label>
        ))}
        <p className="small muted">The whole app updates as you pick colours. Everything else (hover, faint text, borders) is worked out from these five.</p>
        <div className="modal-actions">
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onSave({ ...t, name: t.name.trim() || 'My theme' });
            }}
          >
            Save theme
          </button>
        </div>
      </div>
    </div>
  );
}
