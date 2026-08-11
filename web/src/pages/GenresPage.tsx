import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { api } from '../api';
import { ErrorMessage, Loading } from '../components/States';

/**
 * Liste des genres.
 *
 * Version minimale : l'entrée « Genres » de la barre de navigation existe déjà,
 * la laisser mener nulle part serait un défaut visible. Les grilles filtrées
 * arriveront avec les pages bibliothèque.
 */
export function GenresPage() {
  const genres = useQuery({ queryKey: ['genres'], queryFn: api.genres });

  if (genres.isPending) return <Loading />;
  if (genres.error !== null) return <ErrorMessage error={genres.error} />;

  return (
    <div>
      <h1 className="mb-6 text-[19px] font-semibold">Genres</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {genres.data.map((genre) => (
          <Link
            key={genre.id}
            to={`/library/films?genre=${genre.id}`}
            className="flex items-baseline justify-between rounded border border-[rgba(249,249,249,0.07)] bg-surface px-5 py-4 transition-colors hover:bg-surface-haute"
          >
            <span className="text-[15px] font-semibold">{genre.name}</span>
            <span className="text-[13px] text-faible">
              {genre.movieCount > 0 && `${genre.movieCount} films`}
              {genre.movieCount > 0 && genre.showCount > 0 && ' · '}
              {genre.showCount > 0 && `${genre.showCount} séries`}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
