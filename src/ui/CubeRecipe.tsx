import { useEffect, useMemo, useRef, useState } from 'react';
import { parseDc6 } from '../formats/dc6';
import { palettePath, parsePalette, type Palette } from '../formats/palette';
import { colIndex, parseTxtTable, type TxtTableDoc } from '../formats/txtTable';
import { mapItemLevel, PATCH_STRINGS, planCubeItem, removeRows, studioItems, studioRecipes, templateRisk } from '../game/cubeRecipe';
import { dataRows } from '../game/addToGame';
import { getCell } from '../formats/txtTable';
import { parseTbl, type Tbl } from '../formats/tbl';
import { normalizePath } from '../vfs/vfs';
import type { LayeredFs } from '../vfs/vfs';
import { Modal } from './Dialogs';
import { HelpTip } from './HelpTip';
import type { TableWrite } from './LevelTools';

const EXCEL = 'data/global/excel/';

/** Plain-language help for every field (the "?" tips). */
const HELP = {
  template:
    'The existing item the new one is copied from. The copy keeps its picture, size and how it behaves in your inventory — only its name and code change. Elixirs are not offered: a copy of one crashed the game when hovered.',
  name: 'What you call the new item. It is written into Misc.txt so you can find it again; the name players see in game still comes from the template’s text until you add your own string.',
  code: 'Every item has a short unique code (3 or 4 letters/numbers) that the game uses to tell items apart — cube recipes, drops and your mod’s map system all refer to the item by it. DS1 Studio picks an unused one for you; choose “Custom item” to type your own.',
  customCode: 'Type 3 or 4 letters or numbers that no other item uses (checked as you type). Your mod’s map system will look for this code to know which map the item opens.',
  inputs:
    'What players put into the Horadric Cube to make the item. Pick each ingredient by name and how many of it are needed; the recipe works when exactly these are in the cube.',
  qty: 'How many of this ingredient the cube needs (for example 3 for three of the same gem).',
  advanced: 'For special cases the list can’t express, type the cube input exactly as CubeMain.txt expects it, e.g. "gem4,qty=3" (any gem of that quality) or "rin,mag" (a magic ring).',
  result: 'What will be added to your mod’s tables when you click Create. The originals are kept as .bak the first time.',
} as const;

interface Item {
  table: 'Misc' | 'Weapons' | 'Armor';
  row: number;
  name: string;
  code: string;
  invfile: string;
  type: string;
}

interface Ingredient {
  code: string;
  qty: number;
}

interface Props {
  fs: LayeredFs;
  mapName: string;
  /** The open map (data/global/tiles/...), to find the level a map item should open. */
  mapPath: string;
  /** A recipe to start from (an imported package's): its ingredients and item name. */
  suggested?: { inputs: string[]; itemName: string | null } | null;
  onApply: (writes: TableWrite[]) => Promise<void>;
  /** Writes removals and reloads the game tables, keeping this window open. */
  onRemove: (writes: TableWrite[]) => Promise<void>;
  /** Opens Add to game (for a map that isn't a level yet). */
  onAddToGame: () => void;
  onClose: () => void;
}

async function load(fs: LayeredFs, name: string): Promise<TxtTableDoc | null> {
  const b = await fs.read(`${EXCEL}${name}`);
  return b ? parseTxtTable(b) : null;
}

function catalog(doc: TxtTableDoc | null, table: Item['table']): Item[] {
  if (!doc) return [];
  const c = (n: string) => colIndex(doc, n);
  const [name, code, inv, type] = [c('name'), c('code'), c('invfile'), c('type')];
  return doc.rows
    .map((r, row) => ({ table, row, name: (r[name] ?? '').trim(), code: (r[code] ?? '').trim(), invfile: (r[inv] ?? '').trim(), type: (r[type] ?? '').trim() }))
    .filter((x) => x.code && x.name && x.name.toLowerCase() !== 'expansion');
}

/** A new item code nobody uses: from the map's name ("ArcaneMap" → "ar01"…), else "m" + 3 characters. */
function freeCode(mapName: string, used: Set<string>): string {
  const letters = mapName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = (letters.slice(0, 2) || 'mp').padEnd(2, 'x');
  for (let n = 1; n < 100; n++) {
    const c = `${base}${String(n).padStart(2, '0')}`;
    if (!used.has(c)) return c;
  }
  for (let n = 0; n < 46656; n++) {
    const c = `m${n.toString(36).padStart(3, '0')}`;
    if (!used.has(c)) return c;
  }
  return 'zzzz';
}

