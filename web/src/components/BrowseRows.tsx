import { useQueries, useQuery } from '@tanstack/react-query';

import { api } from '../api';
import { slugifyGenre } from '../genres';
import { MediaRow } from './MediaRow';
import { MovieTile, ShowTile } from './WorkTile';

/**
 * Rangées à parcourir, affichées quand il n'y a rien à afficher d'autre.
 *
 * La page de recherche ne doit jamais être vide : ni au premier affichage, ni
 * quand un terme ne donne rien. On propose alors de parcourir plutôt que de
 * chercher — c'est exactement ce que fait Disney+, et c'est utile : on ne sait
 * pas toujours quoi taper.
 */

/** Rangées de genre proposées, les mieux fournies d'abord. */
const GENRE_ROWS = 3;

/** Un genre en dessous de ce seuil ferait une rangée à trois vignettes. */
const MIN_PER_GENRE = 12;

export function BrowseRows() {
  const recent = useQuery({ queryKey: ['movies', 'added'], queryFn: () => api.movies({ sort: 'added' }) });
  const films = useQuery({ queryKey: ['movies', 'title'], queryFn: () => api.movies({ sort: 'title' }) });
  const series = useQuery({ queryKey: ['shows', 'title'], queryFn: () => api.shows({ sort: 'title' }) });
  const genres = useQuery({ queryKey: ['genres'], queryFn: api.genres });

  const topGenres = (genres.data ?? [])
    .filter((genre) => genre.movieCount >= MIN_PER_GENRE)
    .slice(0, GENRE_ROWS);

  const genreRows = useQueries({
    queries: topGenres.map((genre) => ({
      queryKey: ['movies', 'genre', genre.id],
      queryFn: () => api.movies({ genre: genre.id, sort: 'added' }),
    })),
  });

  const recentItems = recent.data?.items ?? [];
  const filmItems = films.data?.items ?? [];
  const showItems = series.data?.items ?? [];

  return (
    <div className="flex flex-col gap-[26px] pb-24">
      {recentItems.length > 0 && (
        <MediaRow title="Ajouts récents">
          {recentItems.map((movie) => (
            <MovieTile key={movie.id} movie={movie} />
          ))}
        </MediaRow>
      )}

      {filmItems.length > 0 && (
        <MediaRow title="Films" to="/library/films">
          {filmItems.map((movie) => (
            <MovieTile key={movie.id} movie={movie} />
          ))}
        </MediaRow>
      )}

      {showItems.length > 0 && (
        <MediaRow title="Séries" to="/library/series">
          {showItems.map((show) => (
            <ShowTile key={show.id} show={show} />
          ))}
        </MediaRow>
      )}

      {topGenres.map((genre, position) => {
        const items = genreRows[position]?.data?.items ?? [];
        if (items.length === 0) return null;
        return (
          <MediaRow key={genre.id} title={genre.name} to={`/library/films?genre=${slugifyGenre(genre.name)}`}>
            {items.map((movie) => (
              <MovieTile key={movie.id} movie={movie} />
            ))}
          </MediaRow>
        );
      })}
    </div>
  );
}
