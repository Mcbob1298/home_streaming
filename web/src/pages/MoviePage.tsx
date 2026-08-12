import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../api';
import {
  DetailBackdrop,
  ICONS,
  MetaLine,
  PlayButtons,
  RoundButton,
  Synopsis,
  Tabs,
  formatMinutes,
  type TabKey,
} from '../components/DetailChrome';
import { DetailsPanel, resolutionLabel, type Fact } from '../components/DetailsPanel';
import { ErrorMessage, Loading } from '../components/States';
import { SuggestionsRow } from '../components/SuggestionsRow';
import { shortSynopsis } from '../synopsis';

export function MoviePage() {
  const { id = '' } = useParams();
  const [tab, setTab] = useState<TabKey>('suggestions');

  const movie = useQuery({ queryKey: ['movie', id], queryFn: () => api.movie(id) });

  /*
   * La progression est une donnée d'utilisateur, pas de bibliothèque : elle a
   * son propre cache, court, pour refléter ce qu'on vient de regarder. La fiche
   * s'affiche sans l'attendre — le bouton dit « Lire » puis « Reprendre ».
   */
  const progress = useQuery({
    queryKey: ['progress', 'movie', id],
    queryFn: () => api.progressOf('movie', id),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  if (movie.isPending) return <Loading />;
  if (movie.error !== null) return <ErrorMessage error={movie.error} />;

  const data = movie.data;
  const genreNames = data.genres.map((genre) => genre.name);
  const definition = data.fileSummary.resolutions[0];

  /*
   * Le fichier à ouvrir : celui qu'on écoutait s'il est toujours là, sinon le
   * premier. Deux versions d'un même film — cinéma et longue — ne doivent pas
   * se substituer l'une à l'autre au moment de reprendre, et un fichier disparu
   * du disque ne doit pas rendre le bouton inopérant.
   */
  const stored = progress.data?.mediaFileId ?? null;
  const mediaFileId =
    data.files.find((file) => file.id === stored)?.id ?? data.files[0]?.id ?? null;
  const resumeSeconds = progress.data?.watched === true ? 0 : (progress.data?.positionSeconds ?? 0);

  const facts: Fact[] = [
    { label: 'Durée', value: formatMinutes(data.runtime) },
    { label: 'Date de sortie', value: formatDate(data.releaseDate) },
    { label: 'Genre', value: genreNames.length === 0 ? null : genreNames.join(', ') },
    { label: 'Classification', value: data.certification },
  ];

  return (
    <div className="relative min-h-screen">
      <DetailBackdrop url={data.backdropPath} srcSet={data.backdropSrcSet} />

      <div className="relative z-[1]">
        <header className="w-[600px] max-w-[calc(100%-8rem)] pt-[290px] pl-16">
          {data.originalTitle !== null && data.originalTitle !== data.title && (
            <div className="mb-2 text-[12px] font-semibold tracking-[0.42em] text-[rgba(249,249,249,0.6)] uppercase">
              {data.originalTitle}
            </div>
          )}

          {data.logoPath !== null ? (
            <img
              src={data.logoPath}
              srcSet={data.logoSrcSet ?? undefined}
              sizes="(max-width: 768px) 70vw, 440px"
              alt={data.title}
              className="max-h-[120px] max-w-full object-contain object-left drop-shadow-[0_4px_30px_rgba(0,0,0,0.6)]"
            />
          ) : (
            <h1 className="text-[74px] leading-[0.94] font-bold tracking-[0.04em] uppercase">{data.title}</h1>
          )}

          <MetaLine
            parts={[
              data.year === null ? null : String(data.year),
              genreNames.slice(0, 3).join(', ') || null,
              formatMinutes(data.runtime),
              definition === undefined ? null : resolutionLabel(definition),
              data.certification,
              data.voteAverage === null ? null : `${data.voteAverage.toFixed(1)} / 10`,
            ]}
          />

          {/* Une phrase, pas un pavé : le synopsis entier est dans Détails. */}
          {shortSynopsis(data.overview) !== null && <Synopsis text={shortSynopsis(data.overview) as string} />}

          <div className="mt-[30px] flex items-center gap-4">
            <PlayButtons mediaFileId={mediaFileId} resumeSeconds={resumeSeconds} />
            <div className="flex gap-3">
              <RoundButton label="Ajouter à ma liste">{ICONS.plus}</RoundButton>
              <RoundButton label="Partager">{ICONS.share}</RoundButton>
            </div>
          </div>
        </header>

        {/* Onglets posés sur l'image, comme sur la fiche série. */}
        <div className="mt-[90px]">
          <Tabs tabs={['suggestions', 'details']} active={tab} onChange={setTab} />
        </div>

        {tab === 'suggestions' ? (
          <SuggestionsRow genreName={genreNames[0] ?? null} currentId={data.id} kind="movie" />
        ) : (
          <DetailsPanel
            title={data.title}
            overview={data.overview}
            left={facts}
            credits={data.credits}
            fileSummary={data.fileSummary}
            reviewKey={`movie-${data.id}`}
          />
        )}
      </div>
    </div>
  );
}

/** « 2009-12-15 » → « 15 décembre 2009 ». */
export function formatDate(value: string | null): string | null {
  if (value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}
