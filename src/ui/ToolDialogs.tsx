import { useEffect, useState } from 'react';
import type { CheckResult, Fix } from '../game/compat';
import type { ImportPlan, MapPackage } from '../game/mapPackage';
import { Modal } from './Dialogs';
import { ColHelp } from './HelpTip';

// ---------------------------------------------------------------------------------------------------------------
// Compatibility check

const ICON: Record<CheckResult['severity'], string> = { error: '✕', warning: '!', info: 'i', ok: '✓' };

interface CheckProps {
  results: CheckResult[] | null;
  onRerun: () => void;
  onShowCells: (cells: { x: number; y: number }[]) => void;
  /** Carries out a fix; resolves when done (the check then re-runs). */
  onFix: (fix: Fix) => Promise<void> | void;
  onClose: () => void;
}

export function CompatDialog({ results, onRerun, onShowCells, onFix, onClose }: CheckProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fix: Fix) => {
    setBusy(key);
    try {
      await onFix(fix);
    } finally {
      setBusy(null);
    }
  };
  const errors = results?.filter((r) => r.severity === 'error').length ?? 0;
  const warnings = results?.filter((r) => r.severity === 'warning').length ?? 0;
  return (
    <Modal title="Compatibility check" onClose={onClose} wide>
      <div className="check-summary">
        {results ? (
          <span className={errors ? 'error-text' : warnings ? 'warn-text' : 'ok-text'}>
            {errors ? `${errors} error${errors > 1 ? 's' : ''}` : 'No errors'}
            {warnings ? ` · ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}
            {!errors && !warnings ? ' — this map should load and play in game.' : ''}
          </span>
        ) : (
          <span className="muted">Checking…</span>
        )}
        <button className="btn" onClick={onRerun}>
          Re-run
        </button>
      </div>
      <ul className="check-list">
        {results?.map((r, i) => (
          <li key={i} className={`check ${r.severity}`}>
            <span className="check-icon">{ICON[r.severity]}</span>
            <div className="check-text">
              <div>
                <span className="muted small">{r.area} · </span>
                {r.title}
                {r.columns?.map((c) => <ColHelp key={`${c.table}.${c.col}`} table={c.table} col={c.col} />)}
              </div>
              {r.detail && <div className="muted small">{r.detail}</div>}
              <div className="inline">
                {r.cells && r.cells.length > 0 && r.severity !== 'ok' && (
                  <button className="link small" onClick={() => onShowCells(r.cells!)}>
                    Show on map ({r.cells.length})
                  </button>
                )}
              </div>
              {r.fixes && r.fixes.length > 0 && r.severity !== 'ok' && (
                <div className="check-fixes">
                  <span className="muted small">Fix:</span>
                  {r.fixes.map((f, n) => {
                    const key = `${i}.${n}`;
                    return (
                      <button key={key} className={`btn small${n === 0 ? ' primary' : ''}`} disabled={!!busy} onClick={() => void run(key, f)}>
                        {busy === key ? 'Working…' : f.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Map packages

interface ExportProps {
  mapPath: string;
  building: boolean;
  result: { files: { path: string; size: number; from: string }[]; missing: string[] } | null;
  onBuild: (notes: string, includeBaseGame: boolean) => void;
  onClose: () => void;
}

export function ExportPackageDialog({ mapPath, building, result, onBuild, onClose }: ExportProps) {
  const [notes, setNotes] = useState('');
  const [base, setBase] = useState(true);
  return (
    <Modal title="Export map package" onClose={onClose}>
      <p className="muted small">
        A .zip with everything another map maker needs to open <span className="mono">{mapPath.split('/').pop()}</span> in DS1 Studio: the DS1, its
        tile libraries, custom object sprites and its LvlPrest / Levels / LvlTypes rows.
      </p>
      <label className="mini-check">
        <input type="checkbox" checked={base} onChange={(e) => setBase(e.target.checked)} /> include base-game tile libraries (larger, but works even if
        they were modded)
      </label>
      <label className="form-row">
        <span>Notes</span>
        <textarea className="text-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      {result && (
        <div className="change-list">
          <div className="field-label">
            {result.files.length} files · {(result.files.reduce((s, f) => s + f.size, 0) / 1024).toFixed(0)} KB
          </div>
          {result.files.map((f) => (
            <div key={f.path} className="small mono">
              {f.path} <span className="muted">({f.from})</span>
            </div>
          ))}
          {result.missing.length > 0 && <div className="small error-text">Missing: {result.missing.join(', ')}</div>}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn primary" disabled={building} onClick={() => onBuild(notes, base)}>
          {building ? 'Building…' : 'Export .zip…'}
        </button>
      </div>
    </Modal>
  );
}

interface ImportProps {
  pkg: MapPackage;
  plan: ImportPlan;
  canWrite: boolean;
  onImport: () => Promise<void>;
  onClose: () => void;
}

export function ImportPackageDialog({ pkg, plan, canWrite, onImport, onClose }: ImportProps) {
  const [busy, setBusy] = useState(false);
  const count = (a: string) => plan.writes.filter((w) => w.action === a).length;
  useEffect(() => setBusy(false), [pkg]);
  return (
    <Modal title="Import map package" onClose={onClose}>
      <p className="small">
        <span className="mono">{pkg.manifest.map}</span>
        {pkg.manifest.notes ? <span className="muted"> — {pkg.manifest.notes}</span> : null}
      </p>
      <p className="muted small">
        {count('new')} new files, {count('overwrite')} replacing existing ones, {count('identical')} already identical. Files go into your mod folder
        (replaced files are kept as .bak).
      </p>
      <div className="change-list">
        {plan.writes
          .filter((w) => w.action !== 'identical')
          .map((w) => (
            <div key={w.path} className={`small mono ${w.action === 'overwrite' ? 'warn-text' : ''}`}>
              {w.action === 'new' ? '+' : '~'} {w.path}
            </div>
          ))}
        {plan.txtMerges.map((m, i) => (
          <div key={i} className="small">
            <span className={m.action === 'failed' || m.action === 'missing-table' ? 'warn-text' : ''}>
              {m.table}: {m.note ?? `${m.action} row ${m.keyValue}`}
            </span>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!canWrite || busy}
          title={canWrite ? '' : 'No writable mod folder configured'}
          onClick={async () => {
            setBusy(true);
            await onImport();
            setBusy(false);
          }}
        >
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </Modal>
  );
}
