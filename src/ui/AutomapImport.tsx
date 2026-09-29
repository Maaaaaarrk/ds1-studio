import { useMemo, useState } from 'react';
import { mergeAutomapRows, namesByNumber, type AutomapSource } from '../game/automapImport';
import type { LvlTypeInfo } from '../game/GameData';
import { Modal } from './Dialogs';

/**
 * Import AutoMap rows from another mod's AutoMap.txt: every LevelName in them (the level type's number or name in THAT
 * mod) is mapped to one of this mod's level types, the open map's by default, then the rows are added (those already
 * there are skipped).
 */
export function AutomapImportDialog({
  fileName,
  source,
  target,
  types,
  mapType,
  busy,
  onImport,
  onClose,
}: {
  fileName: string;
  source: AutomapSource;
  /** This mod's AutoMap.txt. */
  target: Uint8Array;
  types: LvlTypeInfo[];
  /** The open map's level type, if any. */
  mapType: LvlTypeInfo | null;
  busy: boolean;
  onImport: (bytes: Uint8Array, summary: string) => void;
  onClose: () => void;
}) {
  const byNumber = useMemo(() => namesByNumber(target), [target]);
  const valueOf = (t: LvlTypeInfo) => (byNumber ? String(t.id) : t.name);
  // Default: the open map's level type when there is one kind of LevelName; else a type with that name here, else skip.
  const [mapping, setMapping] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(
      source.levels.map((l) => {
        const sameName = types.find((t) => t.name.toLowerCase() === l.name.toLowerCase());
        return [l.name, source.levels.length === 1 && mapType ? mapType.id : (sameName?.id ?? null)];
      }),
    ),
  );
  const plan = useMemo(() => {
    const m = Object.fromEntries(Object.entries(mapping).map(([k, id]) => [k, id === null ? null : valueOf(types.find((t) => t.id === id)!)]));
    return mergeAutomapRows(target, source, m);
  }, [mapping, target, source, types]); // eslint-disable-line react-hooks/exhaustive-deps
  const typeLabel = (id: number) => {
    const t = types.find((x) => x.id === id);
    return t ? `${t.id} ${t.name}` : String(id);
  };

  return (
    <Modal title="Import AutoMap rows" onClose={onClose} wide>
      <p className="small muted">
        <span className="mono">{fileName}</span>: {source.rows.length} rows. Their <b>LevelName</b> is the level type&apos;s number (or name) in the mod they
        came from, which is usually a different level type in yours. Choose, for each one, which of your level types the rows are for. Your AutoMap.txt names
        level types by {byNumber ? 'number' : 'name'}, so that is what is written.
      </p>
      <table className="am-import">
        <thead>
          <tr>
            <th>LevelName in the file</th>
            <th>Rows</th>
            <th>Tiles</th>
            <th>For your level type</th>
          </tr>
        </thead>
        <tbody>
          {source.levels.map((l) => {
            const clash = types.find((t) => valueOf(t) === l.name);
            return (
              <tr key={l.name}>
                <td className="mono">{l.name || '(empty)'}</td>
                <td>{l.rows}</td>
                <td className="mono small">{l.codes.join(' ')}</td>
                <td>
                  <select value={mapping[l.name] ?? ''} onChange={(e) => setMapping({ ...mapping, [l.name]: e.target.value === '' ? null : Number(e.target.value) })}>
                    <option value="">skip these rows</option>
                    {types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id} · {t.name}
                        {mapType?.id === t.id ? ' (this map)' : ''}
                      </option>
                    ))}
                  </select>
                  {clash && mapping[l.name] !== clash.id && (
                    <div className="small warn-text">In your mod, {l.name} is {typeLabel(clash.id)}: kept as is, the rows would go to that level type.</div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small">
        {plan.added} row{plan.added === 1 ? '' : 's'} will be added{plan.already ? `, ${plan.already} already there` : ''}. The game uses the first row that matches
        a tile, so rows already in your AutoMap.txt for the same level type win over added ones.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || plan.added === 0}
          onClick={() =>
            onImport(
              plan.bytes,
              `AutoMap.txt: added ${plan.added} rows (${Object.entries(mapping)
                .filter(([, id]) => id !== null)
                .map(([k, id]) => `${k} → ${typeLabel(id!)}`)
                .join(', ')})`,
            )
          }
        >
          {busy ? 'Adding…' : `Add ${plan.added} rows to AutoMap.txt`}
        </button>
      </div>
    </Modal>
  );
}
