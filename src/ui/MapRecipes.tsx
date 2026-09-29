import { useEffect, useState } from 'react';
import { loadMapRecipes, type MapRecipe, type RecipeSlot } from '../game/mapRecipes';
import type { LayeredFs } from '../vfs/vfs';
import { Modal } from './Dialogs';

function Slot({ slot, label }: { slot?: RecipeSlot; label: string }) {
  return <div className={`map-recipe-slot${slot ? '' : ' empty'}`} aria-disabled={!slot} aria-label={label}>
    <span className="muted small">{label}</span>
    <strong>{slot ? `${slot.quantity > 1 ? `${slot.quantity} × ` : ''}${slot.name}` : '—'}</strong>
    {slot && <span className="mono small muted">{[slot.code, ...slot.modifiers].join(', ')}</span>}
  </div>;
}

export function MapRecipesDialog({ fs, mapPath, onClose }: { fs: LayeredFs; mapPath: string; onClose: () => void }) {
  const [recipes, setRecipes] = useState<MapRecipe[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let live = true;
    setRecipes(null); setError(''); setSelected(0);
    void loadMapRecipes(fs, mapPath).then((result) => { if (live) setRecipes(result); }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [fs, mapPath]);
  const recipe = recipes?.[selected];
  return <Modal title="Cube recipe to access this map" onClose={onClose} wide>
    <p className="muted">{mapPath.split(/[\\/]/).pop()}</p>
    {error ? <p role="alert">Could not check recipes: {error}</p> : recipes === null ? <p role="status">Looking for recipes…</p> : !recipes.length ? <p role="status">No recipe found for this map.</p> : <>
      <label>Recipe <select aria-label="Recipe" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
        {recipes.map((r, i) => <option key={r.row} value={i}>{i + 1}. {r.description}</option>)}
      </select></label>
      <p className="muted small">Combine these ingredients in the Horadric Cube to make the map item.</p>
    </>}
    <div className="map-recipe-slots">
      {Array.from({ length: Math.max(3, recipe?.inputs.length ?? 0) }, (_, i) => <Slot key={i} label={`Ingredient ${i + 1}`} slot={recipe?.inputs[i]} />)}
    </div>
    <div className="map-recipe-results">{(recipe?.outputs ?? [undefined]).map((s, i) => <Slot key={i} label={i ? `Additional result ${i}` : 'Result'} slot={s} />)}</div>
    {recipe?.conditions.map((c) => <p className="small muted" key={c}>{c}</p>)}
    <p className="small muted">Shows enabled recipes linked to this map’s item in your loaded game and mod tables. Access controlled by game code or other maps may not have a listed recipe. Item requirements are shown beneath each name.</p>
    <div className="modal-actions"><button className="btn" onClick={onClose}>Close</button></div>
  </Modal>;
}
