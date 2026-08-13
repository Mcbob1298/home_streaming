import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api, type MovieSummary, type ShowSummary } from '../api';
import { useLibraryRefresh, usePreparationStatus, useStableOrder } from '../preparation';
import { ContinueRow } from '../components/ContinueRow';
import { Hero, type HeroItem } from '../components/Hero';
import { MediaRow } from '../components/MediaRow';
import { ErrorMessage, Loading } from '../components/States';
import { MovieTile, ShowTile } from '../components/WorkTile';

/** Nombre de titres mis en avant dans le hero. */
const HERO_COUNT = 5;
/** Rangées de genre affichées, les plus représentés d'abord. */
const GENRE_ROWS = 4;

/** Une œuvre est « nouvelle » si elle a été ajoutée dans les deux dernières semaines. */
const NEW_WINDOW_MS = 14 * 24 * 3600 * 1000;

function isRecent(addedAt: string): boolean {
  return Date.now() - new Date(addedAt).getTime() < NEW_WINDOW_MS;
}

/**
 * Choisit les titres du hero.
 *
 * Il faut un backdrop ET un logo : sans backdrop l'image est vide, sans logo le
 * repli typographique en 62px passe mal sur une image plein cadre. Le tirage
 * est aléatoire à chaque chargement, comme demandé.
 */
function pickHero(movies: MovieSummary[], shows: ShowSummary[]): HeroItem[] {
  const candidates: HeroItem[] = [
    ...movies
      .filter((movie) => movie.backdropPath !== null && movie.logoPath !== null)
      .map((movie) => ({
        id: movie.id,
        kind: 'movie' as const,
        title: movie.title,
        logoUrl: movie.logoPath,
        logoSrcSet: movie.logoSrcSet,
        backdropUrl: movie.backdropPath,
        backdropSrcSet: movie.backdropSrcSet,
        year: movie.year,
        genres: movie.genres,
        runtimeMinutes: movie.runtime,
        overview: movie.overview,
        isNew: isRecent(movie.addedAt),
      })),
    ...shows
      .filter((show) => show.backdropPath !== null && show.logoPath !== null)
      .map((show) => ({
        id: show.id,
        kind: 'show' as const,
        title: show.title,
        logoUrl: show.logoPath,
        logoSrcSet: show.logoSrcSet,
        backdropUrl: show.backdropPath,
        backdropSrcSet: show.backdropSrcSet,
        year: show.year,
        genres: show.genres,
        runtimeMinutes: null,
        overview: show.overview,
        isNew: isRecent(show.addedAt),
      })),
  ];

  // Tirage sans remise, sur une copie : l'ordre d'origine sert ailleurs.
  const pool = [...candidates];
  const picked: HeroItem[] = [];
  while (picked.length < HERO_COUNT && pool.length > 0) {
    const [taken] = pool.splice(Math.floor(Math.random() * pool.length), 1);
    if (taken !== undefined) picked.push(taken);
  }
  return picked;
}

/**
 * Une rangée de genre, dans un composant à elle.
 *
 * `useStableOrder` est un hook : il ne peut pas être appelé dans le `.map` des
 * genres. Sans ce composant, les quatre rangées du bas restaient les seules à
 * sauter pendant une passe — le défaut y était même plus visible qu'ailleurs,
 * elles sont triées par date d'ajout.
 */
function RangeeGenre({ titre, items, freeze }: { titre: string; items: MovieSummary[]; freeze: boolean }) {
  const stables = useStableOrder(items, freeze);
  if (stables.length === 0) return null;

  return (
    <MediaRow title={titre}>
      {stables.map((movie) => (
        <MovieTile key={movie.id} movie={movie} />
      ))}
    </MediaRow>
  );
}

