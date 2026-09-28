import { useMemo, useState } from 'react';
import type { Palette } from '../formats/palette';
import type { Clipboard } from '../game/clipboard';
import type { TileLibrary } from '../game/GameData';
import { presetFromClipboard, type Preset } from '../game/presets';
import { PresetThumb } from './PresetsPanel';

const LAYER_NAMES: Record<string, string> = { floor: 'Floor', wall: 'Wall', shadow: 'Shadow' };

/**
 * What was just copied: a picture of it, pasting it (again), and keeping it as a preset. Shown from a copy until Esc.
 */
export function ClipboardPanel({
  clip,
  lib,
  palette,
  pasting,
  canSave,
  defaultName,
  onPaste,
  onSavePreset,
  onClose,
}: {
  clip: Clipboard;
  lib: TileLibrary;
  palette: Palette;
  pasting: boolean;
  canSave: boolean;
  defaultName: string;
  onPaste: () => void;
  onSavePreset: (p: Preset) => Promise<void>;
  onClose: () => void;
}) {
  const preview = useMemo(() => presetFromClipboard(clip, lib, '', ''), [clip, lib]);
  const [saving, setSaving] = useState<{ name: string; category: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const layers = preview.layers.map((l) => `${LAYER_NAMES[l.kind] ?? l.kind} ${l.index + 1}`);
  const objects = clip.objects?.length ?? 0;
  const empty = !clip.layers.some((l) => l.cells.length) || !preview.layers.length;
  return (
    <section className="panel clip-panel">
      <div className="panel-header static">
        <span>Copied</span>
        <span className="muted small">
          {clip.width}×{clip.height}
          {objects ? ` · ${objects} object${objects === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      <div className="panel-body">
        <div className="clip-thumb">{empty ? <span className="muted small">Nothing visible was copied.</span> : <PresetThumb preset={preview} lib={lib} palette={palette} />}</div>
        <p className="muted small">
          {layers.length ? layers.join(', ') : 'No tiles'}
          {' · '}
          {pasting ? 'move over the map to see where it goes, click to paste' : 'pasted: paste it again, or keep it as a preset'}
        </p>
        {saving ? (
          <div className="clip-save">
            <label className="form-row">
              <span>Name</span>
              <input value={saving.name} autoFocus onChange={(e) => setSaving({ ...saving, name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            </label>
            <label className="form-row">
              <span>Category</span>
              <input value={saving.category} onChange={(e) => setSaving({ ...saving, category: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            </label>
            <div className="inline">
              <button
                className="btn small primary"
                disabled={busy || !saving.name.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onSavePreset(presetFromClipboard(clip, lib, saving.name.trim(), saving.category.trim() || 'My presets'));
                    setSaving(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Saving…' : 'Save preset'}
              </button>
              <button className="btn small" onClick={() => setSaving(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="inline">
            {!pasting && (
              <button className="btn small primary" onClick={onPaste}>
                Paste again
              </button>
            )}
            <button className="btn small" disabled={!canSave || empty} title={canSave ? 'Keep it in the Presets panel (saved in your mod)' : 'No writable mod folder'} onClick={() => setSaving({ name: defaultName, category: 'My presets' })}>
              Save as preset…
            </button>
            <button className="btn small" onClick={onClose} title="Esc">
              Done
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
