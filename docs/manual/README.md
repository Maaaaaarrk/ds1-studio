# DS1 Studio manual

`DS1-Studio-Manual.pdf` is printed from `manual.html` (which uses the screenshots in `img/` and `../media/`).

## Rebuilding the PDF

```
node --experimental-websocket tools/build-manual.mjs
```

The build checks that every image loads and every `#link` has a target, then prints with headless Chrome: links
between sections stay clickable and the chapters become PDF bookmarks. `CHROME=<path>` picks another browser.

## Retaking the screenshots

Screenshots must show vanilla data only (no mod assets):

1. Point `ds1studio.local.json` at a vanilla install with `"modDirs": []` and `"saveDir"` set to a throwaway folder.
2. `npm run dev`
3. `SCENES=tools/manual-scenes.mjs OUT=docs/manual/img node --experimental-websocket tools/capture-docs.mjs [scene ...]`

The `importDs1` and `importDt1` scenes need sample files in `.test-output/inputs`: `My_Town.ds1` (any map saved
under that name), `mytown_tiles/mytown/{floor,fence,trees}.dt1`, `treegroups.dt1` and `stonewall.dt1` (copies of
vanilla DT1s made with the DT1 editor).
