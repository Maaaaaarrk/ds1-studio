import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev-only: serves a local Diablo II install (read-only) to the app at /__d2/.
 *
 * Configure in ds1studio.local.json:
 *   { "gameDir": "C:/Program Files/Diablo II", "modDirs": ["C:/Program Files/Diablo II/ProjectD2"], "modMpqs": false }
 * A mod dir may contain a loose `data/` tree and/or its own .mpq files.
 *
 * Saving (POST /__d2/save/<game path>) writes .ds1 files under `saveDir`, which defaults to the first mod dir.
 * The first time an existing file is overwritten, the original is copied to `<name>.bak`.
 *
 * Optional `winds1Dir` (a WinDS1 install) exposes Data/obj.txt (object names) and Data/ds1edit.dt1 (special-tile
 * graphics) as the virtual files winds1/obj.txt and winds1/ds1edit.dt1.
 */

interface Config {
  gameDir?: string;
  modDirs?: string[];
  /** Also mount .mpq files found in mod dirs (default false). */
  modMpqs?: boolean;
  /** Where edited files are written (default: first mod dir). */
  saveDir?: string;
  /** A WinDS1 install, for object names and special-tile graphics. */
  winds1Dir?: string;
}

const WINDS1_FILES = ['obj.txt', 'ds1edit.dt1'];

export interface ManifestSource {
  id: string;
  kind: 'mpq' | 'loose';
  label: string;
}

const BASE_MPQS = ['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq', 'd2char.mpq'];
const RELEVANT = /\.(ds1|dt1|dat|txt)$/i;

function loadConfig(root: string): Config {
  const file = join(root, 'ds1studio.local.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const fallback = 'C:/Program Files/Diablo II';
  return existsSync(join(fallback, 'd2data.mpq')) ? { gameDir: fallback } : {};
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (RELEVANT.test(name)) out.push(p);
  }
}

export function gameDataPlugin(): Plugin {
  let sources: (ManifestSource & { path: string })[] = [];
  const looseLists = new Map<string, string[]>();
  let saveRoot: string | null = null;

  return {
    name: 'ds1studio-gamedata',
    apply: 'serve',
    configResolved(cfg) {
      const conf = loadConfig(cfg.root);
      saveRoot = conf.saveDir ?? conf.modDirs?.[0] ?? null;
      sources = [];
      for (const [i, mod] of (conf.modDirs ?? []).entries()) {
        if (existsSync(join(mod, 'data'))) sources.push({ id: `mod${i}`, kind: 'loose', label: `${mod}${sep}data`, path: mod });
        if (conf.modMpqs) {
          for (const f of readdirSync(mod).filter((f) => /\.mpq$/i.test(f)).sort()) {
            sources.push({ id: `mod${i}-${f}`, kind: 'mpq', label: `${mod}${sep}${f}`, path: join(mod, f) });
          }
        }
      }
      if (conf.winds1Dir && existsSync(join(conf.winds1Dir, 'Data'))) {
        sources.push({ id: 'winds1', kind: 'loose', label: `${conf.winds1Dir}${sep}Data`, path: join(conf.winds1Dir, 'Data') });
      }
      if (conf.gameDir) {
        if (existsSync(join(conf.gameDir, 'data'))) sources.push({ id: 'game-data', kind: 'loose', label: `${conf.gameDir}${sep}data`, path: conf.gameDir });
        for (const f of BASE_MPQS) {
          const p = join(conf.gameDir, f);
          if (existsSync(p)) sources.push({ id: f, kind: 'mpq', label: f, path: p });
        }
      }
    },
    configureServer(server) {
      server.middlewares.use('/__d2', (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

        if (parts[0] === 'manifest') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(sources.map(({ id, kind, label }) => ({ id, kind, label }))));
          return;
        }

        const json = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };

        if (parts[0] === 'save-target') {
          return saveRoot ? json(200, { root: saveRoot }) : json(404, { error: 'No saveDir or modDirs configured in ds1studio.local.json' });
        }

        if (parts[0] === 'save' && req.method === 'POST') {
          if (!saveRoot) return json(409, { error: 'No saveDir or modDirs configured in ds1studio.local.json' });
          const rel = parts.slice(1).join('/');
          const file = resolve(saveRoot, rel);
          if (!/\.ds1$/i.test(rel) || !file.startsWith(resolve(saveRoot) + sep)) return json(400, { error: `refusing to write ${rel}` });
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              mkdirSync(dirname(file), { recursive: true });
              let backup: string | null = null;
              if (existsSync(file) && !existsSync(`${file}.bak`)) {
                copyFileSync(file, `${file}.bak`);
                backup = `${file}.bak`;
              }
              writeFileSync(file, Buffer.concat(chunks));
              json(200, { written: file, backup });
            } catch (e) {
              json(500, { error: String(e) });
            }
          });
          return;
        }

        const src = sources.find((s) => s.id === parts[1]);
        if (!src) return next();

        if (src.id === 'winds1') {
          const name = parts.slice(2).join('/').replace(/^winds1\//, '');
          if (parts[0] === 'list') return json(200, WINDS1_FILES.filter((f) => existsSync(join(src.path, f))).map((f) => `winds1/${f}`));
          if (parts[0] !== 'file' || !WINDS1_FILES.includes(name)) return json(404, { error: 'not found' });
          const file = join(src.path, name);
          res.setHeader('content-length', String(statSync(file).size));
          createReadStream(file).pipe(res);
          return;
        }

        if (parts[0] === 'list' && src.kind === 'loose') {
          let files = looseLists.get(src.id);
          if (!files) {
            const abs: string[] = [];
            walk(join(src.path, 'data'), abs);
            files = abs.map((p) => relative(src.path, p).split(sep).join('/'));
            looseLists.set(src.id, files);
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(files));
          return;
        }

        if (parts[0] === 'file') {
          const file = src.kind === 'mpq' ? src.path : resolve(src.path, parts.slice(2).join('/'));
          // Never serve anything outside the configured folder.
          if (src.kind === 'loose' && !file.startsWith(resolve(src.path) + sep)) {
            res.statusCode = 403;
            res.end();
            return;
          }
          if (!existsSync(file)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const size = statSync(file).size;
          res.setHeader('accept-ranges', 'bytes');
          res.setHeader('cache-control', 'no-store');
          const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range ?? '');
          if (m) {
            const start = Number(m[1]);
            const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
            res.statusCode = 206;
            res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
            res.setHeader('content-length', String(end - start + 1));
            if (req.method === 'HEAD') return void res.end();
            createReadStream(file, { start, end }).pipe(res);
          } else {
            res.setHeader('content-length', String(size));
            if (req.method === 'HEAD') return void res.end();
            createReadStream(file).pipe(res);
          }
          return;
        }
        next();
      });
    },
  };
}
