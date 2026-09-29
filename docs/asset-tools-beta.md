# DS1 Studio 0.2.16 — asset tools

This release adds map management, cleanup, selection, floor and water tools. Update through Help → Check for updates or use the installer from the GitHub release. Recovery folders are created beside the executable, which must be in a writable folder; keep those recovery folders with it if you move the app.

## Where to find the changes

| Task | Location |
| --- | --- |
| Delete a loose DS1 map | Right-click its name in the left DS1 pane → Delete DS1 |
| Check game compatibility | Diagnostics → Compatibility |
| Find unused libraries or tile groups | Diagnostics → Unused DT1s |
| Recover deleted or moved assets | Diagnostics → Restore assets, or Deleted by accident? in the DT1 review |
| Find a library's map placements | Map → Tile libraries → choose a library → Select matching map tiles |
| Remove its placements and attachment | Map → Tile libraries → Clear tiles & detach |
| Edit objects | View → Mode → Objects, or Tab through modes |
| Reroll floors | Map → Reroll floors, or the selection panel's Re-roll Floor button |
| Clear selected automap pieces | View → Automap → Clear selected automap pieces |
| Edit/create animated water | Map → Animated water |

## Cleanup and recovery

The scan considers indexed maps in the configured game/mod sources, their embedded DT1 lists, game-table references, and unsaved changes in the open map. Saved and shadowed map versions are also checked. A library counts as used even if a map loads it without placing any of its tiles. Individual tile usage includes every tile layer and hidden placements.

The two cleanup tabs distinguish whole unused files from unused tile groups inside a file. Hover thumbnails for a larger preview, check the items, then move or delete them. Frames and random variants sharing a tile ID stay together, because a DS1 references that ID rather than a particular image record.

Moving creates a dated subfolder under the source mod's `data/global/tiles/PD2assets/unused`. This folder is excluded from the active tile lists. Partial cleanup keeps used records in the original DT1 and writes the removed records into the unused folder.

Deletion requires confirmation. Before changing a DT1, the app saves its complete original in `Deleted DT1s` beside the executable. DS1 deletion similarly uses `Deleted DS1s`. Recovery records remember the original folder. Restore refuses to overwrite a different, newer file; restore repeated changes to the same file from newest to oldest. Keep the backup folders intact.

Cleanup rechecks map references before modifying files and rejects DT1s changed since the scan. If any map cannot be checked safely, cleanup is disabled. Missing maps with known table references protect those referenced libraries. Archive contents and unsupported/unreadable DT1s are protected. Effective libraries are shown once per virtual path; shadowed physical copies are not separate cleanup candidates. Files outside configured sources, and unlisted archive members with no known name, are outside the scan's coverage.

Deleting a DS1 removes its loose file only. If an archive or lower-priority source has the same map, that version can reappear. Game-table registrations are not deleted. Run Compatibility after changing maps used by the game.

## Selection and map references

In 0.2.18, a blue hover preview shows the combined visible artwork of a cell, including after scrolling through layers. Selected artwork remains gold; dragged selections highlight all visible layers in every selected cell. The Show bar stays directly above the map with floor layers, wall layers, upper walls, lower walls, roofs, shadows and special tiles. Wall-layer buttons control the upper walls, lower walls and roofs stored in that layer; category buttons filter those kinds across enabled layers.

As of 0.2.19, only Shift+scroll selects an individual tile. Ordinary scrolling zooms, including over selected cells. Normal clicks and drags select every visible tile in the selected cells; Copy and Cut include those layers, and Delete clears their tiles. Hidden categories/layers stay behind. Shift+Delete also clears objects and NPCs in the area.

Clicking visible wall artwork selects its owning cell, including its other visible tile layers, even when it overlaps another grid cell. Clicking floor or empty space selects the grid cell under the pointer. Drag selections start at the pointer's grid cell and follow the grid. Shift+click adds a wall's owning cell or a grid cell; Shift+drag adds a grid area. Shift+wheel cycles individual overlapping visible tiles in either direction. Esc or a normal click restores combined selection. Pick/Alt-click still samples visible artwork. Pointer projection accounts for display scaling, canvas size and renderer rounding, and interrupted drags release their selection state.