export function HomePage() {
  const recent = useQuery({ queryKey: ['movies', 'added'], queryFn: () => api.movies({ sort: 'added' }) });
  const films = useQuery({ queryKey: ['movies', 'title'], queryFn: () => api.movies({ sort: 'title' }) });
  const series = useQuery({ queryKey: ['shows', 'title'], queryFn: () => api.shows({ sort: 'title' }) });
  const genres = useQuery({ queryKey: ['genres'], queryFn: api.genres });

  /*
   * Pendant une passe, la bibliothèque se remplit sous les yeux. Deux règles :
   * on rafraîchit les listes quand le compteur bouge, et on FIGE l'ordre pour
   * que les arrivants se posent en fin de rangée. « Ajouts récents » est trié
   * par date décroissante : sans ce gel, un titre prêt s'insérerait en tête et
   * pousserait toute la rangée sous le curseur.
   */
  const preparation = usePreparationStatus();
  useLibraryRefresh(preparation);
  const enCours = preparation?.running === true || preparation?.paused === true;

  const topGenres = (genres.data ?? []).filter((genre) => genre.movieCount >= 12).slice(0, GENRE_ROWS);

  const genreRows = useQueries({
    queries: topGenres.map((genre) => ({
      queryKey: ['movies', 'genre', genre.id],
      queryFn: () => api.movies({ genre: genre.id, sort: 'added' }),
    })),
  });

  /*
   * Le tirage se fait UNE fois, au premier chargement des données.
   *
   * Avec un useMemo dépendant des données, tout rafraîchissement en arrière-plan
   * de React Query renvoyait un nouvel objet, relançait le tirage et changeait
   * les titres du hero sous les yeux de l'utilisateur — alors que la consigne
   * est « à chaque chargement de page », pas « en cours de consultation ».
   */
  const [heroItems, setHeroItems] = useState<HeroItem[]>([]);
  useEffect(() => {
    if (heroItems.length > 0) return;
    if (recent.data === undefined || series.data === undefined) return;
    setHeroItems(pickHero(recent.data.items, series.data.items));
  }, [recent.data, series.data, heroItems.length]);

  /*
   * Calculés AVANT les retours anticipés : ce sont des hooks, ils ne peuvent pas
   * vivre après un `return`. Les listes sont vides tant que les données ne sont
   * pas là, ce qui ne mémorise aucun ordre — le gel ne commence qu'au premier
   * rendu réel.
   */
  const recents = useStableOrder(recent.data?.items ?? [], enCours);
  const tousFilms = useStableOrder(films.data?.items ?? [], enCours);
  const toutesSeries = useStableOrder(series.data?.items ?? [], enCours);

  const firstError = recent.error ?? films.error ?? series.error;
  if (firstError !== null) return <ErrorMessage error={firstError} />;
  // Les trois listes conditionnent la page : on attend qu'elles soient toutes là.
  if (recent.data === undefined || films.data === undefined || series.data === undefined) {
    return <Loading />;
  }

  const movieTile = (movie: MovieSummary) => <MovieTile key={movie.id} movie={movie} />;
  const showTile = (show: ShowSummary) => <ShowTile key={show.id} show={show} />;

  return (
    <div className="pb-24">
      <div className="pt-[84px]">
        <Hero items={heroItems} />
      </div>

      {/*
        L'espace entre le hero et la première rangée : 56px. Les points
        indicateurs occupent déjà 20px sous le carrousel, un écart plus serré
        collerait la rangée aux points ; plus large, la page paraîtrait vide.
      */}
      <div className="mt-14 flex flex-col gap-[26px]">
        {/* En tête : reprendre ce qu'on a commencé passe avant tout le reste.
            La rangée se retire d'elle-même quand il n'y a rien à reprendre. */}
        <ContinueRow />

        <MediaRow title="Ajouts récents">{recents.map(movieTile)}</MediaRow>
        <MediaRow title="Films" to="/library/films">
          {tousFilms.map(movieTile)}
        </MediaRow>
        <MediaRow title="Séries" to="/library/series">
          {toutesSeries.map(showTile)}
        </MediaRow>

        {topGenres.map((genre, position) => (
          <RangeeGenre
            key={genre.id}
            titre={genre.name}
            items={genreRows[position]?.data?.items ?? []}
            freeze={enCours}
          />
        ))}
      </div>
    </div>
  );
}
