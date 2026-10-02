import type { Ds1 } from '../formats/ds1';
import type { LayerSlot, Visibility } from './state';
import { memo, useMemo } from 'react';
import type { TileLibrary } from '../game/GameData';
import { wallCategory, wallLibraryKey, type WallCategory } from '../game/wallCategories';

/** Always available above the map, including when the side panels are folded. */
export const MapLayerBar = memo(MapLayerBarImpl);

function MapLayerBarImpl({ ds1, lib, visibility: v, onChange, onSolo }: { ds1: Ds1; /** Changes when a layer is added or removed (the DS1 is edited in place). */ layerCount?: number; lib: TileLibrary; visibility: Visibility; onChange: (v: Visibility) => void; onSolo?: (slot: LayerSlot) => void }) {
  /** Middle click: show only this layer (again: back as it was). */
  const solo = (slot: LayerSlot) => ({
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button !== 1 || !onSolo) return;
      e.preventDefault();
      onSolo(slot);
    },
  });
  const soloTip = onSolo ? ' · middle-click: show only this (again: back as it was)' : '';
  const libraries = useMemo(() => lib.loaded.map(source => {
    const tiles = lib.tilesOf(source.path).filter(t => wallCategory(t.orientation));
    return {path:source.path,tiles};
  }).filter(source => source.tiles.length), [lib]);
  const indexed = (key: 'floors' | 'walls', index: number) => {
    const values = [...v[key]];
    values[index] = !(values[index] ?? true);
    onChange({ ...v, [key]: values });
  };
  const categories = [['upperWalls', 'Upper walls'], ['lowerWalls', 'Lower walls'], ['roofs', 'Roofs'], ['shadows', 'Shadows'], ['specials', 'Special tiles']] as const;
  return <div className="map-layer-bar" role="group" aria-label="Map layer visibility">
    <span className="map-layer-label">Show</span>
    {ds1.floors.map((_, i) => <button key={`f${i}`} aria-pressed={v.floors[i] ?? true} title={`Show or hide floor layer ${i + 1}${soloTip}`} onClick={() => indexed('floors', i)} {...solo({ floor: i })}>Floor {i + 1}</button>)}
    {ds1.walls.map((_, i) => <button key={`w${i}`} aria-pressed={v.walls[i] ?? true} title={`Show or hide wall layer ${i + 1}, including its upper walls, lower walls and roofs${soloTip}`} onClick={() => indexed('walls', i)} {...solo({ wall: i })}>Wall layer {i + 1}</button>)}
    <span className="map-layer-separator" />
    {categories.map(([key, label]) => <button key={key} aria-pressed={v[key]} title={`Show or hide ${label.toLowerCase()}${key === 'shadows' || key === 'specials' ? '' : ' across the enabled wall layers'}${soloTip}`} onClick={() => onChange({ ...v, [key]: !v[key] })} {...solo(key)}>{label}</button>)}
    <details className="wall-category-options">
      <summary>DT1 wall categories</summary>
      <div className="wall-category-list">
        <p>Upper/Lower are visibility groups, separate from W1–W4. Automatic uses the DT1 tile type. Override a library here when its artwork belongs in a different group. This saves an editor preference; game files stay unchanged.</p>
        {libraries.map(({path,tiles}) => {
          const key = wallLibraryKey(path);
          const lower = tiles.filter(t => wallCategory(t.orientation) === 'lower').length;
          const heights = tiles.map(t => Math.abs(t.height));
          return <label className="wall-category-row" key={path}>
            <span title={path}>{path.replace(/^data[\\/]global[\\/]tiles[\\/]/i, '')}<small>{tiles.length} wall tiles · {Math.min(...heights)}–{Math.max(...heights)} px high · {tiles.length-lower} upper / {lower} lower in DT1</small></span>
            <select aria-label={`Wall category for ${path}`} value={v.wallCategories?.[key] ?? 'auto'} onChange={e => {
              const wallCategories = {...v.wallCategories};
              if(e.target.value === 'auto') delete wallCategories[key]; else wallCategories[key] = e.target.value as WallCategory;
              onChange({...v,wallCategories});
            }}><option value="auto">Automatic (DT1 type)</option><option value="upper">Upper walls</option><option value="lower">Lower walls</option></select>
          </label>;
        })}
      </div>
    </details>
  </div>;
}
