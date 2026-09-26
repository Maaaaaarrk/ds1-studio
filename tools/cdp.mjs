// Dev helper: inspect the running desktop app through WebView2's DevTools port.
// Start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9229, then:
//   node --experimental-websocket tools/cdp.mjs eval "<js expression>"
//   node --experimental-websocket tools/cdp.mjs shot out.png
import { writeFileSync } from 'node:fs';

const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const my = ++id;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== my) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: my, method, params }));
  });

if (cmd === 'eval') {
  const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result.value ?? r.result.description ?? r, null, 2));
} else if (cmd === 'shot') {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(arg, Buffer.from(r.data, 'base64'));
  console.log(`wrote ${arg}`);
}
ws.close();
