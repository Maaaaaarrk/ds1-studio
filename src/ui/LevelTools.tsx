import { useEffect, useMemo, useState } from 'react';
import { appendRow, cloneRow, colIndex, getCell, parseTxtTable, serializeTxtTable, setCell, type TxtTableDoc } from '../formats/txtTable';
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
const has = (doc: TxtTableDoc, col: string) => colIndex(doc, col) >= 0;
const setIf = (doc: TxtTableDoc, row: number, col: string, value: string) => (has(doc, col) ? setCell(doc, row, col, value) : doc);

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
  onApply: (writes: TableWrite[]) => Promise<void>;
  onClose: () => void;
}

/** Creates the LvlPrest (and optionally Levels/LvlTypes) rows that make the game load this map. */
export function RegisterMapDialog({ fs, mapPath, width, height, usedDt1s, onApply, onClose }: RegisterProps) {
  const [tables, setTables] = useState<{ prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc } | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [levelId, setLevelId] = useState(0);
  const [name, setName] = useState(() => mapPath.split('/').pop()!.replace(/\.ds1$/i, ''));
  const [busy, setBusy] = useState(false);
  const rel = mapPath.replace(/^data\/global\/tiles\//i, '');

  useEffect(() => {
    void Promise.all([load(fs, 'LvlPrest.txt'), load(fs, 'Levels.txt'), load(fs, 'LvlTypes.txt')]).then(([prest, levels, types]) => {
      if (prest && levels && types) setTables({ prest, levels, types });
    });
  }, [fs]);

  const levelRows = useMemo(
    () =>
      tables
        ? tables.levels.rows
            .map((r, i) => ({ i, id: num(r[colIndex(tables.levels, 'Id')] ?? ''), name: getCell(tables.levels, i, 'LevelName') || getCell(tables.levels, i, 'Name') }))
            .filter((l) => l.id > 0)
        : [],
    [tables],
  );

  const plan = useMemo((): TableWrite[] | string => {
    if (!tables) return 'Loading tables…';
    let { prest, levels, types } = tables;
    const writes: TableWrite[] = [];
    const summary: Record<string, string[]> = { 'LvlPrest.txt': [], 'Levels.txt': [], 'LvlTypes.txt': [] };

    const template = levelRows.find((l) => l.id === levelId);
    if (!template) return 'Pick a level.';
    let targetLevel = template.id;
    let typeId = num(getCell(levels, template.i, 'LevelType'));

    if (mode === 'new') {
      const newId = Math.max(...levelRows.map((l) => l.id)) + 1;
      levels = cloneRow(levels, template.i);
      const row = template.i + 1;
      levels = setCell(levels, row, 'Id', String(newId));
      levels = setCell(levels, row, 'Name', name);
      levels = setIf(levels, row, 'LevelName', name);
      levels = setIf(levels, row, 'LevelWarp', name);
      levels = setIf(levels, row, 'EntryFile', '');
      levels = setIf(levels, row, 'DrlgType', '2'); // preset level
      for (let i = 0; i < 8; i++) {
        levels = setIf(levels, row, `Vis${i}`, '0');
        levels = setIf(levels, row, `Warp${i}`, '-1');
      }
      levels = setIf(levels, row, 'Waypoint', '255');
      for (const s of ['', '(N)', '(H)']) {
        levels = setIf(levels, row, `SizeX${s}`, String(width));
        levels = setIf(levels, row, `SizeY${s}`, String(height));
      }
      targetLevel = newId;
      summary['Levels.txt'].push(`New level ${newId} "${name}" (cloned from ${template.id} ${template.name}; preset level, no connections yet)`);
    }

    // The level type must load every DT1 the map uses; add missing ones to free File slots.
    const typeRow = types.rows.findIndex((r) => num(r[colIndex(types, 'Id')] ?? '') === typeId);
    if (typeRow < 0) return `LvlTypes.txt has no type ${typeId}.`;
    const slotPath = (i: number) => {
      const v = getCell(types, typeRow, `File ${i}`);
      return v && v !== '0' ? normalizePath(`data/global/tiles/${v}`) : '';
    };
    let mask = 0;
    for (const dt1 of usedDt1s) {
      let slot = [...Array(32).keys()].map((k) => k + 1).find((i) => slotPath(i) === dt1);
      if (!slot) {
        slot = [...Array(32).keys()].map((k) => k + 1).find((i) => !slotPath(i));
        if (!slot) return `LvlTypes "${getCell(types, typeRow, 'Name')}" has no free File slot for ${dt1}.`;
        const value = dt1.replace(/^data\/global\/tiles\//, '');
        types = setCell(types, typeRow, `File ${slot}`, value);
        summary['LvlTypes.txt'].push(`Type ${typeId} "${getCell(types, typeRow, 'Name')}": File ${slot} = ${value}`);
      }
      mask |= 1 << (slot - 1);
    }

    // LvlPrest row: clone one that belongs to a real level, then point it at this map.
    const already = prest.rows.findIndex((r) => [1, 2, 3, 4, 5, 6].some((i) => normalizePath(r[colIndex(prest, `File${i}`)] ?? '') === normalizePath(rel)));
    const def = Math.max(...prest.rows.map((r) => num(r[colIndex(prest, 'Def')] ?? ''))) + 1;
    const values: Record<string, string> = {
      Name: name,
      Def: String(def),
      LevelId: String(targetLevel),
      Populate: '1',
      Logicals: '1',
      Animate: '1',
      AutoMap: '1',
      Scan: '1',
      Files: '1',
      File1: rel,
      Dt1Mask: String(mask >>> 0),
    };
    if (already >= 0) {
      prest = setCell(prest, already, 'LevelId', String(targetLevel));
      prest = setCell(prest, already, 'Dt1Mask', String(mask >>> 0));
      summary['LvlPrest.txt'].push(`Update "${getCell(prest, already, 'Name')}": LevelId ${targetLevel}, Dt1Mask ${mask >>> 0}`);
    } else {
      for (const k of Object.keys(values)) if (!has(prest, k)) delete values[k];
      prest = appendRow(prest, values);
      summary['LvlPrest.txt'].push(`New preset "${name}" (Def ${def}) → level ${targetLevel}, File1 ${rel}, Dt1Mask ${mask >>> 0}`);
    }

    const push = (table: string, doc: TxtTableDoc, changed: boolean) => {
      if (changed) writes.push({ table, path: `${EXCEL}${table}`, bytes: serializeTxtTable(doc), summary: summary[table] });
    };
    push('LvlPrest.txt', prest, true);
    push('Levels.txt', levels, mode === 'new');
    push('LvlTypes.txt', types, summary['LvlTypes.txt'].length > 0);
    return writes;
  }, [tables, mode, levelId, name, levelRows, usedDt1s, rel, width, height]);

  return (
    <Modal title="Add map to game" onClose={onClose}>
      <p className="muted small">
        Makes the game load <span className="mono">{rel}</span>: a LvlPrest row (File1 <ColHelp table="LvlPrest" col="File1" />) pointing at it, with a
        Dt1Mask <ColHelp table="LvlPrest" col="Dt1Mask" /> covering the tile libraries it uses; missing libraries go into free LvlTypes slots{' '}
        <ColHelp table="LvlTypes" col="File 1" />.
      </p>
      <div className="form-row">
        <span>Level</span>
        <div className="inline">
          <label className="mini-check">
            <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> use an existing level
          </label>
          <label className="mini-check">
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> new level, cloned from
          </label>
        </div>
      </div>
      <label className="form-row">
        <span>
          {mode === 'new' ? 'Template' : 'Level'} <ColHelp table="LvlPrest" col="LevelId" />
        </span>
        <select value={levelId} onChange={(e) => setLevelId(Number(e.target.value))}>
          <option value={0}>Choose…</option>
          {levelRows.map((l) => (
            <option key={l.id} value={l.id}>
              {l.id} · {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className="form-row">
        <span>Name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      <div className="change-list">
        {typeof plan === 'string' ? (
          <p className="muted small">{plan}</p>
        ) : (
          plan.map((w) => (
            <div key={w.table}>
              <div className="field-label">{w.table}</div>
              {w.summary.map((s) => (
                <div key={s} className="small">
                  • {s}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      <p className="muted small">
        {mode === 'new' && 'The new level has no connections yet: link it from another level (Levels Vis/Warp + LvlWarp) or open it with a cube recipe (Data → Cube recipe). '}
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
            await onApply(plan);
            setBusy(false);
          }}
        >
          Apply
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Cube recipe

interface CubeProps {
  fs: LayeredFs;
  mapName: string;
  onApply: (writes: TableWrite[]) => Promise<void>;
  onClose: () => void;
}

/**
 * Creates a map item (a clone of an existing Misc.txt item, e.g. one of the mod's map items) and a CubeMain recipe
 * that produces it. Which level the item opens is decided by the mod's code (e.g. PD2's map-item plugin).
 */
export function CubeRecipeDialog({ fs, mapName, onApply, onClose }: CubeProps) {
  const [misc, setMisc] = useState<TxtTableDoc | null>(null);
  const [cube, setCube] = useState<TxtTableDoc | null>(null);
  const [template, setTemplate] = useState(-1);
  const [code, setCode] = useState('');
  const [itemName, setItemName] = useState(`${mapName} Map`);
  const [inputs, setInputs] = useState('"t1me,qty=1","runs,qty=1"');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([load(fs, 'Misc.txt'), load(fs, 'CubeMain.txt')]).then(([m, c]) => {
      setMisc(m);
      setCube(c);
      if (m) {
        const guess = m.rows.findIndex((r) => /map/i.test(r[colIndex(m, 'name')] ?? '') && (r[colIndex(m, 'code')] ?? '').length > 0);
        setTemplate(guess);
      }
    });
  }, [fs]);

  const codes = useMemo(() => new Set(misc ? misc.rows.map((r) => (r[colIndex(misc, 'code')] ?? '').toLowerCase()) : []), [misc]);
  const codeOk = /^[a-z0-9]{3,4}$/i.test(code) && !codes.has(code.toLowerCase());
  const items = useMemo(() => (misc ? misc.rows.map((r, i) => ({ i, name: r[colIndex(misc, 'name')] ?? '', code: r[colIndex(misc, 'code')] ?? '' })).filter((x) => x.code) : []), [misc]);

  const plan = useMemo((): TableWrite[] | string => {
    if (!misc || !cube) return 'Loading Misc.txt and CubeMain.txt…';
    if (template < 0) return 'Pick a template item.';
    if (!codeOk) return 'Enter a new, unused 3–4 character item code.';
    let m = cloneRow(misc, template);
    const row = template + 1;
    m = setCell(m, row, 'name', itemName);
    m = setIf(m, row, '*name', itemName);
    m = setCell(m, row, 'code', code); // namestr and graphics stay the template's, so the item has a name and an icon
    const parts = inputs.match(/"[^"]*"|[^,]+/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
    const values: Record<string, string> = { description: `${itemName} [map:${mapName.toLowerCase()}] (DS1 Studio)`, enabled: '1', version: '100', numinputs: String(parts.length), output: code };
    parts.slice(0, 7).forEach((p, i) => (values[`input ${i + 1}`] = p));
    for (const k of Object.keys(values)) if (!has(cube, k)) delete values[k];
    const c = appendRow(cube, values);
    return [
      { table: 'Misc.txt', path: `${EXCEL}Misc.txt`, bytes: serializeTxtTable(m), summary: [`New item "${itemName}" (code ${code}), cloned from "${items.find((x) => x.i === template)?.name}"`] },
      { table: 'CubeMain.txt', path: `${EXCEL}CubeMain.txt`, bytes: serializeTxtTable(c), summary: [`Recipe: ${parts.join(' + ')} → ${code}`] },
    ];
  }, [misc, cube, template, code, codeOk, itemName, inputs, items]);

  return (
    <Modal title="Cube recipe for this map" onClose={onClose}>
      <p className="muted small">
        Creates a map item and a Horadric Cube recipe that makes it. The item-to-level link is handled by your mod&apos;s code (for PD2, its map-item
        system); vanilla D2 can only open the hard-coded portals.
      </p>
      <label className="form-row">
        <span>
          Template item <ColHelp table="Misc" col="namestr" />
        </span>
        <select value={template} onChange={(e) => setTemplate(Number(e.target.value))}>
          <option value={-1}>Choose…</option>
          {items.map((x) => (
            <option key={x.i} value={x.i}>
              {x.name} ({x.code})
            </option>
          ))}
        </select>
      </label>
      <label className="form-row">
        <span>Item name</span>
        <input className="text-input" value={itemName} onChange={(e) => setItemName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      <label className="form-row">
        <span>
          Item code <ColHelp table="Misc" col="code" />
        </span>
        <input className="text-input mono" value={code} maxLength={4} placeholder="e.g. mymp" onChange={(e) => setCode(e.target.value.trim())} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      <label className="form-row">
        <span>
          Cube inputs <ColHelp table="CubeMain" col="input 1" />
        </span>
        <input className="text-input mono" value={inputs} onChange={(e) => setInputs(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      <div className="change-list">
        {typeof plan === 'string' ? (
          <p className="muted small">{plan}</p>
        ) : (
          plan.map((w) => (
            <div key={w.table} className="small">
              <b>{w.table}</b>: {w.summary.join('; ')}
            </div>
          ))
        )}
      </div>
      <p className="muted small">Item names shown in game come from the string tables (.tbl); the new item reuses the template&apos;s name string until you add one.</p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={typeof plan === 'string' || busy}
          onClick={async () => {
            if (typeof plan === 'string') return;
            setBusy(true);
            await onApply(plan);
            setBusy(false);
          }}
        >
          Apply
        </button>
      </div>
    </Modal>
  );
}
