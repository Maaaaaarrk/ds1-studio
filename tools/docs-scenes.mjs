// Scenes for tools/capture-docs.mjs: each one sets the app up and writes screenshots/GIFs to docs/media.
export function makeScenes(h) {
  const { sleep, js, press, keyDown, keyUp, click, drag, wheel, button, openMap, viewport, rect, shot, gif, ribbonTab, W, H } = h;

  /** Zoom around a point (negative notches = in). */
  const zoomAt = async (x, y, notches) => {
    for (let i = 0; i < Math.abs(notches); i++) await wheel(x, y, notches < 0 ? -300 : 300);
  };
  const zoom = async (notches) => {
    const v = await viewport();
    await zoomAt(v.cx, v.cy, notches);
  };
  const fit = () => press('f');
  const stage = async () => {
    const v = await viewport();
    return { x: v.x, y: v.y, width: v.w, height: v.h };
  };
  const dialog = () => rect('[role=dialog]');
  const setRange = (selector, value) =>
    js(`const el = document.querySelector(${JSON.stringify(selector)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event('input', { bubbles: true }));`);
  const setSelect = (selector, match) =>
    js(`const el = document.querySelector(${JSON.stringify(selector)});
        const o = [...el.options].find((o) => ${match}.test(o.text));
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, o.value);
        el.dispatchEvent(new Event('change', { bubbles: true }));`);
  /** Makes sure the automap view is on (true) or off (false). */
  const automapOn = async (on) => {
    const shown = await js(`return [...document.querySelectorAll('.panel')].some((p) => /^automap/i.test(p.innerText.trim()))`);
    if (shown !== on) await press('a');
    await sleep(on ? 2500 : 300);
  };
  /** Opens a tile library in the DT1 editor's tree by searching for it. */
  const pickLibrary = async (search) => {
    await js(`const i = document.querySelector('.dtt input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(search)});
      i.dispatchEvent(new Event('input', { bubbles: true }));`);
    await sleep(400);
    await js(`document.querySelector('.dtt-file')?.click();`);
    await sleep(1500);
  };
  const town = async () => {
    await openMap('act1/town/town', 'townN1.ds1');
    await fit();
    await sleep(1500); // object sprites
  };

  return {
    async overview() {
      await town();
      await zoom(-2);
      const v = await viewport();
      await click(v.cx + 40, v.cy + 20);
      await press('Escape');
      await shot('overview');
    },

    async tileFocus() {
      await town();
      await zoom(-4);
      const v = await viewport();
      await click(v.cx - 60, v.cy - 40);
      await sleep(600);
      await shot('tile-focus');
    },

    async stackedTiles() {
      await openMap('act1/outdoors/bord1', 'bord1.ds1');
      await fit();
      await zoom(-2);
      const v = await viewport();
      await gif(
        'stacked-tiles',
        7,
        async (i) => {
          if (i > 0) await wheel(v.cx, v.cy, 120, ['shift']);
          await sleep(250);
        },
        { clip: { x: v.x + v.w * 0.2, y: v.y + v.h * 0.1, width: v.w * 0.6, height: v.h * 0.8 }, delay: 700, scale: 0.7, hold: 2 },
      );
    },

    async walkability() {
      await town();
      await zoom(-2);
      await press('w');
      await sleep(600);
      await shot('walkability', await stage());
      await press('w');
    },

    async rooms() {
      await town();
      await press('r');
      await press('g');
      await sleep(400);
      await shot('rooms', await stage());
      await press('r');
      await press('g');
    },

    async automap() {
      await town();
      await zoom(-2);
      await automapOn(true);
      await shot('automap');
      await gif(
        'automap-toggle',
        6,
        async () => {
          await press('a');
          await sleep(700);
        },
        { clip: await stage(), delay: 900, scale: 0.5, hold: 1 },
      );
      await automapOn(false);
    },

    async automapSuggest() {
      await town();
      await automapOn(true);
      await zoom(-2);
      await button('Suggest pieces for missing tiles');
      // Wait for the analysis to finish (the Discard button appears with the suggestions).
      for (let i = 0; i < 90 && !(await js(`return [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Discard')`)); i++) await sleep(1000);
      await sleep(800);
      await shot('automap-suggest');
      await button('Discard');
      await automapOn(false);
    },

    async automapEditor() {
      await town();
      await ribbonTab('Game');
      await button('Automap editor');
      for (let i = 0; i < 20 && !(await js(`return !!document.querySelector('.am-editor')`)); i++) await sleep(500);
      await sleep(1200);
      await js(`[...document.querySelectorAll('.am-editor .amc-sub')].find((r) => /Left walls/.test(r.innerText))?.click();`);
      await sleep(800);
      await shot('automap-editor');
      await js(`[...document.querySelectorAll('.am-editor .modal-actions button')].find((b) => b.innerText.trim() === 'Close')?.click();`);
      await ribbonTab('Home');
    },

    async objects() {
      await town();
      await zoom(-2);
      await press('o');
      await sleep(1000);
      await js(`document.querySelector('.og-grid')?.closest('.panel')?.scrollIntoView({ block: 'start' });`);
      await sleep(3000);
      await shot('objects');
      await press('v');
    },

    async gameView() {
      await town();
      await press('z');
      await sleep(800);
      await shot('game-view', await stage());
      await press('z');
    },

    async arrowPan() {
      await town();
      await zoom(-3);
      await sleep(500);
      await gif(
        'arrow-pan',
        16,
        async (i) => {
          const key = i < 8 ? 'ArrowRight' : 'ArrowDown';
          await keyDown(key);
          await sleep(110);
          await keyUp(key);
        },
        { clip: await stage(), delay: 90, scale: 0.45, hold: 3 },
      );
    },

    async tileLibraries() {
      await town();
      await ribbonTab('Map');
      await button('Tile libraries');
      await sleep(800);
      await js(`[...document.querySelectorAll('.dt1m-list li')].find((l) => /treegroups\\.dt1/i.test(l.innerText))?.click();`);
      await sleep(1500);
      await js(`document.querySelectorAll('.dt1v-grid .thumb')[1]?.click();`);
      await sleep(800);
      await shot('tile-libraries', await dialog());
      await ribbonTab('Home');
    },

    async dt1Editor() {
      await town();
      await ribbonTab('Map');
      await button('DT1 editor');
      await sleep(1200);
      await pickLibrary('outdoors/treegroups');
      await sleep(2000);
      await setRange('.dte-slider input[type=range]', 140);
      await sleep(1200);
      await shot('dt1-editor', await dialog());
      await gif(
        'recolor',
        12,
        async (i) => {
          await setRange('.dte-slider input[type=range]', -180 + i * 30);
          await sleep(700);
        },
        { clip: await rect('.dte-grid'), delay: 260, scale: 0.6, hold: 2 },
      );
      await ribbonTab('Home');
    },

    async pixelPainter() {
      await town();
      await ribbonTab('Map');
      await button('DT1 editor');
      await sleep(1200);
      await pickLibrary('town/fence');
      await sleep(1500);
      await js(`document.querySelectorAll('.dte-grid .thumb')[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`);
      await sleep(800);
      await setRange('.pp-toolbar input[type=range]:nth-of-type(1)', 3);
      await js(`[...document.querySelectorAll('.pp-palette.all .pp-swatch')].find((b) => b.title === '#151').click();`);
      const c = await rect('.pp-canvas');
      const clip = await dialog();
      const strokes = [
        [[0.3, 0.35], [0.7, 0.45]],
        [[0.35, 0.55], [0.65, 0.6]],
        [[0.4, 0.7], [0.6, 0.75]],
      ];
      await gif(
        'pixel-paint',
        4,
        async (i) => {
          if (i === 0) return sleep(300);
          const [[ax, ay], [bx, by]] = strokes[i - 1];
          await drag([c.x + c.width * ax, c.y + c.height * ay], [c.x + c.width * bx, c.y + c.height * by], 18);
        },
        { clip, delay: 700, scale: 0.55, hold: 3 },
      );
      await shot('pixel-painter', clip);
      await button('Cancel');
      await ribbonTab('Home');
    },

    async presets() {
      await town();
      await button('Presets');
      await sleep(400);
      await js(`[...document.querySelectorAll('button')].find((b) => /^Suggest/.test(b.innerText.trim()))?.click();`);
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (await js(`return !/Scanning|Analysing/i.test(document.body.innerText)`)) break;
      }
      await sleep(1500);
      await shot('presets');
      await button('Tiles');
    },

    async dataTables() {
      await town();
      await ribbonTab('Game');
      await button('LvlPrest');
      await sleep(1500);
      await js(`document.querySelector('.col-help, [class*=help]')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`);
      await sleep(500);
      await shot('data-tables');
      await ribbonTab('Home');
    },

    async compatibility() {
      await town();
      await ribbonTab('Diagnostics');
      await button('Compatibility');
      await sleep(2500);
      await shot('compatibility', await dialog());
    },

    async tileSettings() {
      await town();
      await ribbonTab('Map');
      await button('DT1 editor');
      await sleep(1200);
      await pickLibrary('town/fence');
      await sleep(1500);
      await js(`document.querySelectorAll('.dte-grid .thumb')[2].click();`);
      await sleep(500);
      await js(`[...document.querySelectorAll('.dte-tabs .chip')].find((b) => /Tile settings/.test(b.innerText)).click();`);
      await sleep(800);
      // Paint "block missiles" on a row of sub-tiles to show the flag editor at work.
      await js(`[...document.querySelectorAll('.st-bits button, .st-bit')].find((b) => /Block missiles/.test(b.innerText))?.click();`);
      await sleep(200);
      const c = await rect('.st-canvas');
      await drag([c.x + c.width * 0.35, c.y + c.height * 0.88], [c.x + c.width * 0.72, c.y + c.height * 0.8], 10);
      await sleep(500);
      await js(`document.querySelector('.ts-field')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`);
      await shot('tile-settings', await dialog());
      await button('Close');
      await sleep(300);
      await js(`[...document.querySelectorAll('[role=dialog] button')].find((b) => /discard|close/i.test(b.innerText))?.click();`);
      await ribbonTab('Home');
    },

    async cubeRecipe() {
      await town();
      await ribbonTab('Game');
      await button('Cube recipe');
      await sleep(2500);
      // A template item picked, so the plan of what gets written shows.
      await js(`[...document.querySelectorAll('.cr-list button')].find((b) => /Healing Potion/.test(b.innerText))?.click();`);
      await sleep(800);
      await shot('cube-recipe', await dialog());
      await js(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Cancel' || b.innerText.trim() === 'Close')?.click();`);
      await ribbonTab('Home');
    },

    async help() {
      await ribbonTab('Help');
      await sleep(300);
      await shot('help-menu', { x: 0, y: 0, width: 900, height: 125 });
      await button('About');
      await sleep(500);
      await shot('about', await dialog());
      await ribbonTab('Home');
    },

    async ribbon() {
      await town();
      // The Game tab keeps its old picture name (ribbon-data.png).
      for (const [tab, file] of [['Home', 'home'], ['Map', 'map'], ['Game', 'data']]) {
        await ribbonTab(tab);
        await sleep(300);
        await shot(`ribbon-${file}`, { x: 0, y: 0, width: W, height: 125 });
      }
      await ribbonTab('Home');
    },
  };
}
