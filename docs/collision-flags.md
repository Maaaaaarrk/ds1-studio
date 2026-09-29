# DT1 collision editing

A DT1 tile has 25 bytes, one per sub-tile in its 5×5 footprint. Each byte is eight independent flags, not mutually exclusive types. `01 | 02 | 04 = 07`.

The classic engine ORs these bytes into its room collision grid. Floors, walls (including corner halves), and roofs contribute; shadows do not. Removing a flag from one contributor does not remove it from another. DS1 cell properties also contribute: bit 17 adds `01` across the whole cell; bit 16 adds `04`. A missing floor can introduce an implicit walking blocker.

## Meanings and limits

| Bit | Description | Evidence / limitations |
|---|---|---|
| 01 | Block walking | WALL; used in ordinary player and monster path masks. |
| 02 | Sight / shooting barrier | VISIBLE; obstacles that cannot be shot over. Skill checks vary. |
| 04 | Jump / flight barrier | MISSILE_BARRIER; used in flying and leap checks. Teleport destination collision depends on Levels.txt Teleport. Do not promise universal teleport prevention. |
| 08 | Block player walking | NOPLAYER; present in player-path masks, absent from ordinary monster-path masks. Other flags still apply. |
| 10 | Preset / placement | PRESET in the classic collision grid. Not a general-purpose missile blocker. |
| 20 | Light / blank | OpenDiablo2 calls this BlockLight; D2MOO calls the collision value BLANK and includes it in some movement masks. Not necessarily only lighting. |
| 40 | Missile mask bit | Overlaps dynamic MISSILE occupancy. An authored terrain meaning is not established. Monster-only block is unsupported: MONSTER is 0100, outside a DT1 byte. |
| 80 | Player mask bit | Overlaps dynamic PLAYER occupancy. An authored terrain meaning is not established. Do not label it universally unused. |

The last four bits are advanced flags so existing combinations can be preserved or deliberately edited. These sources describe classic Diablo II or compatible implementations, not proof of every Project Diablo 2 modification. Test unusual combinations and skill interactions in the target mod.

## Editor behaviour

- Add flags ORs checked flags into each painted sub-tile.
- Remove flags clears only checked flags across contributors.
- Set exactly replaces all eight bits. 00 clears them all.
- Make walkable removes 0D (walking, player walking, jump/flight) while preserving other flags. Advanced flags, objects, doors and runtime occupancy may still affect movement.
- Hover a map cell to inspect all 25 bytes; click a diamond in the panel to paint precisely. Pick combination copies its byte into an exact brush.
- Amber/red map colours show movement flags; the inspector shows all bits.

Edits create map-specific copies, preserving graphics, animation data, variant order and weights. Original shared DT1s are unchanged. Copies are appended so map undo can reference older tiles. A stroke, including its added library and floor layer, is one map-history operation. If a cell cannot be edited safely, none of that cell's edits are applied and the reason is shown.

## Primary implementation sources inspected

D2MOO revision 5596f5cb6c5251a0a07c6637d26458b06099d516:

- [Collision flags and masks](https://github.com/ThePhrozenKeep/D2MOO/blob/5596f5cb6c5251a0a07c6637d26458b06099d516/source/D2Common/include/D2Collision.h)
- [Room collision construction](https://github.com/ThePhrozenKeep/D2MOO/blob/5596f5cb6c5251a0a07c6637d26458b06099d516/source/D2Common/src/D2Collision.cpp): sub_6FD411F0, COLLISION_AllocRoomCollisionGrid, sub_6FD413E0.
- [DS1 tile properties](https://github.com/ThePhrozenKeep/D2MOO/blob/5596f5cb6c5251a0a07c6637d26458b06099d516/source/D2Common/include/Drlg/D2DrlgRoomTile.h)
- [Teleport implementation](https://github.com/ThePhrozenKeep/D2MOO/blob/5596f5cb6c5251a0a07c6637d26458b06099d516/source/D2Game/src/SKILLS/SkillSor.cpp): SKILLS_SrvDo027_Teleport checks the destination against the flying mask when the level's Teleport value is 2.
- [OpenDiablo2 DT1 sub-tile flags](https://github.com/OpenDiablo2/OpenDiablo2/blob/master/d2common/d2fileformats/d2dt1/subtile.go): historical labels and bitwise combination.
