import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dt1Tile, TileImage } from '../formats/dt1';
import type { TileSettings } from '../formats/dt1Header';
import type { Palette } from '../formats/palette';
import { HelpTip } from './HelpTip';
import { ORIENTATION_NAMES } from './state';

/** The eight sub-tile flag bits, as DS1Edit / DT1 Tools users know them. */
export const FLAG_BITS: { bit: number; name: string; color: string; help: string }[] = [
  { bit: 0x01, name: 'Block walk', color: '#ff9f40', help: 'Nobody can walk here — players, mercenaries or monsters. Used for walls, rocks, water, cliffs.' },
  { bit: 0x02, name: 'Block light & sight', color: '#5ad15a', help: 'Blocks light and line of sight: you can’t see (or target) through it. Walls usually have this with “Block walk”.' },
  { bit: 0x04, name: 'Block jump / teleport', color: '#4da3ff', help: 'Can’t leap or teleport onto this spot (Barbarian Leap, Sorceress Teleport…).' },
  { bit: 0x08, name: 'Block player walk', color: '#b77dff', help: 'Players can’t walk here but mercenaries and monsters can (used for doorways and edges the player shouldn’t cross).' },
  { bit: 0x10, name: 'Block missiles', color: '#ffe14d', help: 'Arrows, bolts and other missiles stop here even though units might walk it.' },
  { bit: 0x20, name: 'Block light', color: '#7fe3ff', help: 'Blocks light only (not sight or movement): makes the area behind it darker.' },
  { bit: 0x40, name: 'Monster-only block', color: '#f0f0f0', help: 'Monsters can’t walk here but players can.' },
  { bit: 0x80, name: 'Reserved / unknown', color: '#8b8b95', help: 'Unused by the game as far as anyone knows; kept as it is.' },
];

/** Plain-language explanations of every field in a DT1 Tools .ini block. */
export const FIELD_HELP: Record<string, string> = {
  direction:
    'How the game groups the tile when building walls and floors (DT1 Tools “direction”). Floors use 3; walls and other kinds keep the value they came with. Only change it if you know the tile is filed under the wrong kind.',
  roof_y: 'For roofs: how many pixels above the floor the roof is drawn. For everything else it is 0.',
  tile_sound: 'Which footstep sound plays when walking on this tile (0 = the level’s default). Grass, stone, wood and so on each have a number.',
  animated: 'On: this floor tile is one frame of an animation (water, lava). All frames share the same numbers and “frame” gives their order.',
  orientation: 'What kind of tile this is: floor, left/right wall, corner, door, tree/object, roof, shadow, lower wall… The map (DS1) asks for tiles by this kind.',
  main_index: 'First part of the tile’s number. A map cell asks for “kind + main + sub”, and the game uses the tile with those numbers.',
  sub_index: 'Second part of the tile’s number (together with kind and main index it picks the tile).',
  frame:
    'For normal tiles: the “rarity” — when several tiles share the same numbers, how often this one is picked at random (higher = more often, 0 = only if nothing else). For animated tiles: which frame of the animation this is.',
  unknown: 'A value the game stores but nobody has figured out. DS1 Studio keeps it as it is unless you change it.',
  flags: 'The tile’s 25 sub-tiles (a 5×5 grid over its floor diamond) decide where units can walk, see through, teleport and so on. Pick a flag, then click or drag on the grid.',
};

const ORIENTATIONS = Object.entries(ORIENTATION_NAMES).map(([o, name]) => ({ o: Number(o), name }));

interface Props {
  tiles: { index: number; tile: Dt1Tile; image: TileImage | null }[];
  palette: Palette;
  /** Current settings (with pending edits) of each selected tile. */
  settingsOf: (index: number) => TileSettings;
  /** Which fields/flags differ from the file (to mark edits). */
  changed: (index: number) => boolean;
  onChange: (patch: Partial<TileSettings>, flagsFor?: (current: Uint8Array) => Uint8Array) => void;
  onRevert: () => void;
}

