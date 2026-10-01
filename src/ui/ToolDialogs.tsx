import { useEffect, useState } from 'react';
import { listCrashLogs, readCrashLog, type CrashLogFile } from '../app/crashLogs';
import { resultKey, type CheckResult, type Fix } from '../game/compat';
import type { Palette } from '../formats/palette';
import { TileLibrary } from '../game/GameData';
import { Thumb } from './TilePalette';
import { explainCrash, parseCrashLog, type Crash, type CrashExplanation } from '../game/crashLog';
import { missingTablesWarning, type ImportPlan, type MapPackage, type TableCoverage } from '../game/mapPackage';
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
  /** Results marked as intended for this map (by resultKey): kept out of the list and the counts. */
  accepted: Set<string>;
  onAccept: (r: CheckResult, accept: boolean) => void;
}

export function CompatDialog({ results, onRerun, onShowCells, onFix, onClose, accepted, onAccept }: CheckProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showAccepted, setShowAccepted] = useState(false);
  const isAccepted = (r: CheckResult) => r.severity !== 'ok' && r.severity !== 'error' && accepted.has(resultKey(r));
  const acceptedNow = results?.filter(isAccepted) ?? [];
  const shown = showAccepted ? acceptedNow : results?.filter((r) => !isAccepted(r));
  const run = async (key: string, fix: Fix) => {
    setBusy(key);
    try {
      await onFix(fix);
    } finally {
      setBusy(null);
    }
  };
  const errors = results?.filter((r) => r.severity === 'error').length ?? 0;
  const warnings = results?.filter((r) => r.severity === 'warning' && !isAccepted(r)).length ?? 0;
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
        <span className="inline">
          {(acceptedNow.length > 0 || showAccepted) && (
            <button className={`btn${showAccepted ? ' primary' : ''}`} onClick={() => setShowAccepted(!showAccepted)} title="Warnings you marked as intended for this map">
              {showAccepted ? 'Back to the check' : `Accepted (${acceptedNow.length})`}
            </button>
          )}
          <button className="btn" onClick={onRerun}>
            Re-run
          </button>
        </span>
      </div>
      {showAccepted && (
        <p className="small muted">
          Warnings you marked as intended for this map. They stay out of the check and its counts; their fixes still work here. Un-accept puts one back.
        </p>
      )}
      {showAccepted && !acceptedNow.length && <p className="small muted">No accepted warnings appear in this check.</p>}
      <ul className="check-list">
        {shown?.map((r, i) => (
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
              {(r.severity === 'warning' || r.severity === 'info') && (
                <div className="inline">
                  <button
                    className="link small"
                    onClick={() => onAccept(r, !showAccepted)}
                    title={showAccepted ? 'Show it in the check again' : 'Mark it as intended for this map: it no longer shows in the check (see Accepted)'}
                  >
                    {showAccepted ? 'Un-accept' : 'Accept as intended'}
                  </button>
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
  /** The map's rows in the tables it needs (null while they are being read). */
  coverage: TableCoverage[] | null;
  onBuild: (notes: string, includeBaseGame: boolean) => void;
  /** Exports the .ds1 file on its own instead. */
  onDs1Only: () => void;
  onClose: () => void;
}

/** The tables a map needs and how many of its rows each has (or will get), with what they do. */
export function TableCoverageList({ coverage }: { coverage: TableCoverage[] }) {
  return (
    <div className="change-list">
      {coverage.map((c) => (
        <div key={c.table} className="small">
          <span className={c.rows ? '' : 'warn-text'}>
            {c.rows ? '✓' : '✗'} <b>{c.table}.txt</b> {c.rows ? `(${c.rows} row${c.rows === 1 ? '' : 's'})` : '(none)'}
          </span>{' '}
          <span className="muted">— {c.role}</span>
        </div>
      ))}
    </div>
  );
}

export function ExportPackageDialog({ mapPath, building, result, coverage, onBuild, onDs1Only, onClose }: ExportProps) {
  const [notes, setNotes] = useState('');
  const [base, setBase] = useState(true);
  const missing = coverage?.filter((c) => !c.rows && c.table !== 'CubeMain').map((c) => c.table) ?? [];
  return (
    <Modal title="Export map" onClose={onClose}>
      <p className="muted small">
        A map package (.zip) with everything another map maker needs to use <span className="mono">{mapPath.split('/').pop()}</span>: the DS1, its tile
        libraries, custom object sprites, and its rows from the game's tables, so the game loads it the same way for them:
      </p>
      {coverage ? <TableCoverageList coverage={coverage} /> : <p className="muted small">Reading the tables…</p>}
      <p className="muted small">
        For a developer adding it by hand (no DS1 Studio needed), the zip also has a <span className="mono">for-developers</span> folder: your tables as they
        are, just the map&apos;s rows of each, and a README saying which lines are the map&apos;s, where they go and which numbers link them.
      </p>
      {missing.length > 0 && (
        <p className="small warn-text">
          This map has no {missing.join(', ')} rows in your tables{missing.includes('LvlPrest') ? ' (it has not been added to the game yet: Game → Add to game)' : ''}. Whoever imports it keeps
          their own, which may not match it: that can crash the game when the map loads.
        </p>
      )}
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
        <button className="btn" onClick={onDs1Only} title="Just the map file, without its tile libraries or table rows">
          DS1 only…
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
  /** `makeRecipe`: open the map and the Cube recipe tool afterwards, to make a recipe and map item for it. */
  onImport: (makeRecipe: boolean) => Promise<void>;
  onClose: () => void;
}

export function ImportPackageDialog({ pkg, plan, canWrite, onImport, onClose }: ImportProps) {
  const [busy, setBusy] = useState(false);
  // A recipe needs the map to be a level: its LvlPrest row (else Add to game first).
  const isLevel = plan.coverage.some((c) => c.table === 'LvlPrest' && c.rows > 0);
  const [makeRecipe, setMakeRecipe] = useState(true);
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
      <div className="field-label">The map's rows from the game's tables</div>
      <TableCoverageList coverage={plan.coverage} />
      {missingTablesWarning(plan.coverage) && <p className="small warn-text">{missingTablesWarning(plan.coverage)}</p>}
      <div className="field-label">Getting there in game</div>
      <p className="muted small">
        The maker&apos;s cube recipe and map item aren&apos;t copied: their item code, the level number it opens and its name belong to the maker&apos;s tables.
        Instead DS1 Studio makes a new recipe and map item for your tables (a free code, this map&apos;s level here, its name){plan.recipe ? ', starting from the maker\'s ingredients' : ''}.
      </p>
      <label className="mini-check">
        <input type="checkbox" checked={makeRecipe && isLevel} disabled={!isLevel} onChange={(e) => setMakeRecipe(e.target.checked)} /> make a cube recipe
        and map item for it next {plan.recipe?.inputs.length ? <span className="muted">({plan.recipe.inputs.join(' + ')})</span> : null}
      </label>
      {!isLevel && <p className="small muted">The package doesn&apos;t make the map a level: use Game → Add to game after importing, then Game → Cube recipe.</p>}
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
            await onImport(makeRecipe && isLevel);
            setBusy(false);
          }}
        >
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Crash logs

interface CrashLogProps {
  /** The levels (as "205 Guild 3") whose Levels.txt EntryFile is a given loading-screen image. */
  levelsWithEntry: (entry: string) => string[];
  /** Runs the compatibility check on the open map (null when no map is open). */
  onCheck: (() => void) | null;
  onClose: () => void;
}

const logDay = (path: string) => {
  const m = /D2(\d\d)(\d\d)(\d\d)\.txt$/i.exec(path);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : path;
};

/** Crashes (newest first) with each run of the same crash in a row shown once, as the newest with a count. */
function groupCrashes(crashes: Crash[], levelsWithEntry: (entry: string) => string[]) {
  const out: { crash: Crash; e: CrashExplanation; count: number; first: string }[] = [];
  for (const crash of crashes) {
    const e = explainCrash(crash, levelsWithEntry);
    const last = out[out.length - 1];
    if (last && last.e.title === e.title) {
      last.count++;
      last.first = crash.time;
    } else out.push({ crash, e, count: 1, first: crash.time });
  }
  return out;
}

/** The game's recent crashes, read from its logs, with what they mean for a map and how to fix them. */
export function CrashLogDialog({ levelsWithEntry, onCheck, onClose }: CrashLogProps) {
  const [logs, setLogs] = useState<CrashLogFile[] | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [crashes, setCrashes] = useState<Crash[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    void listCrashLogs().then((l) => {
      setLogs(l);
      setPath((p) => (p && l.some((x) => x.path === p) ? p : (l[0]?.path ?? null)));
    });
  }, [reload]);
  useEffect(() => {
    if (!path) return;
    setCrashes(null);
    setError(null);
    readCrashLog(path)
      .then((text) => setCrashes(parseCrashLog(text).reverse()))
      .catch((e) => setError(String(e)));
  }, [path, reload]);
  return (
    <Modal title="Crash log" onClose={onClose} wide>
      <p className="muted small">
        When Diablo II crashes it writes what happened to a log in its folder (D2&lt;date&gt;.txt). This reads the newest crashes and says what they mean for
        your maps — most crashes a map causes come from its table rows.
      </p>
      {logs === null ? (
        <p className="muted">Looking for logs…</p>
      ) : logs.length === 0 ? (
        <p className="muted">No game logs found in the game or mod folders. The game writes one the first time it crashes on a day.</p>
      ) : (
        <>
          <div className="check-summary">
            <label className="inline">
              Log{' '}
              <select value={path ?? ''} onChange={(e) => setPath(e.target.value)}>
                {logs.map((l) => (
                  <option key={l.path} value={l.path}>
                    {logDay(l.path)} · {l.path}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" onClick={() => setReload((n) => n + 1)}>
              Refresh
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}
          {!error && crashes === null && <p className="muted">Reading…</p>}
          {crashes?.length === 0 && <p className="ok-text">No crashes in this log.</p>}
          <ul className="check-list">
            {groupCrashes(crashes ?? [], levelsWithEntry).slice(0, 20).map(({ crash: c, e, count, first }, i) => {
              return (
                <li key={i} className={`check ${i === 0 ? 'error' : 'warning'}`}>
                  <span className="check-icon">{i === 0 ? '✕' : '!'}</span>
                  <div className="check-text">
                    <div>
                      <span className="muted small">{c.time || 'unknown time'}{i === 0 ? ' · latest' : ''}{count > 1 ? ` · ${count} times since ${first}` : ''} · </span>
                      {e.title}
                    </div>
                    <div className="muted small">{e.detail}</div>
                    <div className="muted small">
                      {c.kind === 'halt' ? `Halt: ${c.what || 'no message'}` : c.what}
                      {c.module ? ` · ${c.module}${c.offset !== undefined ? ` +0x${c.offset.toString(16)}` : ''}` : ''}
                      {c.line ? ` · line ${c.line}` : ''}
                    </div>
                    {e.check && onCheck && i === 0 && (
                      <div className="check-fixes">
                        <button className="btn small primary" onClick={onCheck}>
                          Run compatibility check
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Two copies of the same tiles: choose which to keep

interface CopiesProps {
  pairs: { earlier: string; later: string; keys: number[] }[];
  lib: TileLibrary;
  palette: Palette;
  onApply: (remove: string[]) => Promise<void>;
  onClose: () => void;
}

/**
 * The map loads two DT1s with the same tiles (an original and a copy): the game picks among both at random per cell,
 * so some cells show the other copy. Shows the same tiles from each side by side to choose which to keep; the other
 * leaves the map's tile libraries (its tables are updated like any library change).
 */
export function ChooseCopiesDialog({ pairs, lib, palette, onApply, onClose }: CopiesProps) {
  const [keep, setKeep] = useState<Record<number, 'earlier' | 'later' | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');
  const tileOf = (path: string, k: number) => lib.tilesOf(path).find((t) => TileLibrary.key(t.orientation, t.mainIndex, t.subIndex) === k);
  const remove = pairs.flatMap((p, i) => (keep[i] === 'earlier' ? [p.later] : keep[i] === 'later' ? [p.earlier] : []));
  return (
    <Modal title="Choose which copy to keep" wide onClose={() => !busy && onClose()}>
      <p className="small">
        Each pair below provides the same tile numbers, so the game picks between them at random on every cell that uses them: a few cells show the other
        copy. Compare the same tiles from each and keep the one that looks right; the other is taken off this map (and out of its level&apos;s Dt1Mask).
      </p>
      {pairs.map((p, i) => (
        <div key={i} className="copies-pair">
          {(['earlier', 'later'] as const).map((side) => {
            const path = p[side];
            return (
              <label key={side} className={`copies-side${keep[i] === side ? ' on' : ''}`}>
                <span className="inline">
                  <input type="radio" name={`keep${i}`} checked={keep[i] === side} onChange={() => setKeep({ ...keep, [i]: side })} />
                  <b className="mono small">{short(path)}</b>
                </span>
                <span className="copies-tiles">
                  {p.keys.map((k) => {
                    const t = tileOf(path, k);
                    return t ? <Thumb key={k} tile={t} palette={palette} /> : <span key={k} className="thumb-img" />;
                  })}
                </span>
              </label>
            );
          })}
        </div>
      ))}
      {error && <p className="small error-text">{error}</p>}
      <div className="modal-actions">
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || !remove.length}
          onClick={() => {
            setBusy(true);
            setError(null);
            onApply(remove)
              .then(onClose)
              .catch((e) => setError(String((e as Error)?.message ?? e)))
              .finally(() => setBusy(false));
          }}
        >
          {remove.length ? `Keep the chosen ${remove.length === 1 ? 'copy' : 'copies'}: remove ${remove.map((r) => r.split('/').pop()).join(', ')}` : 'Choose a copy to keep'}
        </button>
      </div>
    </Modal>
  );
}
