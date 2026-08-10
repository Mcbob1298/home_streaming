import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { api } from '../api';
import { Empty, ErrorMessage, Loading } from '../components/States';

/** Page d'accueil : la liste des bibliothèques et leur nombre d'éléments. */
export function Home() {
  const { data, isPending, error } = useQuery({ queryKey: ['libraries'], queryFn: api.libraries });

  if (isPending) return <Loading />;
  if (error !== null) return <ErrorMessage error={error} />;
  if (data.length === 0) return <Empty label="Aucune bibliothèque. Vérifiez config.json puis lancez npm run scan." />;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {data.map((library) => (
        <Link
          key={library.id}
          to={`/library/${library.id}`}
          className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 transition hover:border-zinc-600 hover:bg-zinc-900"
        >
          <h2 className="text-lg font-medium text-zinc-100">{library.label}</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {library.itemCount} {library.type === 'movie' ? 'films' : 'séries'}
          </p>
        </Link>
      ))}
    </div>
  );
}
