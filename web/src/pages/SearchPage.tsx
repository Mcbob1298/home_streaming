import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../api';
import { BrowseRows } from '../components/BrowseRows';
import { MediaGrid } from '../components/MediaGrid';
import { ErrorMessage, Loading } from '../components/States';
import { MovieTile, ShowTile } from '../components/WorkTile';

const DEBOUNCE_MS = 300;

/**
 * Page de recherche, films et séries confondus.
 *
 * Deux principes :
 *
 * - La page n'est JAMAIS vide. Champ vide ou terme sans résultat, on propose
 *   des rangées à parcourir : on ne sait pas toujours quoi taper.
 * - Le terme vit dans l'URL, donc la recherche est partageable. L'entrée
 *   d'historique est REMPLACÉE et non empilée : sans quoi le bouton
 *   « précédent » rejouerait la requête lettre par lettre au lieu de ramener à
 *   la page d'où l'on vient.
 */
export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [term, setTerm] = useState(() => searchParams.get('q') ?? '');
  const [debounced, setDebounced] = useState(term);

  // La frappe met à jour le champ immédiatement, la requête attend le silence.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    const trimmed = debounced.trim();
    const current = searchParams.get('q') ?? '';
    // La comparaison évite la boucle : setSearchParams provoque un rendu, qui
    // rejouerait l'effet, qui rappellerait setSearchParams.
    if (trimmed === current) return;
    setSearchParams(trimmed === '' ? {} : { q: trimmed }, { replace: true });
  }, [debounced, searchParams, setSearchParams]);

  const enabled = debounced.trim() !== '';
  const movies = useQuery({
    queryKey: ['search', 'movies', debounced],
    queryFn: () => api.movies({ search: debounced, sort: 'title' }),
    enabled,
  });
  const shows = useQuery({
    queryKey: ['search', 'shows', debounced],
    queryFn: () => api.shows({ search: debounced, sort: 'title' }),
    enabled,
  });

  const error = movies.error ?? shows.error;

  return (
    <div>
      <SearchField value={term} onChange={setTerm} />

      {!enabled ? (
        <BrowseRows />
      ) : error !== null ? (
        <ErrorMessage error={error} />
      ) : movies.data === undefined || shows.data === undefined ? (
        <Loading />
      ) : (
        <Results term={debounced} movies={movies.data.items} shows={shows.data.items} />
      )}
    </div>
  );
}

function Results({
  term,
  movies,
  shows,
}: {
  term: string;
  movies: Parameters<typeof MovieTile>[0]['movie'][];
  shows: Parameters<typeof ShowTile>[0]['show'][];
}) {
  if (movies.length === 0 && shows.length === 0) {
    return (
      <div>
        <p className="px-16 pt-10 pb-2 text-[17px]">Aucun résultat pour « {term} ».</p>
        <p className="px-16 pb-8 text-[14px] text-faible">
          Essayer une partie du titre, ou parcourir la bibliothèque.
        </p>
        <BrowseRows />
      </div>
    );
  }

  return (
    <div className="pb-16">
      <p className="px-16 pt-8 text-[13px] text-faible">
        {movies.length + shows.length} résultat{movies.length + shows.length > 1 ? 's' : ''} pour « {term} »
      </p>

      {movies.length > 0 && (
        <section>
          <h2 className="px-16 pt-6 text-[19px] font-semibold">Films</h2>
          <MediaGrid>
            {movies.map((movie) => (
              <MovieTile key={`m${movie.id}`} movie={movie} fluid withBadge />
            ))}
          </MediaGrid>
        </section>
      )}

      {shows.length > 0 && (
        <section>
          <h2 className="px-16 pt-6 text-[19px] font-semibold">Séries</h2>
          <MediaGrid>
            {shows.map((show) => (
              <ShowTile key={`s${show.id}`} show={show} fluid withBadge />
            ))}
          </MediaGrid>
        </section>
      )}
    </div>
  );
}

/**
 * Grand champ de recherche : fond transparent, filet inférieur seulement.
 *
 * Le focus automatique est le comportement attendu d'une page dédiée à la
 * saisie — on y arrive pour taper, pas pour regarder un champ.
 */
function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="px-16 pt-12">
      <div className="flex items-center gap-4 border-b border-[rgba(249,249,249,0.24)] focus-within:border-texte">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden="true"
          className="shrink-0 text-faible"
        >
          <circle cx="11" cy="11" r="6.6" />
          <path d="m16 16 4.5 4.5" />
        </svg>

        <input
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onChange('')}
          placeholder="Rechercher un titre, un genre"
          aria-label="Rechercher un titre, un genre"
          className="h-14 w-full bg-transparent text-[20px] text-texte placeholder-faible outline-none"
        />

        {value !== '' && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Effacer la recherche"
            className="shrink-0 p-2 text-faible transition-colors hover:text-texte"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