/** An item's inventory picture (lazy: loaded when scrolled into view). */
function ItemIcon({ fs, invfile, palette }: { fs: LayeredFs; invfile: string; palette: Palette | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setSeen(true));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!seen || !palette || !invfile) return;
    let live = true;
    void fs.read(`data/global/items/${invfile}.dc6`).then((bytes) => {
      if (!live || !bytes) return;
      try {
        const f = parseDc6(bytes).frames[0]?.[0]?.image;
        const c = ref.current;
        if (!f || !c) return;
        c.width = f.width;
        c.height = f.height;
        const ctx = c.getContext('2d')!;
        const img = ctx.createImageData(f.width, f.height);
        for (let i = 0; i < f.pixels.length; i++) {
          const p = f.pixels[i];
          if (p) img.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], i * 4);
        }
        ctx.putImageData(img, 0, 0);
      } catch {
        // no picture
      }
    });
    return () => {
      live = false;
    };
  }, [seen, fs, invfile, palette]);
  return <canvas ref={ref} className="cr-icon" width={1} height={1} />;
}

/** A searchable list of items to pick from. */
function ItemPicker({ items, fs, palette, selected, onPick, groups, height = 220 }: {
  items: Item[];
  fs: LayeredFs;
  palette: Palette | null;
  selected: string | null;
  onPick: (item: Item) => void;
  groups?: { label: string; test: (i: Item) => boolean }[];
  height?: number;
}) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const shown = items.filter((i) => !query || i.name.toLowerCase().includes(query) || i.code.toLowerCase() === query || i.type.toLowerCase() === query);
  const sections = groups ? groups.map((g) => ({ label: g.label, list: shown.filter(g.test) })).filter((g) => g.list.length) : [{ label: '', list: shown }];
  return (
    <div className="cr-picker">
      <input className="search small-input" placeholder="Search by name or code…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="cr-list" style={{ maxHeight: height }}>
        {sections.map((s) => (
          <div key={s.label}>
            {s.label && <div className="cr-group">{s.label}</div>}
            {s.list.slice(0, 400).map((i) => (
              <button key={`${i.table}.${i.row}`} className={`cr-item${selected === `${i.table}.${i.row}` ? ' active' : ''}`} onClick={() => onPick(i)} title={`${i.name} · code ${i.code} · ${i.table}.txt`}>
                <ItemIcon fs={fs} invfile={i.invfile} palette={palette} />
                <span className="cr-name">{i.name}</span>
                <span className="mono muted small">{i.code}</span>
              </button>
            ))}
          </div>
        ))}
        {!shown.length && <p className="muted small pad">Nothing matches.</p>}
      </div>
    </div>
  );
}

/**
 * Creates a map item (a copy of a template item in Misc.txt with a new name and code) and a Horadric Cube recipe that
 * makes it — without needing to know item codes or CubeMain syntax. Which level the item opens is up to the mod's
 * code (e.g. PD2's map system).
 */
