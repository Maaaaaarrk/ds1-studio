// App themes, as in PD2 Filter Forge: each is five base colours; the in-between shades (hover, borders, faint text…)
// are worked out from them, so a custom theme needs only five colours and still looks consistent. Share codes use
// Filter Forge's format, so a theme made in one app can be pasted into the other.

export interface ThemeColors {
  bg: string;
  panel: string;
  text: string;
  accent: string;
  line: string;
}

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  colors: ThemeColors;
  /** Built-in themes may pin exact shades instead of derived ones. */
  exact?: Partial<Record<'bg2' | 'panel2' | 'line2' | 'heading' | 'muted' | 'hover' | 'accentText', string>>;
  custom?: boolean;
}

export const DEFAULT_THEME = 'studio';

export const BUILTIN_THEMES: Theme[] = [
  {
    id: 'studio',
    name: 'DS1 Studio',
    dark: true,
    colors: { bg: '#0b0c0f', panel: '#13151a', text: '#d8dbe2', accent: '#d4a84f', line: '#252932' },
    exact: { bg2: '#101216', panel2: '#181b21', line2: '#3a404c', heading: '#aeb4bf', muted: '#7d8491', hover: '#1e222a', accentText: '#f1d9a6' },
  },
  {
    id: 'sanctuary',
    name: 'Sanctuary',
    dark: true,
    colors: { bg: '#0f0d10', panel: '#1a171c', text: '#ebe4d6', accent: '#d9a441', line: '#2e2830' },
    exact: { bg2: '#151216', panel2: '#221e24', line2: '#3b3440', muted: '#a1978c', hover: '#262129' },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    dark: true,
    colors: { bg: '#0b0f14', panel: '#141a22', text: '#e3e9f1', accent: '#4a9de0', line: '#242d39' },
    exact: { bg2: '#10151c', panel2: '#1a212b', line2: '#303b4a', muted: '#93a1b3', hover: '#1c2430' },
  },
  { id: 'graphite', name: 'Graphite', dark: true, colors: { bg: '#111214', panel: '#1a1c1f', text: '#e6e7e9', accent: '#9aa7b8', line: '#2a2d31' } },
  { id: 'nord', name: 'Nord', dark: true, colors: { bg: '#1e222a', panel: '#262b34', text: '#e5e9f0', accent: '#88c0d0', line: '#353c48' } },
  { id: 'ember', name: 'Ember', dark: true, colors: { bg: '#130c0b', panel: '#1e1412', text: '#f1e6e1', accent: '#e2583e', line: '#33221e' } },
  { id: 'verdant', name: 'Verdant', dark: true, colors: { bg: '#0c1310', panel: '#142019', text: '#e3efe8', accent: '#5fbf8a', line: '#223328' } },
  {
    id: 'parchment',
    name: 'Parchment',
    dark: false,
    colors: { bg: '#efe8da', panel: '#f8f3e8', text: '#2b241b', accent: '#b7791f', line: '#d8ccb4' },
    exact: { bg2: '#e7dfcf', panel2: '#efe7d7', line2: '#c8b995', muted: '#6d604d', hover: '#ebe2cf' },
  },
  { id: 'snow', name: 'Snow', dark: false, colors: { bg: '#f3f5f8', panel: '#ffffff', text: '#1c2230', accent: '#3b6fd8', line: '#dde2ea' } },
];

/** Accent colours offered next to the themes (any colour can be picked too). */
export const ACCENTS = ['#d4a84f', '#c7b377', '#e0603a', '#b04ad9', '#4a9de0', '#3fbf8a', '#e04a6a', '#9aa7b8'];

const mix = (a: string, b: string, pct: number) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

/** Is a hex colour dark? Picks dark/light for custom themes, and the text colour on accent buttons. */
export function isDarkColor(hex: string): boolean {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return true;
  const [r, g, b] = m.map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** Every CSS variable the app's stylesheet uses, for one theme (and an accent that replaces the theme's own). */
export function themeVars(t: Theme, accent?: string): Record<string, string> {
  const c = t.colors;
  const e = t.exact ?? {};
  const a = accent || c.accent;
  return {
    '--bg': c.bg,
    '--bg2': e.bg2 ?? mix(c.panel, c.bg, 45),
    '--panel': c.panel,
    '--panel-2': e.panel2 ?? mix(c.text, c.panel, 5),
    '--border': c.line,
    '--border-2': e.line2 ?? mix(c.text, c.line, 12),
    '--text': c.text,
    '--heading': e.heading ?? mix(c.text, c.bg, 78),
    '--muted': e.muted ?? mix(c.text, c.bg, 58),
    '--hover': e.hover ?? mix(c.text, c.panel, 7),
    '--accent': a,
    '--accent-dim': mix(a, 'transparent', t.dark ? 14 : 18),
    '--accent-hover': mix(a, t.dark ? '#ffffff' : '#000000', 85),
    // Text that sits on a selected row / active tab: a light tint of the accent (a dark one on light themes).
    '--accent-text': e.accentText && a.toLowerCase() === c.accent.toLowerCase() ? e.accentText : mix(a, c.text, t.dark ? 45 : 75),
    '--on-accent': isDarkColor(a) ? '#ffffff' : '#1a1406',
    '--error': t.dark ? '#ff5a6e' : '#c53030',
    '--warn': t.dark ? '#f0b54a' : '#b7791f',
    '--ok': t.dark ? '#7fd38a' : '#2f855a',
    '--info': t.dark ? '#7cc8ff' : '#2b6cb0',
    'color-scheme': t.dark ? 'dark' : 'light',
  };
}

export function findTheme(id: string, custom: Theme[]): Theme {
  return custom.find((t) => t.id === id) ?? BUILTIN_THEMES.find((t) => t.id === id) ?? BUILTIN_THEMES[0];
}

/** Puts a theme's colours on the page (before the first render too, so there's no flash of the default theme). */
export function applyTheme(t: Theme, accent?: string): void {
  const r = document.documentElement;
  r.dataset.theme = t.dark ? 'dark' : 'light';
  for (const [k, v] of Object.entries(themeVars(t, accent))) r.style.setProperty(k, v);
}

/** Share a theme as a short code (PD2 Filter Forge's format), and read one back. */
export function exportTheme(t: Theme): string {
  return `ffthemes:${btoa(JSON.stringify({ name: t.name, colors: t.colors }))}`;
}

export function importTheme(code: string): Theme | null {
  try {
    const body = code.trim().replace(/^(ffthemes|ds1themes):/, '');
    const j = JSON.parse(atob(body));
    const hex = /^#[0-9a-f]{6}$/i;
    const keys: (keyof ThemeColors)[] = ['bg', 'panel', 'text', 'accent', 'line'];
    if (typeof j.name !== 'string' || !keys.every((k) => hex.test(j.colors?.[k]))) return null;
    return { id: `custom-${Date.now().toString(36)}`, name: j.name.slice(0, 30), dark: isDarkColor(j.colors.bg), colors: j.colors, custom: true };
  } catch {
    return null;
  }
}
