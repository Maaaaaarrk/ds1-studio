import type { Ds1 } from '../formats/ds1';
import { buildDt1, dt1Records, type Dt1Record } from '../formats/dt1Write';
import type { TxtTableDoc } from '../formats/txtTable';
import { setAutomapCel, type AutomapPiece } from './automap';
import { inSelection, type CellSelection } from './clipboard';
import { planCustomDt1 } from './customDt1';
import type { GameData, TileLibrary } from './GameData';
import { MapDocument, type CellEdit } from './MapDocument';
import { mapTileUses, tileIdentity } from './assetUsage';

/** Isolate selected cells under fresh tile IDs, so clearing their automap does not clear other cells of the same type. */
export async function planAutomapClear(gd: GameData, lib: TileLibrary, ds1: Ds1, area: CellSelection, pieces: AutomapPiece[], table: TxtTableDoc, level: string) {
  const wanted = new Map(pieces.filter(p => p.cel !== null && inSelection(area, p.cellX, p.cellY)).map(p => [tileIdentity(p.orientation,p.main,p.sub),p]));
  const sources = new Map<string, Dt1Record[]>(), records: Dt1Record[] = [], seen = new Set<string>();
  for (const p of wanted.values()) {
    const orientations = p.orientation === 3 || p.orientation === 4 ? [3,4] : [p.orientation];
    for (const o of orientations) for (const tile of lib.variants(o,p.main,p.sub)) {
      const source = lib.sourceOf(tile);
      if (!source) throw new Error('The source for a selected tile was not found.');
      const key = source.path + '#' + source.index;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!sources.has(source.path)) sources.set(source.path,dt1Records(await gd.fs.readOrThrow(source.path)));
      const record = sources.get(source.path)![source.index];
      if (!record) throw new Error('A tile library changed. Reload the map before clearing pieces.');
      records.push(record);
    }
  }
  if (!records.length) return null;
  const source = 'selected-automap.dt1';
  const plan = planCustomDt1(records.map((_,index)=>({dt1:source,index})),new Map([[source,buildDt1(records)]]),new Set(lib.entries().map(e=>tileIdentity(e.orientation,e.main,e.sub))));
  if (plan.skipped.length) throw new Error(plan.skipped.join('\n'));
  const uses=mapTileUses(ds1), edits: CellEdit[]=[], done=new Set<string>();
  for (const tile of plan.tiles) {
    const key=tileIdentity(tile.orientation,tile.main,tile.sub);
    if (done.has(key) || !wanted.has(key)) continue;
    done.add(key);
    table=setAutomapCel(table,level,tile.orientation,tile.newMain,tile.newSub,-1,'seq').doc;
    for (const u of uses.get(key) ?? []) {
      if (!inSelection(area,u.x,u.y)) continue;
      const cells=u.layer.kind==='floor'?ds1.floors[u.layer.index]:u.layer.kind==='wall'?ds1.walls[u.layer.index]:ds1.shadows[u.layer.index];
      edits.push({...u,cell:MapDocument.painted(u.layer,cells[u.y*ds1.width+u.x],{orientation:tile.orientation,main:tile.newMain,sub:tile.newSub})});
    }
  }
  return { bytes:buildDt1(plan.records),table,edits };
}