export function CubeRecipeDialog({ fs, mapName, mapPath, suggested, onApply, onRemove, onAddToGame, onClose }: Props) {
  const [tables, setTables] = useState<{
    misc: TxtTableDoc | null;
    weapons: TxtTableDoc | null;
    armor: TxtTableDoc | null;
    cube: TxtTableDoc | null;
    levels: TxtTableDoc | null;
    prest: TxtTableDoc | null;
    strings: Tbl | null;
  } | null>(null);
  const [levelTitle, setLevelTitle] = useState(mapName);
  const [nameLevel, setNameLevel] = useState(true);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [mode, setMode] = useState<'template' | 'custom'>('template');
  /** What the item is for: a map item that opens this map, or an ordinary item (opens nothing). */
  const [kind, setKind] = useState<'map' | 'other'>('map');
  const [template, setTemplate] = useState<Item | null>(null);
  const [itemName, setItemName] = useState(suggested?.itemName ?? `${mapName} Map`);
  const [customCode, setCustomCode] = useState('');
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [adding, setAdding] = useState(false);
  const [advanced, setAdvanced] = useState('');
  const [busy, setBusy] = useState(false);
  const [acceptMod, setAcceptMod] = useState(false);
  const [nobodyHolds, setNobodyHolds] = useState(false);
  /** Rows of DS1 Studio's recipes (CubeMain) and items (Misc) ticked for removal, and a removal waiting to be confirmed. */
  const [selRecipes, setSelRecipes] = useState<Set<number>>(new Set());
  const [selItems, setSelItems] = useState<Set<number>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState<{ recipes: number[]; items: number[] } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void Promise.all([
      load(fs, 'Misc.txt'),
      load(fs, 'Weapons.txt'),
      load(fs, 'Armor.txt'),
      load(fs, 'CubeMain.txt'),
      load(fs, 'Levels.txt'),
      load(fs, 'LvlPrest.txt'),
      fs.read(PATCH_STRINGS).then((b) => {
        try {
          return b ? parseTbl(b) : null;
        } catch {
          return null;
        }
      }),
    ]).then(([misc, weapons, armor, cube, levels, prest, strings]) => setTables({ misc, weapons, armor, cube, levels, prest, strings }));
    void fs.read(palettePath(0)).then((b) => b && setPalette(parsePalette(b)));
  }, [fs, reload]);

  const allMisc = useMemo(() => catalog(tables?.misc ?? null, 'Misc'), [tables]);
  // Templates: never ones known to crash (see game/cubeRecipe.ts).
  const typeOf = (i: Item) => (tables?.misc ? [tables.misc.rows[i.row][colIndex(tables.misc, 'type')] ?? '', tables.misc.rows[i.row][colIndex(tables.misc, 'type2')] ?? ''] : ['', '']);
  const miscItems = useMemo(() => allMisc.filter((i) => templateRisk(...(typeOf(i) as [string, string]))?.kind !== 'blocked'), [allMisc]); // eslint-disable-line react-hooks/exhaustive-deps
  const allItems = useMemo(() => [...allMisc, ...catalog(tables?.weapons ?? null, 'Weapons'), ...catalog(tables?.armor ?? null, 'Armor')], [tables, allMisc]);
  const used = useMemo(() => new Set(allItems.map((i) => i.code.toLowerCase())), [allItems]);
  // Start with the mod's first map item (it will open this map), and a sensible default recipe.
  useEffect(() => {
    if (!miscItems.length) return;
    if (!template) {
      // The most common kind of map item (a regular map, not a one-off like PD2's Uber Tristram map).
      const maps = miscItems.filter((i) => opensOf(i) !== null);
      const count = new Map<string, number>();
      for (const i of maps) count.set(i.type, (count.get(i.type) ?? 0) + 1);
      const common = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
      setTemplate(maps.find((i) => i.type === common) ?? null);
    }
    const byCode = (c: string) => allItems.find((i) => i.code === c);
    if (suggested?.inputs.length && !ingredients.length && !advanced) {
      // An imported package's recipe: known items as ingredients, anything else ("gem4,qty=3", "rin,mag") as typed.
      const known: Ingredient[] = [];
      const other: string[] = [];
      for (const input of suggested.inputs) {
        const m = /^([a-z0-9]{3,4})(?:,qty=(\d+))?$/i.exec(input.trim());
        if (m && byCode(m[1])) known.push({ code: m[1], qty: Number(m[2]) || 1 });
        else other.push(input.trim());
      }
      setIngredients(known);
      if (other.length) setAdvanced(other.join(', '));
      return;
    }
    const defaults = ['tbk', 'isc'].filter((c) => byCode(c)).map((code) => ({ code, qty: 1 }));
    if (!ingredients.length) setIngredients(defaults);
  }, [miscItems]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoCode = useMemo(() => freeCode(mapName, used), [mapName, used]);
  const code = mode === 'custom' ? customCode.trim() : autoCode;
  const codeProblem =
    mode !== 'custom'
      ? null
      : !code
        ? 'Type a code.'
        : !/^[a-z0-9]{3,4}$/i.test(code)
          ? 'Use 3 or 4 letters or numbers.'
          : used.has(code.toLowerCase())
            ? `“${code}” is already used by ${allItems.find((i) => i.code.toLowerCase() === code.toLowerCase())?.name}.`
            : null;
  const inputStrings = [
    ...ingredients.map((g) => `"${g.code}${g.qty > 1 ? `,qty=${g.qty}` : ''}"`),
    ...(advanced.trim() ? (advanced.match(/"[^"]*"|[^,\s][^,]*/g) ?? []).map((s) => (s.startsWith('"') ? s.trim() : `"${s.trim()}"`)) : []),
  ];

  const risk = template ? templateRisk(...(typeOf(template) as [string, string])) : null;
  /** The level the game builds from the open map: the first LvlPrest row claiming a level that lists it. */
  const mapLevel = useMemo(() => {
    const prest = tables?.prest;
    const levels = tables?.levels;
    if (!prest || !levels) return null;
    const rel = normalizePath(mapPath).replace(/^data\/global\/tiles\//, '');
    for (const r of dataRows(prest)) {
      const id = Number(getCell(prest, r, 'LevelId')) || 0;
      if (!id || ![1, 2, 3, 4, 5, 6].some((i) => normalizePath(getCell(prest, r, `File${i}`)) === rel)) continue;
      const first = dataRows(prest).find((x) => (Number(getCell(prest, x, 'LevelId')) || 0) === id);
      if (first !== r) continue;
      const lr = levels.rows.findIndex((_, i) => getCell(levels, i, 'Id').trim() === String(id));
      return { id, name: lr >= 0 ? getCell(levels, lr, 'Name') : `level ${id}` };
    }
    return null;
  }, [tables, mapPath]);
  const opensOf = (i: Item) => (tables?.misc ? mapItemLevel(tables.misc, i.row, tables.levels) : null);
  const templateOpens = template ? opensOf(template) : null;
  const plan = useMemo((): TableWrite[] | string => {
    if (!tables?.misc || !tables.cube) return 'Loading the item and cube tables…';
    if (!template) return kind === 'map' ? 'Pick the map item to copy.' : 'Pick a template item.';
    if (kind === 'map' && opensOf(template) === null) return 'Pick one of the map items: only they can open this map.';
    if (codeProblem) return codeProblem;
    const numinputs =
      ingredients.reduce((n, g) => n + g.qty, 0) + inputStrings.slice(ingredients.length).reduce((n, p) => n + (Number(/qty=(\d+)/.exec(p)?.[1]) || 1), 0);
    return planCubeItem(
      { misc: tables.misc, cube: tables.cube, levels: tables.levels, strings: tables.strings },
      {
        templateRow: template.row,
        name: itemName,
        code,
        inputs: inputStrings,
        numinputs,
        mapName,
        acceptModType: acceptMod,
        map: mapLevel ? { levelId: mapLevel.id, levelTitle: nameLevel ? levelTitle : '' } : undefined,
      },
    );
  }, [tables, template, codeProblem, inputStrings.join('|'), itemName, code, mapName, acceptMod, mapLevel, nameLevel, levelTitle, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const ours = useMemo(() => (tables?.cube && tables.misc ? { recipes: studioRecipes(tables.cube), items: studioItems(tables.misc) } : { recipes: [], items: [] }), [tables]);

  return (
    <Modal title="Cube recipe for this map" onClose={onClose} wide>
      <p className="muted small">
        Makes a new item and a Horadric Cube recipe that creates it. The item is added at the end of Misc.txt (never in the middle, which would
        renumber every item after it), never drops at random, and a recipe with the same ingredients as an existing one is refused.
      </p>
      <p className="small">
        Pick one of your mod&apos;s <b>map items</b> as the template and the new item opens <b>this map</b>: its level number goes into the item
        (the <span className="mono">len</span> column, as PD2&apos;s maps do), its name into patchstring.tbl, and the recipe makes it like your mod&apos;s
        other map recipes.
      </p>
      {!mapLevel && tables && (
        <div className="imp-callout small">
          <span>
            <b>This map isn&apos;t a level in the game yet,</b> so a map item can&apos;t open it. Add it first, then come back.
          </span>
          <button className="btn small primary" onClick={onAddToGame}>
            Add this map to the game…
          </button>
        </div>
      )}
      <div className="cr-cols">
        <section className="cr-card">
          <div className="cr-card-title">1 · The item</div>
          <div className="chips">
            <button
              className={`chip${kind === 'map' ? ' active' : ''}`}
              onClick={() => {
                setKind('map');
                if (template && opensOf(template) === null) setTemplate(null);
              }}
              title="A copy of one of your mod's map items that opens the map you have open"
            >
              Map item that opens this map
            </button>
            <button
              className={`chip${kind === 'other' ? ' active' : ''}`}
              onClick={() => {
                setKind('other');
                if (template && opensOf(template) !== null) setTemplate(null);
              }}
              title="Any other item: the cube makes it, but it doesn't open anything"
            >
              Other item (opens nothing)
            </button>
          </div>
          {kind === 'map' && !miscItems.some((i) => opensOf(i) !== null) && tables && (
            <p className="small warn-text">
              Your mod has no map items (items that open a level through their len column, like PD2&apos;s maps), so there is nothing to copy that
              could open this map.
            </p>
          )}
          {kind === 'other' && <p className="small muted">The cube makes this item, but using it does not open this map (or anything else).</p>}
          <div className="chips">
            <button className={`chip${mode === 'template' ? ' active' : ''}`} onClick={() => setMode('template')}>
              From a template
            </button>
            <button className={`chip${mode === 'custom' ? ' active' : ''}`} onClick={() => setMode('custom')}>
              Custom item (my own code)
            </button>
          </div>
          <div className="field-label">
            Template item <HelpTip text={HELP.template} />
          </div>
          <ItemPicker
            items={miscItems.filter((i) => (kind === 'map') === (opensOf(i) !== null))}
            fs={fs}
            palette={palette}
            selected={template ? `${template.table}.${template.row}` : null}
            onPick={(i) => {
              setTemplate(i);
              setAcceptMod(false);
            }}
          />
          {templateOpens !== null && (
            <div className="small cr-risk ok-text">
              {mapLevel ? (
                <>
                  A map item: the copy opens <b>level {mapLevel.id} “{mapLevel.name}”</b>, the map you have open (the template opens level {templateOpens}).
                  <label>
                    <input type="checkbox" checked={nameLevel} onChange={(e) => setNameLevel(e.target.checked)} /> name the level in game:{' '}
                    <input className="text-input" value={levelTitle} disabled={!nameLevel} onChange={(e) => setLevelTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                  </label>
                </>
              ) : (
                <span className="warn-text">A map item — but this map isn&apos;t a level yet (see above).</span>
              )}
            </div>
          )}
          {risk && templateOpens === null && (
            <div className="small warn-text cr-risk">
              {risk.text}
              {risk.kind === 'mod-type' && (
                <label>
                  <input type="checkbox" checked={acceptMod} onChange={(e) => setAcceptMod(e.target.checked)} /> my mod supports new items of this type
                </label>
              )}
            </div>
          )}
          <label className="cr-field">
            <span>
              Item name <HelpTip text={HELP.name} />
            </span>
            <input className="text-input" value={itemName} onChange={(e) => setItemName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          {mode === 'template' ? (
            <div className="cr-field">
              <span>
                Item code <HelpTip text={HELP.code} />
              </span>
              <span>
                <code className="cr-code">{autoCode}</code> <span className="muted small">made for you (unused)</span>
              </span>
            </div>
          ) : (
            <label className="cr-field">
              <span>
                Item code <HelpTip text={HELP.customCode} />
              </span>
              <span>
                <input className="text-input mono cr-code-input" value={customCode} maxLength={4} placeholder={autoCode} onChange={(e) => setCustomCode(e.target.value.trim())} onKeyDown={(e) => e.stopPropagation()} />
                {codeProblem ? <span className="small error-text"> {codeProblem}</span> : <span className="small ok-text"> ✓ free</span>}
              </span>
            </label>
          )}
        </section>

        <section className="cr-card">
          <div className="cr-card-title">
            2 · What goes in the cube <HelpTip text={HELP.inputs} />
          </div>
          {ingredients.map((g, n) => {
            const it = allItems.find((i) => i.code === g.code);
            return (
              <div key={n} className="cr-ing">
                <ItemIcon fs={fs} invfile={it?.invfile ?? ''} palette={palette} />
                <span className="cr-name">{it?.name ?? g.code}</span>
                <span className="mono muted small">{g.code}</span>
                <label className="small" title={HELP.qty}>
                  ×{' '}
                  <input
                    className="text-input cr-qty"
                    type="number"
                    min={1}
                    max={99}
                    value={g.qty}
                    onChange={(e) => setIngredients((list) => list.map((x, i) => (i === n ? { ...x, qty: Math.max(1, Math.min(99, Number(e.target.value) || 1)) } : x)))}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </label>
                <button className="icon-btn" title="Remove" onClick={() => setIngredients((list) => list.filter((_, i) => i !== n))}>
                  ×
                </button>
              </div>
            );
          })}
          {!ingredients.length && <p className="muted small">No ingredients yet.</p>}
          {adding ? (
            <ItemPicker
              items={allItems}
              fs={fs}
              palette={palette}
              selected={null}
              height={200}
              onPick={(i) => {
                setIngredients((list) => {
                  const k = list.findIndex((x) => x.code === i.code);
                  return k >= 0 ? list.map((x, n) => (n === k ? { ...x, qty: x.qty + 1 } : x)) : [...list, { code: i.code, qty: 1 }];
                });
                setAdding(false);
              }}
              groups={[
                { label: 'Misc items (gems, runes, keys, scrolls…)', test: (i) => i.table === 'Misc' },
                { label: 'Weapons', test: (i) => i.table === 'Weapons' },
                { label: 'Armor', test: (i) => i.table === 'Armor' },
              ]}
            />
          ) : (
            <button className="btn small" disabled={ingredients.length >= 7} onClick={() => setAdding(true)}>
              + Add ingredient
            </button>
          )}
          <details className="cr-advanced">
            <summary className="small">
              Advanced: type cube inputs yourself <HelpTip text={HELP.advanced} />
            </summary>
            <input className="text-input mono" placeholder='e.g. "gem4,qty=3"' value={advanced} onChange={(e) => setAdvanced(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </details>
        </section>
      </div>

      <div className="change-list">
        <div className="field-label">
          What will be written <HelpTip text={HELP.result} />
        </div>
        {typeof plan === 'string' ? (
          <p className="muted small">{plan}</p>
        ) : (
          plan.map((w) => (
            <div key={w.table} className="small">
              <b>{w.table}</b>: {w.summary.join('; ')}
            </div>
          ))
        )}
      </div>
      {(ours.recipes.length > 0 || ours.items.length > 0) && tables?.cube && tables.misc && (() => {
        const toggle = (set: Set<number>, put: (s: Set<number>) => void, row: number) => {
          const n = new Set(set);
          if (n.has(row)) n.delete(row);
          else n.add(row);
          put(n);
        };
        // An item can go once no remaining recipe makes it (its own recipes ticked too count as gone).
        const madeBy = (code: string) => ours.recipes.filter((r) => r.output.split(',')[0].trim() === code);
        const itemBlocked = (code: string, recipesGoing: Set<number>) => madeBy(code).some((r) => !recipesGoing.has(r.row));
        const itemsOk = [...selItems].every((row) => {
          const it = ours.items.find((x) => x.row === row);
          return !!it && !itemBlocked(it.code, selRecipes);
        });
        const count = selRecipes.size + selItems.size;
        const canRemove = count > 0 && (selItems.size === 0 || (nobodyHolds && itemsOk));
        const everything = selRecipes.size === ours.recipes.length && selItems.size === ours.items.length;
        const ask = (recipes: number[], items: number[]) => setConfirmRemove({ recipes, items });
        const recipeName = (row: number) => ours.recipes.find((r) => r.row === row)?.description ?? `row ${row}`;
        const itemName = (row: number) => {
          const it = ours.items.find((x) => x.row === row);
          return it ? `${it.name} (${it.code})` : `row ${row}`;
        };
        const doRemove = async () => {
          if (!confirmRemove || !tables.cube || !tables.misc) return;
          const writes: TableWrite[] = [];
          if (confirmRemove.recipes.length) writes.push(removeRows('CubeMain.txt', tables.cube, confirmRemove.recipes, (r) => `recipe “${recipeName(r)}”`));
          if (confirmRemove.items.length) writes.push(removeRows('Misc.txt', tables.misc, confirmRemove.items, (r) => `item “${itemName(r)}”`));
          setBusy(true);
          try {
            await onRemove(writes);
            setSelRecipes(new Set());
            setSelItems(new Set());
            setReload((n) => n + 1);
          } finally {
            setConfirmRemove(null);
            setBusy(false);
          }
        };
        const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
        return (
          <details className="cr-ours" open={count > 0 || !!confirmRemove || undefined}>
            <summary className="small">
              Made by DS1 Studio: {plural(ours.recipes.length, 'recipe')}, {plural(ours.items.length, 'item')}
            </summary>
            <div className="cr-ours-tools small">
              <button
                className="link"
                onClick={() => {
                  setSelRecipes(everything ? new Set() : new Set(ours.recipes.map((r) => r.row)));
                  setSelItems(everything ? new Set() : new Set(ours.items.map((it) => it.row)));
                }}
              >
                {everything ? 'Select none' : 'Select all'}
              </button>
              <button
                className="btn small danger"
                disabled={busy || !canRemove}
                onClick={() => ask([...selRecipes], [...selItems])}
                title={count && !canRemove ? 'Items need the box below ticked, and every recipe that makes them ticked too' : undefined}
              >
                Remove selected{count ? ` (${count})` : ''}
              </button>
            </div>
            {ours.recipes.map((r) => (
              <div key={`r${r.row}`} className="pops-row small">
                <label className="cr-pick">
                  <input type="checkbox" checked={selRecipes.has(r.row)} onChange={() => toggle(selRecipes, setSelRecipes, r.row)} />
                  <span>
                    Recipe “{r.description}” → <span className="mono">{r.output}</span>
                  </span>
                </label>
                <button className="btn small" disabled={busy} onClick={() => ask([r.row], [])}>
                  Remove recipe
                </button>
              </div>
            ))}
            {ours.items.length > 0 && (
              <label className="small warn-text">
                <input type="checkbox" checked={nobodyHolds} onChange={(e) => setNobodyHolds(e.target.checked)} /> no character holds these items (a character that
                does may not load once its item&apos;s code is gone)
              </label>
            )}
            {ours.items.map((it) => (
              <div key={`i${it.row}`} className="pops-row small">
                <label className="cr-pick">
                  <input type="checkbox" checked={selItems.has(it.row)} onChange={() => toggle(selItems, setSelItems, it.row)} />
                  <span>
                    Item “{it.name}” <span className="mono">{it.code}</span>
                    {itemBlocked(it.code, selRecipes) ? ' (a recipe still makes it: remove that first, or tick it too)' : ''}
                  </span>
                </label>
                <button className="btn small" disabled={busy || !nobodyHolds || itemBlocked(it.code, new Set())} onClick={() => ask([], [it.row])}>
                  Remove item
                </button>
              </div>
            ))}
            {confirmRemove && (
              <div className="cr-confirm" role="alertdialog">
                <b>
                  Remove{' '}
                  {[confirmRemove.recipes.length ? plural(confirmRemove.recipes.length, 'recipe') : '', confirmRemove.items.length ? plural(confirmRemove.items.length, 'item') : '']
                    .filter(Boolean)
                    .join(' and ')}
                  ?
                </b>
                <ul className="small">
                  {confirmRemove.recipes.map((row) => (
                    <li key={`cr${row}`}>Recipe “{recipeName(row)}”</li>
                  ))}
                  {confirmRemove.items.map((row) => (
                    <li key={`ci${row}`}>Item “{itemName(row)}”</li>
                  ))}
                </ul>
                <p className="small muted">
                  They are taken out of {[confirmRemove.recipes.length ? 'CubeMain.txt' : '', confirmRemove.items.length ? 'Misc.txt' : ''].filter(Boolean).join(' and ')} (the old
                  file is kept as .bak).
                </p>
                <div className="cr-confirm-actions">
                  <button className="btn small" onClick={() => setConfirmRemove(null)} disabled={busy}>
                    Cancel
                  </button>
                  <button className="btn small danger" onClick={() => void doRemove()} disabled={busy}>
                    {busy ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </div>
            )}
          </details>
        );
      })()}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={typeof plan === 'string' || busy}
          onClick={async () => {
            if (typeof plan === 'string') return;
            setBusy(true);
            await onApply(plan);
            setBusy(false);
          }}
        >
          {busy ? 'Creating…' : 'Create item and recipe'}
        </button>
      </div>
    </Modal>
  );
}
