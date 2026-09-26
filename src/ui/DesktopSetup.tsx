import { useState } from 'react';
import { pickFolder, type DesktopConfig } from '../vfs/tauri';

interface Props {
  initial: DesktopConfig;
  error?: string;
  busy?: string;
  onOpen: (config: DesktopConfig) => void;
  onCancel?: () => void;
}

function FolderRow({ label, hint, value, onPick, onClear }: { label: string; hint: string; value?: string | null; onPick: () => void; onClear?: () => void }) {
  return (
    <div className="folder-row">
      <div className="folder-label">
        <span>{label}</span>
        <span className="muted small">{hint}</span>
      </div>
      <div className="folder-value">
        <span className={`mono small ${value ? '' : 'muted'}`}>{value || 'not set'}</span>
        <div className="inline">
          {value && onClear && (
            <button className="btn ghost" onClick={onClear}>
              Clear
            </button>
          )}
          <button className="btn" onClick={onPick}>
            Choose…
          </button>
        </div>
      </div>
    </div>
  );
}

/** Desktop app: choose the game, mod and WinDS1 folders (remembered between runs). */
export function DesktopSetup({ initial, error, busy, onOpen, onCancel }: Props) {
  const [cfg, setCfg] = useState<DesktopConfig>(initial);
  const mod = cfg.modDirs[0] ?? null;
  const choose = async (title: string, apply: (dir: string) => DesktopConfig) => {
    const dir = await pickFolder(title);
    if (dir) setCfg(apply(dir));
  };
  return (
    <div className="setup">
      <div className="setup-card wide">
        <div className="brand big">
          <span className="brand-mark">◆</span> DS1 Studio
        </div>
        <p className="muted">Choose your folders. They are remembered for next time; only the mod folder is ever written to.</p>
        <FolderRow
          label="Diablo II"
          hint="needs d2data.mpq, d2exp.mpq, patch_d2.mpq"
          value={cfg.gameDir}
          onPick={() => choose('Diablo II folder', (d) => ({ ...cfg, gameDir: d }))}
        />
        <FolderRow
          label="Mod folder"
          hint="optional: extracted data/ tree; saves go here"
          value={mod}
          onPick={() => choose('Mod folder', (d) => ({ ...cfg, modDirs: [d] }))}
          onClear={() => setCfg({ ...cfg, modDirs: [] })}
        />
        {mod && (
          <label className="mini-check folder-check">
            <input type="checkbox" checked={cfg.modMpqs} onChange={(e) => setCfg({ ...cfg, modMpqs: e.target.checked })} />
            Also read the mod folder&apos;s own .mpq files
          </label>
        )}
        <FolderRow
          label="WinDS1"
          hint="optional: object names, sprites, special-tile labels"
          value={cfg.winds1Dir}
          onPick={() => choose('WinDS1 folder (contains Data\\obj.txt)', (d) => ({ ...cfg, winds1Dir: d }))}
          onClear={() => setCfg({ ...cfg, winds1Dir: null })}
        />
        {error && <p className="error-text small">{error}</p>}
        <div className="modal-actions">
          {onCancel && (
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button className="btn primary" disabled={!cfg.gameDir || !!busy} onClick={() => onOpen(cfg)}>
            {busy ?? 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
