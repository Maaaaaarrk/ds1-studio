# DS1 Studio

A modern map-preset (DS1) viewer — and, soon, editor — for classic Diablo II (1.13/1.14), meant to replace WinDS1.

TypeScript + WebGL2 + React, runs in the browser today; a Tauri desktop shell is planned.

## Running

```bash
npm install
npm run dev        # http://localhost:5188
```

In dev mode the app reads your game install directly (read-only) through a small Vite plugin.
Configure it in `ds1studio.local.json` (git-ignored; see `ds1studio.local.example.json`):

```json
{
  "gameDir": "C:/Program Files/Diablo II",
  "modDirs": ["C:/Program Files/Diablo II/ProjectD2"],
  "modMpqs": false
}
```

Without that file it falls back to `C:/Program Files/Diablo II`. Without a dev server (e.g. a static build),
the app asks for the folders via the browser's folder picker (Chrome/Edge).

File priority: mod `data/` folders → mod MPQs (if `modMpqs`) → `patch_d2.mpq` → `d2exp.mpq` → `d2data.mpq`.
Nothing is ever written to the game or mod folders.

```bash
npm test           # parses every DS1/DT1 in your install; skipped if the game isn't found
npm run typecheck
```

## Controls

Drag to pan · scroll to zoom (around the cursor) · **F** fit · **G** grid · **O** objects · hover a cell to inspect it.

## Layout

| Path | What |
|---|---|
| `src/formats/mpq/` | MPQ reader: hash/block tables, Storm decryption, sectors, zlib + PKWARE explode (port of blast.c) |
| `src/formats/ds1.ts` | DS1 parser, versions 1–18: layers, objects, substitution groups, NPC paths |
| `src/formats/dt1.ts` | DT1 parser + isometric/RLE block decoder |
| `src/vfs/` | Layered virtual file system (loose folders, MPQs), dev-server and folder-picker loaders |
| `src/game/GameData.ts` | LvlPrest → Levels → LvlTypes + Dt1Mask resolution, tile lookup with rarity variants |
| `src/render/` | Scene builder (placement + draw order), palette-indexed texture-array atlas, instanced WebGL2 renderer |
| `src/ui/` | React UI: preset browser, viewport, layers, inspector, map info |
| `tools/vite-plugin-gamedata.ts` | Dev-only read-only file server with HTTP range support |

## How DT1s are chosen

Like the game: the DS1's row in `LvlPrest.txt` gives a `LevelId` and `Dt1Mask`; `Levels.txt` maps the level to a
`LvlTypes.txt` row, and each set mask bit *i* selects that row's `File i+1`. Presets shared by several levels
(`LevelId` 0) and presets not in LvlPrest at all get the level type whose files best match the DS1's embedded
file list; you can override the level type per map in the **Map** panel.

## Roadmap

- [x] Viewer: MPQ + loose files, all DS1 versions, walls/floors/shadows/roofs/lower walls, objects, NPC paths, inspector
- [x] DS1 writer, byte-exact on every vanilla and ProjectD2 v18 preset
- [x] Tile editing: tile palette, paint/erase/pick, brush preview, undo/redo, save with backup
- [ ] Rectangle selection: fill, copy/paste, move; per-cell flag editing (hidden, prop bytes)
- [ ] Objects & NPC paths editing, substitution groups, tag layer, special tiles (warps, spawn points)
- [ ] Object/monster names, animated floors, walkability (sub-tile flags) overlay
- [ ] Tauri desktop shell (needs the Rust toolchain)
