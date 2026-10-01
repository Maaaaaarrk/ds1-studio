import { useEffect, useMemo, useState } from 'react';
import type { TxtTableDoc } from '../formats/txtTable';
import type { GameData } from '../game/GameData';
import { loadTable } from '../game/levelTables';
import { isBaseGameLabel } from '../game/mapPackage';
import { typeHome } from '../game/ownTiles';
import { buildTypePackage, mapsOfType, planGatherType, suggestGatherFolder, type GatherPlan } from '../game/typePackage';
import { normalizePath } from '../vfs/vfs';
import { Modal } from './Dialogs';
import { HelpTip } from './HelpTip';

interface Props {
  gd: GameData;
  typeId: number;
  canWrite: boolean;
  /** Writes the copies and LvlTypes.txt (then the tables are reloaded). */
  onGather: (plan: GatherPlan) => Promise<void>;
  /** Saves the package zip (returns where, or null when cancelled). */
  onExport: (name: string, zip: Uint8Array) => Promise<string | null>;
  onClose: () => void;
}

const FOLDER_OK = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;

/**
 * A level type as one tidy package: its tile libraries (gathered into one folder first if they are spread out) and
 * the table rows of all its maps in one file per table, for whoever merges it into their mod.
 */
export function TypePackageDialog({ gd, typeId, canWrite, onGather, onExport, onClose }: Props) {
  const type = gd.lvlType(typeId);
  const [tables, setTables] = useState<{ prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc } | null>(null);
  const [folder, setFolder] = useState(() => (type ? suggestGatherFolder(gd.fs, type.name, type.files, typeHome(gd, type)) : 'LevelType'));
  const [withGame, setWithGame] = useState(true);
  const [withMaps, setWithMaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([loadTable(gd.fs, 'LvlPrest.txt'), loadTable(gd.fs, 'Levels.txt'), loadTable(gd.fs, 'LvlTypes.txt')]).then(([prest, levels, types]) => {
      if (live && prest && levels && types) setTables({ prest, levels, types });
    });
    return () => {
      live = false;
    };
  }, [gd]);
  const libs = useMemo(
    () =>
      (type?.files ?? [])
        .filter(Boolean)
        .map((f) => {
          const path = `data/global/tiles/${f.replace(/\\/g, '/')}`;
          return { path, folder: f.replace(/\\/g, '/').replace(/\/[^/]+$/, ''), game: isBaseGameLabel(gd.fs.locate(normalizePath(path)) ?? '') };
        }),
    [type, gd],
  );
  const folders = [...new Set(libs.map((l) => l.folder))];
  const maps = tables ? mapsOfType(tables.prest, tables.levels, typeId) : [];
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    fn()
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false));
  };
  if (!type) return null;
  const outside = libs.filter((l) => normalizePath(l.folder) !== normalizePath(folder) && (withGame || !l.game)).length;
  return (
    <Modal title={`Level type ${typeId} “${type.name}”: package`} wide onClose={() => !busy && onClose()}>
      <p className="small">
        Everything this level type needs, as one tidy zip: its {libs.length} tile libraries once each, and the table rows of its {maps.length} map{maps.length === 1 ? '' : 's'}{' '}
        (Levels, LvlPrest, LvlTypes, AutoMap, map items and their strings) with one file per table. For handing the levels to a mod&apos;s developers.
      </p>
      <div className="small">
        <b>Tile libraries</b> in {folders.length} folder{folders.length === 1 ? '' : 's'}:{' '}
        <span className="mono">{folders.map((f) => `${f || '(tiles root)'} (${libs.filter((l) => l.folder === f).length})`).join(', ')}</span>
      </div>
      <div className="small muted">Maps: {maps.map((m) => m.split('/').pop()).join(', ') || '…'}</div>

      <div className="field-label">1 · Gather into one folder {folders.length <= 1 && <span className="ok-text">(already in one)</span>}</div>
      <p className="small muted">
        Copies the libraries into one folder under readable names and points the level type at the copies, slot for slot: no map, Dt1Mask or AutoMap
        row changes. The originals stay where they are (other levels may use them); Diagnostics → Unused DT1s finds the ones nothing uses any more.
      </p>
      <div className="entry-row small">
        Folder <span className="mono muted">data/global/tiles/</span>
        <input className="text-input mono" value={folder} onChange={(e) => setFolder(e.target.value.trim())} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="small">
        <label>
          <input type="checkbox" checked={withGame} onChange={(e) => setWithGame(e.target.checked)} /> base-game libraries too{' '}
          <HelpTip text="Copies of the game's own DT1s the level type uses (act1, act3…) go in the folder too, so it holds everything the type loads. Off: they stay at their game paths." />
        </label>
      </div>
      <button
        className="btn small"
        disabled={busy || !canWrite || !tables || !FOLDER_OK.test(folder) || !outside}
        onClick={() =>
          run(async () => {
            const plan = await planGatherType(gd.fs, tables!.types, typeId, folder, withGame);
            await onGather(plan);
            setDone(`Gathered ${plan.copies.length} libraries into ${folder}/.`);
          })
        }
      >
        {outside ? `Gather ${outside} into ${folder || '…'}/` : 'Nothing to gather'}
      </button>

      <div className="field-label">2 · Export</div>
      <div className="small">
        <label>
          <input type="checkbox" checked={withMaps} onChange={(e) => setWithMaps(e.target.checked)} /> include the maps (.ds1)
        </label>
      </div>
      <button
        className="btn primary small"
        disabled={busy || !tables}
        onClick={() =>
          run(async () => {
            const pkg = await buildTypePackage(gd, gd.fs, typeId, { includeMaps: withMaps, prest: tables!.prest, levels: tables!.levels });
            const where = await onExport(`${type.name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}-level-type.zip`, pkg.zip);
            if (where)
              setDone(
                `Exported ${where}: ${pkg.dt1s.length} libraries, ${pkg.tables.map((t) => `${t.table} ${t.rows}`).join(', ')}${pkg.missing.length ? `; not found: ${pkg.missing.join(', ')}` : ''}.`,
              );
          })
        }
      >
        Export level type…
      </button>
      {done && <p className="small ok-text">{done}</p>}
      {error && <p className="small error-text">{error}</p>}
      <div className="modal-actions">
        <button className="btn" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
