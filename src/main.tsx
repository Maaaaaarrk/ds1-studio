import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

// `ds1-studio --mcp` starts a hidden window that serves the MCP tools instead of the editor.
if ((window as { __DS1_MCP__?: boolean }).__DS1_MCP__) {
  void import('./mcp/main').then((m) => m.startMcp());
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
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
