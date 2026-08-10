import { Link } from 'react-router-dom';

import { Poster } from './Poster';

interface MediaCardProps {
  to: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  /** Deuxième ligne : « 2 fichiers », « 3 saisons · 28 épisodes »… */
  subtitle?: string;
}

export function MediaCard({ to, title, year, posterPath, subtitle }: MediaCardProps) {
  return (
    <Link
      to={to}
      className="group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      <div className="aspect-[2/3] overflow-hidden rounded-lg border border-zinc-800 transition group-hover:border-zinc-600">
        <Poster title={title} posterPath={posterPath} className="transition group-hover:scale-105" />
      </div>
      <div className="mt-2 px-0.5">
        <p className="truncate text-sm font-medium text-zinc-100" title={title}>
          {title}
        </p>
        <p className="truncate text-xs text-zinc-500">
          {year ?? '—'}
          {subtitle !== undefined && ` · ${subtitle}`}
        </p>
      </div>
    </Link>
  );
}
