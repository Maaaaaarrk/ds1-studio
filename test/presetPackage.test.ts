import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { buildPresetPackage, planPresetImport } from '../src/game/presetPackage';
import { serializePreset, type Preset } from '../src/game/presets';
import { LayeredFs, LooseSource } from '../src/vfs/vfs';

const bytes = (...v: number[]) => new Uint8Array(v);
const source = (label: string, files: Record<string, Uint8Array>) => new LooseSource(label, new Map(Object.entries(files).map(([p, b]) => [p, async () => b])));
const preset = (id: string, name: string, category: string, dt1s: string[]): Preset => ({
  format: 'ds1studio-preset',
  version: 1,
  id,
  name,
  category,
  width: 1,
  height: 1,
  dt1s,
  layers: [{ kind: 'floor', index: 0, cells: [0] }],
  objects: [],
});

describe('preset packages', () => {
  const modDt1 = 'data/global/tiles/PD2assets/custom/house.dt1';
  const gameDt1 = 'data/global/tiles/ACT1/Town/floor.dt1';
  // The game's own files come from an archive (label ends in d2data.mpq), the mod's from its folder.
  const game = source('C:/Diablo II/d2data.mpq', { [gameDt1]: bytes(1, 1) });
  const mod = source('C:/mod', { [modDt1]: bytes(2, 2, 2) });
  const fs = new LayeredFs([mod, game]);
  const a = preset('aaaa1111', 'House', 'Buildings', [modDt1, gameDt1]);
  const b = preset('bbbb2222', 'Wall', 'Buildings', [gameDt1]);

  it('packs the presets and only the mod’s own tile libraries', async () => {
    const built = await buildPresetPackage(fs, [a, b]);
    const files = Object.keys(unzipSync(built.zip)).sort();
    expect(files).toEqual(['ds1studio-presets.json', 'presets/house-aaaa1111.json', 'presets/wall-bbbb2222.json', 'tiles/PD2assets/custom/house.dt1']);
    expect(built.dt1s).toEqual(['PD2assets/custom/house.dt1']);
    expect(built.missing).toEqual([]);
  });

  it('imports into a mod that lacks the library: writes it and the presets', async () => {
    const { zip } = await buildPresetPackage(fs, [a]);
    const other = new LayeredFs([source('C:/other', {}), game]);
    const plan = await planPresetImport(other, zip, []);
    expect(plan.presets.map((p) => p.name)).toEqual(['House']);
    expect(plan.dt1Writes.map((w) => w.path)).toEqual([modDt1]);
    expect(plan.problems).toEqual([]);
  });

  it('a different library under the same name is kept: the imported one is renamed and the preset points at it', async () => {
    const { zip } = await buildPresetPackage(fs, [a]);
    const clash = new LayeredFs([source('C:/other', { [modDt1]: bytes(9, 9) }), game]);
    const plan = await planPresetImport(clash, zip, []);
    expect(plan.renamed).toEqual([{ from: 'PD2assets/custom/house.dt1', to: 'PD2assets/custom/house2.dt1' }]);
    expect(plan.dt1Writes.map((w) => w.path)).toEqual(['data/global/tiles/PD2assets/custom/house2.dt1']);
    expect(plan.presets[0].dt1s).toContain('data/global/tiles/PD2assets/custom/house2.dt1');
    expect(plan.presets[0].dt1s).not.toContain(modDt1);
  });

  it('the same library already there is not written again; an unchanged preset is skipped; a taken id gets a new one', async () => {
    const { zip } = await buildPresetPackage(fs, [a, b]);
    const changedB = { ...b, name: 'Wall (theirs)' };
    const plan = await planPresetImport(fs, zip, [a, changedB]);
    expect(plan.same).toEqual(['PD2assets/custom/house.dt1']);
    expect(plan.dt1Writes).toEqual([]);
    expect(plan.duplicates).toEqual(['House']);
    expect(plan.presets.map((p) => p.name)).toEqual(['Wall']);
    expect(plan.presets[0].id).not.toBe(b.id);
  });

  it('a single preset file (.json) imports too, and says which libraries this mod is missing', async () => {
    const plan = await planPresetImport(new LayeredFs([source('C:/empty', {})]), serializePreset(a), []);
    expect(plan.presets.map((p) => p.name)).toEqual(['House']);
    expect(plan.problems.join(' ')).toMatch(/house\.dt1 isn't in this game or mod/);
  });

  it('refuses files that are not preset packages', async () => {
    await expect(planPresetImport(fs, bytes(0x50, 0x4b, 3, 4), [])).rejects.toThrow();
    await expect(planPresetImport(fs, new TextEncoder().encode('{"hello":1}'), [])).resolves.toMatchObject({ presets: [] });
  });
});
