import { DEFAULT_PROP1, EMPTY_CELL, withTile, type Ds1, type Ds1Object, type TileCell, type WallCell } from '../formats/ds1';

export type LayerKind = 'floor' | 'wall' | 'shadow';

export interface LayerRef {
  kind: LayerKind;
  index: number;
}

export function layerKey(l: LayerRef): string {
  return `${l.kind}:${l.index}`;
}

export function layerLabel(l: LayerRef): string {
  return l.kind === 'shadow' ? 'Shadow' : `${l.kind === 'floor' ? 'Floor' : 'Wall'} ${l.index + 1}`;
}

/** A DT1 tile identity to paint with. */
export interface Brush {
  orientation: number;
  main: number;
  sub: number;
}

type AnyCell = TileCell | WallCell;

interface CellChange {
  layer: LayerRef;
  index: number;
  before: AnyCell;
  after: AnyCell;
}

/** One undoable step: cell changes and/or a before/after snapshot of the object list. */
interface HistoryStep {
  cells: CellChange[];
  objects?: { before: Ds1Object[]; after: Ds1Object[] };
  /** Whole-map snapshots, for structural edits (resize, tags, groups). */
  map?: { before: Ds1; after: Ds1 };
}

const cloneObjects = (objs: Ds1Object[]): Ds1Object[] => objs.map((o) => ({ ...o, path: o.path.map((p) => ({ ...p })) }));

export interface CellEdit {
  layer: LayerRef;
  x: number;
  y: number;
  cell: AnyCell;
}

/**
 * An open, editable DS1. All mutations go through `apply`, which records undo history.
 * Changes made between beginStroke/endStroke undo as a single step.
 */
export class MapDocument {
  private undoStack: HistoryStep[] = [];
  private redoStack: HistoryStep[] = [];
  private stroke: Map<string, CellChange> | null = null;
  private objectsBefore: Ds1Object[] | null = null;
  private savedRevision = 0;
  revision = 0;

  constructor(
    public path: string,
    readonly ds1: Ds1,
  ) {}

  get dirty(): boolean {
    return this.revision !== this.savedRevision;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  markSaved(): void {
    this.savedRevision = this.revision;
  }

  layers(): LayerRef[] {
    return [
      ...this.ds1.floors.map((_, index) => ({ kind: 'floor' as const, index })),
      ...this.ds1.walls.map((_, index) => ({ kind: 'wall' as const, index })),
      ...this.ds1.shadows.map((_, index) => ({ kind: 'shadow' as const, index })),
    ];
  }

  private cells(layer: LayerRef): AnyCell[] {
    const list = layer.kind === 'floor' ? this.ds1.floors : layer.kind === 'wall' ? this.ds1.walls : this.ds1.shadows;
    const cells = list[layer.index];
    if (!cells) throw new Error(`no ${layerKey(layer)} layer`);
    return cells;
  }

  cell(layer: LayerRef, x: number, y: number): AnyCell {
    return this.cells(layer)[y * this.ds1.width + x];
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.ds1.width && y < this.ds1.height;
  }

  /** What `current` becomes when painted with `brush` on `layer` (null brush = erase). */
  static painted(layer: LayerRef, current: AnyCell, brush: Brush | null): AnyCell {
    if (!brush) {
      return layer.kind === 'wall' ? { ...EMPTY_CELL, orientation: 0, orientationHigh: (current as WallCell).orientationHigh } : EMPTY_CELL;
    }
    const next = withTile(current, brush.main, brush.sub, DEFAULT_PROP1[layer.kind]);
    return layer.kind === 'wall' ? { ...next, orientation: brush.orientation } : next;
  }

  beginStroke(): void {
    this.endStroke();
    this.stroke = new Map();
  }

  endStroke(): void {
    if (this.stroke?.size) this.pushHistory({ cells: [...this.stroke.values()] });
    this.stroke = null;
  }

  /** Sets cells; returns true if anything changed. */
  apply(edits: CellEdit[]): boolean {
    const applied: CellChange[] = [];
    for (const { layer, x, y, cell } of edits) {
      if (!this.inBounds(x, y)) continue;
      const cells = this.cells(layer);
      const index = y * this.ds1.width + x;
      const before = cells[index];
      if (sameCell(before, cell)) continue;
      cells[index] = cell;
      applied.push({ layer, index, before, after: cell });
    }
    if (!applied.length) return false;
    if (this.stroke) {
      for (const c of applied) {
        const k = `${layerKey(c.layer)}@${c.index}`;
        const prev = this.stroke.get(k);
        this.stroke.set(k, prev ? { ...c, before: prev.before } : c);
      }
    } else {
      this.pushHistory({ cells: applied });
    }
    this.revision++;
    return true;
  }

  /**
   * A structural edit (resize, tag layer, substitution groups) as one undoable step. `fn` either mutates the map in
   * place or returns a replacement map.
   */
  mutate(fn: (ds1: Ds1) => Ds1 | void): void {
    this.endStroke();
    this.endObjectEdit();
    const before = structuredClone(this.ds1);
    const result = fn(this.ds1);
    if (result) this.restore(result);
    this.pushHistory({ cells: [], map: { before, after: structuredClone(this.ds1) } });
    this.revision++;
  }

  private restore(snapshot: Ds1): void {
    Object.assign(this.ds1, structuredClone(snapshot));
  }

  /** Replaces the object list as one undoable step. */
  setObjects(next: Ds1Object[]): void {
    this.endObjectEdit();
    this.pushHistory({ cells: [], objects: { before: cloneObjects(this.ds1.objects), after: cloneObjects(next) } });
    this.ds1.objects = cloneObjects(next);
    this.revision++;
  }

  /** Starts a live object edit (e.g. a drag): changes via `liveObjects` become one undo step at `endObjectEdit`. */
  beginObjectEdit(): void {
    this.endObjectEdit();
    this.objectsBefore = cloneObjects(this.ds1.objects);
  }

  liveObjects(next: Ds1Object[]): void {
    this.ds1.objects = next;
    this.revision++;
  }

  endObjectEdit(): void {
    const before = this.objectsBefore;
    this.objectsBefore = null;
    if (before && JSON.stringify(before) !== JSON.stringify(this.ds1.objects)) {
      this.pushHistory({ cells: [], objects: { before, after: cloneObjects(this.ds1.objects) } });
    }
  }

  private pushHistory(step: HistoryStep): void {
    this.undoStack.push(step);
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): boolean {
    this.endStroke();
    this.endObjectEdit();
    const step = this.undoStack.pop();
    if (!step) return false;
    for (const c of [...step.cells].reverse()) this.cells(c.layer)[c.index] = c.before;
    if (step.objects) this.ds1.objects = cloneObjects(step.objects.before);
    if (step.map) this.restore(step.map.before);
    this.redoStack.push(step);
    this.revision++;
    return true;
  }

  redo(): boolean {
    const step = this.redoStack.pop();
    if (!step) return false;
    for (const c of step.cells) this.cells(c.layer)[c.index] = c.after;
    if (step.objects) this.ds1.objects = cloneObjects(step.objects.after);
    if (step.map) this.restore(step.map.after);
    this.undoStack.push(step);
    this.revision++;
    return true;
  }
}

function sameCell(a: AnyCell, b: AnyCell): boolean {
  return (
    a.prop1 === b.prop1 &&
    a.prop2 === b.prop2 &&
    a.prop3 === b.prop3 &&
    a.prop4 === b.prop4 &&
    (a as WallCell).orientation === (b as WallCell).orientation
  );
}
