import { Fragment, useEffect, useState } from 'react';
import { parseDc6 } from '../formats/dc6';
import { palettePath, parsePalette, type Palette } from '../formats/palette';
import { loadMapRecipes, type MapRecipe, type RecipeSlot } from '../game/mapRecipes';
import type { LayeredFs } from '../vfs/vfs';

function ItemSprite({ fs, slot, palette }: { fs: LayeredFs; slot: RecipeSlot; palette: Palette | null }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let live = true;
    setUrl('');
    if (slot.invfile && palette) void fs.read(`data/global/items/${slot.invfile}.dc6`).then((bytes) => {
      if (!bytes || !live) return;
      const frame = parseDc6(bytes).frames[0]?.[0]?.image;
      if (!frame) return;
      const canvas = document.createElement('canvas');
      canvas.width = frame.width; canvas.height = frame.height;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(frame.width, frame.height);
      frame.pixels.forEach((p, i) => { if (p) img.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], i * 4); });
      ctx.putImageData(img, 0, 0);
      if (live) setUrl(canvas.toDataURL());
    }).catch(() => { /* Keep the item name when its picture is missing. */ });
    return () => { live = false; };
  }, [fs, slot.invfile, palette]);
  const title = `${slot.quantity} × ${slot.name}${slot.modifiers.length ? ` (${slot.modifiers.join(', ')})` : ''}`;
  return <span className="recipe-sprite" title={title} aria-label={title}>
    {url ? <img src={url} alt={slot.name} /> : <span className="recipe-sprite-name">{slot.name}</span>}
    {slot.quantity > 1 && <b className="recipe-quantity">×{slot.quantity}</b>}
  </span>;
}

/** Always visible in View: real inventory sprites form the recipe, with no dialog to open. */
export function MapRecipeRibbon({ fs, mapPath, refresh }: { fs: LayeredFs; mapPath?: string; refresh?: unknown }) {
  const [recipes, setRecipes] = useState<MapRecipe[] | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let live = true;
    setRecipes(null); setError(''); setSelected(0);
    if (mapPath) void loadMapRecipes(fs, mapPath).then((r) => { if (live) setRecipes(r); }).catch((e: unknown) => { if (live) setError(String(e)); });
    void fs.read(palettePath(0)).then((b) => { if (live) setPalette(b ? parsePalette(b) : null); }).catch(() => { if (live) setPalette(null); });
    return () => { live = false; };
  }, [fs, mapPath, refresh]);
  const recipe = recipes?.[selected];
  if (!recipe) return <div className="recipe-ribbon muted" role="status" title={error || undefined}>{!mapPath ? 'No map open' : error ? 'Recipe unavailable' : recipes === null ? 'Checking recipe…' : 'No recipe'}</div>;
  return <div className="recipe-ribbon" aria-label="Cube recipe">
    <div className="recipe-equation" title={[recipe.description, ...recipe.conditions].join('\n')}>
      {recipe.inputs.map((slot, i) => <Fragment key={`in${i}`}>{i > 0 && <span className="recipe-operator">+</span>}<ItemSprite fs={fs} slot={slot} palette={palette} /></Fragment>)}
      <span className="recipe-operator">=</span>
      {recipe.outputs.map((slot, i) => <Fragment key={`out${i}`}>{i > 0 && <span className="recipe-operator">+</span>}<ItemSprite fs={fs} slot={slot} palette={palette} /></Fragment>)}
    </div>
    {recipes!.length > 1 && <select aria-label="Choose cube recipe" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>{recipes!.map((r, i) => <option key={r.row} value={i}>{r.description}</option>)}</select>}
    {!!recipe.conditions.length && <span className="small muted" title={recipe.conditions.join('\n')}>Recipe requirements ⓘ</span>}
  </div>;
}
