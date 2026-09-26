import { useEffect, useMemo, useRef, useState } from 'react';
import type { Palette } from '../formats/palette';
import { loadSpriteAnimation, type SpriteAnimation } from '../game/spriteAnim';
import type { SpriteSpec } from '../game/sprites';
import type { LayeredFs } from '../vfs/vfs';
import './objectPreview.css';

interface Props {
  fs: LayeredFs;
  spec: SpriteSpec | null;
  palette: Palette;
  name: string;
  subtitle?: string;
}

const VIEW_W = 280;
const VIEW_H = 220;
const PAD = 10;
const SPEEDS = { min: 0.25, max: 2, step: 0.25 };

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'none' } | { state: 'ready'; anim: SpriteAnimation };

/** Animated preview of an object/monster sprite, played at its in-game rate. */
export function ObjectPreview({ fs, spec, palette, name, subtitle }: Props) {
  const [direction, setDirection] = useState(spec?.direction ?? 0);
  const [load, setLoad] = useState<Load>({ state: spec ? 'loading' : 'idle' });
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [dirCount, setDirCount] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Parents may rebuild equal specs on every render; key effects on content, not identity.
  const specId = spec ? JSON.stringify(spec) : '';
  const shownSpec = useRef('');

  // A new object resets the facing to its default.
  useEffect(() => {
    setDirection(spec?.direction ?? 0);
    setDirCount(1);
    setFrame(0);
  }, [specId]);

  useEffect(() => {
    if (!spec) {
      shownSpec.current = '';
      setLoad({ state: 'idle' });
      return;
    }
    let cancelled = false;
    // Keep showing the old direction while another one of the same object loads.
    if (shownSpec.current !== specId) setLoad({ state: 'loading' });
    shownSpec.current = specId;
    loadSpriteAnimation(fs, spec, direction).then(
      (anim) => {
        if (cancelled) return;
        if (!anim || !anim.frames.length) {
          setLoad({ state: 'none' });
          return;
        }
        setDirCount(anim.directions);
        setFrame((f) => (f < anim.frames.length ? f : 0));
        setLoad({ state: 'ready', anim });
      },
      () => !cancelled && setLoad({ state: 'none' }),
    );
    return () => {
      cancelled = true;
    };
  }, [fs, specId, direction]);

  const anim = load.state === 'ready' ? load.anim : null;

  // Palette-expanded frames, rendered once per animation + palette.
  const bitmaps = useMemo(() => (anim ? anim.frames.map((f) => toCanvas(f.width, f.height, f.pixels, palette)) : []), [anim, palette]);

  // Playback loop.
  const speedRef = useRef(speed);
  speedRef.current = speed;
  useEffect(() => {
    if (!anim || !playing || anim.frames.length < 2) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * anim.fps * speedRef.current;
      last = now;
      if (acc >= 1) {
        const step = Math.floor(acc);
        acc -= step;
        setFrame((f) => (f + step) % anim.frames.length);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anim, playing]);

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(VIEW_W * dpr)) canvas.width = Math.round(VIEW_W * dpr);
    if (canvas.height !== Math.round(VIEW_H * dpr)) canvas.height = Math.round(VIEW_H * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!anim || !bitmaps.length) return;
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;

    // Fit the sprite with the feet on the horizontal centre.
    const halfX = Math.max(1, -anim.offsetX, anim.offsetX + anim.width);
    const above = Math.max(0, -anim.offsetY);
    const below = Math.max(4, anim.offsetY + anim.height);
    let scale = Math.min((VIEW_W - 2 * PAD) / (2 * halfX), (VIEW_H - 2 * PAD) / (above + below), 6);
    if (scale >= 1) scale = Math.floor(scale);
    const feetX = Math.round(VIEW_W / 2);
    const feetY = Math.round(PAD + above * scale + (VIEW_H - 2 * PAD - (above + below) * scale) / 2);

    // Ground shadow.
    const rx = Math.max(8, Math.min(anim.width, 2 * halfX) * scale * 0.32);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.ellipse(feetX, feetY, rx, rx * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    const img = bitmaps[Math.min(frame, bitmaps.length - 1)];
    ctx.drawImage(img, feetX + anim.offsetX * scale, feetY + anim.offsetY * scale, anim.width * scale, anim.height * scale);
  }, [anim, bitmaps, frame]);

  const count = anim?.frames.length ?? 0;
  const step = (d: number) => {
    if (!count) return;
    setPlaying(false);
    setFrame((f) => (f + d + count) % count);
  };

  let overlay: string | null = null;
  if (load.state === 'idle') overlay = 'Select an object to preview it';
  else if (load.state === 'loading') overlay = 'Loading…';
  else if (load.state === 'none') overlay = 'No sprite available';

  return (
    <div className="object-preview">
      <div className="op-head">
        <div className="op-name" title={name}>
          {name || '—'}
        </div>
        {subtitle && <div className="op-sub muted small">{subtitle}</div>}
      </div>
      <div className="op-stage">
        <canvas ref={canvasRef} className="op-canvas" style={{ width: VIEW_W, height: VIEW_H }} />
        {overlay && <div className="op-overlay muted small">{overlay}</div>}
      </div>
      <div className="op-controls">
        <button className="btn op-btn" onClick={() => step(-1)} disabled={count < 2} title="Previous frame">
          ◀
        </button>
        <button className="btn op-btn op-play" onClick={() => setPlaying((p) => !p)} disabled={count < 2} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="btn op-btn" onClick={() => step(1)} disabled={count < 2} title="Next frame">
          ▶|
        </button>
        <span className="op-counter mono small">{count ? `${Math.min(frame, count - 1) + 1}/${count}` : '–/–'}</span>
        <span className="op-fps mono small muted">{anim ? `${formatFps(anim.fps * speed)} fps` : ''}</span>
      </div>
      <div className="op-controls">
        <label className="op-field small">
          <span className="muted">Dir</span>
          <select className="op-select" value={direction} disabled={!spec || dirCount < 2} onChange={(e) => setDirection(Number(e.target.value))}>
            {Array.from({ length: Math.max(dirCount, direction + 1) }, (_, i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field op-speed small">
          <span className="muted">Speed</span>
          <input type="range" min={SPEEDS.min} max={SPEEDS.max} step={SPEEDS.step} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          <span className="mono">{speed.toFixed(2)}×</span>
        </label>
      </div>
    </div>
  );
}

function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(1);
}

function toCanvas(width: number, height: number, pixels: Uint8Array, palette: Palette): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  if (!ctx || !width || !height) return canvas;
  const img = ctx.createImageData(width, height);
  const out = img.data;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (!p) continue;
    const o = i * 4;
    out[o] = palette[p * 4];
    out[o + 1] = palette[p * 4 + 1];
    out[o + 2] = palette[p * 4 + 2];
    out[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
