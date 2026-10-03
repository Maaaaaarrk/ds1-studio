import { useEffect, useMemo, useRef, useState } from 'react';
import type { Palette } from '../formats/palette';
import { readPng, toPaletteIndices, type PngImage } from '../formats/png';
import { getCell, serializeTxtTable, type TxtTableDoc } from '../formats/txtTable';
import { loadAct0Palette } from '../game/act0Palette';
import { customObjectFiles, customObjectRow, freeToken, fromGameArchive, gameRows, objectSlots, objGroupRows, guessFrames, presetRow, rowRecord, scanRowUse, splitStrip, startingPoint, vanillaRowUse, type ObjectSlot, type StartingPoint } from '../game/customObject';
import { objectSpec } from '../game/objectCatalog';
import { loadSpriteAnimation } from '../game/spriteAnim';
import type { SpriteSpec } from '../game/sprites';
import type { GameData } from '../game/GameData';
import { loadTable } from '../game/levelTables';
import { importBytes } from '../vfs/save';
import { Modal } from './Dialogs';
import { HelpTip } from './HelpTip';

export interface CustomObjectResult {
  files: { path: string; bytes: Uint8Array }[];
  act0: number;
  id: number;
  name: string;
}

interface Props {
  gd: GameData;
  /** The act (0-4) to start in: the open map's. */
  act0: number;
  canWrite: boolean;
  onCreate: (r: CustomObjectResult) => Promise<void>;
  onClose: () => void;
}

const TOKEN_OK = /^[a-z0-9]{2}$/;
/** Maps scanned for the objects they place, per game data (the scan reads every map once). */
const usageCache = new WeakMap<GameData, Promise<Map<number, number>>>();

/**
 * Game → Custom object…: a picture of your own made into an object placed like the game's. It takes over an
 * objects.txt row that nothing uses (see game/customObject.ts), writes the row and the graphics into the mod, and the
 * object is then in the Objects gallery of its act under its id.
 */
