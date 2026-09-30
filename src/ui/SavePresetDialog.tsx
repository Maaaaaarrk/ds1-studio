import { useMemo, useState } from 'react';
import type { Palette } from '../formats/palette';
import { CLIP_PARTS, countParts, filterClipboard, type Clipboard, type ClipPart } from '../game/clipboard';
import type { TileLibrary } from '../game/GameData';
import { presetFromClipboard, type Preset } from '../game/presets';
import { Modal } from './Dialogs';
import { CategoryPicker } from './CategoryPicker';
import { PresetThumb } from './PresetsPanel';

/**
 * Save as preset: a name, a category, and what to keep — floors, walls, roofs, shadows, markers, objects — with a
 * picture of the result. What starts ticked follows the view: with As if inside on the roofs are left out (a building's
 * inside without its roof); layers switched off in Layers start unticked too.
 */
export function SavePresetDialog({
  clip,
  lib,
  palette,
  defaultName,
  categories,
  initial,
  insideNote,
  onSave,
  onClose,
}: {
  clip: Clipboard;
  lib: TileLibrary;
  palette: Palette;
  defaultName: string;
  /** Categories already used, to pick from. */
  categories: string[];
  /** Parts that start ticked. */
  initial: ReadonlySet<ClipPart>;
  /** Shown when roofs start unticked because of As if inside. */
  insideNote: boolean;
  onSave: (p: Preset) => Promise<void>;
  onClose: () => void;
}) {
  const counts = useMemo(() => countParts(clip), [clip]);
  const present = CLIP_PARTS.filter((p) => counts[p.id] > 0);
  const [keep, setKeep] = useState<Set<ClipPart>>(() => new Set(present.map((p) => p.id).filter((id) => initial.has(id))));
  const [name, setName] = useState(defaultName);
  const [category, setCategory] = useState(categories.includes('My presets') || !categories.length ? 'My presets' : categories[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = useMemo(() => filterClipboard(clip, keep), [clip, keep]);
  const preview = useMemo(() => presetFromClipboard(kept, lib, name, category), [kept, lib, name, category]);
  const nothing = !preview.layers.length && !preview.objects.length;
  const toggle = (id: ClipPart) =>
    setKeep((k) => {
      const n = new Set(k);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const save = async () => {
    if (!name.trim() || nothing) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(presetFromClipboard(kept, lib, name.trim(), category.trim() || 'My presets'));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Save as preset" onClose={onClose}>
      <div className="sp-body">
        <div className="sp-thumb">{nothing ? <span className="muted small">Nothing ticked to keep.</span> : <PresetThumb preset={preview} lib={lib} palette={palette} />}</div>
        <div className="sp-form">
          <label className="form-row">
            <span>Name</span>
            <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
          </label>
          <div className="form-row">
            <span>Category</span>
            <CategoryPicker categories={categories} value={category} onChange={setCategory} onEnter={() => void save()} />
          </div>
          <div className="field-label">
            Keep <span className="muted small">{clip.width}×{clip.height} cells</span>
          </div>
          <div className="sp-parts">
            {present.map((p) => (
              <label key={p.id} className={`chip sp-part${keep.has(p.id) ? ' active' : ''}`}>
                <input type="checkbox" checked={keep.has(p.id)} onChange={() => toggle(p.id)} /> {p.label} <span className="muted">{counts[p.id]}</span>
              </label>
            ))}
          </div>
          {insideNote && counts.roofs > 0 && !keep.has('roofs') && <p className="muted small">Roofs are left out because As if inside is on: tick Roofs to keep them.</p>}
          {error && <p className="error-text small">{error}</p>}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !name.trim() || nothing} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save preset'}
        </button>
      </div>
    </Modal>
  );
}
