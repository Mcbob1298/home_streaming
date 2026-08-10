import { useEffect, useState } from 'react';

import type { SortField } from '../api';

/**
 * Barre de recherche + tri.
 *
 * La saisie est « débouncée » : on attend 300 ms de silence avant de prévenir
 * le parent, sinon chaque lettre tapée déclencherait une requête. Le champ
 * reste réactif (état local), c'est seulement la remontée qui est retardée.
 */

interface ToolbarProps {
  search: string;
  sort: SortField;
  onSearchChange: (value: string) => void;
  onSortChange: (value: SortField) => void;
  /** Nombre total de résultats, affiché à droite. */
  total?: number;
}

const DEBOUNCE_MS = 300;

const SORT_LABELS: Record<SortField, string> = {
  title: 'Titre',
  year: 'Année',
  added: 'Ajout',
};

export function Toolbar({ search, sort, onSearchChange, onSortChange, total }: ToolbarProps) {
  const [draft, setDraft] = useState(search);

  // Si la recherche change ailleurs (retour arrière du navigateur), on resynchronise.
  useEffect(() => {
    setDraft(search);
  }, [search]);

  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => onSearchChange(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, search, onSearchChange]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-56 flex-1">
        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Rechercher un titre…"
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-600"
        />
      </div>

      <div className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 p-1">
        {(Object.keys(SORT_LABELS) as SortField[]).map((field) => (
          <button
            key={field}
            type="button"
            onClick={() => onSortChange(field)}
            className={`rounded px-3 py-1 text-xs transition ${
              sort === field ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {SORT_LABELS[field]}
          </button>
        ))}
      </div>

      {total !== undefined && (
        <span className="text-xs text-zinc-500">
          {total} {total > 1 ? 'éléments' : 'élément'}
        </span>
      )}
    </div>
  );
}
