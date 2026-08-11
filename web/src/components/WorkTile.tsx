import { useQueryClient } from '@tanstack/react-query';

import { api, type MovieSummary, type ShowSummary } from '../api';
import { isNew } from '../genres';
import { MediaTile } from './MediaTile';

/**
 * Vignette d'un film ou d'une série, à partir de la donnée de liste.
 *
 * Les quatre écrans qui affichent des vignettes — accueil, bibliothèque,
 * recherche, suggestions — passaient chacun les mêmes douze propriétés à
 * MediaTile. Une seule définition, donc : un champ ajouté à l'API se répercute
 * partout d'un coup.
 *
 * Le préchargement du détail est monté ici : au relâchement du clic, la fiche
 * est déjà en cache.
 */

/** Les pastilles n'ont de sens que sur les écrans de parcours, pas sur l'accueil. */
interface TileOptions {
  /** Occupe toute la largeur de sa cellule, pour les grilles. */
  fluid?: boolean;
  /** Affiche « Nouveau » ou « Terminée » quand c'est le cas. */
  withBadge?: boolean;
}

export function MovieTile({ movie, fluid, withBadge }: TileOptions & { movie: MovieSummary }) {
  const queryClient = useQueryClient();

  return (
    <MediaTile
      fluid={fluid}
      to={`/movie/${movie.id}`}
      title={movie.title}
      logoUrl={movie.logoPath}
      logoSrcSet={movie.logoSrcSet}
      backdropUrl={movie.backdropPath}
      backdropSrcSet={movie.backdropSrcSet}
      posterUrl={movie.posterPath}
      posterSrcSet={movie.posterSrcSet}
      tagline={movie.tagline}
      year={movie.year}
      genres={movie.genres}
      runtimeMinutes={movie.runtime}
      badge={withBadge === true && isNew(movie.addedAt) ? 'Nouveau' : null}
      onPrefetch={() =>
        void queryClient.prefetchQuery({
          queryKey: ['movie', String(movie.id)],
          queryFn: () => api.movie(movie.id),
        })
      }
    />
  );
}

export function ShowTile({ show, fluid, withBadge }: TileOptions & { show: ShowSummary }) {
  const queryClient = useQueryClient();

  // « Nouveau » l'emporte sur « Terminée » : c'est l'information la plus utile.
  const badge =
    withBadge !== true
      ? null
      : isNew(show.addedAt)
        ? 'Nouveau'
        : show.status === 'Ended' || show.status === 'Canceled'
          ? 'Terminée'
          : null;

  return (
    <MediaTile
      fluid={fluid}
      to={`/show/${show.id}`}
      title={show.title}
      logoUrl={show.logoPath}
      logoSrcSet={show.logoSrcSet}
      backdropUrl={show.backdropPath}
      backdropSrcSet={show.backdropSrcSet}
      posterUrl={show.posterPath}
      posterSrcSet={show.posterSrcSet}
      tagline={null}
      year={show.year}
      genres={show.genres}
      runtimeMinutes={null}
      badge={badge}
      onPrefetch={() =>
        void queryClient.prefetchQuery({
          queryKey: ['show', String(show.id)],
          queryFn: () => api.show(show.id),
        })
      }
    />
  );
}
