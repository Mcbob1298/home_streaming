import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { EpisodeProgress, EpisodeSummary } from '../api';
import { formatMinutes } from './DetailChrome';
import {
  MAX_COLUMNS,
  VIRTUALIZE_ABOVE,
  columnsFor,
  computeRange,
  estimateRowHeight,
  measuredRowHeight,
  spacers,
} from './episodeGridLayout';
import { RAISED, TileProgress } from './MediaTile';

/**
 * Épisodes en grille de vignettes 16:9.
 *
 * Écart assumé avec Disney+ : leurs vignettes n'affichent ni numéro ni titre,
 * parce que leurs images suffisent à reconnaître l'épisode. Sur une série qu'on
 * ne connaît pas, non — d'où le numéro, le titre, la durée et deux lignes de
 * synopsis sous chaque vignette.
 *
 * La virtualisation raisonne en RANGÉES de N vignettes et non en lignes : le
 * nombre de colonnes dépend de la largeur, il faut donc la mesurer avant de
 * pouvoir calculer quoi que ce soit. Les calculs eux-mêmes sont dans
 * episodeGridLayout.ts, où ils sont testables sans navigateur.
 */

export function EpisodeGrid({
  episodes,
  progress,
}: {
  episodes: EpisodeSummary[];
  /** Progression par identifiant d'épisode. Vide tant qu'elle n'est pas chargée. */
  progress?: Map<number, EpisodeProgress>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(MAX_COLUMNS);
  const [rowHeight, setRowHeight] = useState(0);
  const [range, setRange] = useState({ start: 0, end: episodes.length });

  const measure = useCallback(() => {
    const node = container.current;
    if (node === null) return;

    const width = node.clientWidth;
    const next = columnsFor(width);
    setColumns(next);
    setRowHeight(estimateRowHeight(width, next));
  }, []);

  useEffect(() => {
    measure();
    const node = container.current;
    if (node === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const virtualize = episodes.length > VIRTUALIZE_ABOVE;

  /*
   * Correction de la hauteur de rangée sur le rendu réel.
   *
   * L'estimation suppose une légende de 92px ; l'interligne effectif dépend du
   * navigateur. Quelques pixels d'écart, multipliés par la douzaine de rangées
   * remplacées par une cale, suffisent à faire sauter le défilement — d'où la
   * mesure. Le seuil d'un demi-pixel évite la boucle : la hauteur mesurée est
   * la même à chaque rendu, donc l'état se stabilise au premier passage.
   */
  useLayoutEffect(() => {
    const node = grid.current;
    if (node === null || !virtualize) return;

    const renderedRows = Math.ceil((range.end - range.start) / columns);
    const measured = measuredRowHeight(node.getBoundingClientRect().height, renderedRows);
    if (measured !== null && Math.abs(measured - rowHeight) > 0.5) setRowHeight(measured);
  });

  useEffect(() => {
    if (!virtualize || rowHeight === 0) {
      setRange({ start: 0, end: episodes.length });
      return;
    }

    function update() {
      const node = container.current;
      if (node === null) return;

      setRange(
        computeRange({
          count: episodes.length,
          columns,
          rowHeight,
          offsetTop: node.getBoundingClientRect().top,
          viewportHeight: window.innerHeight,
        }),
      );
    }

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [virtualize, rowHeight, columns, episodes.length]);

  const visible = episodes.slice(range.start, range.end);

  // Les cales occupent la hauteur des rangées non rendues, pour que la barre de
  // défilement reste juste et que rien ne saute.
  const { before, after } = spacers({ count: episodes.length, columns, range, rowHeight });

  return (
    <div ref={container}>
      {virtualize && <div style={{ height: before }} aria-hidden="true" />}
      <div
        ref={grid}
        className="grid gap-[20px]"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {visible.map((episode) => (
          <EpisodeCard key={episode.id} episode={episode} progress={progress?.get(episode.id)} />
        ))}
      </div>
      {virtualize && <div style={{ height: after }} aria-hidden="true" />}
    </div>
  );
}

function EpisodeCard({
  episode,
  progress,
}: {
  episode: EpisodeSummary;
  progress: EpisodeProgress | undefined;
}) {
  const numbering =
    episode.episodeNumberEnd === null
      ? episode.episodeNumber
      : `${episode.episodeNumber}–${episode.episodeNumberEnd}`;

  const duration = formatMinutes(episode.runtime);

  return (
    <div>
      {/* Même traitement de survol que les vignettes de l'accueil, scale comprise. */}
      <div className="group relative block aspect-video outline-none">
        <div
          className={[
            'absolute inset-0 box-border overflow-hidden rounded border-[3px] border-transparent bg-surface',
            'transition-transform duration-[180ms] ease-[ease] motion-reduce:transition-none',
            'transform-gpu will-change-transform [backface-visibility:hidden]',
            RAISED,
          ].join(' ')}
        >
          {episode.stillPath !== null && (
            <img
              src={episode.stillPath}
              srcSet={episode.stillSrcSet ?? undefined}
              // Deux colonnes : la vignette occupe près de la moitié de la page.
              sizes="(max-width: 768px) 90vw, 45vw"
              alt=""
              loading="lazy"
              decoding="async"
              // Un épisode vu s'efface un peu : on repère d'un coup d'œil où on
              // en est dans une saison de vingt-quatre vignettes.
              className={`h-full w-full object-cover ${progress?.watched === true ? 'opacity-55' : ''}`}
            />
          )}
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.55)_0%,rgba(0,0,0,0)_55%)]"
          />

          <PlayBadge mediaFileId={episode.mediaFileId} title={episode.title} />

          {progress?.watched === true && <WatchedMark />}

          {/* Épisode en cours : la même barre que sur les vignettes de l'accueil. */}
          {progress !== undefined && !progress.watched && progress.ratio > 0 && (
            <TileProgress ratio={progress.ratio} />
          )}

          {/* TEMPORAIRE — repère de mise au point du lecteur. Disparaîtra avec
              l'arrivée du transcodage, quand tout sera lisible. */}
          {episode.playableDirect === 1 && (
            <span
              title="Lisible sans transcodage"
              className="absolute top-3 right-3 rounded-full bg-[rgba(0,168,225,0.92)] px-2 py-[3px] text-[10px] font-bold tracking-[0.1em] text-fond uppercase"
            >
              Lisible
            </span>
          )}
        </div>
      </div>

      {/*
        Toutes les légendes font exactement la même hauteur : deux lignes de
        titre, deux lignes de synopsis réservées même absent, une de durée.
        Sans cela, un épisode sans synopsis produit une carte plus courte, les
        rangées cessent d'être uniformes et la virtualisation fait sauter le
        défilement.
      */}
      <div className="pt-4">
        <h3 className="line-clamp-2 h-[46px] text-[17px] leading-[1.35] font-semibold">
          {numbering}. {episode.title ?? <span className="text-faible">sans titre</span>}
        </h3>
        <p className="mt-2 line-clamp-2 h-[44px] text-[14px] leading-[1.55] text-faible">
          {episode.overview ?? ''}
        </p>
        <p className="mt-2 h-[18px] truncate text-[13px] leading-[1.4] text-faible">
          {duration === null ? '' : `(${duration})`}
          {episode.fileCount > 1 && ` · ${episode.fileCount} fichiers`}
        </p>
      </div>
    </div>
  );
}

/**
 * Marque « vu », en haut à gauche.
 *
 * Elle est titrée et non purement décorative : sur une saison entière, la seule
 * différence d'opacité de l'image ne suffit pas à trancher entre « vu » et
 * « vignette sombre ».
 */
function WatchedMark() {
  return (
    <span
      title="Épisode vu"
      className="absolute top-3 left-3 flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(0,168,225,0.92)] text-fond"
    >
      <span className="sr-only">Épisode vu</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m5 13 4 4 10-10" />
      </svg>
    </span>
  );
}

/**
 * Bouton de lecture, en bas à gauche de la vignette survolée.
 *
 * Il est DANS le conteneur agrandi : il suit la vignette au lieu de flotter
 * au-dessus d'elle.
 */
function PlayBadge({ mediaFileId, title }: { mediaFileId: number; title: string | null }) {
  return (
    <Link
      to={`/watch/${mediaFileId}`}
      aria-label={title === null ? 'Lire cet épisode' : `Lire — ${title}`}
      className={[
        'absolute bottom-4 left-4 flex h-11 w-11 items-center justify-center rounded-full',
        'border border-[rgba(249,249,249,0.55)] bg-[rgba(15,17,23,0.72)] text-texte backdrop-blur-[6px]',
        'opacity-0 transition-opacity duration-[180ms] motion-reduce:transition-none',
        'group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100',
      ].join(' ')}
    >
      <svg width="13" height="15" viewBox="0 0 13 15" fill="currentColor" aria-hidden="true">
        <path d="M0 0l13 7.5L0 15z" />
      </svg>
    </Link>
  );
}
