import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev-only: serves a local Diablo II install (read-only) to the app at /__d2/.
 *
 * Configure in ds1studio.local.json:
 *   { "gameDir": "C:/Program Files/Diablo II", "modDirs": ["C:/Program Files/Diablo II/ProjectD2"], "modMpqs": false }
 * A mod dir may contain a loose `data/` tree and/or its own .mpq files.
 */

interface Config {
  gameDir?: string;
  modDirs?: string[];
  /** Also mount .mpq files found in mod dirs (default false). */
  modMpqs?: boolean;
}

export interface ManifestSource {
  id: string;
  kind: 'mpq' | 'loose';
  label: string;
}

const BASE_MPQS = ['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'];
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

  return {
    name: 'ds1studio-gamedata',
    apply: 'serve',
    configResolved(cfg) {
      const conf = loadConfig(cfg.root);
      sources = [];
      for (const [i, mod] of (conf.modDirs ?? []).entries()) {
        if (existsSync(join(mod, 'data'))) sources.push({ id: `mod${i}`, kind: 'loose', label: `${mod}${sep}data`, path: mod });
        if (conf.modMpqs) {
          for (const f of readdirSync(mod).filter((f) => /\.mpq$/i.test(f)).sort()) {
            sources.push({ id: `mod${i}-${f}`, kind: 'mpq', label: `${mod}${sep}${f}`, path: join(mod, f) });
          }
        }
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

        const src = sources.find((s) => s.id === parts[1]);
        if (!src) return next();

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
