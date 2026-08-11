import { useEffect, useRef, useState } from 'react';

import { reviewApi, type ReviewCandidate } from '../reviewApi';

/**
 * Recherche manuelle, dépliable.
 *
 * Trois entrées, de la plus rapide à la plus lente :
 * l'identifiant TMDB collé depuis le site (immédiat, et le seul moyen fiable
 * pour les titres numérotés), puis le couple titre + année.
 *
 * La recherche interroge le français et l'anglais à chaque fois, sans
 * sélecteur : c'est le serveur qui fusionne les deux jeux de résultats.
 */

interface ManualSearchProps {
  entryKey: string;
  initialTitle: string;
  initialYear: number | null;
  open: boolean;
  onToggle: () => void;
  onResults: (candidates: ReviewCandidate[]) => void;
  /** Remonte l'échappement pour rendre le focus à la liste. */
  onEscape: () => void;
}

export function ManualSearch({
  entryKey,
  initialTitle,
  initialYear,
  open,
  onToggle,
  onResults,
  onEscape,
}: ManualSearchProps) {
  const [title, setTitle] = useState(initialTitle);
  const [year, setYear] = useState(initialYear === null ? '' : String(initialYear));
  const [tmdbId, setTmdbId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Chaque nouvelle entrée repart de ce que le parser a extrait.
  useEffect(() => {
    setTitle(initialTitle);
    setYear(initialYear === null ? '' : String(initialYear));
    setTmdbId('');
    setError(null);
  }, [entryKey, initialTitle, initialYear]);

  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  async function run(event?: React.FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = tmdbId.trim() !== '' ? { tmdbId: tmdbId.trim() } : { title, year: year === '' ? null : Number(year) };
      const result = await reviewApi.search(entryKey, body);
      onResults(result.candidates);
      if (result.candidates.length === 0) setError('Aucun résultat.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-600';

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/30">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm text-zinc-300 hover:text-zinc-100"
      >
        <span>Recherche manuelle</span>
        <span className="text-xs text-zinc-600">{open ? '−' : '+'}  ( / )</span>
      </button>

      {open && (
        <form
          onSubmit={run}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onEscape();
            }
          }}
          className="space-y-3 border-t border-zinc-800 p-4"
        >
          <div className="flex flex-wrap gap-3">
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Titre"
              className={`${inputClass} min-w-64 flex-1`}
            />
            <input
              value={year}
              onChange={(event) => setYear(event.target.value)}
              placeholder="Année"
              inputMode="numeric"
              className={`${inputClass} w-28`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              value={tmdbId}
              onChange={(event) => setTmdbId(event.target.value)}
              placeholder="ou identifiant TMDB collé depuis le site"
              className={`${inputClass} min-w-72 flex-1`}
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-100 transition hover:border-zinc-500 disabled:opacity-50"
            >
              {busy ? 'Recherche…' : 'Chercher'}
            </button>
          </div>

          <p className="text-xs text-zinc-600">
            Interroge TMDB en français et en anglais, résultats fusionnés.
          </p>
          {error !== null && <p className="text-xs text-red-300">{error}</p>}
        </form>
      )}
    </section>
  );
}
