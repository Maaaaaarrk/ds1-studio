// Regenerates the README screenshots and GIFs in docs/media from a running dev server, using headless Chrome.
//
//   1. Point ds1studio.local.json at a vanilla install (no mod folders, so no mod assets end up in the docs).
//   2. npm run dev
//   3. node --experimental-websocket tools/capture-docs.mjs [scene ...]
//
// CHROME=<path to chrome/msedge> and DS1_URL=<dev server> override the defaults.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.DS1_URL ?? 'http://localhost:5188';
const W = 1600;
const H = 900;
const OUT = 'docs/media';
const PORT = 9333;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Chrome + CDP ------------------------------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'ds1-capture-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--window-size=${W},${H}`,
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=1',
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let page;
for (let i = 0; i < 50 && !page; i++) {
  await sleep(200);
  try {
    page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page');
  } catch {
    // not up yet
  }
}
if (!page) throw new Error('Chrome did not start');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await call('Page.enable');
await call('Page.navigate', { url: URL });

// --- Page helpers -----------------------------------------------------------------------------------------------
async function js(expression) {
  const r = await call('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(selector, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await js(`return !!document.querySelector(${JSON.stringify(selector)})`)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${selector}`);
}
const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const modBits = (mods = []) => mods.reduce((b, m) => b | MODS[m], 0);
const KEY_CODES = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27, Tab: 9, Delete: 46 };
async function keyDown(key, mods = []) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const vk = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
  await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers: modBits(mods) });
}
async function keyUp(key, mods = []) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const vk = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: modBits(mods) });
}
async function press(key, mods = []) {
  await keyDown(key, mods);
  await keyUp(key, mods);
  await sleep(150);
}
async function mouse(type, x, y, extra = {}) {
  await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
}
async function click(x, y, mods = []) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, { modifiers: modBits(mods) });
  await mouse('mouseReleased', x, y, { modifiers: modBits(mods) });
  await sleep(250);
}
async function drag(from, to, steps = 12) {
  await mouse('mouseMoved', ...from);
  await mouse('mousePressed', ...from);
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, { buttons: 1 });
  await mouse('mouseReleased', ...to);
  await sleep(250);
}
async function wheel(x, y, deltaY, mods = []) {
  await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: modBits(mods) });
  await sleep(120);
}
/** Clicks the first button whose text matches (exact string or regex source). */
async function button(text, scope = 'document') {
  const test = text instanceof RegExp ? `${text}.test(t)` : `t.toLowerCase() === ${JSON.stringify(text.toLowerCase())}`;
  const ok = await js(`
    const b = [...${scope}.querySelectorAll('button')].find((b) => { const t = b.innerText.trim(); return ${test}; });
    if (!b) return false;
    b.click();
    return true;`);
  if (!ok) throw new Error(`no button ${text}`);
  await sleep(300);
}
async function openMap(filter, name) {
  await waitFor('input[placeholder^="Filter"]');
  await sleep(1500); // let the file list settle after start-up
  await js(`
    const i = document.querySelector('input[placeholder^="Filter"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(filter)});
    i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await sleep(400);
  await button(name);
  await sleep(4000);
}
async function viewport() {
  return js(`const r = document.querySelector('.viewport').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };`);
}
async function rect(selector) {
  return js(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };`);
}
async function grab(clip) {
  const r = await call('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: clip.scale ?? 1 } } : {}) });
  return Buffer.from(r.data, 'base64');
}
async function shot(name, clip) {
  await sleep(500);
  writeFileSync(`${OUT}/${name}.png`, await grab(clip));
  console.log(`  ${name}.png`);
}
/** Records a GIF: `step(i)` changes the page between frames; `hold` repeats the last frame. */
async function gif(name, frames, step, { clip, delay = 120, scale = 0.6, hold = 6 } = {}) {
  const images = [];
  for (let i = 0; i < frames; i++) {
    await step(i);
    const png = PNG.sync.read(await grab({ ...(clip ?? { x: 0, y: 0, width: W, height: H }), scale }));
    images.push(png);
  }
  const enc = GIFEncoder();
  // One palette for the whole clip keeps colours steady between frames (sampled from up to 4 frames).
  const every = Math.max(1, Math.floor(images.length / 4));
  const picked = images.filter((_, i) => i % every === 0).slice(0, 4);
  const sample = new Uint8Array(picked.reduce((n, im) => n + im.data.length, 0));
  let o = 0;
  for (const im of picked) {
    sample.set(im.data, o);
    o += im.data.length;
  }
  const palette = quantize(sample.subarray(0, o), 256);
  images.forEach((im, i) => {
    const index = applyPalette(im.data, palette);
    enc.writeFrame(index, im.width, im.height, { palette, delay: i === images.length - 1 ? delay * hold : delay });
  });
  enc.finish();
  writeFileSync(`${OUT}/${name}.gif`, enc.bytes());
  console.log(`  ${name}.gif (${images.length} frames)`);
}
async function closeDialogs() {
  for (let i = 0; i < 3; i++) {
    await press('Escape');
    await js(`document.querySelectorAll('.modal-backdrop').forEach((m) => m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));`);
  }
}
async function ribbonTab(label) {
  await button(label);
}

const helpers = { sleep, js, waitFor, press, keyDown, keyUp, click, drag, wheel, button, openMap, viewport, rect, shot, gif, closeDialogs, ribbonTab, W, H };

// --- Scenes ------------------------------------------------------------------------------------------------------
const { makeScenes } = await import('./docs-scenes.mjs');
const scenes = makeScenes(helpers);
await waitFor('input[placeholder^="Filter"]');
const wanted = process.argv.slice(2);
try {
  for (const [name, run] of Object.entries(scenes)) {
    if (wanted.length && !wanted.includes(name)) continue;
    console.log(name);
    try {
      await run();
    } catch (e) {
      console.error(`  failed: ${e.message}`);
    }
    await closeDialogs();
  }
} finally {
  ws.close();
  chrome.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold files for a moment
  }
}
