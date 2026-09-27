// Builds docs/manual/DS1-Studio-Manual.pdf from docs/manual/manual.html with headless Chrome. Links between sections
// stay clickable in the PDF, and the chapters become PDF bookmarks.
//
//   node --experimental-websocket tools/build-manual.mjs
//
// CHROME=<path to chrome/msedge> overrides the browser.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = resolve('docs/manual/manual.html');
const OUT = resolve('docs/manual/DS1-Studio-Manual.pdf');
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'ds1-manual-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--allow-file-access-from-files', 'about:blank'],
  { stdio: 'ignore' },
);
try {
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
    new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const js = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

  await call('Page.enable');
  await call('Page.navigate', { url: pathToFileURL(SRC).href });
  for (let i = 0; i < 100 && (await js('document.readyState')) !== 'complete'; i++) await sleep(100);
  const broken = await js(
    `Promise.all([...document.images].map((i) => i.decode().catch(() => null))).then(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')))`,
  );
  if (broken.length) throw new Error(`images not found: ${broken.join(', ')}`);
  const dead = await js(`[...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1)).filter((id) => !document.getElementById(id))`);
  if (dead.length) throw new Error(`links to missing sections: ${[...new Set(dead)].join(', ')}`);

  const footer = `<div style="width: 100%; font: 8px 'Segoe UI', sans-serif; color: #7a818c; padding: 0 15mm; display: flex; justify-content: space-between;"><span>DS1 Studio — How-To Manual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
  const { data } = await call('Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: footer,
    generateDocumentOutline: true,
    generateTaggedPDF: true,
  });
  writeFileSync(OUT, Buffer.from(data, 'base64'));
  console.log(`wrote ${OUT}`);
  ws.close();
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
