// Screenshots and GIFs for the manual's Quick start and the newer features (see docs/manual/README.md):
//   SCENES=tools/guide-scenes.mjs OUT=docs/manual/img node --experimental-websocket tools/capture-docs.mjs [scene ...]
// Vanilla data only (ds1studio.local.json with "modDirs": [] and a throwaway saveDir).
export function makeScenes(h) {
  const { sleep, js, press, click, drag, wheel, mouse, button, openMap, viewport, rect, shot, gif, ribbonTab, closeDialogs, W, H } = h;
  const dialog = () => rect('[role=dialog]');
  const blur = () => js(`document.activeElement?.blur()`);
  const town = async () => {
    await openMap('act1/town/town', 'townN1.ds1');
    await blur();
    await press('f');
    await sleep(1200);
  };
  /** The map pane (for GIF clips). */
  const stage = async () => {
    const v = await viewport();
    return { x: Math.round(v.x), y: Math.round(v.y), width: Math.round(v.w), height: Math.round(v.h) };
  };
  const dbl = async (x, y) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, { clickCount: 1 });
    await mouse('mouseReleased', x, y, { clickCount: 1 });
    await mouse('mousePressed', x, y, { clickCount: 2 });
    await mouse('mouseReleased', x, y, { clickCount: 2 });
    await sleep(500);
  };
  const sideTab = (re) => js(`[...document.querySelectorAll('.side-tabs button')].find((b) => ${re}.test(b.innerText))?.click()`);
  /** Zooms the view in around a screen point. */
  const zoomAt = async (x, y, ticks) => {
    for (let i = 0; i < ticks; i++) await wheel(x, y, -120);
    await sleep(500);
  };
  const ribbonButton = async (re) => {
    for (const tab of ['Home', 'View', 'Map', 'Game', 'Diagnostics']) {
      await ribbonTab(tab);
      const ok = await js(`const b = [...document.querySelectorAll('button')].find((b) => ${re}.test(b.innerText.trim())); if (!b) return false; b.click(); return true;`);
      if (ok) {
        await sleep(400);
        return;
      }
    }
    throw new Error(`no ribbon button ${re}`);
  };

  return {
    /** Quick start 1: find a map in the file list and open it. */
    async quickOpen() {
      await sleep(1500);
      const frames = [];
      const text = 'townn';
      await gif(
        'quick-open',
        text.length + 8,
        async (i) => {
          if (i === 0) {
            await js(`const i = document.querySelector('input[placeholder^="Filter"]'); i.focus();`);
          } else if (i <= text.length) {
            await js(`
              const i = document.querySelector('input[placeholder^="Filter"]');
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}.slice(0, ${i}));
              i.dispatchEvent(new Event('input', { bubbles: true }));`);
            await sleep(120);
          } else if (i === text.length + 1) {
            await button('townN1.ds1');
            await sleep(3500);
            await blur();
            await press('f');
            await sleep(800);
          } else await sleep(150);
        },
        { clip: { x: 0, y: 0, width: W, height: H }, delay: 160, scale: 0.5, hold: 10 },
      );
      void frames;
    },

    /** Quick start 2: pick a tile and paint with it. */
    async quickPaint() {
      await town();
      const v = await viewport();
      await zoomAt(v.cx, v.cy, 6);
      await press('b');
      await sleep(300);
      // A fence post, painted along one row of cells across the open ground.
      await js(`[...document.querySelectorAll('.chip')].find((c) => c.innerText.trim() === 'Walls')?.click()`);
      await sleep(400);
      await js(`document.querySelectorAll('.thumb-grid .thumb')[0]?.click()`);
      await sleep(400);
      const clip = { x: Math.round(v.x), y: Math.round(v.y), width: Math.round(v.w), height: Math.round(v.h) };
      // Along one column of cells (+y on the map is left-and-down on screen), the way a left wall runs.
      const path = Array.from({ length: 12 }, (_, i) => [v.cx + 300 - i * 36, v.cy - 300 + i * 18]);
      await gif(
        'quick-paint',
        path.length + 6,
        async (i) => {
          if (i === 0) {
            await mouse('mouseMoved', ...path[0]);
            await mouse('mousePressed', ...path[0]);
          } else if (i < path.length) {
            await mouse('mouseMoved', path[i][0], path[i][1], { buttons: 1 });
            await sleep(60);
          } else if (i === path.length) {
            await mouse('mouseReleased', ...path[path.length - 1]);
            await sleep(300);
          } else await sleep(120);
        },
        { clip, delay: 110, scale: 0.6, hold: 8 },
      );
      await press('z', ['ctrl']);
    },

    /** Home → Preferences. */
    async preferences() {
      await town();
      await ribbonButton(/^Preferences/);
      await sleep(400);
      await shot('preferences', await dialog());
      await closeDialogs();
    },

    /** Esc with nothing selected: close the map (after an edit, so all three choices show). */
    async closePrompt() {
      await town();
      const v = await viewport();
      await press('e');
      await click(v.cx, v.cy);
      await press('v');
      await press('Escape');
      await sleep(600);
      await shot('close-prompt', await dialog());
      await js(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Cancel')?.click()`);
      await press('z', ['ctrl']);
    },

    /** Double-click a tile: every copy of it on its layer. */
    async sameTiles() {
      await town();
      const v = await viewport();
      const clip = await stage();
      await press('v');
      await gif(
        'same-tiles',
        10,
        async (i) => {
          if (i === 3) await dbl(v.cx + 40, v.cy + 40);
          else await sleep(200);
        },
        { clip, delay: 180, scale: 0.6, hold: 10 },
      );
      await shot('same-tiles');
      await press('Escape');
    },

    /** Shift+scroll narrows an area selection to one layer at a time. */
    async layerScroll() {
      await town();
      const v = await viewport();
      await zoomAt(v.cx - 60, v.cy - 40, 4);
      await press('v');
      await drag([v.cx - 40, v.cy - 190], [v.cx - 40, v.cy + 150]);
      const clip = await stage();
      await gif(
        'layer-scroll',
        12,
        async (i) => {
          if (i > 0 && i % 3 === 0) await wheel(v.cx, v.cy, 100, ['shift']);
          await sleep(250);
        },
        { clip, delay: 260, scale: 0.6, hold: 4 },
      );
      await press('Escape');
    },

    /** A paste shows which existing tiles it would replace. */
    async pastePreview() {
      await town();
      const v = await viewport();
      await zoomAt(v.cx, v.cy, 4);
      await press('v');
      await drag([v.cx - 60, v.cy - 110], [v.cx - 60, v.cy + 70]);
      await press('c', ['ctrl']);
      await sleep(300);
      await mouse('mouseMoved', v.cx + 120, v.cy - 40);
      await sleep(700);
      await shot('paste-preview');
      await press('Escape');
      await press('Escape');
    },

    /** Double-click an object: every object of that kind. */
    async sameObjects() {
      await town();
      await press('o');
      await sleep(400);
      for (let i = 0; i < 6; i++) await wheel(822, 461, -120);
      await sleep(800);
      let found = false;
      for (let dy = -60; dy <= 60 && !found; dy += 12)
        for (let dx = -60; dx <= 60 && !found; dx += 12) {
          await dbl(822 + dx, 461 + dy);
          found = /^Selected \d+ ×/.test(await js(`return document.querySelector('.toast')?.innerText ?? ''`));
        }
      await shot('same-objects');
      await press('Escape');
      await press('o');
    },

    /** Presets: save a selection (category drop-down), the right-click menu, the builder. */
    async presets() {
      await town();
      const v = await viewport();
      await press('v');
      await drag([v.cx - 60, v.cy - 30], [v.cx + 60, v.cy + 30]);
      await sideTab(/presets/i);
      await sleep(300);
      await button(/^Save selection/);
      await sleep(700);
      await js(`const i = document.querySelector('[role=dialog] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Fence corner'); i.dispatchEvent(new Event('input', { bubbles: true }));`);
      await shot('save-preset', await dialog());
      await js(`[...document.querySelectorAll('[role=dialog] button')].find((b) => /^Save/.test(b.innerText.trim()))?.click()`);
      await sleep(1500);
      const card = await js(`const r = document.querySelector('.preset-card')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + 20 } : null`);
      if (card) {
        await mouse('mouseMoved', card.x, card.y);
        await mouse('mousePressed', card.x, card.y, { button: 'right', buttons: 2 });
        await mouse('mouseReleased', card.x, card.y, { button: 'right', buttons: 0 });
        await sleep(500);
        const m = await rect('.ctx-menu');
        await shot('preset-menu', { x: Math.max(0, m.x - 260), y: Math.max(0, m.y - 60), width: Math.min(W - Math.max(0, m.x - 260), m.width + 300), height: Math.min(H - Math.max(0, m.y - 60), m.height + 180) });
        await press('Escape');
      }
      await button(/^Preset builder/);
      await sleep(1500);
      await js(`
        const s = document.querySelector('select[aria-label="Builder tile library"]');
        const o = [...s.options].find((o) => /fence/.test(o.text));
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
        s.dispatchEvent(new Event('change', { bubbles: true }));`);
      await sleep(1500);
      await js(`[...document.querySelectorAll('.builder-tiles button')].find((b) => b.innerText.trim() === 'Walls')?.click()`);
      await sleep(800);
      await js(`document.querySelector('.builder-tiles .thumb')?.click()`);
      await sleep(600);
      const c = await js(`const r = document.querySelector('.builder-canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`);
      for (let i = 0; i < 4; i++) await click(c.x - 40 + i * 26, c.y - 20 + i * 13);
      await sleep(400);
      await shot('preset-builder', await dialog());
      await closeDialogs();
      await js(`[...document.querySelectorAll('[role=dialog] button')].find((b) => /discard/i.test(b.innerText))?.click()`);
      await sideTab(/tiles/i);
    },

    /** New map with an existing level type. */
    async newMapType() {
      await town();
      await ribbonButton(/^New map/);
      await js(`[...document.querySelectorAll('[role=dialog] input[type=radio]')].find((r) => r.parentElement.innerText.includes('Choose Existing')).click()`);
      await sleep(300);
      await js(`
        const s = [...document.querySelectorAll('[role=dialog] select')].find((s) => [...s.options].some((o) => o.text.includes('tile libraries')));
        const opt = [...s.options].find((o) => /Barracks/i.test(o.text)) ?? s.options[1];
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, opt.value);
        s.dispatchEvent(new Event('change', { bubbles: true }));`);
      await sleep(300);
      await shot('new-map-type', await dialog());
      await closeDialogs();
    },

    /** Wall hiding, over a selection around a building's walls. */
    async wallHiding() {
      // A town with houses (Act 2's Lut Gholein): the first map the file list shows for it.
      await h.waitFor('input[placeholder^="Filter"]');
      await sleep(1500);
      await js(`
        const i = document.querySelector('input[placeholder^="Filter"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'act2/town');
        i.dispatchEvent(new Event('input', { bubbles: true }));`);
      await sleep(500);
      await js(`[...document.querySelectorAll('button')].find((b) => /\.ds1$/i.test(b.innerText.trim()))?.click()`);
      await sleep(4000);
      await blur();
      await press('f');
      await sleep(1200);
      const v = await viewport();
      await press('v');
      await drag([v.cx, v.cy - 90], [v.cx, v.cy + 90]);
      await ribbonButton(/^Wall hiding/);
      await sleep(600);
      await shot('wall-hiding', await dialog());
      await closeDialogs();
    },
  };
}
