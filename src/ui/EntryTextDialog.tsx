import { useEffect, useMemo, useRef, useState } from 'react';
import type { Palette } from '../formats/palette';
import { getCell, type TxtTableDoc } from '../formats/txtTable';
import { dataRows, ENTRY_IMAGE_DIR } from '../game/addToGame';
import { ENTRY_FONTS, entryDc6, FRAME_WIDTH, loadFont, renderEntryText, suggestEntryName, type EntryFont } from '../game/entryText';
import type { LayeredFs } from '../vfs/vfs';
import { Modal } from './Dialogs';
import { HelpTip } from './HelpTip';

interface Props {
  fs: LayeredFs;
  levels: TxtTableDoc;
  /** The open map's level, chosen first (0: none). */
  levelId: number;
  /** The palette the text is previewed in (Act 1's: the game draws these images with it). */
  palette: Palette;
  canWrite: boolean;
  onApply: (r: { levelId: number; entryFile: string; dc6: Uint8Array }) => Promise<void>;
  onClose: () => void;
}

const NAME_OK = /^[A-Za-z0-9_]{1,30}$/;

/**
 * Makes the "Entering …" text image a level shows when entered (for players without PD2's digital text), as the
 * community's txt2dc6 did: type the name, pick a font, check the preview, and it is saved as the level's EntryFile.
 */
export function EntryTextDialog({ fs, levels, levelId: initialLevel, palette, canWrite, onApply, onClose }: Props) {
  // Act 5 levels (109 on) read their EntryFile from the expansion folder; every level DS1 Studio adds is one.
  const choices = useMemo(
    () =>
      dataRows(levels)
        .map((r) => ({ id: Number(getCell(levels, r, 'Id')), name: getCell(levels, r, 'Name'), entry: getCell(levels, r, 'EntryFile').trim() }))
        .filter((l) => l.id >= 109),
    [levels],
  );
  const [levelId, setLevelId] = useState(choices.some((c) => c.id === initialLevel) ? initialLevel : (choices[choices.length - 1]?.id ?? 0));
  const level = choices.find((c) => c.id === levelId);
  const [text, setText] = useState(level?.name ?? '');
  const [font, setFont] = useState<EntryFont>('font42');
  const exists = (n: string) => !!fs.locate(`${ENTRY_IMAGE_DIR}${n}.dc6`);
  const [file, setFile] = useState(() => suggestEntryName(level?.name ?? '', exists));
  const [loaded, setLoaded] = useState<ReturnType<typeof loadFont> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const l = choices.find((c) => c.id === levelId);
    setText(l?.name ?? '');
    setFile(suggestEntryName(l?.name ?? '', exists));
  }, [levelId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    setLoaded(null);
    void Promise.all([fs.read(`data/local/font/latin/${font}.dc6`), fs.read(`data/local/font/latin/${font}.tbl`)])
      .then(([d, t]) => {
        if (!live) return;
        if (!d || !t) throw new Error(`The game's ${font} font wasn't found (data/local/font/latin).`);
        setLoaded(loadFont(d, t));
        setError(null);
      })
      .catch((e) => live && setError(String((e as Error).message ?? e)));
    return () => {
      live = false;
    };
  }, [fs, font]);

  const line = `Entering ${text.trim()}`;
  const image = useMemo(() => (loaded && text.trim() ? renderEntryText(loaded, line) : null), [loaded, line, text]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !image) return;
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext('2d')!;
    const data = ctx.createImageData(image.width, image.height);
    for (let i = 0; i < image.pixels.length; i++) {
      const p = image.pixels[i];
      if (!p) continue;
      data.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], i * 4);
    }
    ctx.putImageData(data, 0, 0);
  }, [image, palette]);

  const fileProblem = !NAME_OK.test(file) ? 'letters, digits and _ only (up to 30)' : null;
  const overwrite = !fileProblem && exists(file);
  const frames = image ? Math.ceil(image.width / FRAME_WIDTH) : 0;
  return (
    <Modal title="Entering text" wide onClose={() => !busy && onClose()}>
      <p className="small">
        The &ldquo;Entering &hellip;&rdquo; line a level shows as players walk in, for those who play without PD2&apos;s digital text. It&apos;s an image drawn with
        the game&apos;s own font (as txt2dc6 made them), saved as <span className="mono">{ENTRY_IMAGE_DIR}&lt;name&gt;.dc6</span> and named in the level&apos;s
        EntryFile (Levels.txt).
      </p>
      <label className="form-row">
        <span>Level</span>
        <select value={levelId} onChange={(e) => setLevelId(Number(e.target.value))}>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} {c.name}
              {c.entry ? ` (EntryFile ${c.entry})` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="form-row">
        <span>Text</span>
        <span className="entry-row">
          <span className="muted">Entering</span>
          <input className="text-input" value={text} maxLength={40} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} autoFocus />
        </span>
      </label>
      <label className="form-row">
        <span>Font</span>
        <select value={font} onChange={(e) => setFont(e.target.value as EntryFont)}>
          {ENTRY_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <div className="entry-preview">{image ? <canvas ref={canvas} /> : <span className="muted small">{error ?? (loaded ? 'Type the level’s name.' : 'Loading the font…')}</span>}</div>
      {image && (
        <p className="small muted">
          {image.width}×{image.height} pixels, {frames} frame{frames === 1 ? '' : 's'} of up to {FRAME_WIDTH} across.
          {image.missing.length > 0 && <span className="warn-text"> The font has no {image.missing.map((m) => `“${m}”`).join(', ')}: left out.</span>}
          {image.width > 640 && <span className="warn-text"> Wider than the 640-pixel game screen: shorten the name.</span>}
        </p>
      )}
      <label className="form-row">
        <span>
          File name <HelpTip text="The EntryFile value: the image is saved as data/local/ui/eng/expansion/<name>.dc6 in your mod. Keep it short, letters and digits." />
        </span>
        <span className="entry-row">
          <input className="text-input mono" value={file} onChange={(e) => setFile(e.target.value.trim())} onKeyDown={(e) => e.stopPropagation()} />
          <span className="muted">.dc6</span>
          {fileProblem && <span className="error-text small">{fileProblem}</span>}
          {overwrite && <span className="warn-text small">exists: it will be replaced (the old one kept as .bak)</span>}
        </span>
      </label>
      {level && (
        <p className="small muted">
          Level {level.id} &ldquo;{level.name}&rdquo;: EntryFile {level.entry ? <span className="mono">{level.entry}</span> : 'empty'} →{' '}
          <span className="mono">{file || '…'}</span>.
        </p>
      )}
      {error && image && <p className="small error-text">{error}</p>}
      <div className="modal-actions">
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || !canWrite || !image || !!fileProblem || !level}
          onClick={() => {
            if (!image || !level) return;
            setBusy(true);
            setError(null);
            onApply({ levelId: level.id, entryFile: file, dc6: entryDc6(image) })
              .then(onClose)
              .catch((e) => setError(String((e as Error)?.message ?? e)))
              .finally(() => setBusy(false));
          }}
        >
          Save and set EntryFile
        </button>
      </div>
    </Modal>
  );
}
