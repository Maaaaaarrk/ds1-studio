/** Thumbnail selection is local to the viewer; an explicit anchor makes Shift ranges predictable. */
export function selectTileIndices(previous: ReadonlySet<number>, index: number, anchor: number | null, count: number, modifiers: { shift: boolean; toggle: boolean }): Set<number> {
  if (!Number.isInteger(index) || index < 0 || index >= count) return new Set(previous);
  if (modifiers.shift && anchor !== null && anchor >= 0 && anchor < count) {
    const next = modifiers.toggle ? new Set(previous) : new Set<number>();
    for (let i = Math.min(anchor, index); i <= Math.max(anchor, index); i++) next.add(i);
    return next;
  }
  if (!modifiers.toggle) return new Set([index]);
  const next = new Set(previous);
  if (next.has(index)) next.delete(index); else next.add(index);
  return next;
}
