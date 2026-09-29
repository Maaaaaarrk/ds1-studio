import type { Ds1 } from '../formats/ds1';
import type { Visibility } from './state';

/** Always available above the map, including when the side panels are folded. */
export function MapLayerBar({ ds1, visibility: v, onChange }: { ds1: Ds1; visibility: Visibility; onChange: (v: Visibility) => void }) {
  const indexed = (key: 'floors' | 'walls', index: number) => {
    const values = [...v[key]];
    values[index] = !(values[index] ?? true);
    onChange({ ...v, [key]: values });
  };
  const categories = [['upperWalls', 'Upper walls'], ['lowerWalls', 'Lower walls'], ['roofs', 'Roofs'], ['shadows', 'Shadows'], ['specials', 'Special tiles']] as const;
  return <div className="map-layer-bar" role="group" aria-label="Map layer visibility">
    <span className="map-layer-label">Show</span>
    {ds1.floors.map((_, i) => <button key={`f${i}`} aria-pressed={v.floors[i] ?? true} title={`Show or hide floor layer ${i + 1}`} onClick={() => indexed('floors', i)}>Floor {i + 1}</button>)}
    {ds1.walls.map((_, i) => <button key={`w${i}`} aria-pressed={v.walls[i] ?? true} title={`Show or hide wall layer ${i + 1}, including its upper walls, lower walls and roofs`} onClick={() => indexed('walls', i)}>Wall layer {i + 1}</button>)}
    <span className="map-layer-separator" />
    {categories.map(([key, label]) => <button key={key} aria-pressed={v[key]} title={`Show or hide ${label.toLowerCase()}${key === 'shadows' || key === 'specials' ? '' : ' across the enabled wall layers'}`} onClick={() => onChange({ ...v, [key]: !v[key] })}>{label}</button>)}
  </div>;
}
