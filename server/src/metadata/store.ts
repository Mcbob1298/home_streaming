/** Écriture des métadonnées TMDB en base. */
import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';
import type { ScoredCandidate } from './match.js';
import type { TmdbGenre, TmdbMovieDetails, TmdbSeasonDetails, TmdbShowDetails } from './tmdb.js';

export type MatchStatus = 'applied' | 'needs_review' | 'ignored' | 'not_found';
export type TargetType = 'movie' | 'show';

export interface WorkRow {
  id: number;
  title: string;
  year: number | null;
}

/** Œuvres à apparier, avec de quoi calculer leur empreinte. */
export function listMovies(db: Db): WorkRow[] {
  return db
    .prepare(
      `SELECT id, title, year FROM movie
       WHERE EXISTS (SELECT 1 FROM media_file f WHERE f.movie_id = movie.id AND f.present = 1)
       ORDER BY id`,
    )
    .all() as WorkRow[];
}

export function listShows(db: Db): WorkRow[] {
  return db
    .prepare(
      `SELECT id, title, year FROM show
       WHERE EXISTS (SELECT 1 FROM episode e
                     JOIN media_file f ON f.episode_id = e.id AND f.present = 1
                     WHERE e.show_id = show.id)
       ORDER BY id`,
    )
    .all() as WorkRow[];
}

export function getWork(db: Db, type: TargetType, id: number): WorkRow | undefined {
  const table = type === 'movie' ? 'movie' : 'show';
  return db.prepare(`SELECT id, title, year FROM ${table} WHERE id = ?`).get(id) as WorkRow | undefined;
}

/**
 * L'œuvre a-t-elle encore au moins un fichier sur le disque ?
 *
 * Un re-parsing complet peut changer le titre d'un film — « darkino com-…-Star
 * Wars 1 » devient « Star Wars 1 » — et donc créer une nouvelle fiche en
 * laissant l'ancienne sans fichier. Ces fiches mortes ne doivent ni être
 * ré-appariées ni compter dans le rapport.
 */
export function hasPresentFiles(db: Db, type: TargetType, id: number): boolean {
  const sql =
    type === 'movie'
      ? 'SELECT 1 FROM media_file WHERE movie_id = ? AND present = 1 LIMIT 1'
      : `SELECT 1 FROM episode e JOIN media_file f ON f.episode_id = e.id AND f.present = 1
         WHERE e.show_id = ? LIMIT 1`;
  return db.prepare(sql).get(id) !== undefined;
}

/**
 * Empreinte d'une œuvre : si son titre ou son année changent (re-parsing du
 * scanner), l'appariement est refait. Sinon il est conservé.
 */
export function fingerprintOf(row: WorkRow): string {
  return `${row.title}|${row.year ?? ''}`;
}

/** Une correspondance déjà validée à la main ne doit jamais être écrasée. */
export function isManuallyResolved(db: Db, type: TargetType, id: number): boolean {
  const row = db
    .prepare('SELECT status FROM tmdb_match WHERE target_type = ? AND target_id = ?')
    .get(type, id) as { status: MatchStatus } | undefined;
  return row?.status === 'ignored';
}

export interface RecordMatchInput {
  type: TargetType;
  id: number;
  status: MatchStatus;
  tmdbId: number | null;
  confidence: number | null;
  reason: string;
  candidates: ScoredCandidate[];
  searchedTitle: string;
  searchedYear: number | null;
}

export function recordMatch(db: Db, input: RecordMatchInput): void {
  db.prepare(
    `INSERT INTO tmdb_match
       (target_type, target_id, status, tmdb_id, confidence, reason, candidates_json,
        searched_title, searched_year, updated_at)
     VALUES (@target_type, @target_id, @status, @tmdb_id, @confidence, @reason, @candidates_json,
             @searched_title, @searched_year, @updated_at)
     ON CONFLICT(target_type, target_id) DO UPDATE SET
       status          = excluded.status,
       tmdb_id         = excluded.tmdb_id,
       confidence      = excluded.confidence,
       reason          = excluded.reason,
       candidates_json = excluded.candidates_json,
       searched_title  = excluded.searched_title,
       searched_year   = excluded.searched_year,
       updated_at      = excluded.updated_at`,
  ).run({
    target_type: input.type,
    target_id: input.id,
    status: input.status,
    tmdb_id: input.tmdbId,
    confidence: input.confidence,
    reason: input.reason,
    candidates_json: JSON.stringify(input.candidates),
    searched_title: input.searchedTitle,
    searched_year: input.searchedYear,
    updated_at: nowIso(),
  });
}