export function CustomObjectDialog({ gd, act0: initialAct, canWrite, onCreate, onClose }: Props) {
  const presets = gd.objectPresets;
  const [act0, setAct] = useState(Math.min(4, Math.max(0, initialAct)));
  const [objects, setObjects] = useState<TxtTableDoc | null>(null);
  const [groups, setGroups] = useState<Set<number>>(new Set());
  const [uses, setUses] = useState<Map<number, number> | null>(null);
  const [scan, setScan] = useState('');
  const [slotId, setSlotId] = useState<number | null>(null);
  const [showTaken, setShowTaken] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [png, setPng] = useState<{ img: PngImage; file: string } | null>(null);
  /** Frames taken from an object (yours, to edit, or any other to start from) instead of a PNG. */
  const [start, setStart] = useState<{ point: StartingPoint; from: string } | null>(null);
  /** Where the object stands, from the picture's left edge (null: its centre). */
  const [anchorX, setAnchorX] = useState<number | null>(null);
  const [startId, setStartId] = useState('');
  const [loadingStart, setLoadingStart] = useState(false);
  const [frames, setFrames] = useState(1);
  const [fps, setFps] = useState(12);
  const [feet, setFeet] = useState(0);
  const [light, setLight] = useState(0);
  const [lightHex, setLightHex] = useState('#ffd890');
  const [flicker, setFlicker] = useState(true);
  const [blocks, setBlocks] = useState(true);
  const [size, setSize] = useState(2);
  const [drawUnder, setDrawUnder] = useState(false);
  const [shared, setShared] = useState(true);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [usable, setUsable] = useState<boolean[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  // The tables, then every map's objects (once per session: it reads each map).
  useEffect(() => {
    let live = true;
    void (async () => {
      const [o, g] = await Promise.all([loadTable(gd.fs, 'objects.txt'), loadTable(gd.fs, 'ObjGroup.txt')]);
      if (!live) return;
      if (!o) return setError('objects.txt was not found.');
      setObjects(o);
      setGroups(objGroupRows(g));
      setToken((t) => t || freeToken(gd.fs, o));
      if (!presets) return;
      let p = usageCache.get(gd);
      if (!p) {
        // The game's own maps are known; only the mod's (new or changed) ones are read.
        const maps = gd.fs.list((x) => x.endsWith('.ds1') && x.startsWith('data/global/tiles/')).filter((x) => !fromGameArchive(gd.fs, x));
        p = scanRowUse(gd.fs, presets, maps, (done, total) => live && setScan(`Checking which objects your maps use… ${done} of ${total}`), vanillaRowUse(presets));
        usageCache.set(gd, p);
      }
      const u = await p;
      if (live) (setUses(u), setScan(''));
    })().catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [gd, presets]);

  useEffect(() => {
    let live = true;
    void Promise.all([gd.palette(act0), loadAct0Palette(gd.fs).catch(() => null)]).then(([p, a0]) => {
      if (!live) return;
      setPalette(p);
      setUsable(a0?.usable ?? null);
    });
    return () => {
      live = false;
    };
  }, [gd, act0]);

  const slots = useMemo(() => (presets && objects && uses ? objectSlots(presets, objects, act0, uses, groups) : []), [presets, objects, uses, groups, act0]);
  const offered = slots.filter((s) => s.free || showTaken);
  const slot = slots.find((s) => s.id === slotId && (s.free || false)) ?? null;
  // Picking a free slot again (in another act, or after a scan): the first free one; a custom one brings its settings.
  useEffect(() => {
    if (slotId !== null && slots.some((s) => s.id === slotId && s.free)) return;
    setSlotId(slots.find((s) => s.free && !s.custom)?.id ?? slots.find((s) => s.free)?.id ?? null);
  }, [slots]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Takes an object's frames and settings as the starting point (its colours are kept as they are). */
  const loadFrom = async (spec: SpriteSpec | null, row: Record<string, string>, from: string) => {
    if (!spec) throw new Error(`${from} has no graphics to start from.`);
    const anim = await loadSpriteAnimation(gd.fs, spec, spec.direction ?? 0);
    if (!anim?.frames.length) throw new Error(`${from}'s graphics weren't found (data/global/objects/${spec.token}/).`);
    const point = startingPoint(anim, row, spec.mode);
    setPng(null);
    setStart({ point, from });
    setFrames(point.frames.length);
    setFps(point.fps);
    setFeet(point.feet);
    setAnchorX(point.anchorX);
    setLight(point.light);
    setLightHex(`#${point.lightColour.map((c) => Math.min(255, c).toString(16).padStart(2, '0')).join('')}`);
    setFlicker(point.flicker);
    setBlocks(point.blocks);
    setSize(point.size);
    setDrawUnder(point.drawUnder);
  };
  const run = (f: () => Promise<void>) => {
    setError(null);
    setLoadingStart(true);
    f()
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoadingStart(false));
  };
  // One of yours: everything comes back, its picture included, to change what you like and save it again.
  useEffect(() => {
    if (!slot?.custom || !objects) return;
    const line = gameRows(objects)[slot.row];
    const row = rowRecord(objects, line);
    setName(slot.name);
    setToken(getCell(objects, line, 'Token').toLowerCase());
    run(() => loadFrom(objectSpec(row), row, slot.name));
  }, [slot?.row, slot?.custom]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setStartId(''), [act0]);
  /** Objects of the act with graphics, to start from. */
  const startable = useMemo(() => gd.objectList(act0).filter((o) => o.type === 2 && o.hasSprite), [gd, act0]);
  const startFrom = (id: number) => {
    if (!objects || !presets) return;
    const entry = startable.find((o) => o.id === id);
    const line = gameRows(objects)[presetRow(presets, act0, id)];
    if (!entry || line === undefined) return;
    const label = entry.name.replace(/\s*\([^)]*\)\s*$/, '');
    run(async () => {
      await loadFrom(gd.objectSpec(act0, 2, id), rowRecord(objects, line), label);
      if (!slot?.custom) setName((n) => (n && n !== 'My object' ? n : `${label} (custom)`.slice(0, 40)));
    });
  };

  // The picture as palette indices, cut into its frames.
  const cut = useMemo(() => {
    if (start) return { frames: start.point.frames, remapped: 0, problem: null as string | null };
    if (!png || !palette) return null;
    try {
      const { pixels, remapped } = toPaletteIndices(png.img, palette, shared ? usable : null);
      return { frames: splitStrip(png.img.width, png.img.height, pixels, frames), remapped, problem: null as string | null };
    } catch (e) {
      return { frames: [], remapped: 0, problem: (e as Error).message };
    }
  }, [png, start, palette, usable, shared, frames]);

  // Preview: the frames playing at the chosen speed, on a dark ground with the object's spot marked.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !cut?.frames.length || !palette) return;
    const f0 = cut.frames[0];
    const scale = Math.max(1, Math.min(3, Math.floor(240 / Math.max(f0.width, f0.height))));
    c.width = f0.width * scale;
    c.height = (f0.height + Math.max(0, -feet) + 8) * scale;
    const ctx = c.getContext('2d')!;
    let k = 0;
    const draw = () => {
      const f = cut.frames[k % cut.frames.length];
      const img = ctx.createImageData(f.width, f.height);
      for (let i = 0; i < f.pixels.length; i++) {
        const p = f.pixels[i];
        if (p) img.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], i * 4);
      }
      ctx.fillStyle = '#1c1f1a';
      ctx.fillRect(0, 0, c.width, c.height);
      const tmp = document.createElement('canvas');
      tmp.width = f.width;
      tmp.height = f.height;
      tmp.getContext('2d')!.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, f.width * scale, f.height * scale);
      // Where the object stands (its spot in the map).
      const y = (f.height - feet) * scale;
      ctx.fillStyle = '#e8b04a';
      ctx.fillRect((anchorX ?? Math.floor(f.width / 2)) * scale - 3, y - 1, 7, 3);
      k++;
    };
    draw();
    if (cut.frames.length < 2) return;
    const t = setInterval(draw, 1000 / Math.max(1, fps));
    return () => clearInterval(t);
  }, [cut, palette, fps, feet, anchorX]);

  const pickPng = async () => {
    setError(null);
    const bytes = await importBytes('png');
    if (!bytes) return;
    try {
      const img = readPng(bytes);
      setPng({ img, file: 'picture.png' });
      setStart(null);
      setAnchorX(null);
      // A strip: guess the frame count from the see-through gaps between frames.
      setFrames(guessFrames(img.width, img.height, (x, y) => img.rgba[(y * img.width + x) * 4 + 3] >= 128));
      if (!name) setName('My object');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const nameProblem = !name.trim() ? 'give it a name' : !/^[\x20-\x7e]{1,40}$/.test(name) ? 'plain letters, digits and spaces (up to 40)' : null;
  const tokenTaken =
    !!objects && objects.rows.some((_, i) => getCell(objects, i, 'Token').toLowerCase() === token && !(slot?.custom && gameRows(objects)[slot.row] === i));
  const tokenProblem = !TOKEN_OK.test(token) ? 'two letters or digits' : tokenTaken ? 'another object uses it' : null;
  const ready = !!slot && !!objects && !!cut?.frames.length && !cut.problem && !nameProblem && !tokenProblem && canWrite;

  const create = async () => {
    if (!ready || !slot || !objects || !cut) return;
    setBusy(true);
    setError(null);
    try {
      const rgb = [1, 3, 5].map((i) => parseInt(lightHex.slice(i, i + 2), 16)) as [number, number, number];
      const doc = customObjectRow(objects, slot.row, {
        name: name.trim(),
        token,
        frames: cut.frames.length,
        speed: Math.round((fps / 25) * 256),
        light,
        lightColour: rgb,
        flicker,
        blocks,
        size,
        drawUnder,
        act0,
      });
      const files = [...customObjectFiles(token, cut.frames, feet, anchorX ?? undefined), { path: gd.fs.exactPath('data/global/excel/objects.txt') ?? 'data/global/excel/objects.txt', bytes: serializeTxtTable(doc) }];
      await onCreate({ files, act0, id: slot.id, name: name.trim() });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const describe = (s: ObjectSlot) =>
    s.custom ? 'yours (made here)' : s.free ? 'free' : [s.uses ? `${s.uses} placed in maps` : '', s.inGroup ? 'spawned by ObjGroup' : '', s.functions ? 'game function' : ''].filter(Boolean).join(', ');

  return (
    <Modal title="Custom object" wide onClose={() => !busy && onClose()}>
      <p className="small">
        Turns a picture of yours into an object you place like the game&apos;s own. The game decides which object an id means from a fixed table in its
        program files, so a new object takes over an <span className="mono">objects.txt</span> row that nothing uses: no map places it, no object group
        spawns it and the game runs nothing for it. The row becomes a plain decoration; your picture is saved under{' '}
        <span className="mono">data/global/objects/{token || '??'}/</span>.
      </p>
      {!presets && <p className="error-text small">The game&apos;s object table wasn&apos;t found in its program files, so ids can&apos;t be matched to rows.</p>}
      <div className="form-row">
        <span>Act</span>
        <span className="entry-row">
          <select value={act0} onChange={(e) => setAct(Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map((a) => (
              <option key={a} value={a}>
                Act {a + 1}
              </option>
            ))}
          </select>
          <HelpTip text="Each act has its own 150 object ids. A map places objects from its own act (and from other acts with negative or large ids, as the Objects gallery shows)." />
        </span>
      </div>
      <div className="form-row">
        <span>Object id</span>
        <span className="entry-row">
          {uses ? (
            <select value={slotId ?? ''} onChange={(e) => setSlotId(Number(e.target.value))}>
              {offered.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.free}>
                  {s.id} · row {s.row} · {s.name} ({describe(s)})
                </option>
              ))}
            </select>
          ) : (
            <span className="muted small">{scan || 'Reading the tables…'}</span>
          )}
          <label className="small">
            <input type="checkbox" checked={showTaken} onChange={(e) => setShowTaken(e.target.checked)} /> list the taken ones too
          </label>
        </span>
      </div>
      {uses && !slots.some((s) => s.free) && <p className="warn-text small">Act {act0 + 1} has no free object row. Try another act.</p>}
      <label className="form-row">
        <span>Name</span>
        <span className="entry-row">
          <input className="text-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          {nameProblem && name && <span className="error-text small">{nameProblem}</span>}
        </span>
      </label>
      <label className="form-row">
        <span>
          Token <HelpTip text="The object's two-character code: the folder its graphics go in (data/global/objects/<token>/) and the start of their file names. Picked free; any two letters or digits no other object uses." />
        </span>
        <span className="entry-row">
          <input className="text-input mono" style={{ width: 60 }} value={token} maxLength={2} onChange={(e) => setToken(e.target.value.toLowerCase())} onKeyDown={(e) => e.stopPropagation()} />
          {tokenProblem && <span className="error-text small">{tokenProblem}</span>}
        </span>
      </label>
      <div className="form-row">
        <span>Picture</span>
        <span className="entry-row">
          <button className="btn small" onClick={() => void pickPng()}>
            {png ? 'Another PNG…' : 'Choose a PNG…'}
          </button>
          {png && (
            <span className="small muted">
              {png.img.width}×{png.img.height}
            </span>
          )}
          <HelpTip text="One image, or an animation as a strip: the frames side by side, all the same width. Transparent pixels stay see-through. Its colours are matched to the game's palette." />
          <span className="muted small">or</span>
          <select
            value={startId}
            disabled={!objects || loadingStart}
            onChange={(e) => {
              setStartId(e.target.value);
              if (e.target.value !== '') startFrom(Number(e.target.value));
            }}
            title="Start from an object of this act that has graphics: its picture (all its frames, colours as they are) and its light, collision and size become the starting point"
          >
            <option value="">Start from an existing object…</option>
            {startable.map((o) => (
              <option key={o.id} value={o.id}>
                {o.id} · {o.name}
              </option>
            ))}
          </select>
        </span>
      </div>
      {loadingStart && <p className="small muted">Loading its graphics…</p>}
      {start && (
        <p className="small muted">
          Picture from <b>{start.from}</b>: {start.point.frames.length} frame{start.point.frames.length === 1 ? '' : 's'}, {start.point.frames[0].width}×{start.point.frames[0].height}, colours as they are. Choose a PNG to use your own picture instead.
        </p>
      )}
      {(png || start) && (
        <>
          <div className="form-row">
            <span>Frames</span>
            <span className="entry-row">
              <input type="number" min={1} max={64} value={frames} disabled={!!start} title={start ? 'The frames of the object it starts from' : undefined} onChange={(e) => setFrames(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} style={{ width: 60 }} />
              {frames > 1 && (
                <label className="small">
                  at <input type="number" min={1} max={25} value={fps} onChange={(e) => setFps(Math.max(1, Math.min(25, Number(e.target.value) || 1)))} style={{ width: 50 }} /> frames a second
                </label>
              )}
            </span>
          </div>
          <div className="form-row">
            <span>
              Stands at <HelpTip text="How far above the picture's bottom edge its base is (the spot it stands on in the map, marked in yellow): 0 for something standing on the ground, more for a picture with a shadow or ground below its base." />
            </span>
            <span className="entry-row">
              <input type="number" min={-200} max={400} value={feet} onChange={(e) => setFeet(Number(e.target.value) || 0)} style={{ width: 60 }} />
              <span className="small muted">pixels above the bottom</span>
            </span>
          </div>
          <div className="custom-object-preview">
            {cut?.problem ? <span className="error-text small">{cut.problem}</span> : <canvas ref={canvas} />}
          </div>
          <label className="small" hidden={!!start}>
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> only colours that look the same in every act
            <HelpTip text="On: it looks the same placed in any act (some colours, dark greens especially, come out a little duller). Off: the closest colours of Act N's palette, exact in that act's levels but possibly off in others'." />
          </label>
          {cut && cut.remapped > 0 && <p className="small muted">{cut.remapped} pixels took the nearest palette colour.</p>}
        </>
      )}
      <div className="form-row">
        <span>Light</span>
        <span className="entry-row">
          <input type="range" min={0} max={20} value={light} onChange={(e) => setLight(Number(e.target.value))} />
          <span className="small">{light ? `radius ${light}` : 'none'}</span>
          {light > 0 && (
            <>
              <input type="color" value={lightHex} onChange={(e) => setLightHex(e.target.value)} />
              <label className="small">
                <input type="checkbox" checked={flicker} onChange={(e) => setFlicker(e.target.checked)} /> flickers
              </label>
            </>
          )}
        </span>
      </div>
      <div className="form-row">
        <span>Ground</span>
        <span className="entry-row">
          <label className="small">
            <input type="checkbox" checked={blocks} onChange={(e) => setBlocks(e.target.checked)} /> blocks walking
          </label>
          {blocks && (
            <label className="small">
              over <input type="number" min={1} max={15} value={size} onChange={(e) => setSize(Math.max(1, Math.min(15, Number(e.target.value) || 1)))} style={{ width: 50 }} /> sub-tiles each way (5 a cell)
            </label>
          )}
          <label className="small">
            <input type="checkbox" checked={drawUnder} onChange={(e) => setDrawUnder(e.target.checked)} /> drawn under characters (a rug, a decal)
          </label>
        </span>
      </div>
      {slot && (
        <p className="small muted">
          Saves Act {act0 + 1} object id <b>{slot.id}</b> as <b>{name.trim() || '…'}</b>: objects.txt row {slot.row} ({slot.custom ? 'your custom object, updated' : `was “${slot.name}”`}) and its graphics,{' '}
          <span className="mono">
            data/global/objects/{token}/cof/{token}nuhth.cof
          </span>{' '}
          and <span className="mono">tr/{token}trlitnuhth.dc6</span>. Files it replaces are kept as .bak. If your game reads compiled .bin tables, rebuild objects.bin.
        </p>
      )}
      {!canWrite && <p className="error-text small">No writable mod folder is set up.</p>}
      {error && <p className="error-text small">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ready || busy} onClick={() => void create()}>
          {busy ? 'Saving…' : slot?.custom ? 'Update the object' : 'Create the object'}
        </button>
      </div>
    </Modal>
  );
}
