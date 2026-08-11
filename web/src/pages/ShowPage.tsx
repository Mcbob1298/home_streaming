import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../api';
import {
  DetailBackdrop,
  ICONS,
  MetaLine,
  PlayButton,
  RoundButton,
  Synopsis,
  Tabs,
  formatMinutes,
  type TabKey,
} from '../components/DetailChrome';
import { DetailsPanel, type Fact } from '../components/DetailsPanel';
import { EpisodeGrid } from '../components/EpisodeGrid';
import { ErrorMessage, Loading } from '../components/States';
import { SuggestionsRow } from '../components/SuggestionsRow';
import { shortSynopsis } from '../synopsis';
import { formatDate } from './MoviePage';

export function ShowPage() {
  const { id = '' } = useParams();
  const [season, setSeason] = useState<number | null>(null);
  // Sur une série, c'est la liste des épisodes qu'on vient voir.
  const [tab, setTab] = useState<TabKey>('episodes');

  const show = useQuery({ queryKey: ['show', id], queryFn: () => api.show(id) });

  // Saison retenue par défaut : la première non vide, hors bonus.
  useEffect(() => {
    if (season !== null || show.data === undefined) return;
    const seasons = show.data.seasons;
    const first = seasons.find((entry) => entry.seasonNumber > 0) ?? seasons[0];
    if (first !== undefined) setSeason(first.seasonNumber);
  }, [show.data, season]);

  if (show.isPending) return <Loading />;
  if (show.error !== null) return <ErrorMessage error={show.error} />;

  const data = show.data;
  const current = data.seasons.find((entry) => entry.seasonNumber === season) ?? data.seasons[0];
  const totalEpisodes = data.seasons.reduce((sum, entry) => sum + entry.episodes.length, 0);
  const genreNames = data.genres.map((genre) => genre.name);

  // Premier épisode hors bonus, sinon le tout premier : c'est par là qu'on
  // commence une série qu'on n'a pas encore vue.
  const firstSeason = data.seasons.find((entry) => entry.seasonNumber > 0) ?? data.seasons[0];
  const firstEpisode = firstSeason?.episodes[0];

  const yearRange =
    data.year === null
      ? null
      : data.status === 'Ended' || data.status === 'Canceled'
        ? String(data.year)
        : `${data.year} – aujourd’hui`;

  /*
   * Une série n'a pas de durée : c'est la durée moyenne d'un épisode qui
   * renseigne, et elle se déduit des épisodes déjà sondés.
   */
  const runtimes = data.seasons.flatMap((entry) =>
    entry.episodes.map((episode) => episode.runtime).filter((runtime): runtime is number => runtime !== null),
  );
  const averageRuntime =
    runtimes.length === 0 ? null : Math.round(runtimes.reduce((sum, value) => sum + value, 0) / runtimes.length);

  const facts: Fact[] = [
    {
      label: 'Durée',
      value: averageRuntime === null ? null : `${formatMinutes(averageRuntime)} par épisode`,
    },
    { label: 'Date de sortie', value: formatDate(data.firstAirDate) },
    { label: 'Genre', value: genreNames.length === 0 ? null : genreNames.join(', ') },
    { label: 'Classification', value: data.certification },
  ];

  return (
    <div className="relative min-h-screen">
      <DetailBackdrop url={data.backdropPath} srcSet={data.backdropSrcSet} />

      <div className="relative z-[1]">
        <header className="w-[620px] max-w-[calc(100%-8rem)] pt-[250px] pl-16">
          {data.logoPath !== null ? (
            <img
              src={data.logoPath}
              srcSet={data.logoSrcSet ?? undefined}
              sizes="(max-width: 768px) 70vw, 440px"
              alt={data.title}
              className="max-h-[110px] max-w-full object-contain object-left drop-shadow-[0_4px_30px_rgba(0,0,0,0.6)]"
            />
          ) : (
            <h1 className="text-[70px] leading-[0.94] font-bold tracking-[0.04em] uppercase">{data.title}</h1>
          )}

          <MetaLine
            parts={[
              yearRange,
              `${data.seasons.length} ${data.seasons.length > 1 ? 'saisons' : 'saison'}`,
              genreNames.slice(0, 3).join(', ') || null,
              data.certification,
              data.voteAverage === null ? null : `${data.voteAverage.toFixed(1)} / 10`,
            ]}
          />

          {shortSynopsis(data.overview) !== null && <Synopsis text={shortSynopsis(data.overview) as string} />}

          <div className="mt-[30px] flex items-center gap-4">
            {/* Sur une série, « Lire » ouvre le premier épisode disponible. */}
            <PlayButton mediaFileId={firstEpisode?.mediaFileId ?? null} label="Lire" />
            <div className="flex gap-3">
              <RoundButton label="Ajouter à ma liste">{ICONS.plus}</RoundButton>
              <RoundButton label="Partager">{ICONS.share}</RoundButton>
            </div>
          </div>
        </header>

        {/* Les onglets sont posés sur l'image, dans son tiers inférieur. */}
        <div className="mt-[90px]">
          <Tabs tabs={['episodes', 'suggestions', 'details']} active={tab} onChange={setTab} />
        </div>

        {tab === 'episodes' && (
          <section className="px-16 pt-6 pb-24">
            <div className="mb-6 flex flex-wrap items-center gap-4">
              <SeasonSelect
                seasons={data.seasons.map((entry) => entry.seasonNumber)}
                value={season}
                onChange={setSeason}
              />
              <span className="text-[13px] text-faible">
                {current === undefined ? totalEpisodes : current.episodes.length}{' '}
                {(current?.episodes.length ?? totalEpisodes) > 1 ? 'épisodes' : 'épisode'}
              </span>
            </div>

            {current === undefined ? (
              <p className="text-[14px] text-faible">Aucun épisode présent sur le disque.</p>
            ) : (
              /*
                Largeur plafonnée : sur un écran de 2560px, deux colonnes pleine
                largeur donneraient des vignettes de 1 200px dont une seule
                rangée tiendrait à l'écran. À 1 400px, elles restent nettement
                plus grandes qu'avant sans qu'on ne voie plus qu'un épisode.
              */
              <div className="max-w-[1400px]">
                <EpisodeGrid episodes={current.episodes} />
              </div>
            )}
          </section>
        )}

        {tab === 'suggestions' && (
          <SuggestionsRow genreName={data.genres[0]?.name ?? null} currentId={data.id} kind="show" />
        )}

        {tab === 'details' && (
          <DetailsPanel
            title={data.title}
            overview={data.overview}
            left={facts}
            credits={data.credits}
            // Une série n'a pas de fichier : la synthèse agrège ses épisodes.
            fileSummary={data.fileSummary}
            reviewKey={`show-${data.id}`}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Liste déroulante des saisons — une liste, pas des onglets : onze saisons en
 * onglets déborderaient de la ligne.
 */
function SeasonSelect({
  seasons,
  value,
  onChange,
}: {
  seasons: number[];
  value: number | null;
  onChange: (season: number) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value ?? ''}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="Choisir une saison"
        className="h-10 appearance-none rounded border border-[rgba(249,249,249,0.16)] bg-surface-haute pr-11 pl-4 text-[14px] font-semibold text-texte outline-none focus-visible:border-[rgba(249,249,249,0.5)]"
      >
        {seasons.map((number) => (
          <option key={number} value={number}>
            {number === 0 ? 'Bonus' : `Saison ${number}`}
          </option>
        ))}
      </select>
      <svg
        width="12"
        height="8"
        viewBox="0 0 12 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-faible"
      >
        <path d="m1 1 5 5 5-5" />
      </svg>
    </div>
  );
}
