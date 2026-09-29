import { useEffect, useMemo, useState } from 'react';
import { decodeTile, type Dt1, type TileImage } from '../formats/dt1';
import { recolorDt1 } from '../formats/dt1Edit';
import { ACT0_PALETTE, OLD_ACT5_PALETTE, PALETTE_NAMES, type Palette } from '../formats/palette';
import { act0Remap, dt1Act, loadAct0Palette, type Act0Palette } from '../game/act0Palette';
import { guessDrawnAct } from '../game/openMap';
import type { GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import { isBuiltinPath } from '../game/specialTiles';
import { duplicateDt1s } from '../game/duplicateDt1s';
import { Modal } from './Dialogs';
import { HelpTip } from './HelpTip';
import { ImageThumb } from './PixelPainter';

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

/** The act a DT1 was drawn for, guessed from its folder (act1..act5, expansion = Act 5); null when the folder doesn't say. */
export function actFromPath(path: string): number | null {
  return dt1Act(path);
}

interface Row {
  path: string;
  /** Where the DT1 is read from (a game archive, or a folder). */
  source: string;
  fromArchive: boolean;
  dt1: Dt1;
  images: (TileImage | null)[];
  /** Pixels (and tiles) using colours that change between acts. */
  unsafePixels: number;
  pixels: number;
  unsafeTiles: number;
  /** Tile indices shown as examples: the ones with the most act-specific pixels. */
  samples: number[];
}

interface Props {
  map: OpenMap;
  gd: GameData;
  canSave: boolean;
  onApply: (files: { path: string; bytes: Uint8Array }[]) => Promise<void>;
  /** Removes DT1s from the map's tile libraries (and the game's tables). */
  onRemove: (paths: string[]) => Promise<void>;
  onClose: () => void;
}

/**
 * Converts the colours of this map's DT1s that change between acts to the nearest Act 0 colour, judged by how they look
 * in the act each DT1 was drawn for. Fixes tiles drawn for one act (say Act 1) showing odd colours (often red) in a map
 * of another act, both here and in game.
 */
export function ActSafeDialog({ map, gd, canSave, onApply, onRemove, onClose }: Props) {
  const mapAct = map.paletteAct === OLD_ACT5_PALETTE ? 4 : map.paletteAct === ACT0_PALETTE ? Math.min(4, map.ds1.act) : map.paletteAct;
  const [act0, setAct0] = useState<Act0Palette | null>(null);
  const [acts, setActs] = useState<Palette[] | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [from, setFrom] = useState<Record<string, number>>({});
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [a0, ...pals] = await Promise.all([loadAct0Palette(gd.fs), ...[0, 1, 2, 3, 4].map((a) => gd.palette(a))]);
      const paths = map.lib.loaded.filter((l) => l.found && !isBuiltinPath(l.path)).map((l) => l.path);
      const out: Row[] = [];
      for (const path of paths) {
        const dt1 = await gd.dt1(path);
        if (!dt1) continue;
        const images = dt1.tiles.map((t) => decodeTile(t));
        let unsafePixels = 0, pixels = 0, unsafeTiles = 0;
        const perTile = images.map((img) => {
          let n = 0;
          if (img)
            for (const p of img.pixels) {
              if (!p) continue;
              pixels++;
              if (!a0.usable[p]) n++;
            }
          unsafePixels += n;
          if (n) unsafeTiles++;
          return n;
        });
        const samples = perTile
          .map((n, i) => [n, i] as const)
          .filter(([n]) => n > 0)
          .sort((a, b) => b[0] - a[0])
          .slice(0, 4)
          .map(([, i]) => i);
        const source = gd.fs.locate(path) ?? '';
        out.push({ path, source, fromArchive: /\.mpq$/i.test(source), dt1, images, unsafePixels, pixels, unsafeTiles, samples });
      }
      if (!live) return;
      setAct0(a0);
      setActs(pals);
      setRows(out);
      // Drawn for: the act its folder names, else Act 1. Converted by default: DT1s in a folder (a mod's own, or
      // imported) drawn for another act and using act-specific colours. Game archives are shared by the game's maps.
      // Drawn for: the act its folder names, else the one its art fits (never simply this map's act).
      setFrom(Object.fromEntries(out.map((r) => [r.path, actFromPath(r.path) ?? guessDrawnAct(r.dt1.tiles, pals) ?? mapAct])));
      // A DT1 with an act-safe copy loaded too: the map mixes the two, and removing this one is the fix, not converting it.
      const safeCopy = new Set(
        duplicateDt1s(map.lib).flatMap((d) => [
          ...(out.find((r) => r.path === d.later)?.unsafePixels === 0 ? [d.earlier] : []),
          ...(out.find((r) => r.path === d.earlier)?.unsafePixels === 0 ? [d.later] : []),
        ]),
      );
      // Act 0 is the standard: every DT1 still using colours that change between acts is converted (unless an act-safe
      // copy of it is loaded too, where removing it is the fix).
      setOn(Object.fromEntries(out.map((r) => [r.path, r.unsafePixels > 0 && !safeCopy.has(r.path)])));
    })().catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [map, gd, mapAct]);

  /** Per drawn-for act: every colour snapped to the nearest Act 0 colour, as it looks in that act. */
  const remaps = useMemo(() => (act0 && acts ? acts.map((p) => act0Remap(p, act0.usable)) : null), [act0, acts]);
  /** Per drawn-for act: the map's palette showing each index as it looks once converted (Act 0 colours are the same in every act). */
  const afterPalettes = useMemo(
    () =>
      remaps?.map((r) => {
        const out = map.palette.slice();
        for (let i = 1; i < 256; i++) out.set(map.palette.subarray(r[i] * 4, r[i] * 4 + 4), i * 4);
        return out;
      }) ?? null,
    [remaps, map.palette],
  );
  const chosen = rows?.filter((r) => on[r.path]) ?? [];
  /** Per DT1: the other copy of the same tiles loaded by this map, if any. */
  const copies = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of duplicateDt1s(map.lib)) {
      m.set(d.earlier, d.later);
      m.set(d.later, d.earlier);
    }
    return m;
  }, [map]);
  const unsafeOf = (path: string) => rows?.find((r) => r.path === path)?.unsafePixels ?? 0;
  /** DT1s that have an act-safe copy loaded too: removing them fixes the map without changing any file. */
  const redundant = rows?.filter((r) => r.unsafePixels > 0 && copies.has(r.path) && unsafeOf(copies.get(r.path)!) === 0).map((r) => r.path) ?? [];
  const remove = async (paths: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await onRemove(paths);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!remaps) return;
    setBusy(true);
    setError(null);
    try {
      const files = [];
      for (const r of chosen) {
        const bytes = await gd.fs.read(r.path);
        if (!bytes) throw new Error(`${r.path} could not be read`);
        files.push({ path: r.path, bytes: recolorDt1(bytes, remaps[from[r.path]]) });
      }
      await onApply(files);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Make this map's tiles act-safe" onClose={onClose} wide>
      <p className="small">
        DT1s store palette numbers, not colours. About 30 of the 256 colours change between acts, so tiles drawn for one act can show odd
        colours (often red or purple) in a map of another act — here and in the game. This converts those colours to the nearest of the 225
        colours that look the same in every act (Act 0), judged by how they look in the act the tiles were drawn for.{' '}
        <HelpTip text="Pick the act each DT1 was drawn for: the “after” preview should look right. Pixels already using Act 0 colours don't change. The DT1s are saved into your mod folder over the ones this map uses (the originals are kept as .bak the first time); every map using them gets the new colours." />
      </p>
      <p className="small muted">
        This map is drawn with the <b>{PALETTE_NAMES[map.paletteAct]}</b> palette.
      </p>
      {redundant.length > 0 && (
        <div className="imp-callout small actsafe-callout">
          <b>{redundant.length} of these DT1s also have an act-safe copy in this map.</b> The map loads both copies of the same tiles, and
          where a tile has random variants the game picks among both, so some cells show the act-specific colours at random. Removing the
          copies that aren't act-safe from this map's tile libraries fixes it without changing any DT1.{' '}
          <button className="btn small" disabled={busy} onClick={() => void remove(redundant)}>
            Remove {redundant.length} duplicate cop{redundant.length === 1 ? 'y' : 'ies'} from this map
          </button>
        </div>
      )}
      {!rows && !error && <p className="small">Checking the map's tile libraries…</p>}
      {rows && (
        <div className="actsafe-list">
          {rows.map((r) => {
            const act = from[r.path] ?? 0;
            const pct = r.pixels ? (r.unsafePixels / r.pixels) * 100 : 0;
            return (
              <div key={r.path} className={`actsafe-row${on[r.path] ? '' : ' off'}`}>
                <label className="actsafe-name">
                  <input type="checkbox" checked={!!on[r.path]} disabled={!r.unsafePixels} onChange={(e) => setOn((o) => ({ ...o, [r.path]: e.target.checked }))} />
                  <span className="mono small">{short(r.path)}</span>
                </label>
                <div className="small muted">
                  {r.unsafePixels
                    ? `${r.unsafeTiles} of ${r.dt1.tiles.length} tiles use act-specific colours (${pct < 0.1 ? '<0.1' : pct.toFixed(1)}% of pixels)`
                    : `${r.dt1.tiles.length} tiles · already act-safe`}
                  {r.fromArchive && r.unsafePixels > 0 && <span className="warn-text"> · from {r.source.split('/').pop()}: a converted copy in your mod changes every game map using it</span>}
                  {copies.has(r.path) && <span className="warn-text"> · same tiles as {short(copies.get(r.path)!)}{unsafeOf(copies.get(r.path)!) === 0 ? ' (act-safe)' : ''}</span>}
                </div>
                {r.unsafePixels > 0 && (
                  <>
                    <label className="small">
                      Drawn for{' '}
                      <select value={act} onChange={(e) => setFrom((f) => ({ ...f, [r.path]: Number(e.target.value) }))}>
                        {[0, 1, 2, 3, 4].map((a) => (
                          <option key={a} value={a}>
                            {PALETTE_NAMES[a]}
                            {a === mapAct ? ' (this map)' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    {afterPalettes && (
                      <div className="actsafe-samples">
                        <span className="small muted">now</span>
                        {[0, 1, 2, 3].map((k) => (r.images[r.samples[k]] ? <ImageThumb key={`b${k}`} image={r.images[r.samples[k]]!} palette={map.palette} /> : <span key={`b${k}`} />))}
                        <span className="small muted">after</span>
                        {[0, 1, 2, 3].map((k) => (r.images[r.samples[k]] ? <ImageThumb key={`a${k}`} image={r.images[r.samples[k]]!} palette={afterPalettes[act]} /> : <span key={`a${k}`} />))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && <p className="error-text small">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!canSave || busy || !chosen.length} onClick={() => void apply()} title={canSave ? undefined : 'No writable mod folder'}>
          {busy ? 'Saving…' : `Convert ${chosen.length} DT1${chosen.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </Modal>
  );
}
