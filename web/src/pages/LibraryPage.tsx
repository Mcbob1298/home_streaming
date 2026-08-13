import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { api, type MovieSummary, type Page, type ShowSummary, type SortField } from '../api';
import { FilterPills } from '../components/FilterPills';
import { MediaGrid } from '../components/MediaGrid';
import { ErrorMessage, Loading } from '../components/States';
import { MovieTile, ShowTile } from '../components/WorkTile';
import { findGenreBySlug, slugifyGenre } from '../genres';
import { useLibraryRefresh, usePreparationStatus, useStableOrder } from '../preparation';

const SORTS: { key: SortField; label: string }[] = [
  { key: 'title', label: 'Titre' },
  { key: 'year', label: 'Année' },
  { key: 'added', label: 'Ajout' },
];

/**
 * Page d'une bibliothèque : titre centré, pastilles de filtre, grille.
 *
 * Le genre actif et le tri vivent dans l'URL : un lien reste partageable et le
 * bouton « précédent » du navigateur refait exactement la vue attendue.
 */
export function LibraryPage() {
  const { libraryId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const genreSlug = searchParams.get('genre');
  const sort = (searchParams.get('sort') as SortField | null) ?? 'title';

  const libraries = useQuery({ queryKey: ['libraries'], queryFn: api.libraries });
  const genres = useQuery({ queryKey: ['genres'], queryFn: api.genres });

  const library = libraries.data?.find((entry) => entry.id === libraryId);
  const type = library?.type;
  const genre = findGenreBySlug(genres.data ?? [], genreSlug);

  // Films et séries n'ont pas la même forme : on déclare le type commun une
  // fois ici, et les cartes plus bas distinguent les deux.
  const list = useInfiniteQuery<Page<MovieSummary | ShowSummary>>({
    queryKey: ['library', libraryId, type, genreSlug, sort],
    enabled: type !== undefined,
    initialPageParam: 1,
    queryFn: ({ pageParam }): Promise<Page<MovieSummary | ShowSummary>> => {
      const params = { library: libraryId, genre: genre?.id, sort, page: pageParam as number };
      return type === 'movie' ? api.movies(params) : api.shows(params);
    },
    // Le serveur renvoie déjà page et totalPages : rien à deviner.
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });

  /*
   * Pendant une passe de préparation, la grille se remplit sous les yeux.
   *
   * Calculé AVANT les retours anticipés — ce sont des hooks. Le gel garde les
   * vignettes déjà affichées à leur place et pose les arrivantes à la suite :
   * sur un tri par titre, un film qui devient prêt s'insérerait au milieu et
   * décalerait toute la grille sous le curseur.
   */
  const preparation = usePreparationStatus();
  useLibraryRefresh(preparation);
  const enCours = preparation?.running === true || preparation?.paused === true;

  const chargees = (list.data?.pages ?? []).flatMap((page) => page.items);
  const items = useStableOrder(chargees, enCours);

  if (libraries.isPending) return <Loading />;
  if (libraries.error !== null) return <ErrorMessage error={libraries.error} />;
  if (library === undefined) return <Empty label={`Bibliothèque « ${libraryId} » inconnue.`} />;

  /*
   * Seuls les genres présents dans CETTE bibliothèque sont proposés : filtrer
   * les films par « Action & Adventure », un genre propre aux séries, ne
   * renverrait jamais rien.
   */
  const relevant = (genres.data ?? []).filter((entry) =>
    library.type === 'movie' ? entry.movieCount > 0 : entry.showCount > 0,
  );

  const options = [
    { key: '', label: 'Tout' },
    ...relevant.map((entry) => ({ key: slugifyGenre(entry.name), label: entry.name })),
  ];

  const total = list.data?.pages[0]?.total ?? 0;

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  }

  return (
    <div className="pb-16">
      <h1 className="pt-14 pb-9 text-center text-[44px] font-bold">{library.label}</h1>

      <FilterPills options={options} active={genreSlug ?? ''} onChange={(key) => update({ genre: key })} />

      <div className="mt-4 flex items-center justify-between px-16">
        <p className="text-[13px] text-faible">
          {total} {library.type === 'movie' ? (total > 1 ? 'films' : 'film') : total > 1 ? 'séries' : 'série'}
        </p>
        <SortSelect value={sort} onChange={(value) => update({ sort: value === 'title' ? null : value })} />
      </div>

      {list.error !== null && <ErrorMessage error={list.error} />}
      {list.isPending && <Loading />}

      {items.length === 0 && !list.isPending ? (
        <Empty label={genre === null ? 'Bibliothèque vide.' : `Aucun titre dans « ${genre.name} ».`} />
      ) : (
        <>
          <MediaGrid>
            {/* Films et séries partagent la liste : le champ propre au film discrimine. */}
            {items.map((item) =>
              'fileCount' in item ? (
                <MovieTile key={`m${item.id}`} movie={item} fluid withBadge />
              ) : (
                <ShowTile key={`s${item.id}`} show={item} fluid withBadge />
              ),
            )}
          </MediaGrid>
          <LoadMore
            hasMore={list.hasNextPage}
            loading={list.isFetchingNextPage}
            onReach={() => void list.fetchNextPage()}
          />
        </>
      )}
    </div>
  );
}

/** Sentinelle de défilement infini : charge le lot suivant à l'approche du bas. */
export function LoadMore({
  hasMore,
  loading,
  onReach,
}: {
  hasMore: boolean;
  loading: boolean;
  onReach: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = sentinel.current;
    if (node === null || !hasMore) return;

    // La marge déclenche le chargement avant que le bas ne soit atteint :
    // la grille se remplit sans temps mort visible.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReach();
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onReach]);

  if (!hasMore) return null;
  return (
    <div ref={sentinel} className="py-6 text-center text-[13px] text-faible">
      {loading ? 'Chargement…' : ''}
    </div>
  );
}

function SortSelect({ value, onChange }: { value: SortField; onChange: (value: SortField) => void }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as SortField)}
        aria-label="Trier par"
        className="h-9 appearance-none rounded border border-[rgba(249,249,249,0.16)] bg-transparent pr-9 pl-3 text-[13px] text-faible outline-none hover:text-texte focus-visible:border-[rgba(249,249,249,0.5)]"
      >
        {SORTS.map((option) => (
          <option key={option.key} value={option.key} className="bg-surface text-texte">
            {option.label}
          </option>
        ))}
      </select>
      <svg
        width="10"
        height="7"
        viewBox="0 0 12 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-faible"
      >
        <path d="m1 1 5 5 5-5" />
      </svg>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="py-20 text-center text-[14px] text-faible">{label}</p>;
}
