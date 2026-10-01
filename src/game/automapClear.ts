import { withFields, type Ds1 } from '../formats/ds1';
import { buildDt1, dt1Records, type Dt1Record } from '../formats/dt1Write';
import type { TxtTableDoc } from '../formats/txtTable';
import { setAutomapCel, type AutomapPiece } from './automap';
import { inSelection, type CellSelection } from './clipboard';
import { planCustomDt1 } from './customDt1';
import type { GameData, TileLibrary } from './GameData';
import type { CellEdit } from './MapDocument';
import { mapTileUses, tileIdentity } from './assetUsage';
import { decodeTile } from '../formats/dt1';
import { sameTileRecoloured } from './duplicateDt1s';

/** Isolate selected pieces under fresh tile IDs, preserving matching cells elsewhere and all graphics. */
export async function planAutomapEdit(gd: GameData, lib: TileLibrary, ds1: Ds1, pieces: AutomapPiece[], table: TxtTableDoc, level: string, cel: number) {
  const wanted = new Map<string, AutomapPiece[]>();
  for (const p of pieces) {
    const key = tileIdentity(p.orientation, p.main, p.sub);
    const list = wanted.get(key) ?? [];
    list.push(p); wanted.set(key, list);
  }
  const sources = new Map<string, Dt1Record[]>(), records: Dt1Record[] = [], seen = new Set<string>();
  for (const [p] of wanted.values()) {
    const orientations = p.orientation === 3 || p.orientation === 4 ? [3,4] : [p.orientation];
    for (const o of orientations) for (const tile of lib.variants(o,p.main,p.sub)) {
      const source = lib.sourceOf(tile);
      if (!source) throw new Error('The source for a selected tile was not found.');
      const key = source.path + '#' + source.index;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!sources.has(source.path)) sources.set(source.path,dt1Records(await gd.fs.readOrThrow(source.path)));
      const record = sources.get(source.path)![source.index];
      if (!record) throw new Error('A tile library changed. Reload the map before editing pieces.');
      records.push(record);
    }
  }
  if (!records.length) return null;
  // Versions of one tile from two copies of a library in different colours: copying both would keep the random mix
  // (some cells in the wrong colours) in a DT1 of their own, where the copies can no longer be told apart.
  for (const [p] of wanted.values()) {
    const vs = lib.variants(p.orientation, p.main, p.sub);
    for (let a = 0; a < vs.length; a++)
      for (let b = a + 1; b < vs.length; b++) {
        const [sa, sb] = [lib.sourceOf(vs[a]), lib.sourceOf(vs[b])];
        const [ia, ib] = [decodeTile(vs[a]), decodeTile(vs[b])];
        if (sa && sb && sa.path !== sb.path && ia && ib && sameTileRecoloured(ia, ib))
          throw new Error(`Tile ${p.orientation}/${p.main}/${p.sub} comes from two copies of a library in different colours (${sa.path.replace(/^data\/global\/tiles\//i, '')} and ${sb.path.replace(/^data\/global\/tiles\//i, '')}). Keep one copy first (Diagnostics → Compatibility check → Compare the copies), then edit the automap.`);
      }
  }
  const source = 'selected-automap.dt1';
  const plan = planCustomDt1(records.map((_,index)=>({dt1:source,index})),new Map([[source,buildDt1(records)]]),new Set(lib.entries().map(e=>tileIdentity(e.orientation,e.main,e.sub))));
  if (plan.skipped.length) throw new Error(plan.skipped.join('\n'));
  const uses=mapTileUses(ds1), edits: CellEdit[]=[], done=new Set<string>();
  for (const tile of plan.tiles) {
    const key=tileIdentity(tile.orientation,tile.main,tile.sub);
    if (done.has(key) || !wanted.has(key)) continue;
    done.add(key);
    table=setAutomapCel(table,level,tile.orientation,tile.newMain,tile.newSub,cel,'seq').doc;
    for (const u of uses.get(key) ?? []) {
      if (!wanted.get(key)!.some(p => p.cellX === u.x && p.cellY === u.y && p.layer === u.layer.kind && (p.layerIndex === undefined || p.layerIndex === u.layer.index))) continue;
      const cells=u.layer.kind==='floor'?ds1.floors[u.layer.index]:u.layer.kind==='wall'?ds1.walls[u.layer.index]:ds1.shadows[u.layer.index];
      edits.push({...u,cell:withFields(cells[u.y*ds1.width+u.x],{main:tile.newMain,sub:tile.newSub})});
    }
  }
  return { bytes:buildDt1(plan.records),table,edits };
}

/** Clear visible pieces in an area; hidden tiles and other layers retain their original rules. */
export function planAutomapClear(gd: GameData, lib: TileLibrary, ds1: Ds1, area: CellSelection, pieces: AutomapPiece[], table: TxtTableDoc, level: string) {
  return planAutomapEdit(gd, lib, ds1, pieces.filter(p => p.cel !== null && inSelection(area, p.cellX, p.cellY)), table, level, -1);
}
