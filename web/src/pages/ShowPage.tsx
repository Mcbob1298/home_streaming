import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api';
import { Poster } from '../components/Poster';
import { ErrorMessage, Loading } from '../components/States';

/** Page détail d'une série : les saisons, puis les épisodes de chacune. */
export function ShowPage() {
  const { id = '' } = useParams();
  const { data, isPending, error } = useQuery({ queryKey: ['show', id], queryFn: () => api.show(id) });

  if (isPending) return <Loading />;
  if (error !== null) return <ErrorMessage error={error} />;

  return (
    <article>
      <header className="flex flex-col gap-6 sm:flex-row">
        <div className="aspect-[2/3] w-40 shrink-0 overflow-hidden rounded-lg border border-zinc-800">
          <Poster title={data.title} posterPath={data.posterPath} />
        </div>
        <div className="min-w-0">
          <Link to={`/library/${data.libraryId}`} className="text-xs text-zinc-500 hover:text-zinc-300">
            ← Retour à la bibliothèque
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-100">{data.title}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {data.year ?? 'année inconnue'} · {data.seasons.length}{' '}
            {data.seasons.length > 1 ? 'saisons' : 'saison'}
          </p>
          {data.overview !== null && <p className="mt-4 max-w-2xl text-sm text-zinc-400">{data.overview}</p>}
        </div>
      </header>

      <div className="mt-10 space-y-8">
        {data.seasons.map((season) => (
          <section key={season.seasonNumber}>
            <h2 className="mb-3 text-sm font-medium tracking-wide text-zinc-300 uppercase">
              {season.seasonNumber === 0 ? 'Bonus' : `Saison ${season.seasonNumber}`}
              <span className="ml-2 text-zinc-600 normal-case">
                {season.episodes.length} {season.episodes.length > 1 ? 'épisodes' : 'épisode'}
              </span>
            </h2>

            <ul className="divide-y divide-zinc-900 overflow-hidden rounded-lg border border-zinc-800">
              {season.episodes.map((episode) => (
                <li key={episode.id} className="flex items-baseline gap-4 px-4 py-2.5 hover:bg-zinc-900/50">
                  <span className="w-16 shrink-0 font-mono text-xs text-zinc-500">
                    S{String(episode.seasonNumber).padStart(2, '0')}E
                    {String(episode.episodeNumber).padStart(2, '0')}
                    {episode.episodeNumberEnd !== null && `-${String(episode.episodeNumberEnd).padStart(2, '0')}`}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                    {episode.title ?? <span className="text-zinc-600">sans titre</span>}
                  </span>
                  {episode.fileCount > 1 && (
                    <span className="shrink-0 text-xs text-zinc-600">{episode.fileCount} fichiers</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}
