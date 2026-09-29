/** DT1 bytes feed the game's collision mask directly. See docs/collision-flags.md. */
export const COLLISION_FLAGS = [
  { bit: 0x01, name: 'Block walking', color: '#ff9f40', help: 'Blocks ordinary walking for players, mercenaries and monsters. Does not by itself prevent flying or teleporting.' },
  { bit: 0x02, name: 'Sight / shooting barrier', color: '#5ad15a', help: 'An obstacle for sight and shooting checks that use the visible collision mask. Often combined with walking. Individual skills use different masks.' },
  { bit: 0x04, name: 'Jump / flight barrier', color: '#ff5966', help: 'Used by jump and flight collision checks. Teleport also depends on the level’s Teleport setting; this is not a universal ban on teleporting.' },
  { bit: 0x08, name: 'Block player walking', color: '#b77dff', help: 'Blocks ordinary player paths. Monster and pet path masks do not use this bit; other flags may still block them.' },
  { bit: 0x10, name: 'Preset / placement', color: '#ffe14d', help: 'Advanced: the classic engine calls this PRESET and uses it in placement masks. It is not a general “block missiles” flag. Preserve unless your mod requires it.' },
  { bit: 0x20, name: 'Light / blank', color: '#7fe3ff', help: 'Advanced: traditionally labelled Block Light by DT1 tools; the classic collision mask calls this BLANK and uses it in some movement checks. Do not assume it affects only lighting.' },
  { bit: 0x40, name: 'Missile mask bit', color: '#f0f0f0', help: 'Advanced: overlaps the engine’s dynamic missile occupancy bit. Its purpose in authored DT1 terrain is not established. This is not a monster-only blocker.' },
  { bit: 0x80, name: 'Player mask bit', color: '#8b8b95', help: 'Advanced: overlaps the engine’s dynamic player occupancy bit. Its purpose in authored DT1 terrain is not established; preserve existing values unless tested in your mod.' },
] as const;

export const collisionHex = (value: number) => (value & 255).toString(16).toUpperCase().padStart(2, '0');
export const describeCollision = (value: number) => value ? COLLISION_FLAGS.filter(f => value & f.bit).map(f => f.name).join(' + ') : 'No DT1 collision flags';
