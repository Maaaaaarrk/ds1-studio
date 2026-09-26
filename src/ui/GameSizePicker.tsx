/**
 * Game screen sizes for Game view. Classic Diablo II runs at 640×480 or 800×600; Project Diablo 2 adds a 1068×600
 * widescreen mode, and renderers such as D2GL let mods set other sizes, so any size can be entered too.
 */
export const GAME_SIZES: { label: string; size: [number, number] }[] = [
  { label: '640×480 (classic low)', size: [640, 480] },
  { label: '800×600 (classic / PD2 4:3)', size: [800, 600] },
  { label: '1068×600 (PD2 widescreen)', size: [1068, 600] },
];

export function GameSizePicker({ size, onChange }: { size: [number, number]; onChange: (size: [number, number]) => void }) {
  const key = `${size[0]}x${size[1]}`;
  const preset = GAME_SIZES.find((g) => `${g.size[0]}x${g.size[1]}` === key);
  return (
    <>
      <span className="muted small">Game screen</span>
      <select
        value={preset ? key : 'custom'}
        title="The screen size Game view shows: what a player sees at that game resolution"
        onChange={(e) => {
          if (e.target.value === 'custom') {
            const answer = window.prompt('Game screen size (width × height in game pixels)', `${size[0]}x${size[1]}`);
            const m = answer && /^\s*(\d{3,4})\s*[x×*, ]\s*(\d{3,4})\s*$/i.exec(answer);
            if (m) onChange([Math.min(7680, Math.max(320, Number(m[1]))), Math.min(4320, Math.max(240, Number(m[2])))]);
            return;
          }
          const g = GAME_SIZES.find((x) => `${x.size[0]}x${x.size[1]}` === e.target.value);
          if (g) onChange(g.size);
        }}
      >
        {GAME_SIZES.map((g) => (
          <option key={g.label} value={`${g.size[0]}x${g.size[1]}`}>
            {g.label}
          </option>
        ))}
        <option value="custom">{preset ? 'Custom…' : `Custom: ${size[0]}×${size[1]}`}</option>
      </select>
    </>
  );
}
