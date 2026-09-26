// Generates src-tauri/app-icon.png (1024x1024): a gold isometric diamond on a dark rounded square.
// Run: node node_modules/tsx/dist/cli.mjs tools/make-icon.ts && npx tauri icon src-tauri/app-icon.png
import { writeFileSync } from 'node:fs';
import { zlibSync } from 'fflate';

const N = 1024;
const px = new Uint8Array(N * N * 4);

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const cx = N / 2;
const cy = N / 2;
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    // Rounded-square background.
    const r = 180;
    const qx = Math.max(Math.abs(x - cx) - (N / 2 - 40 - r), 0);
    const qy = Math.max(Math.abs(y - cy) - (N / 2 - 40 - r), 0);
    if (Math.hypot(qx, qy) > r) continue;
    const shade = 18 + Math.round((y / N) * 10);
    px.set([shade, shade + 2, shade + 6, 255], i);
    // Isometric diamond (2:1), gold with a lighter upper-left face.
    const d = Math.abs(x - cx) / 330 + Math.abs(y - cy) / 200;
    if (d <= 1) {
      const top = y < cy;
      const edge = d > 0.9;
      const col = edge ? [120, 88, 30] : top ? (x < cx ? [236, 196, 110] : [212, 168, 79]) : x < cx ? [184, 140, 60] : [160, 118, 48];
      px.set([...col, 255], i);
    }
  }

const raw = new Uint8Array(N * (N * 4 + 1));
for (let y = 0; y < N; y++) raw.set(px.subarray(y * N * 4, (y + 1) * N * 4), y * (N * 4 + 1) + 1);
const ihdr = new Uint8Array(13);
const hv = new DataView(ihdr.buffer);
hv.setUint32(0, N);
hv.setUint32(4, N);
ihdr.set([8, 6, 0, 0, 0], 8);
const png = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())];
const total = png.reduce((s, p) => s + p.length, 0);
const out = new Uint8Array(total);
let o = 0;
for (const p of png) {
  out.set(p, o);
  o += p.length;
}
writeFileSync('src-tauri/app-icon.png', out);
console.log('wrote src-tauri/app-icon.png');
