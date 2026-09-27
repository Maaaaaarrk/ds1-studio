import { useEffect, useMemo, useState } from 'react';
import { getCell, parseTxtTable, type TxtTableDoc } from '../formats/txtTable';
import { dataRows, planAddToGame, recordOrderFix, typeAct, type TableFix } from '../game/addToGame';
import type { LayeredFs } from '../vfs/vfs';
import { normalizePath } from '../vfs/vfs';
import { Modal } from './Dialogs';
import { ColHelp } from './HelpTip';

const EXCEL = 'data/global/excel/';

async function load(fs: LayeredFs, name: string): Promise<TxtTableDoc | null> {
  const b = await fs.read(`${EXCEL}${name}`);
  return b ? parseTxtTable(b) : null;
}

const num = (s: string) => Number(s) || 0;

export interface TableWrite {
  table: string;
  path: string;
  bytes: Uint8Array;
  summary: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Add map to game

interface RegisterProps {
  fs: LayeredFs;
  mapPath: string;
  width: number;
  height: number;
  /** DT1 paths the map's placed tiles come from (normalized). */
  usedDt1s: string[];
  /** Roof/wall hide areas ("pops") in the map: LvlPrest's Pops must count them or the game ignores them. */
  popCount?: number;
  onApply: (writes: TableWrite[]) => Promise<void>;
  /** Writes a table fix and reloads the game tables, keeping the dialog open. */
  onFix: (writes: TableWrite[]) => Promise<void>;
  onClose: () => void;
  /** Pre-filled choices (e.g. right after importing a map). */
  initial?: { mode?: 'existing' | 'new'; levelId?: number; name?: string; note?: string; path?: string };
}

/**
 * Add map to game: the Levels / LvlPrest / LvlTypes rows that make the game load this map (see game/addToGame.ts for
 * the rules). Shows every field it sets, old → new and why, before anything is written.
 */
export function RegisterMapDialog({ fs, mapPath, width, height, usedDt1s, popCount = 0, onApply, onFix, onClose, initial }: RegisterProps) {
  const [tables, setTables] = useState<{ prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc } | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>(initial?.mode ?? 'new');
  const [levelId, setLevelId] = useState(initial?.levelId ?? 0);
  const [name, setName] = useState(() => initial?.name ?? mapPath.split('/').pop()!.replace(/\.ds1$/i, ''));
  const [pal, setPal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  // The file's own spelling when known (an imported map), so the table names it exactly as it is on disk.
  const exact = initial?.path && normalizePath(initial.path) === normalizePath(mapPath) ? initial.path : mapPath;
  const rel = exact.replace(/^data\/global\/tiles\//i, '');

  useEffect(() => {
    void Promise.all([load(fs, 'LvlPrest.txt'), load(fs, 'Levels.txt'), load(fs, 'LvlTypes.txt')]).then(([prest, levels, types]) => {
      if (prest && levels && types) setTables({ prest, levels, types });
    });
  }, [fs, reload]);

  // Tables whose rows are out of order (e.g. a row inserted mid-table by an older version): fixable by moving rows.
  const orderFixes = useMemo(() => {
    if (!tables) return [];
    const out: (TableFix | string)[] = [];
    for (const [t, doc, col] of [
      ['Levels.txt', tables.levels, 'Id'],
      ['LvlPrest.txt', tables.prest, 'Def'],
      ['LvlTypes.txt', tables.types, 'Id'],
    ] as const) {
      const f = recordOrderFix(t, doc, col);
      if (f) out.push(f);
    }
    return out;
  }, [tables]);

  const levelRows = useMemo(
    () =>
      tables
        ? dataRows(tables.levels)
            .map((r) => ({
              id: num(getCell(tables.levels, r, 'Id')),
              name: getCell(tables.levels, r, 'Name') || getCell(tables.levels, r, 'LevelName'),
              drlg: num(getCell(tables.levels, r, 'DrlgType')),
              type: num(getCell(tables.levels, r, 'LevelType')),
            }))
            .filter((l) => l.id > 0 && l.drlg > 0 && (mode === 'new' || l.drlg === 2))
        : [],
    [tables, mode],
  );
  const chosen = levelRows.find((l) => l.id === levelId);
  const autoPal = tables && chosen ? (typeAct(tables.types, chosen.type) ?? 4) : 4;

  const plan = useMemo(() => {
    if (!tables) return 'Loading tables…';
    if (!chosen) return mode === 'new' ? 'Pick the level to copy settings (monsters, lighting, music, tiles) from.' : 'Pick the preset level that should use this map.';
    return planAddToGame(tables, { mode, levelId, name, mapRel: rel, width, height, usedDt1s, popCount, palAct: mode === 'new' ? (pal ?? autoPal) : undefined });
  }, [tables, chosen, mode, levelId, name, rel, width, height, usedDt1s, popCount, pal, autoPal]);

  const byTable =
    typeof plan === 'string'
      ? []
      : ['Levels.txt', 'LvlPrest.txt', 'LvlTypes.txt'].map((t) => ({ t, rows: plan.changes.filter((c) => c.table === t) })).filter((g) => g.rows.length);
  return (
    <Modal title="Add map to game" onClose={onClose} wide>
      {initial?.note && <p className="small accent-text">{initial.note}</p>}
      <p className="muted small">
        Makes the game load <span className="mono">{rel}</span>: a level for it in Levels.txt, the LvlPrest row <ColHelp table="LvlPrest" col="File1" /> that
        builds the level from this map, and the tile libraries it uses in its level type&apos;s LvlTypes slots <ColHelp table="LvlTypes" col="File 1" /> with the
        matching Dt1Mask <ColHelp table="LvlPrest" col="Dt1Mask" />. Every field is listed below before anything is written.
      </p>
      <div className="form-row">
        <span>Level</span>
        <div className="inline">
          <label className="mini-check">
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> a new level, with settings copied from
          </label>
          <label className="mini-check">
            <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> replace the map of an existing preset level
          </label>
        </div>
      </div>
      <label className="form-row">
        <span>
          {mode === 'new' ? 'Copy from' : 'Level'} <ColHelp table="LvlPrest" col="LevelId" />
        </span>
        <select value={levelId} onChange={(e) => setLevelId(Number(e.target.value))}>
          <option value={0}>Choose…</option>
          {levelRows.map((l) => (
            <option key={l.id} value={l.id}>
              {l.id} · {l.name}
              {l.drlg === 2 ? '' : l.drlg === 1 ? ' (maze)' : ' (outdoors)'}
            </option>
          ))}
        </select>
      </label>
      {mode === 'new' && (
        <>
          <label className="form-row">
            <span>Name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} maxLength={60} />
          </label>
          <label className="form-row">
            <span>
              Colours <ColHelp table="Levels" col="Pal" />
            </span>
            <select value={pal ?? autoPal} onChange={(e) => setPal(Number(e.target.value))}>
              {[0, 1, 2, 3, 4].map((a) => (
                <option key={a} value={a}>
                  Act {a + 1} palette{a === autoPal ? ' (the act the tiles are from)' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">
            New levels are Act 5 levels in the game (it goes by the level number), so they use Act 5&apos;s objects, music and town. The palette follows the
            act the tiles were drawn for, as the game&apos;s own Act 5 levels that reuse other acts&apos; tiles do.
          </p>
        </>
      )}
      {orderFixes.length > 0 && (
        <div className="imp-callout small">
          <span>
            <b>The game&apos;s tables are out of order.</b> The game reads Levels.txt, LvlPrest.txt and LvlTypes.txt by row position, so every row after a
            misplaced one is read as the wrong level. Fix this first:
          </span>
          {orderFixes.map((f, i) =>
            typeof f === 'string' ? (
              <span key={i} className="error-text">
                {f}
              </span>
            ) : (
              <button
                key={i}
                className="btn small primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onFix(f.writes);
                    setReload((n) => n + 1);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {f.label}
              </button>
            ),
          )}
        </div>
      )}
      {typeof plan === 'string' ? (
        <p className={`small ${tables && chosen ? 'error-text' : 'muted'}`}>{plan}</p>
      ) : (
        <>
          {plan.warnings.map((w) => (
            <p key={w} className="small warn-text">
              {w}
            </p>
          ))}
          <div className="change-list reg-changes">
            {byTable.map((g) => (
              <div key={g.t}>
                <div className="field-label">{g.t}</div>
                <table className="reg-table small">
                  <tbody>
                    {g.rows.map((c, i) => (
                      <tr key={i}>
                        <td className="muted">{i === 0 || g.rows[i - 1].row !== c.row ? c.row : ''}</td>
                        <td className="mono">{c.column}</td>
                        <td className="mono">
                          {c.from !== '' && <span className="muted">{c.from} → </span>}
                          {c.to === '' ? <span className="muted">(empty)</span> : c.to}
                        </td>
                        <td className="muted">{c.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="muted small">
        {mode === 'new' && 'The new level has no connections yet: link it from another level (select a warp tile → Change where it leads) or open it with a cube recipe (Data → Cube recipe). '}
        If your mod ships compiled .bin tables, rebuild them after applying (start the game once with -direct -txt).
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={typeof plan === 'string' || busy || !name.trim()}
          onClick={async () => {
            if (typeof plan === 'string') return;
            setBusy(true);
            await onApply(plan.writes);
            setBusy(false);
          }}
        >
          Apply
        </button>
      </div>
    </Modal>
  );
}
