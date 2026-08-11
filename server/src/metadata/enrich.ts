/**
 * Enrichissement d'une œuvre : recherche, appariement, écriture.
 *
 * Séparé de la CLI pour que la même fonction serve à la passe complète et,
 * plus tard, au bouton « ré-enrichir cette entrée » de l'écran de review.
 */
import type { Db } from '../db/index.js';
import type { JobOutcome } from '../jobs/runner.js';
import type { ImageDownloader } from './images.js';
import {
  CONFIDENCE_THRESHOLD,
  matchResults,
  rankCandidates,
  scoreCandidate,
  type MatchOutcome,
  type MatchQuery,
} from './match.js';
import {
  getWork,
  hasPresentFiles,
  isManuallyResolved,
  recordMatch,
  saveMovieMetadata,
  saveShowMetadata,
  seasonNumbersOf,
  type TargetType,
} from './store.js';
import {
  fallbackOverview,
  fetchAlternativeTitles,
  fetchEnglishTitle,
  nonEmpty,
  TmdbClient,
  type TmdbMovieDetails,
  type TmdbSearchResponse,
  type TmdbSeasonDetails,
  type TmdbShowDetails,
} from './tmdb.js';

const LANGUAGE = 'fr-FR';

/**
 * TMDB peut regrouper jusqu'à 20 sous-requêtes dans un seul appel via
 * `append_to_response`. On y met les traductions, qui servent au repli en
 * anglais quand le synopsis français est vide.
 */
const MOVIE_APPEND = 'translations';
const SHOW_APPEND = 'translations';

export interface EnrichContext {
  db: Db;
  client: TmdbClient;
  images: ImageDownloader;
}

/**
 * Un résultat de travail, enrichi de la décision prise.
 *
 * Intersection et non `extends` : `JobOutcome` est une union discriminée, et
 * une interface ne peut pas étendre une union.
 */
export type EnrichResult = JobOutcome & {
  decision?: 'applied' | 'needs_review' | 'not_found' | 'ignored';
};

/** Recherche dans TMDB et classe les candidats. */
async function search(
  client: TmdbClient,
  type: TargetType,
  title: string,
  year: number | null,
): Promise<MatchOutcome> {
  const endpoint = type === 'movie' ? '/search/movie' : '/search/tv';
  const params: Record<string, string | number | undefined> = {
    query: title,
    language: LANGUAGE,
    include_adult: 'false',
  };

  // Le paramètre d'année n'est pas le même selon le type, et n'est envoyé que
  // si on la connaît : l'envoyer vide écarterait des résultats valides.
  if (year !== null) {
    if (type === 'movie') params.year = year;
    else params.first_air_date_year = year;
  }

  const response = await client.get<TmdbSearchResponse>(endpoint, params);
  const results = response.results ?? [];

  /*
   * Si la recherche datée ne donne rien, on retente sans l'année : le fichier
   * porte peut-être une année erronée, et un résultat non daté vaut mieux que
   * pas de résultat du tout — il partira simplement en « à vérifier ».
   */
  if (results.length === 0 && year !== null) {
    const retry = await client.get<TmdbSearchResponse>(endpoint, {
      query: title,
      language: LANGUAGE,
      include_adult: 'false',
    });
    return matchResults({ title, year }, retry.results ?? []);
  }

  return matchResults({ title, year }, results);
}

/** Nombre de candidats pour lesquels on va chercher les titres alternatifs. */
const ALTERNATIVE_TITLE_LOOKUPS = 3;

/**
 * Deuxième chance pour les fichiers rangés sous un titre étranger.
 *
 * « Spirited Away » ne ressemble ni à « Le Voyage de Chihiro » (le titre
 * français que TMDB nous renvoie) ni à « 千と千尋の神隠し » (le titre original).
 * Le titre anglais n'existe que dans les titres alternatifs, qui ne figurent
 * pas dans les résultats de recherche : il faut un appel de plus.
 *
 * Cet appel n'est fait que si trois conditions sont réunies :
 * la correspondance n'est pas déjà sûre, on connaît notre année, et l'année du
 * candidat est exactement la nôtre. Sans cette dernière condition on irait à la
 * pêche ; avec elle, on ne fait que confirmer un candidat déjà crédible.
 *
 * Le seuil de confiance n'est pas modifié : c'est la ressemblance des titres
 * qui s'améliore, parce qu'on compare enfin les bons.
 */
