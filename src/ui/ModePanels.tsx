import type { ReactNode } from 'react';
import type { Ds1 } from '../formats/ds1';
import { popProblems, type PopArea } from '../game/pops';
import { HelpTip } from './HelpTip';
import { LevelLightEditor, type LevelLight } from './panels';
import type { ViewMode } from './state';

/**
 * The right-hand panel of a view mode (walkability, automap, level light, roof hiding): a bar naming the mode with a
 * way back to editing tiles, then only that mode's options.
 */

const MODE_NAMES: Record<Exclude<ViewMode, 'tiles'>, string> = {
  walk: 'Walkability',
  automap: 'Automap',
  light: 'Level light',
  roofs: 'Roof hiding',
};

export function ModeBar({ mode, onDone }: { mode: Exclude<ViewMode, 'tiles'>; onDone: () => void }) {
  return (
    <div className="mode-bar">
      <span>
        <span className="muted small">View · </span>
        <b>{MODE_NAMES[mode]}</b>
      </span>
      <button className="btn small" onClick={onDone} title="Back to editing tiles (the Tiles panel)">
        Done
      </button>
    </div>
  );
}

interface LightPanelProps {
  light: LevelLight | null;
  canWrite: boolean;
  playerLight: number;
  onPlayerLight: (r: number) => void;
  onDraft: (d: LevelLight | null) => void;
  onApply: (intensity: number, rgb: [number, number, number]) => Promise<void>;
  onAddToGame: () => void;
}

/** Level light mode: the map drawn in its level's light, and the light's settings. */
export function LightPanel({ light, canWrite, playerLight, onPlayerLight, onDraft, onApply, onAddToGame }: LightPanelProps) {
  return (
    <section className="panel">
      <div className="panel-body">
        {light ? (
          <>
            <LevelLightEditor light={light} shown canWrite={canWrite} onApply={onApply} onDraft={onDraft} playerLight={playerLight} onPlayerLight={onPlayerLight} />
            <p className="muted small">
              The map is drawn as dark and tinted as the game lights this level. Move the mouse over it to see a player&apos;s own light (Player light).
              Changes show straight away; Apply writes them into Levels.txt.
            </p>
          </>
        ) : (
          <>
            <p className="small">This map isn&apos;t a level of the game yet, so it has no light settings.</p>
            <button className="btn small" onClick={onAddToGame} disabled={!canWrite}>
              Add to game…
            </button>
          </>
        )}
      </div>
    </section>
  );
}

interface RoofPanelProps {
  ds1: Ds1;
  areas: PopArea[];
  /** LvlPrest.txt Pops / PopPad for the map (null when it has no row). */
  preset: { pops: number; popPad: number } | null;
  inside: boolean;
  onInside: (on: boolean) => void;
  onShowCells: (cells: { x: number; y: number }[]) => void;
  onSetUp: () => void;
}

/** Roof hiding mode: where roofs (or other tiles) fade when a player walks in, what fades, and what would stop it. */
export function RoofPanel({ ds1, areas, preset, inside, onInside, onShowCells, onSetUp }: RoofPanelProps) {
  const problems = popProblems(ds1, areas, preset ? preset.pops : null, preset?.popPad ?? 0);
  return (
    <section className="panel">
      <div className="panel-body">
        <label className="mini-check">
          <input type="checkbox" checked={inside} onChange={(e) => onInside(e.target.checked)} /> As if inside{' '}
          <HelpTip text="Hide the tiles of every hide area, as the game does while a player stands inside: clicks then reach the floors and walls under the roof. The same toggle is in View → Show, for painting with the Tiles panel." />
        </label>
        <div className="field-label">
          Hide areas <span className="muted small">{areas.length}</span>
        </div>
        {areas.length ? (
          <ul className="mode-list">
            {areas.map((a, i) => (
              <li key={i}>
                <button className="link" onClick={() => onShowCells(a.markers.map((m) => ({ x: m.x, y: m.y })))} title="Mark its corner markers on the map">
                  Area {a.main}
                </button>{' '}
                <span className="small">
                  cells {a.x0},{a.y0} – {a.x1},{a.y1} · hides main index {a.target}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None: no roof fades when a player walks in.</p>
        )}
        {preset && (
          <p className="small muted">
            LvlPrest.txt: Pops {preset.pops}, PopPad {preset.popPad}
          </p>
        )}
        {problems.map((p, i) => (
          <p key={i} className={`small ${p.severity === 'error' ? 'error-text' : p.severity === 'warning' ? 'warn-text' : 'muted'}`}>
            {p.text}
          </p>
        ))}
        <button className="btn small primary" onClick={onSetUp}>
          {areas.length ? 'Change roof hiding…' : 'Set up roof hiding…'}
        </button>
      </div>
    </section>
  );
}

/** A mode's panel with its bar. */
export function ModeFrame({ mode, onDone, children }: { mode: Exclude<ViewMode, 'tiles'>; onDone: () => void; children: ReactNode }) {
  return (
    <>
      <ModeBar mode={mode} onDone={onDone} />
      {children}
    </>
  );
}
