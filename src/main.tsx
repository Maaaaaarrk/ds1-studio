import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './ui/styles.css';
import { loadPrefs } from './ui/prefs';
import { applyTheme, findTheme } from './ui/themes';

// The saved theme before the first paint (no flash of the default colours).
{
  const p = loadPrefs();
  applyTheme(findTheme(p.theme, p.customThemes ?? []), p.accent);
}

// `ds1-studio --mcp` starts a hidden window that serves the MCP tools instead of the editor.
if ((window as { __DS1_MCP__?: boolean }).__DS1_MCP__) {
  void import('./mcp/main').then((m) => m.startMcp());
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary what="DS1 Studio">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

// No browser context menu (Back / Refresh / Inspect…) anywhere in the app: right-dragging to pan the map and letting go
// over another part of the window would otherwise open it. Text boxes keep theirs for copy/paste.
window.addEventListener(
  'contextmenu',
  (e) => {
    const t = e.target as HTMLElement | null;
    const editable = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (!editable) e.preventDefault();
  },
  { capture: true },
);
