import { describe, expect, it } from 'vitest';
import { EMPTY_CELL, withFields, writeDs1, parseDs1 } from '../src/formats/ds1';
import { newDs1 } from '../src/formats/ds1ops';
import { buildDt1, blockerRecord } from '../src/formats/dt1Write';
import { parseDt1 } from '../src/formats/dt1';
import { parseTxtTable, serializeTxtTable } from '../src/formats/txtTable';
import { GameData, TileLibrary } from '../src/game/GameData';
import { LayeredFs } from '../src/vfs/vfs';
import { MapDocument } from '../src/game/MapDocument';
import { automapPieces, parseAutomap } from '../src/game/automap';
import { planAutomapEdit, planAutomapClear } from '../src/game/automapClear';

async function setup(orientation = 0) {
  const fs = new LayeredFs([]);
  const source = 'data/global/tiles/test.dt1';
  const records = [orientation, ...(orientation === 3 ? [4] : [])].flatMap(o => [1, 2].map(rarity => {
    const r = blockerRecord(0, 24, new Uint8Array(25).fill(7));
    const v = new DataView(r.header.buffer); v.setInt32(20, o, true); v.setInt32(32, rarity, true); return r;
  }));
  const bytes = buildDt1(records); fs.remember(source, bytes, 'fixture');
  const lib = new TileLibrary(); lib.add(source, parseDt1(bytes));
  const d = newDs1({width:4,height:1,act:0,floorLayers:2,wallLayers:2,tagType:0,files:[source]});
  const c = { ...withFields(EMPTY_CELL,{prop1:1,main:0,sub:24}),orientation,orientationHigh:0 };
  const layers = orientation === 0 ? d.floors : d.walls;
  layers.forEach(l => l.fill(c));
  const table = parseTxtTable(new TextEncoder().encode(`LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tCel1\n59\t${orientation === 0 ? 'fl' : 'wt'}\t0\t24\t24\t0\n`));
  return { gd: await GameData.load(fs), lib, d, table };
}

describe('cell-specific automap editing', () => {
  it('adds a post to one cell and layer, preserves adjacent copies, and survives save / undo / redo', async () => {
    const {gd,lib,d,table} = await setup();
    const pieces = automapPieces(d,parseAutomap(table),'59');
    const selected = pieces.find(p => p.cellX === 1 && p.layerIndex === 0)!;
    const plan = (await planAutomapEdit(gd,lib,d,[selected],table,'59',25))!;
    expect(plan.edits).toHaveLength(1);
    expect(parseDt1(plan.bytes).tiles).toHaveLength(2); // Every random graphic variant retained.
    const doc = new MapDocument('map.ds1',d);
    const before = serializeTxtTable(table), after = serializeTxtTable(plan.table);
    let stored = after;
    doc.mutate(d => { for(const e of plan.edits)d.floors[e.layer.index][e.y*d.width+e.x]=e.cell; },'Change piece',{path:'AutoMap.txt',before,after});
    const check = (count: number) => {
      const saved = parseDs1(writeDs1(doc.ds1));
      const actual = automapPieces(saved,parseAutomap(parseTxtTable(stored)),'59');
      expect(actual.filter(p => p.cel === 25)).toHaveLength(count);
      if(count)expect(actual.find(p => p.cel === 25)).toMatchObject({cellX:1,layerIndex:0});
    };
    check(1);
    const writer = async (_:string,b:Uint8Array) => { stored=b; };
    await doc.undoWithFiles(writer); check(0);
    await doc.redoWithFiles(writer); check(1);
    expect(d.floors[1][1].mainIndex).toBe(0);
  });
  it('clears only visible pieces in the selected area', async () => {
    const {gd,lib,d,table} = await setup();
    d.floors[1][1]=withFields(d.floors[1][1],{hidden:true});
    const pieces=automapPieces(d,parseAutomap(table),'59').map(p => ({...p,cel:25}));
    const plan=(await planAutomapClear(gd,lib,d,{x0:1,x1:1,y0:0,y1:0},pieces,table,'59'))!;
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].layer.index).toBe(0);
    for (const e of plan.edits) d.floors[e.layer.index][e.y*d.width+e.x] = e.cell;
    const actual = automapPieces(d,parseAutomap(parseTxtTable(serializeTxtTable(plan.table))),'59');
    expect(actual.find(p => p.cellX === 1)?.cel).toBeNull();
    expect(actual.filter(p => p.cellX !== 1).every(p => p.cel === 0)).toBe(true);
  });
  it('keeps both halves and every variant of a corner while changing only the requested wall layer', async () => {
    const {gd,lib,d,table}=await setup(3);
    const selected=automapPieces(d,parseAutomap(table),'59').find(p => p.cellX===2 && p.layerIndex===1)!;
    const plan=(await planAutomapEdit(gd,lib,d,[selected],table,'59',25))!;
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({x:2,layer:{kind:'wall',index:1},cell:{orientation:3}});
    expect(parseDt1(plan.bytes).tiles.map(t=>t.orientation)).toEqual([3,4,4,3]);
  });
});
