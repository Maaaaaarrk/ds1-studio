import { useState } from 'react';

const NEW = '__new_category__';

/**
 * A preset category: one of the saved presets' categories, or a new one typed in ("New category…"). With no saved
 * presets yet it starts on a new one.
 */
export function CategoryPicker({ categories, value, onChange, onEnter }: { categories: string[]; value: string; onChange: (c: string) => void; onEnter?: () => void }) {
  const [typing, setTyping] = useState(() => !categories.includes(value));
  return (
    <span className="category-picker">
      <select
        aria-label="Category"
        value={typing ? NEW : value}
        onChange={(e) => {
          if (e.target.value === NEW) {
            setTyping(true);
            onChange('');
          } else {
            setTyping(false);
            onChange(e.target.value);
          }
        }}
      >
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        <option value={NEW}>New category…</option>
      </select>
      {typing && (
        <input
          value={value}
          autoFocus={categories.length > 0}
          placeholder="New category name"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onEnter?.();
          }}
        />
      )}
    </span>
  );
}