/** Enregistre les genres et les rattache à l'œuvre. */
function saveGenres(db: Db, type: TargetType, id: number, genres: TmdbGenre[] | undefined): void {
  const table = type === 'movie' ? 'movie_genre' : 'show_genre';
  const column = type === 'movie' ? 'movie_id' : 'show_id';

  const upsertGenre = db.prepare(
    'INSERT INTO genre (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name',
  );
  const clear = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`);
  const link = db.prepare(`INSERT OR IGNORE INTO ${table} (${column}, genre_id) VALUES (?, ?)`);

  clear.run(id);
  for (const genre of genres ?? []) {
    upsertGenre.run(genre.id, genre.name);
    link.run(id, genre.id);
  }
}

export interface MovieMetadata {
  details: TmdbMovieDetails;
  overview: string | null;
  tagline: string | null;
}

export function saveMovieMetadata(db: Db, movieId: number, data: MovieMetadata): void {
  const { details } = data;

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE movie SET
         tmdb_id        = @tmdb_id,
         overview       = @overview,
         tagline        = @tagline,
         poster_path    = @poster_path,
         backdrop_path  = @backdrop_path,
         release_date   = @release_date,
         runtime        = @runtime,
         vote_average   = @vote_average,
         original_title = @original_title,
         updated_at     = @updated_at
       WHERE id = @id`,
    ).run({
      id: movieId,
      tmdb_id: details.id,
      overview: data.overview,
      tagline: data.tagline,
      poster_path: details.poster_path ?? null,
      backdrop_path: details.backdrop_path ?? null,
      release_date: details.release_date ?? null,
      runtime: details.runtime ?? null,
      vote_average: details.vote_average ?? null,
      original_title: details.original_title ?? null,
      updated_at: nowIso(),
    });

    saveGenres(db, 'movie', movieId, details.genres);
  });

  run();
}

export interface ShowMetadata {
  details: TmdbShowDetails;
  overview: string | null;
  /** Saisons détaillées, indexées par numéro de saison. */
  seasons: Map<number, TmdbSeasonDetails>;
}

/**
 * Écrit la série, ses saisons et ses épisodes.
 *
 * Seuls les épisodes DÉJÀ présents en base sont enrichis : la passe ne crée
 * jamais d'épisode que le scanner n'a pas vu sur le disque. La bibliothèque
 * reste le reflet des fichiers, pas du catalogue TMDB.
 */
export function saveShowMetadata(db: Db, showId: number, data: ShowMetadata): void {
  const { details } = data;

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE show SET
         tmdb_id           = @tmdb_id,
         overview          = @overview,
         poster_path       = @poster_path,
         backdrop_path     = @backdrop_path,
         first_air_date    = @first_air_date,
         status            = @status,
         number_of_seasons = @number_of_seasons,
         vote_average      = @vote_average,
         original_title    = @original_title,
         updated_at        = @updated_at
       WHERE id = @id`,
    ).run({
      id: showId,
      tmdb_id: details.id,
      overview: data.overview,
      poster_path: details.poster_path ?? null,
      backdrop_path: details.backdrop_path ?? null,
      first_air_date: details.first_air_date ?? null,
      status: details.status ?? null,
      number_of_seasons: details.number_of_seasons ?? null,
      vote_average: details.vote_average ?? null,
      original_title: details.original_name ?? null,
      updated_at: nowIso(),
    });

    saveGenres(db, 'show', showId, details.genres);

    const updateSeason = db.prepare(
      `UPDATE season SET tmdb_id = ?, overview = ?, poster_path = ?, air_date = ?
       WHERE show_id = ? AND season_number = ?`,
    );
    const updateEpisode = db.prepare(
      `UPDATE episode SET
         tmdb_id      = ?,
         title        = COALESCE(?, title),
         overview     = ?,
         still_path   = ?,
         air_date     = ?,
         vote_average = ?,
         runtime      = ?,
         updated_at   = ?
       WHERE show_id = ? AND season_number = ? AND episode_number = ?`,
    );

    for (const [seasonNumber, season] of data.seasons) {
      updateSeason.run(
        season.id ?? null,
        season.overview === undefined || season.overview.trim() === '' ? null : season.overview,
        season.poster_path ?? null,
        season.air_date ?? null,
        showId,
        seasonNumber,
      );

      for (const episode of season.episodes ?? []) {
        if (episode.episode_number === undefined) continue;
        updateEpisode.run(
          episode.id ?? null,
          // Le titre TMDB complète le nôtre, il ne l'écrase pas : le nom de
          // fichier est parfois plus juste que le catalogue.
          episode.name === undefined || episode.name.trim() === '' ? null : episode.name,
          episode.overview === undefined || episode.overview.trim() === '' ? null : episode.overview,
          episode.still_path ?? null,
          episode.air_date ?? null,
          episode.vote_average ?? null,
          episode.runtime ?? null,
          nowIso(),
          showId,
          seasonNumber,
          episode.episode_number,
        );
      }
    }
  });

  run();
}

/** Numéros de saison réellement présents pour une série. */
export function seasonNumbersOf(db: Db, showId: number): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT e.season_number AS n FROM episode e
         JOIN media_file f ON f.episode_id = e.id AND f.present = 1
         WHERE e.show_id = ? ORDER BY n`,
      )
      .all(showId) as { n: number }[]
  ).map((row) => row.n);
}
