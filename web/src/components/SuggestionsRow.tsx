import { useQuery } from '@tanstack/react-query';

import { api, type MovieSummary, type Page, type ShowSummary } from '../api';
import { MediaRow } from './MediaRow';
import { MediaTile } from './MediaTile';

/**
 * Rangée de suggestions : les œuvres du même genre principal.
 *
 * Partagée par les deux fiches. Le genre est désigné par son nom plutôt que par
 * son identifiant : la fiche connaît ses genres, pas leurs identifiants.
 */
export function SuggestionsRow({
  genreName,
  currentId,
  kind,
}: {
  genreName: string | null;
  currentId: number;
  kind: 'movie' | 'show';
}) {
  const genres = useQuery({ queryKey: ['genres'], queryFn: api.genres });
  const genre = (genres.data ?? []).find((entry) => entry.name === genreName);

  // Films et séries n'ont pas la même forme : le type commun est déclaré ici,
  // et chaque champ propre à l'un des deux est lu via « in » plus bas.
  const suggestions = useQuery<Page<MovieSummary | ShowSummary>>({
    queryKey: [kind === 'movie' ? 'movies' : 'shows', 'genre', genre?.id],
    queryFn: (): Promise<Page<MovieSummary | ShowSummary>> =>
      kind === 'movie'
        ? api.movies({ genre: genre?.id, sort: 'added' })
        : api.shows({ genre: genre?.id, sort: 'added' }),
    enabled: genre !== undefined,
  });

  const items = (suggestions.data?.items ?? []).filter((item) => item.id !== currentId).slice(0, 20);

  if (items.length === 0) {
    return <p className="px-16 pt-8 pb-16 text-[14px] text-faible">Aucune suggestion pour ce genre.</p>;
  }

  return (
    <div className="pt-8 pb-16">
      <MediaRow title="">
        {items.map((item) => (
          <MediaTile
            key={item.id}
            to={`/${kind}/${item.id}`}
            title={item.title}
            logoUrl={item.logoPath}
            logoSrcSet={item.logoSrcSet}
            backdropUrl={item.backdropPath}
            backdropSrcSet={item.backdropSrcSet}
            posterUrl={item.posterPath}
            posterSrcSet={item.posterSrcSet}
            tagline={'tagline' in item ? item.tagline : null}
            year={item.year}
            genres={item.genres}
            runtimeMinutes={'runtime' in item ? item.runtime : null}
          />
        ))}
      </MediaRow>
    </div>
  );
}
