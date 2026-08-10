import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { api, type MovieSummary, type Page, type ShowSummary, type SortField } from '../api';
import { MediaCard } from '../components/MediaCard';
import { Pagination } from '../components/Pagination';
import { Empty, ErrorMessage, Loading } from '../components/States';
import { Toolbar } from '../components/Toolbar';

/**
 * Grille d'une bibliothèque.
 *
 * Recherche, tri et page vivent dans l'URL plutôt que dans un état React :
 * on peut ainsi partager un lien, et le bouton « précédent » du navigateur
 * refait exactement la vue attendue.
 */
export function LibraryPage() {
  const { libraryId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get('search') ?? '';
  const sort = (searchParams.get('sort') as SortField | null) ?? 'title';
  const page = Number(searchParams.get('page') ?? '1');

  const libraries = useQuery({ queryKey: ['libraries'], queryFn: api.libraries });
  const library = libraries.data?.find((item) => item.id === libraryId);
  const type = library?.type;

  // Films et séries n'ont pas exactement la même forme : on déclare une seule
  // fois le type commun ici, et la grille plus bas distingue les deux cas.
  const list = useQuery<Page<MovieSummary | ShowSummary>>({
    queryKey: ['library-items', type, libraryId, search, sort, page],
    // `enabled` : on attend de savoir si c'est une bibliothèque de films ou de
    // séries avant d'appeler la bonne route.
    enabled: type !== undefined,
    queryFn: (): Promise<Page<MovieSummary | ShowSummary>> =>
      type === 'movie'
        ? api.movies({ library: libraryId, search, sort, page })
        : api.shows({ library: libraryId, search, sort, page }),
    // Garde l'ancienne page affichée pendant le chargement de la suivante :
    // évite le clignotement à chaque frappe dans la recherche.
    placeholderData: keepPreviousData,
  });

  const updateParams = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const onSearchChange = useCallback(
    (value: string) => updateParams({ search: value, page: null }),
    [updateParams],
  );
  const onSortChange = useCallback(
    (value: SortField) => updateParams({ sort: value, page: null }),
    [updateParams],
  );
  const onPageChange = useCallback(
    (value: number) => {
      updateParams({ page: String(value) });
      window.scrollTo({ top: 0 });
    },
    [updateParams],
  );

  if (libraries.isPending) return <Loading />;
  if (libraries.error !== null) return <ErrorMessage error={libraries.error} />;
  if (library === undefined) return <Empty label={`Bibliothèque « ${libraryId} » inconnue.`} />;

  // Le type est une union « films ou séries » : on l'aplatit une fois ici pour
  // que la grille ci-dessous n'ait qu'un seul tableau à parcourir.
  const items: (MovieSummary | ShowSummary)[] = list.data?.items ?? [];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-zinc-100">{library.label}</h1>

      <Toolbar
        search={search}
        sort={sort}
        onSearchChange={onSearchChange}
        onSortChange={onSortChange}
        total={list.data?.total}
      />

      {list.error !== null && <ErrorMessage error={list.error} />}
      {list.isPending && <Loading />}

      {list.data !== undefined &&
        (items.length === 0 ? (
          <Empty label={search === '' ? 'Bibliothèque vide.' : `Aucun résultat pour « ${search} ».`} />
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {items.map((item) =>
                'fileCount' in item ? (
                  <MediaCard
                    key={item.id}
                    to={`/movie/${item.id}`}
                    title={item.title}
                    year={item.year}
                    posterPath={item.posterPath}
                    subtitle={item.fileCount > 1 ? `${item.fileCount} fichiers` : undefined}
                  />
                ) : (
                  <MediaCard
                    key={item.id}
                    to={`/show/${item.id}`}
                    title={item.title}
                    year={item.year}
                    posterPath={item.posterPath}
                    subtitle={`${item.episodeCount} ép.`}
                  />
                ),
              )}
            </div>

            <Pagination page={list.data.page} totalPages={list.data.totalPages} onChange={onPageChange} />
          </>
        ))}
    </div>
  );
}