async function refineWithAlternativeTitles(
  client: TmdbClient,
  type: TargetType,
  query: MatchQuery,
  outcome: MatchOutcome,
): Promise<MatchOutcome> {
  if (outcome.confident || query.year === null) return outcome;

  const refined = [...outcome.candidates];
  let lookups = 0;

  for (const [index, candidate] of refined.entries()) {
    if (lookups >= ALTERNATIVE_TITLE_LOOKUPS) break;
    if (candidate.year !== query.year) continue;
    if (candidate.exact) continue;

    lookups += 1;
    // Les deux sources sont complémentaires : le titre anglais officiel n'est
    // pas dans les titres alternatifs, et inversement.
    const [alternatives, english] = await Promise.all([
      fetchAlternativeTitles(client, type, candidate.tmdbId),
      fetchEnglishTitle(client, type, candidate.tmdbId),
    ]);
    const titles = english === null ? alternatives : [...alternatives, english];
    if (titles.length === 0) continue;

    const rescored = scoreCandidate(query, candidate, titles);
    // On ne conserve que ce qui améliore : un titre alternatif ne doit jamais
    // dégrader une note déjà établie.
    if (rescored.confidence > candidate.confidence) refined[index] = { ...candidate, ...rescored };
  }

  return lookups === 0 ? outcome : rankCandidates(query, refined);
}

async function enrichMovie(context: EnrichContext, movieId: number, tmdbId: number): Promise<void> {
  const details = await context.client.get<TmdbMovieDetails>(`/movie/${tmdbId}`, {
    language: LANGUAGE,
    append_to_response: MOVIE_APPEND,
  });

  // TMDB renvoie une chaîne VIDE, pas null, quand la traduction manque.
  const overview = nonEmpty(details.overview) ?? fallbackOverview(details.translations);
  const tagline = nonEmpty(details.tagline);

  saveMovieMetadata(context.db, movieId, { details, overview, tagline });

  await context.images.fetchPoster(details.poster_path);
  await context.images.fetchOne(details.backdrop_path, 'backdrop');
}

async function enrichShow(context: EnrichContext, showId: number, tmdbId: number): Promise<void> {
  const seasonNumbers = seasonNumbersOf(context.db, showId);

  /*
   * `append_to_response` accepte jusqu'à 20 sous-requêtes : on y glisse les
   * saisons qu'on possède réellement, ce qui évite un appel par saison. Une
   * série de plus de 19 saisons verra le reste demandé séparément — cas rare,
   * mais il ne doit pas être oublié pour autant.
   */
  const inlineSeasons = seasonNumbers.slice(0, 19);
  const remainingSeasons = seasonNumbers.slice(19);

  const append = [SHOW_APPEND, ...inlineSeasons.map((n) => `season/${n}`)].join(',');
  const details = await context.client.get<TmdbShowDetails & Record<string, unknown>>(`/tv/${tmdbId}`, {
    language: LANGUAGE,
    append_to_response: append,
  });

  const seasons = new Map<number, TmdbSeasonDetails>();
  for (const seasonNumber of inlineSeasons) {
    const embedded = details[`season/${seasonNumber}`] as TmdbSeasonDetails | undefined;
    if (embedded !== undefined) seasons.set(seasonNumber, embedded);
  }
  for (const seasonNumber of remainingSeasons) {
    const season = await context.client.get<TmdbSeasonDetails>(`/tv/${tmdbId}/season/${seasonNumber}`, {
      language: LANGUAGE,
    });
    seasons.set(seasonNumber, season);
  }

  const overview = nonEmpty(details.overview) ?? fallbackOverview(details.translations);
  saveShowMetadata(context.db, showId, { details, overview, seasons });

  await context.images.fetchPoster(details.poster_path);
  await context.images.fetchOne(details.backdrop_path, 'backdrop');
  for (const season of seasons.values()) {
    await context.images.fetchOne(season.poster_path, 'posterSmall');
    for (const episode of season.episodes ?? []) {
      await context.images.fetchOne(episode.still_path, 'still');
    }
  }
}

