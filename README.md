# DS1 Studio

A modern map-preset (DS1) viewer — and, soon, editor — for classic Diablo II (1.13/1.14), meant to replace WinDS1.

TypeScript + WebGL2 + React, packaged as a Windows desktop app with Tauri (it also runs in a browser for development).

## Desktop app

```bash
npm install
npm run app:dev     # run the desktop app (hot reload)
npm run app:build   # build an installer: src-tauri/target/release/bundle/nsis/
```

Needs Rust (rustup, MSVC toolchain) and the Visual Studio C++ build tools. On first start it asks for the Diablo II,
mod and (optional) WinDS1 folders and remembers them (Map ▾ → Folders… to change). The native side only reads inside
those folders and only writes `.ds1` files into the mod folder.

## Browser / dev server

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
  "modMpqs": false,
  "winds1Dir": "C:/path/to/win_ds1edit"
}
```

`winds1Dir` is optional: if set, the app reads WinDS1's `Data/obj.txt` (object names) and `Data/ds1edit.dt1`
(labelled graphics for special tiles such as warps, entries and corpse locations). Without it, NPC names come from
`MonPreset.txt` and special tiles are drawn as numbered markers.

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

## Ribbon

| Tab | What's there |
|---|---|
| **Home** | Save / Save as / Export, clipboard, undo/redo, tools, active layer, view toggles, Compatibility check |
| **Map** | New map, **Resize** (drag the handles on the map edges) or Resize…, palette, **Tile libraries** (add/remove DT1s), **Presets** (panel, save selection, suggest), **Export / Import package** |
| **Data** | **Data tables** (edit any .txt table in a spreadsheet), shortcuts to LvlPrest/LvlTypes/Levels/…, **Add to game** (LvlPrest/Levels/LvlTypes rows), **Cube recipe** (Misc.txt item + CubeMain.txt recipe), Compatibility |

- **Presets** are saved as JSON in the mod (`data/ds1studio/presets/`), so they travel with it. *Suggest* scans every map that shares
  this map's tile libraries and proposes recurring structures (buildings, wall runs, tree groups…), ranked by how often they occur.
- **Compatibility check**: missing tiles/DT1s, LvlPrest/Levels/LvlTypes wiring, DT1s used but not loaded by the level type (Dt1Mask),
  entry/warp markers, NPCs on unwalkable ground, stacked objects, compiled .bin reminders.
- **Tile libraries** keep the game's tables in step: adding a DT1 puts it in a free `File N` slot of the level type
  (LvlTypes.txt) and recomputes the preset's `Dt1Mask` (LvlPrest.txt); removing one clears its bit. Maps not yet in LvlPrest
  need *Add to game* first.
- **Map packages** (.zip): the DS1, its DT1s, custom object sprites and every table row the map needs: LvlPrest, Levels,
  LvlTypes, the level's LvlWarp and LvlMaze rows, and a cube recipe made for it (CubeMain + its Misc item). Import merges the level
  tables by meaning (reuses same-named rows, gives clashing ids new ones, puts DT1s into free slots and recomputes Dt1Mask against
  the importer's own LvlTypes) and the rest by key; re-importing an unchanged map changes nothing.
- **Overlapping tiles**: Shift+mouse wheel over tiles that overlap (trees over trees, a wall over a floor) steps through them one
  at a time; the chosen tile is outlined and only its layer is selected, so copy/cut/Delete leave the others alone. Esc goes back
  to all layers.
- **Automap preview** (View → Automap, **A**): draws the in-game automap over the map from AutoMap.txt + MaxiMap.dc6, outlines
  walls with no AutoMap.txt entry (they won't show in game), and for the selected cell lists each tile's code (fl, wl, wtll…),
  style, sequence, matching row and piece. *Change piece…* opens a gallery of MaxiMap pieces and writes the AutoMap.txt row for you
  (this sequence only, or every sequence of the style). Mod level types keyed by LvlTypes id (PD2's "47") are matched too.
- **Automap suggestions**: *Suggest pieces for missing tiles* proposes a piece for every tile without an automap entry (the level's
  usual piece for that kind of tile, else the most common one in the game), previews it on the map in cyan, lets you swap the piece
  per kind or skip a kind, and writes the rows in one go. Modded MaxiMap.dc6 sheets are used when the mod has one.
- **DT1 editor** (Map → DT1 editor): duplicate/rename a DT1 and recolour it (hue, saturation, brightness, tint, replace a colour) for
  the whole file, hand-picked tiles, the tiles of a preset, or the tiles used in the map selection. The preview is exact (colours
  snap to the act palette); the copy can replace the original in the map, updating LvlTypes/Dt1Mask.
- **Tile libraries** window shows every tile of the clicked DT1 (filter by kind, Ctrl+wheel zoom, details), in its own act palette.
- **Object gallery**: object mode shows every object/NPC as a sprite thumbnail; click one to place it.
- **Game view** (**Z**): zooms to the 800×600 in-game screen centred on the selection, shading what the character can't see.
- **Stacking**: hold **Alt** when you click to place a preset or paste, and tiles landing on occupied cells go into the next free
  wall/floor layer (adding Wall 2–4 / Floor 2 when needed) instead of replacing what is there.
- What the app may write (mod folder only, originals kept as `.bak`): `.ds1/.dt1/.cof/.dcc/.dc6` under `data/global/`, `.txt` under
  `data/global/excel/`, and presets under `data/ds1studio/`.

## Roadmap

- [x] Viewer: MPQ + loose files, all DS1 versions, walls/floors/shadows/roofs/lower walls, objects, NPC paths, inspector
- [x] DS1 writer, byte-exact on every vanilla and ProjectD2 v18 preset
- [x] Tile editing: tile palette, paint/erase/pick, brush preview, undo/redo, save with backup
- [x] Rectangle selection: fill, copy/paste, move; per-cell flag editing (hidden, prop bytes)
- [x] Objects & NPC paths editing, object/monster names, special tiles (WinDS1 graphics), animated floors, walkability overlay
- [x] Substitution groups and tag layer editing; resize map; new map; save as
- [x] Object sprites (COF/DCC/DC6), depth-sorted with walls
- [x] Tauri desktop shell
- [x] Ribbon UI, DT1 manager, presets (+ suggestions), table editor, add-to-game and cube-recipe wizards, compatibility check, map packages, animated object preview