/** Editing a DT1 tile's .ini settings: every field with an explanation, and the 5×5 sub-tile flags visually. */
export function TileSettingsPanel({ tiles, palette, settingsOf, changed, onChange, onRevert }: Props) {
  if (!tiles.length)
    return (
      <p className="muted small">
        Click a tile (Shift+click for several) to edit its settings — everything a DT1 Tools .ini holds for it, including the walkability sub-tiles.
      </p>
    );
  const all = tiles.map((t) => settingsOf(t.index));
  const same = <K extends keyof TileSettings>(k: K) => all.every((s) => JSON.stringify(s[k]) === JSON.stringify(all[0][k]));
  const val = <K extends keyof TileSettings>(k: K) => (same(k) ? all[0][k] : undefined);
  const one = tiles.length === 1 ? tiles[0] : null;

  const num = (label: string, key: 'direction' | 'roofHeight' | 'sound' | 'mainIndex' | 'subIndex' | 'frame' | 'unknown', help: string, opts: { min?: number; max?: number; hex?: boolean } = {}) => {
    const v = val(key) as number | undefined;
    return (
      <label className="ts-field">
        <span>
          {label} <HelpTip text={help} />
        </span>
        <input
          className={`text-input mono${v === undefined ? ' mixed' : ''}`}
          value={v === undefined ? '' : opts.hex ? (v >>> 0).toString(16).toUpperCase().padStart(8, '0') : String(v)}
          placeholder={v === undefined ? 'mixed' : ''}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === '') return;
            let n = opts.hex ? parseInt(raw, 16) : Number(raw);
            if (!Number.isFinite(n)) return;
            if (opts.min !== undefined) n = Math.max(opts.min, n);
            if (opts.max !== undefined) n = Math.min(opts.max, n);
            onChange({ [key]: n } as Partial<TileSettings>);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
    );
  };

  return (
    <div className="ts">
      <div className="ts-head">
        <b>{one ? `Tile #${one.index}` : `${tiles.length} tiles`}</b>
        <span className="muted small">{one ? `${ORIENTATION_NAMES[one.tile.orientation] ?? ''} · ${one.tile.width}×${Math.abs(one.tile.height)}` : 'changes apply to all of them'}</span>
        {tiles.some((t) => changed(t.index)) && (
          <button className="link small" onClick={onRevert}>
            revert
          </button>
        )}
      </div>

      <SubtileEditor tiles={tiles} palette={palette} flagsOf={(i) => settingsOf(i).flags} onFlags={(fn) => onChange({}, fn)} />

      <div className="ts-fields">
        <label className="ts-field">
          <span>
            Kind (orientation) <HelpTip text={FIELD_HELP.orientation} />
          </span>
          <select value={val('orientation') ?? ''} onChange={(e) => onChange({ orientation: Number(e.target.value) })}>
            {val('orientation') === undefined && <option value="">mixed</option>}
            {ORIENTATIONS.map((x) => (
              <option key={x.o} value={x.o}>
                {x.o} · {x.name}
              </option>
            ))}
          </select>
        </label>
        {num('Main index', 'mainIndex', FIELD_HELP.main_index, { min: 0, max: 63 })}
        {num('Sub index', 'subIndex', FIELD_HELP.sub_index, { min: 0, max: 255 })}
        {num('Frame / rarity', 'frame', FIELD_HELP.frame, { min: 0 })}
        <label className="ts-field">
          <span>
            Animated <HelpTip text={FIELD_HELP.animated} />
          </span>
          <input type="checkbox" checked={!!val('animated')} ref={(el) => el && (el.indeterminate = val('animated') === undefined)} onChange={(e) => onChange({ animated: e.target.checked })} />
        </label>
        {num('Footstep sound', 'sound', FIELD_HELP.tile_sound, { min: 0, max: 255 })}
        {num('Roof height', 'roofHeight', FIELD_HELP.roof_y, { min: -32768, max: 32767 })}
        {num('Direction', 'direction', FIELD_HELP.direction)}
        {num('Unknown', 'unknown', FIELD_HELP.unknown, { hex: true })}
      </div>
      <p className="muted tiny-note">Field names in DT1 Tools .ini files: orientation, main_index, sub_index, frame, animated, tile_sound, roof_y, direction, unknown, floor_flag1–5.</p>
    </div>
  );
}