/** Applique un identifiant TMDB choisi explicitement (écran de review). */
export async function applyTmdbId(
  context: EnrichContext,
  type: TargetType,
  id: number,
  tmdbId: number,
): Promise<void> {
  if (type === 'movie') await enrichMovie(context, id, tmdbId);
  else await enrichShow(context, id, tmdbId);

  const work = getWork(context.db, type, id);
  recordMatch(context.db, {
    type,
    id,
    status: 'applied',
    tmdbId,
    confidence: 1,
    reason: 'choisi à la main',
    candidates: [],
    searchedTitle: work?.title ?? '',
    searchedYear: work?.year ?? null,
    manual: true,
  });
}

/** Marque une œuvre comme volontairement laissée sans métadonnées. */
export function ignoreWork(db: EnrichContext['db'], type: TargetType, id: number): void {
  const work = getWork(db, type, id);
  recordMatch(db, {
    type,
    id,
    status: 'ignored',
    tmdbId: null,
    confidence: null,
    reason: 'ignorée à la demande',
    candidates: [],
    searchedTitle: work?.title ?? '',
    searchedYear: work?.year ?? null,
    manual: true,
  });
}

/**
 * Traite une œuvre : cherche, décide, écrit.
 *
 * Ne devine jamais : sous le seuil de confiance, rien n'est écrit et l'entrée
 * part en `needs_review` avec ses candidats, à trancher dans l'écran de review.
 */
export async function enrichWork(context: EnrichContext, type: TargetType, id: number): Promise<EnrichResult> {
  const work = getWork(context.db, type, id);
  if (work === undefined) return { status: 'skipped', reason: 'œuvre absente de l’index' };

  // Fiche laissée derrière par un re-parsing : plus aucun fichier ne la vise.
  if (!hasPresentFiles(context.db, type, id)) {
    return { status: 'skipped', reason: 'plus aucun fichier sur le disque' };
  }

  // Une décision prise à la main ne doit pas être défaite par une passe automatique.
  if (isManuallyResolved(context.db, type, id)) {
    return { status: 'skipped', reason: 'ignorée à la demande', decision: 'ignored' };
  }

  const query: MatchQuery = { title: work.title, year: work.year };
  const outcome = await refineWithAlternativeTitles(
    context.client,
    type,
    query,
    await search(context.client, type, work.title, work.year),
  );

  if (outcome.best === null) {
    recordMatch(context.db, {
      type,
      id,
      status: 'not_found',
      tmdbId: null,
      confidence: null,
      reason: 'aucun résultat TMDB',
      candidates: [],
      searchedTitle: work.title,
      searchedYear: work.year,
    });
    return { status: 'done', decision: 'not_found' };
  }

  if (!outcome.confident) {
    recordMatch(context.db, {
      type,
      id,
      status: 'needs_review',
      tmdbId: outcome.best.tmdbId,
      confidence: outcome.best.confidence,
      reason: outcome.best.reason,
      candidates: outcome.candidates,
      searchedTitle: work.title,
      searchedYear: work.year,
    });
    return { status: 'done', decision: 'needs_review' };
  }

  if (type === 'movie') await enrichMovie(context, id, outcome.best.tmdbId);
  else await enrichShow(context, id, outcome.best.tmdbId);

  recordMatch(context.db, {
    type,
    id,
    status: 'applied',
    tmdbId: outcome.best.tmdbId,
    confidence: outcome.best.confidence,
    reason: outcome.best.reason,
    candidates: outcome.candidates,
    searchedTitle: work.title,
    searchedYear: work.year,
  });

  return { status: 'done', decision: 'applied' };
}

export { CONFIDENCE_THRESHOLD };
