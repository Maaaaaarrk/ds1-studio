import { useMemo, useState } from 'react';
import { Orientation } from '../formats/dt1';
import type { CellRect } from '../game/clipboard';
import type { OpenMap } from '../game/openMap';
import { hideRect, planPops, popProblems, popTargets, type PopArea } from '../game/pops';
import { Modal } from './Dialogs';
import { HelpTip } from './HelpTip';
import { ORIENTATION_NAMES } from './state';
import { Thumb } from './TilePalette';

interface Props {
  map: OpenMap;
  areas: PopArea[];
  /** The map's LvlPrest.txt row (null = not in the game yet). */
  preset: { pops: number; popPad: number } | null;
  selection: CellRect | null;
  canSave: boolean;
  onCreate: (rect: CellRect, targets: number[], popPad: number) => Promise<void>;
  onRemove: (areas: PopArea[]) => Promise<void>;
  onSetTables: (pops: number, popPad: number) => Promise<void>;
  onShow: (area: PopArea) => void;
  onClose: () => void;
}

/**
 * Roof hiding: the game fades roofs (or any wall-layer tiles) while a player is inside a marked rectangle ("pops", see
 * game/pops.ts). Lists the map's areas and what's wrong with them, and makes a new one from the selection: pick the
 * kinds of tiles to hide and DS1 Studio places the corner markers and sets LvlPrest's Pops/PopPad.
 */
