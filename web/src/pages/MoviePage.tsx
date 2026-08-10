import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api';
import { Poster } from '../components/Poster';
import { ErrorMessage, Loading } from '../components/States';

function formatSize(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  if (gigabytes >= 1) return `${gigabytes.toFixed(2)} Go`;
  return `${Math.round(bytes / 1024 ** 2)} Mo`;
}

/**
 * Page détail d'un film.
 *
 * Un film peut avoir plusieurs fichiers : version longue et version cinéma, ou
 * le même film présent sur les deux racines du NAS. On les liste tous, avec
 * leurs sous-titres.
 */
export function MoviePage() {
  const { id = '' } = useParams();
  const { data, isPending, error } = useQuery({ queryKey: ['movie', id], queryFn: () => api.movie(id) });

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
          <p className="mt-1 text-sm text-zinc-500">{data.year ?? 'année inconnue'}</p>
          {data.overview !== null && <p className="mt-4 max-w-2xl text-sm text-zinc-400">{data.overview}</p>}
        </div>
      </header>

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium tracking-wide text-zinc-300 uppercase">
          Fichiers
          <span className="ml-2 text-zinc-600 normal-case">{data.files.length}</span>
        </h2>

        <ul className="space-y-3">
          {data.files.map((file) => (
            <li key={file.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
              <p className="text-sm break-all text-zinc-200">{file.fileName}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {formatSize(file.sizeBytes)} · {file.extension.replace('.', '')}
              </p>
              <p className="mt-1 text-xs break-all text-zinc-600">{file.rootPath}</p>

              {file.subtitles.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {file.subtitles.map((subtitle) => (
                    <li
                      key={subtitle.id}
                      className="rounded border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
                      title={subtitle.fileName}
                    >
                      {subtitle.language ?? '??'}
                      {subtitle.forced === 1 && ' · forcé'}
                      {subtitle.hearingImpaired === 1 && ' · SM'}
                      <span className="text-zinc-600"> ({subtitle.format})</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
