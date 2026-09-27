import { beforeAll, describe, expect, it } from 'vitest';
import { parseDs1 } from '../src/formats/ds1';
import { GameData } from '../src/game/GameData';
import { handleLine } from '../src/mcp/protocol';
import { McpSession, TOOLS, type ToolResult } from '../src/mcp/session';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { binarySource, D2_DIR, hasD2 } from '../tools/testdata';

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');

describe('MCP protocol', () => {
  const noSession = () => Promise.reject(new Error('not needed'));
  it('answers the handshake and lists the tools', async () => {
    const init = JSON.parse((await handleLine(noSession, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }), '9.9.9'))!);
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.serverInfo).toMatchObject({ name: 'ds1-studio', version: '9.9.9' });
    expect(init.result.capabilities.tools).toBeDefined();
    expect(await handleLine(noSession, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), '1')).toBeNull();
    const list = JSON.parse((await handleLine(noSession, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), '1'))!);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe('object');
    const bad = JSON.parse((await handleLine(noSession, '{oops', '1'))!);
    expect(bad.error.code).toBe(-32700);
    const unknown = JSON.parse((await handleLine(noSession, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }), '1'))!);
    expect(unknown.error.code).toBe(-32601);
  });
});

describe.runIf(hasD2)('MCP session', () => {
  let s: McpSession;
  const saved = new Map<string, Uint8Array>();
  beforeAll(async () => {
    const fs = new LayeredFs([binarySource(), ...(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))))]);
    const gd = await GameData.load(fs);
    s = new McpSession(gd, { saveTarget: { label: 'memory', save: async (p, b) => (saved.set(p, b), `Saved ${p}`) } });
  });

  it('opens, reads, edits, undoes and saves a map', async () => {
    expect(textOf(await s.call('get_cells', { rect: { x0: 0, y0: 0, x1: 1, y1: 1 } }))).toMatch(/No map is open/);
    expect(textOf(await s.call('list_maps', { filter: 'act1/town/townn1' }))).toMatch(/townn1\.ds1/);
    const opened = textOf(await s.call('open_map', { path: 'data/global/tiles/act1/town/townN1.ds1' }));
    expect(opened).toMatch(/57×41 cells, act 1/);
    const cells = textOf(await s.call('get_cells', { rect: { x0: 20, y0: 20, x1: 23, y1: 21 }, layers: ['floor1'] }));
    expect(cells).toMatch(/\[floor1\]/);
    expect(cells.split('\n').filter((l) => l.startsWith('y2')).length).toBe(2);

    expect(textOf(await s.call('paint', { layer: 'floor1', rect: { x0: 0, y0: 0, x1: 2, y1: 2 }, tiles: [{ main: 0, sub: 5 }] }))).toMatch(/Painted floor1: rectangle/);
    expect(textOf(await s.call('get_cells', { rect: { x0: 0, y0: 0, x1: 2, y1: 0 }, layers: ['floor1'] }))).toMatch(/y0: 0\/5 0\/5 0\/5/);
    expect(textOf(await s.call('find_replace', { layer: 'floor', from: { main: 0, sub: 5 }, to: { main: 0, sub: 6 }, rect: { x0: 0, y0: 0, x1: 2, y1: 2 } }))).toMatch(/Replaced 9 uses/);
    expect(textOf(await s.call('set_cell', { layer: 'wall1', x: 1, y: 1, main: 0, sub: 3, orientation: 1 }))).toMatch(/wall1 at 1,1 is now 0\/3:1/);

    const objects = textOf(await s.call('list_objects', {}));
    const first = /#0 .* sub-tile (\d+),(\d+)/.exec(objects)!;
    expect(textOf(await s.call('add_object', { type: 2, id: 1, x: 7, y: 7 }))).toMatch(/Added #\d+ Torch/);
    expect(textOf(await s.call('copy_area', { rect: { x0: 0, y0: 0, x1: 2, y1: 2 }, to_x: 10, to_y: 0, move: true }))).toMatch(/Moved .*\(1 objects\)/);
    expect(textOf(await s.call('get_cells', { rect: { x0: 10, y0: 0, x1: 12, y1: 0 }, layers: ['floor1'] }))).toMatch(/0\/6 0\/6 0\/6/);
    expect(textOf(await s.call('history', {}))).toMatch(/Move 3×3/);
    expect(textOf(await s.call('undo', { steps: 2 }))).toBe('Undid 2 steps.');
    expect(textOf(await s.call('get_cells', { rect: { x0: 7, y0: 0, x1: 7, y1: 0 } }))).not.toMatch(/Torch/);
    expect(objects).toContain(`sub-tile ${first[1]},${first[2]}`);

    expect(textOf(await s.call('list_tiles', { kind: 'wall', orientation: 10 }))).toMatch(/Warp · Vis 0|Town entry/);
    expect(textOf(await s.call('list_placeable', { filter: 'waypoint' }))).toMatch(/type 2 id \d+: Waypoint/i);
    expect(textOf(await s.call('check_map', {}))).toMatch(/\[(ok|info|warning|error)\]/);

    const save = await s.call('save_map', { path: 'data/global/tiles/act1/mymaps/copy.ds1' });
    expect(save.isError).toBeFalsy();
    const bytes = saved.get('data/global/tiles/act1/mymaps/copy.ds1')!;
    expect(parseDs1(bytes).width).toBe(57);
    expect(textOf(await s.call('map_info', {}))).not.toMatch(/unsaved/);
  });

  it('reports bad input as tool errors', async () => {
    const r = await s.call('paint', { layer: 'wall9', cells: [[0, 0]] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Unknown layer/);
    expect((await s.call('get_cells', { rect: { x0: 0, y0: 0, x1: 50, y1: 40 } })).isError).toBe(true);
    expect((await s.call('nope', {})).isError).toBe(true);
    expect(textOf(await s.call('new_map', { path: 'data/global/tiles/act1/x/new.ds1', width: 8, height: 6, level_type_id: 2 }))).toMatch(/8×6 cells/);
    expect(textOf(await s.call('map_info', {}))).toMatch(/unsaved/);
  });
});
