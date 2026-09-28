// Screenshots for the PDF manual (docs/manual), taken like the README media:
//   ds1studio.local.json → a vanilla install (modDirs: []) with saveDir pointing at a throwaway folder, npm run dev, then
//   SCENES=tools/manual-scenes.mjs OUT=docs/manual/img node --experimental-websocket tools/capture-docs.mjs [scene ...]
// Import screenshots need the vanilla-made inputs in .test-output/inputs (see docs/manual/README.md).
const INPUTS = 'C:/Users/shawn/ds1-studio/.test-output/inputs';

export function makeScenes(h) {
  const { sleep, js, press, click, drag, wheel, button, openMap, viewport, rect, shot, ribbonTab, chooseFile, W, H } = h;
  const NL = 'String.fromCharCode(10)';
  const dialog = () => rect('[role=dialog]');
  /** The side panel whose header matches `re` (headers are shown in capitals). */
  const panel = (re) =>
    js(`const p = [...document.querySelectorAll('.sidebar.right .panel, .sidebar.right section')].find((s) => ${re}.test(s.querySelector('.panel-header')?.innerText ?? '')); if (!p) return null; p.scrollIntoView({ block: 'start' }); const r = p.getBoundingClientRect(); return { x: r.left, y: Math.max(0, r.top), width: r.width, height: Math.min(${H} - Math.max(0, r.top), r.height) };`);
  const sidebar = () => js(`const r = document.querySelector('.sidebar.right').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };`);
  const openPanel = (re) => js(`const b = [...document.querySelectorAll('button.panel-header')].find((b) => ${re}.test(b.innerText)); if (b && b.innerText.includes('▸')) b.click();`);
  /** Screen point of a cell centre right after "fit" (same maths as MapView.fit). */
  const cellPoint = async (cx, cy, w, hgt) => {
    const v = await viewport();
    const minX = -hgt * 80, maxX = w * 80, minY = 0, maxY = (w + hgt) * 40;
    const zoom = Math.min(v.w / (maxX - minX + 160), v.h / (maxY - minY + 240), 2);
    const camX = (minX + maxX) / 2, camY = (minY + maxY) / 2;
    const wx = (cx + 0.5 - (cy + 0.5)) * 80, wy = (cx + 0.5 + cy + 0.5) * 40;
    return [v.x + v.w / 2 + (wx - camX) * zoom, v.y + v.h / 2 + (wy - camY) * zoom];
  };
  const town = async () => {
    await openMap('act1/town/town', 'townN1.ds1');
    await press('f');
    await sleep(1500);
  };
  /** Makes a layer the active one ("floor:0", "wall:0"…). */
  const setLayer = (key) =>
    js(`const s = [...document.querySelectorAll('.ribbon select')].find((x) => [...x.options].some((o) => o.value === '${key}')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${key}'); s.dispatchEvent(new Event('change', { bubbles: true }));`);
  const ribbonButton = async (re) => {
    const r = await js(`const b = [...document.querySelectorAll('.rb-btn')].find((b) => ${re}.test(b.innerText)); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 };`);
    await click(r.x, r.y);
  };
  /** Clicks an item of the open ribbon menu. */
  const menuItem = async (re) => {
    const r = await js(`const b = [...document.querySelectorAll('.rb-menu-item')].find((b) => ${re}.test(b.innerText)); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 };`);
    await click(r.x, r.y);
  };

  return {
    async window() {
      await town();
      await shot('window');
      await shot('topbar', { x: 0, y: 0, width: W, height: 34 });
      await shot('ribbon-home-full', { x: 0, y: 0, width: W, height: 124 });
      await ribbonTab('View');
      await sleep(300);
      await shot('ribbon-view', { x: 0, y: 0, width: W, height: 124 });
      await ribbonTab('Home');
    },

    async modes() {
      // A level with a light of its own (the Worldstone Chamber, Intensity 40), in the Level light mode.
      await openMap('expansion/baallair', 'wstone01.ds1');
      await press('f');
      await sleep(1500);
      await ribbonTab('View');
      await button('Level light');
      await sleep(1500);
      await shot('mode-light');
      await button('Done');
      await ribbonTab('Home');
    },

    async panels() {
      await town();
      await shot('minimap', await rect('.minimap'));
      await openPanel(/layers/i);
      await sleep(300);
      await shot('layers-panel', await panel(/^▾?\s*layers/i));
      await shot('map-info', await panel(/^▾?\s*map$/i));
    },

    async tiles() {
      await town();
      await setLayer('floor:0');
      await sleep(300);
      await js(`document.querySelector('.sidebar.right').scrollTop = 0;`);
      // Pick a few tiles (they become "recent"), pin one, and add two to a random mix.
      const thumbs = `document.querySelectorAll('.tile-palette .thumb-grid .thumb')`;
      await js(`${thumbs}[3].click()`);
      await js(`${thumbs}[6].click()`);
      await js(`${thumbs}[2].click()`);
      await js(`${thumbs}[6].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
      await js(`${thumbs}[5].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
      await js(`${thumbs}[7].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
      await sleep(600);
      const s = await sidebar();
      await shot('tiles-panel', { x: s.x, y: s.y, width: s.width, height: 560 });
      await shot('paint-modes', { x: 520, y: 34, width: 520, height: 90 });
    },

    async selection() {
      await town();
      await press('v');
      const [ax, ay] = await cellPoint(22, 14, 57, 41);
      const [bx, by] = await cellPoint(34, 24, 57, 41);
      await drag([ax, ay], [bx, by], 12);
      await sleep(800);
      await shot('selection');
      await shot('selection-panel', await panel(/selection/i));
    },

    async cell() {
      await town();
      await press('v');
      const [x, y] = await cellPoint(30, 20, 57, 41);
      await click(x, y);
      await sleep(800);
      const p = await panel(/cell/i);
      await shot('cell-panel', { ...p, height: Math.min(p.height, 900 - p.y) });
      await js(`document.querySelector('.cell-flags')?.scrollIntoView({ block: 'start' })`);
      await sleep(300);
      await shot('cell-flags', await rect('.cell-flags'));
    },

    async replace() {
      await town();
      await press('v');
      const [x, y] = await cellPoint(30, 20, 57, 41);
      await click(x, y);
      await sleep(400);
      await press('h', ['ctrl']);
      await sleep(800);
      await shot('replace', await dialog());
      await press('Escape');
    },

    async history() {
      await town();
      await setLayer('floor:0');
      await sleep(300);
      const thumbs = `document.querySelectorAll('.tile-palette .thumb-grid .thumb')`;
      await js(`${thumbs}[2].click()`);
      await press('u');
      const [ax, ay] = await cellPoint(10, 30, 57, 41);
      const [bx, by] = await cellPoint(16, 36, 57, 41);
      await drag([ax, ay], [bx, by], 8);
      await press('l');
      const [fx, fy] = await cellPoint(3, 3, 57, 41);
      await click(fx, fy);
      await press('b');
      const [px, py] = await cellPoint(40, 36, 57, 41);
      const [qx, qy] = await cellPoint(46, 36, 57, 41);
      await drag([px, py], [qx, qy], 8);
      await press('z', ['ctrl']);
      await sleep(400);
      await openPanel(/history/i);
      await sleep(400);
      await shot('history', await panel(/history/i));
      await shot('rect-fill', await js(`const r = document.querySelector('.viewport').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };`));
    },

    async objects() {
      await town();
      await press('o');
      await sleep(1500);
      await js(`[...document.querySelectorAll('.mo-row')].find((r) => /Cow/.test(r.innerText))?.click()`);
      await sleep(1200);
      await shot('objects-mode');
      await shot('objects-list', await panel(/in this map/i));
      await press('o');
    },

    async recent() {
      await openMap('act1/town/town', 'townE1.ds1');
      await openMap('act1/town/town', 'townN1.ds1');
      await sleep(600);
      await ribbonTab('Home');
      await ribbonButton('/Recent/');
      await sleep(400);
      await shot('recent-menu', { x: 0, y: 0, width: 620, height: 230 });
      await press('Escape');
      await ribbonButton('/^Import/');
      await sleep(400);
      await shot('import-dt1-menu', { x: 0, y: 0, width: 620, height: 200 });
      await press('Escape');
    },

    async warps() {
      await openMap('act1/cathedrl', 'cathy3.ds1');
      await press('f');
      await sleep(1500);
      await press('v');
      const [x, y] = await cellPoint(21, 10, 29, 35);
      await click(x, y);
      await sleep(800);
      await js(`document.querySelector('.cell-warp')?.scrollIntoView({ block: 'center' })`);
      await sleep(300);
      await shot('warp');
      await js(`[...document.querySelectorAll('.cell-warp button.link')].pop()?.click()`);
      await sleep(800);
      await shot('warp-dialog', await dialog());
      await press('Escape');
    },

    async importDs1() {
      await town();
      await js(`window.confirm = () => true;`);
      await ribbonTab('Home');
      await chooseFile(`${INPUTS}/My_Town.ds1`, async () => {
        await ribbonButton('/^Import/');
        await sleep(300);
        await menuItem('/^Map/');
      });
      await sleep(1200);
      await shot('import-ds1-before', await dialog());
      await chooseFile([`${INPUTS}/mytown_tiles/mytown/floor.dt1`, `${INPUTS}/mytown_tiles/mytown/fence.dt1`, `${INPUTS}/mytown_tiles/mytown/trees.dt1`], async () => {
        const r = await js(`const b = [...document.querySelectorAll('[role=dialog] button')].find((b) => /Add DT1 files/.test(b.innerText)); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 };`);
        await click(r.x, r.y);
      });
      await sleep(1500);
      await shot('import-ds1', await dialog());
      await press('Escape');
    },

    async importDt1() {
      await town();
      await ribbonTab('Home');
      await ribbonButton('/^Import/');
      await sleep(300);
      await chooseFile([`${INPUTS}/treegroups.dt1`, `${INPUTS}/stonewall.dt1`, `${INPUTS}/mytown_tiles/mytown/floor.dt1`], async () => {
        const r = await js(`const b = [...document.querySelectorAll('.rb-menu-item')].find((b) => /DT1 files/.test(b.innerText)); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 };`);
        await click(r.x, r.y);
      });
      await sleep(1500);
      await js(`const i = document.querySelector('[role=dialog] input.text-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'mytiles'); i.dispatchEvent(new Event('input', { bubbles: true }));`);
      await sleep(300);
      await shot('import-dt1', await dialog());
      await press('Escape');
    },

    async dialogs() {
      await town();
      await ribbonTab('View');
      await ribbonButton('/Export picture/');
      await sleep(600);
      await shot('export-image', await dialog());
      await press('Escape');
      await ribbonTab('Game');
      await button('Add to game');
      await sleep(1500);
      await js(`const s = [...document.querySelectorAll('[role=dialog] select')][0]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '1'); s.dispatchEvent(new Event('change', { bubbles: true }));`);
      await sleep(600);
      await shot('add-to-game', await dialog());
      await press('Escape');
      await ribbonTab('Map');
      await button('New map');
      await sleep(800);
      await shot('new-map', await dialog());
      await press('Escape');
      await ribbonTab('Home');
      await ribbonButton('/^Export/');
      await sleep(300);
      await menuItem('/Map package/');
      await sleep(800);
      await shot('export-package', await dialog());
      await press('Escape');
      await ribbonTab('Help');
      await button('Shortcuts');
      await sleep(600);
      await shot('shortcuts', await dialog());
      await press('Escape');
    },

    async resize() {
      await town();
      await ribbonTab('Map');
      await button('Resize');
      await sleep(800);
      await shot('resize', await js(`const r = document.querySelector('.viewport').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };`));
      await button('Resize');
      await ribbonTab('Home');
    },

    async stacked() {
      await town();
      await press('v');
      for (let i = 0; i < 4; i++) await wheel(W / 2 - 150, H / 2, -300);
      await sleep(800);
      const v = await viewport();
      await wheel(v.cx - 80, v.cy - 40, 120, ['shift']);
      await sleep(250);
      await wheel(v.cx - 80, v.cy - 40, 120, ['shift']);
      await sleep(800);
      await shot('stacked');
    },
  };
}