DT1 wall categories, under the Show bar, lets a loaded library use Automatic (the DT1 orientation), Upper walls or Lower walls. These groups work across W1–W4 and are saved as editor preferences. They do not change tile orientations, map contents or draw order in the game. Only wall tiles are reassigned; floors and roofs keep their own categories. The list shows each library's tile heights and native categories. For example, guild/outdoors/cliff.dt1 contains tall upright-wall tiles, not native lower-wall tiles; assigning that DT1 to Lower walls makes the Lower toggle control its artwork regardless of the numbered layer.

In the Tiles sidebar, a normal click replaces the paint choice. Ctrl/Command-click explicitly adds to the random mix. Frames/variants with a shared ID appear as one paint choice. In the DT1 editor, an ordinary click replaces the thumbnail selection, Ctrl-click toggles it, and Shift-click selects a range; changing libraries clears the selection. A map selection's holes are preserved when choosing its DT1 tiles.

Map → Tile libraries can search the attached libraries and select all cells matching a library's tile IDs. DT1s can share IDs, so this is deliberately conservative: the confirmation explains that matching placements may also be provided by another attached library. Clear tiles & detach removes those placements and the library attachment, with map undo available. Save the map to retain the result.

Tab and Shift+Tab cycle Tiles, Objects, Walkability, Automap, Level light and Roof hiding. A brief alert at the top of the map names the new mode.

## Floor reroll

Choose any number of floor tiles from multiple libraries, a floor layer and a variation seed. The tool balances choices, avoids adjacent repeats where possible, respects irregular selections and leaves empty cells alone. Preserve walkability keeps cells whose 5×5 walk-blocking pattern cannot be matched. It does not infer artistic terrain seams or generate transition artwork.

Chosen static variants receive independent safe tile IDs; selecting an animated floor includes its full animation. The tool creates a new `studio/f….dt1` library without editing the sources. Floor placement is one undo step; attaching the generated library is a separate step. Save the map afterward. Game library-slot limits still apply.

## Automap clearing

Select cells and use Clear selected automap pieces. The tool copies their artwork under fresh IDs and gives those IDs blank automap rules, preserving pieces on other cells that used the original tile type. This creates a small generated DT1 and updates AutoMap.txt. Undo restores map placements; generated files remain available for later cleanup. Save the map to keep the change. The existing rule-level controls still affect a tile type globally.

## Animated water

Choose an existing animated floor group to edit its frames, reorder or duplicate frames, remove frames, or paint pixels. A static floor can also become a new animation. Create new water generates a looping ripple pattern from two colors, direction, frame count and walk-blocking choice. Colors are matched to the map's indexed palette.

Use the playback and frame controls to review the loop. Preview FPS affects this viewer only; the game's animation timing is not changed. Save to a new named DT1 or confirm an overwrite of the original group. New libraries can be attached to the map with non-conflicting IDs. Existing unrelated tile groups are retained. Frame counts range from 2 to 64. Save the map after attaching a new library.

## Validation and remaining limits

The implementation includes regression tests for cleanup grouping, saved/shadowed map references, water encoding, floor reroll, per-cell automap clearing, input projection and selection behavior. Native recovery tests exercise deletion, partial moves, restore conflicts, stale files, invalid paths, failed backups and DS1 recovery. Browser checks exercise the new dialogs on isolated test assets.

Validation passed: 230 application tests, five native recovery tests, type checking and a Windows production build. Browser verification and native file-operation tests do not replace a playthrough in Diablo II/PD2. Native desktop UI and in-game validation, particularly generated water, remain outstanding. The local game assets used during development were read only; UI save tests used an isolated fixture folder.