export function PopsDialog({ map, areas, preset, selection, canSave, onCreate, onRemove, onSetTables, onShow, onClose }: Props) {
  const { ds1 } = map;
  const problems = useMemo(() => popProblems(ds1, areas, preset?.pops ?? null, preset?.popPad ?? 0), [ds1, areas, preset]);
  const [popPad, setPopPad] = useState(() => (preset && (preset.pops > 0 || preset.popPad !== 0) ? preset.popPad : -4));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wall-layer tiles a new area over the selection could hide, by main index (the game hides by main index).
  const candidates = useMemo(() => {
    if (!selection) return [];
    const r = hideRect(selection);
    const byMain = new Map<number, { main: number; count: number; kinds: Map<number, number>; sample: { o: number; sub: number } }>();
    ds1.walls.forEach((layer) => {
      for (let y = Math.max(0, r.y0); y <= Math.min(ds1.height - 1, r.y1); y++)
        for (let x = Math.max(0, r.x0); x <= Math.min(ds1.width - 1, r.x1); x++) {
          const c = layer[y * ds1.width + x];
          if (c.prop1 === 0 || c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) continue;
          let e = byMain.get(c.mainIndex);
          if (!e) byMain.set(c.mainIndex, (e = { main: c.mainIndex, count: 0, kinds: new Map(), sample: { o: c.orientation, sub: c.subIndex } }));
          e.count++;
          e.kinds.set(c.orientation, (e.kinds.get(c.orientation) ?? 0) + 1);
          if (c.orientation === Orientation.Roof) e.sample = { o: c.orientation, sub: c.subIndex };
        }
    });
    return [...byMain.values()].sort((a, b) => Number(b.kinds.has(Orientation.Roof)) - Number(a.kinds.has(Orientation.Roof)) || b.count - a.count);
  }, [ds1, selection]);
  const [picked, setPicked] = useState<Set<number> | null>(null);
  // Default: the roofs.
  const chosen = picked ?? new Set(candidates.filter((c) => c.kinds.has(Orientation.Roof)).map((c) => c.main));
  const targets = candidates.filter((c) => chosen.has(c.main)).map((c) => c.main);
  const plan = selection && targets.length ? planPops(ds1, selection, targets) : null;
  const newCount = Math.max(preset?.pops ?? 0, areas.length + targets.length);
  const kindText = (k: Map<number, number>) =>
    [...k]
      .sort((a, b) => b[1] - a[1])
      .map(([o, n]) => `${n} ${(ORIENTATION_NAMES[o] ?? `orientation ${o}`).toLowerCase()}`)
      .join(', ');

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const popsFix = preset && areas.length && preset.pops < areas.length ? areas.length : null;
  return (
    <Modal title="Roof hiding" onClose={onClose} wide>
      <p className="small">
        The game fades roofs (or any tiles on the wall layers) while a player is inside a building. A <b>hide area</b> is marked by two special tiles at
        opposite corners of the inside; they name which tiles fade by their <i>main index</i>, and every such tile in the area (one cell around it
        included) fades while the player stands in it.{' '}
        <HelpTip text="Markers are special tiles with main index 8-29 (the area's number) and, as sub index, the main index of the tiles to hide. The game pairs markers by main index — the first and last in the file are the corners — and 8-11, 12-15, 16-19… hide together. LvlPrest.txt's Pops must count the areas (0 = ignored), and PopPad grows (+) or shrinks (−) the trigger area by that many sub-tiles to the south/east; the game's houses use −4. Floors can't be hidden." />
      </p>

      <div className="field-label">Hide areas in this map</div>
      {!areas.length && <p className="small muted">None yet.</p>}
      {areas.map((a) => (
        <div key={a.main} className="pops-row small">
          <span>
            <b>Area {a.main}</b> hides tiles #{a.target} · {a.x1 - a.x0 + 1}×{a.y1 - a.y0 + 1} cells · {popTargets(ds1, a).length} tiles fade
            {a.markers.length !== 2 && <span className="warn-text"> · {a.markers.length} markers</span>}
          </span>
          <button className="btn small" onClick={() => onShow(a)}>
            Show
          </button>
          <button className="btn small" disabled={busy} onClick={() => void run(() => onRemove([a]))}>
            Remove
          </button>
        </div>
      ))}
      {preset ? (
        <p className="small muted">
          LvlPrest.txt: Pops {preset.pops}, PopPad {preset.popPad}
        </p>
      ) : (
        areas.length > 0 && <p className="small muted">This map isn&apos;t in LvlPrest.txt yet: Data → Add to game sets Pops for its hide areas.</p>
      )}
      {problems.map((p, i) => (
        <p key={i} className={`small ${p.severity === 'error' ? 'error-text' : 'warn-text'}`}>
          {p.text}
        </p>
      ))}
      {popsFix !== null && (
        <button className="btn small" disabled={busy || !canSave} onClick={() => void run(() => onSetTables(popsFix, preset!.popPad))}>
          Set Pops to {popsFix}
        </button>
      )}

      <div className="field-label">New hide area</div>
      {!selection ? (
        <p className="small">
          With the Select tool, drag over the <b>inside</b> of the building — the floor a player walks on — then open Roof hiding again (Map tab).
        </p>
      ) : (
        <>
          <p className="small">
            Inside: {selection.x1 - selection.x0 + 1}×{selection.y1 - selection.y0 + 1} cells from ({selection.x0}, {selection.y0}). Tick what should fade:
          </p>
          {!candidates.length && <p className="small warn-text">There are no wall-layer tiles in or around the selection.</p>}
          <div className="pops-candidates">
            {candidates.map((c) => {
              const tile = map.lib.pick(c.sample.o, c.main, c.sample.sub, 0);
              return (
                <label key={c.main} className={`pops-candidate${chosen.has(c.main) ? ' on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={chosen.has(c.main)}
                    onChange={() =>
                      setPicked(() => {
                        const n = new Set(chosen);
                        if (n.has(c.main)) n.delete(c.main);
                        else n.add(c.main);
                        return n;
                      })
                    }
                  />
                  {tile ? <Thumb tile={tile} palette={map.palette} /> : <div className="thumb-img" />}
                  <span className="small">
                    <b>#{c.main}</b> · {kindText(c.kinds)}
                  </span>
                </label>
              );
            })}
          </div>
          {targets.length > 4 && <p className="small error-text">One area can hide at most 4 kinds of tiles (one marker pair each, in one group of 4).</p>}
          <p className="small muted">
            Every tile with a ticked number in the area and one cell around it fades, even if it belongs to something else — check with <b>View → As if
            inside</b>.
          </p>
          <label className="form-row">
            <span>
              PopPad <HelpTip text="In sub-tiles (5 per cell), for the whole map: − makes the player walk further in before the roof fades (the game's houses use −4), + starts it earlier. It only moves the south and east edges." />
            </span>
            <input className="text-input" type="number" value={popPad} onChange={(e) => setPopPad(Number(e.target.value) || 0)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          {plan?.error && <p className="small error-text">{plan.error}</p>}
          {plan && !plan.error && (
            <p className="small muted">
              Places {plan.markers.length * 2} markers ({plan.markers.map((m) => `${m.main}/${m.target}`).join(', ')}) at the corners
              {plan.wallLayers > ds1.walls.length ? `, adding ${plan.wallLayers - ds1.walls.length} wall layer${plan.wallLayers - ds1.walls.length === 1 ? '' : 's'}` : ''}
              {preset ? `, and sets LvlPrest Pops ${newCount}, PopPad ${popPad}` : ''}. One undo step for the map.
            </p>
          )}
        </>
      )}
      {error && <p className="small error-text">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        {selection && (
          <button
            className="btn primary"
            disabled={busy || !plan || !!plan.error || targets.length > 4 || (!!preset && !canSave)}
            onClick={() => void run(() => onCreate(selection, targets, popPad))}
          >
            Add hide area
          </button>
        )}
      </div>
    </Modal>
  );
}