/** The 5×5 sub-tiles over the tile's floor diamond, coloured by their flags; click or drag to set or clear a flag. */
export function SubtileEditor({ tiles, palette, flagsOf, onFlags, maxSize = 300 }: {
  tiles: { index: number; tile: Dt1Tile; image: TileImage | null }[];
  palette: Palette;
  /** Current flags (25, file order) of each tile. */
  flagsOf: (index: number) => Uint8Array;
  onFlags: (fn: (current: Uint8Array) => Uint8Array) => void;
  /** Largest canvas side in pixels. */
  maxSize?: number;
}) {
  const [bit, setBit] = useState(0x01);
  const [show, setShow] = useState<'all' | 'bit'>('all');
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ set: boolean; done: Set<number> } | null>(null);
  const first = tiles[0];
  const flags = flagsOf(first.index);
  const mixed = tiles.some((t) => flagsOf(t.index).some((f, i) => f !== flags[i]));

  // Layout: the image and the cell diamond in tile coordinates, scaled to fit.
  const layout = useMemo(() => {
    const t = first.tile;
    const img = first.image;
    // The cell's top vertex in tile coordinates (see placeTile): floors (80,0), roofs (80,roofHeight), others (80,-80).
    const topY = t.orientation === 0 ? 0 : t.orientation === 15 ? t.roofHeight : -80;
    const x0 = Math.min(img?.offsetX ?? 0, 0);
    const y0 = Math.min(img?.offsetY ?? 0, topY);
    const x1 = Math.max((img?.offsetX ?? 0) + (img?.width ?? 0), 160);
    const y1 = Math.max((img?.offsetY ?? 0) + (img?.height ?? 0), topY + 80);
    const scale = Math.min(maxSize / (x1 - x0), maxSize / (y1 - y0), 3);
    return { topY, x0, y0, w: x1 - x0, h: y1 - y0, scale };
  }, [first, maxSize]);

  // Sub-tile t (file order) → its diamond centre in canvas pixels.
  const centre = (t: number): [number, number] => {
    const sx = t % 5;
    const sy = 4 - Math.floor(t / 5);
    const x = 80 + (sx - sy) * 16;
    const y = layout.topY + (sx + sy) * 8 + 8;
    return [(x - layout.x0) * layout.scale, (y - layout.y0) * layout.scale];
  };

  useEffect(() => {
    const c = canvas.current!;
    const W = Math.ceil(layout.w * layout.scale);
    const H = Math.ceil(layout.h * layout.scale);
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#0d0e12';
    ctx.fillRect(0, 0, W, H);
    const img = first.image;
    if (img) {
      const tmp = document.createElement('canvas');
      tmp.width = img.width;
      tmp.height = img.height;
      const tctx = tmp.getContext('2d')!;
      const d = tctx.createImageData(img.width, img.height);
      for (let i = 0; i < img.pixels.length; i++) {
        const p = img.pixels[i];
        if (p) d.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], i * 4);
      }
      tctx.putImageData(d, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(tmp, (img.offsetX - layout.x0) * layout.scale, (img.offsetY - layout.y0) * layout.scale, img.width * layout.scale, img.height * layout.scale);
      ctx.globalAlpha = 1;
    }
    const hw = 16 * layout.scale;
    const hh = 8 * layout.scale;
    for (let t = 0; t < 25; t++) {
      const [cx, cy] = centre(t);
      const f = flags[t];
      ctx.beginPath();
      ctx.moveTo(cx, cy - hh);
      ctx.lineTo(cx + hw, cy);
      ctx.lineTo(cx, cy + hh);
      ctx.lineTo(cx - hw, cy);
      ctx.closePath();
      const bits = FLAG_BITS.filter((b) => f & b.bit && (show === 'all' || b.bit === bit));
      if (bits.length) {
        ctx.fillStyle = bits[0].color + (bits.length > 1 ? 'cc' : '99');
        ctx.fill();
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.stroke();
      if (layout.scale >= 1.2) {
        ctx.font = `${Math.round(8 * layout.scale * 0.9)}px ui-monospace, monospace`;
        ctx.fillStyle = f ? '#fff' : 'rgba(255,255,255,0.35)';
        ctx.textAlign = 'center';
        ctx.fillText(f.toString(16).toUpperCase().padStart(2, '0'), cx, cy + 3 * layout.scale);
      }
    }
  }, [flags, layout, palette, first, show, bit]); // eslint-disable-line react-hooks/exhaustive-deps

  const subTileAt = (e: React.PointerEvent): number | null => {
    const r = canvas.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * canvas.current!.width;
    const py = ((e.clientY - r.top) / r.height) * canvas.current!.height;
    // Back to tile coordinates, then to sub-tile (inverse of centre()).
    const x = px / layout.scale + layout.x0 - 80;
    const y = py / layout.scale + layout.y0 - layout.topY - 8;
    const a = x / 16;
    const b = y / 8;
    const sx = Math.round((a + b) / 2);
    const sy = Math.round((b - a) / 2);
    if (sx < 0 || sy < 0 || sx > 4 || sy > 4) return null;
    return (4 - sy) * 5 + sx;
  };
  const apply = (t: number, set: boolean) =>
    onFlags((cur) => {
      const next = cur.slice();
      next[t] = set ? next[t] | bit : next[t] & ~bit;
      return next;
    });

  return (
    <div className="st">
      <div className="st-legend">
        <span className="small">
          Sub-tile flags <HelpTip text={FIELD_HELP.flags} />
        </span>
        {mixed && <span className="warn-text small">selected tiles differ — painting sets all of them</span>}
      </div>
      <div className="st-bits">
        {FLAG_BITS.map((b) => (
          <button key={b.bit} className={`st-bit${bit === b.bit ? ' active' : ''}`} onClick={() => setBit(b.bit)} title={b.help}>
            <span className="st-dot" style={{ background: b.color }} />
            <span className="mono">{b.bit.toString(16).toUpperCase().padStart(2, '0')}</span> {b.name}
          </button>
        ))}
      </div>
      <canvas
        ref={canvas}
        className="st-canvas"
        onPointerDown={(e) => {
          const t = subTileAt(e);
          if (t === null) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          // Start on a sub-tile with the flag → clear it along the drag; without → set it.
          const set = !(flags[t] & bit) && !e.altKey;
          drag.current = { set, done: new Set([t]) };
          apply(t, set);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const t = subTileAt(e);
          if (t === null || d.done.has(t)) return;
          d.done.add(t);
          apply(t, d.set);
        }}
        onPointerUp={() => (drag.current = null)}
      />
      <div className="st-tools small">
        <label>
          <input type="radio" checked={show === 'all'} onChange={() => setShow('all')} /> show all flags
        </label>
        <label>
          <input type="radio" checked={show === 'bit'} onChange={() => setShow('bit')} /> only “{FLAG_BITS.find((b) => b.bit === bit)?.name}”
        </label>
        <button className="link" onClick={() => onFlags((cur) => cur.map((f) => f | bit))}>
          set on all 25
        </button>
        <button className="link" onClick={() => onFlags((cur) => cur.map((f) => f & ~bit))}>
          clear from all
        </button>
        <button className="link" onClick={() => onFlags(() => new Uint8Array(25))}>
          all walkable (00)
        </button>
      </div>
      <p className="muted tiny-note">Click or drag across sub-tiles to set the chosen flag; start on one that has it to clear instead. Hover a flag for what it does.</p>
    </div>
  );
}
