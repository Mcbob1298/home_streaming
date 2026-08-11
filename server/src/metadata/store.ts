/** Écriture des métadonnées TMDB en base. */
import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';
import type { SelectedCredit } from './credits.js';
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

/**
 * Une décision humaine a-t-elle déjà été prise sur cette œuvre ?
 *
 * Deux formes : un appariement choisi à la main, ou une entrée volontairement
 * ignorée. Dans les deux cas les passes automatiques passent leur chemin, quelle
 * que soit la confiance qu'elles obtiendraient — sinon un `--full` effacerait
 * silencieusement le travail de tri fait dans l'écran de review.
 */
export function isManuallyResolved(db: Db, type: TargetType, id: number): boolean {
  const decision = manualDecision(db, type, id);
  return decision !== null;
}

export interface ManualDecision {
  status: MatchStatus;
  tmdbId: number | null;
}

/**
 * La décision humaine prise sur cette œuvre, s'il y en a une.
 *
 * Distinction essentielle, apprise à nos dépens : une décision manuelle fige
 * QUEL identifiant TMDB utiliser, pas le fait de rafraîchir ses métadonnées.
 * Une protection trop large avait privé les 62 œuvres triées à la main de leur
 * logo de titre, la passe suivante les ayant purement et simplement sautées.
 *
 * Seul « ignored » justifie de ne rien faire du tout.
 */
export function manualDecision(db: Db, type: TargetType, id: number): ManualDecision | null {
  const row = db
    .prepare(
      'SELECT status, tmdb_id, manually_matched FROM tmdb_match WHERE target_type = ? AND target_id = ?',
    )
    .get(type, id) as { status: MatchStatus; tmdb_id: number | null; manually_matched: number } | undefined;

  if (row === undefined) return null;
  if (row.status !== 'ignored' && row.manually_matched !== 1) return null;
  return { status: row.status, tmdbId: row.tmdb_id };
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
  /** Décision prise dans l'écran de review : à protéger des passes automatiques. */
  manual?: boolean;
}

export function recordMatch(db: Db, input: RecordMatchInput): void {
  const manual = input.manual === true;
  db.prepare(
    `INSERT INTO tmdb_match
       (target_type, target_id, status, tmdb_id, confidence, reason, candidates_json,
        searched_title, searched_year, updated_at, manually_matched, decided_at)
     VALUES (@target_type, @target_id, @status, @tmdb_id, @confidence, @reason, @candidates_json,
             @searched_title, @searched_year, @updated_at, @manually_matched, @decided_at)
     ON CONFLICT(target_type, target_id) DO UPDATE SET
       status           = excluded.status,
       tmdb_id          = excluded.tmdb_id,
       confidence       = excluded.confidence,
       reason           = excluded.reason,
       candidates_json  = excluded.candidates_json,
       searched_title   = excluded.searched_title,
       searched_year    = excluded.searched_year,
       updated_at       = excluded.updated_at,
       manually_matched = excluded.manually_matched,
       decided_at       = excluded.decided_at`,
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
    manually_matched: manual ? 1 : 0,
    decided_at: manual ? nowIso() : null,
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

/**
 * Réécrit les crédits d'une œuvre.
 *
 * Remplacement complet plutôt que fusion : si TMDB corrige une distribution, la
 * fiche doit refléter la correction, pas cumuler l'ancienne et la nouvelle.
 *
 * Les personnes, elles, sont conservées et mises à jour — la même actrice
 * revient sur vingt films, et son nom n'a pas à être réécrit vingt fois avec
 * une valeur différente selon la dernière œuvre traitée.
 */
export function saveCredits(db: Db, type: TargetType, workId: number, credits: SelectedCredit[]): void {
  const upsertPerson = db.prepare(
    `INSERT INTO person (tmdb_id, name, profile_path) VALUES (?, ?, ?)
     ON CONFLICT(tmdb_id) DO UPDATE SET
       name = excluded.name,
       -- Un profil connu ne doit pas être effacé par une source qui l'ignore.
       profile_path = COALESCE(excluded.profile_path, person.profile_path)`,
  );
  const clear = db.prepare('DELETE FROM credit WHERE work_type = ? AND work_id = ?');
  const insert = db.prepare(
    `INSERT INTO credit (work_id, work_type, person_id, role, character, department, credit_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_type, work_id, person_id, role) DO NOTHING`,
  );

  const run = db.transaction(() => {
    clear.run(type, workId);
    for (const credit of credits) {
      upsertPerson.run(credit.personId, credit.name, credit.profilePath);
      insert.run(
        workId,
        type,
        credit.personId,
        credit.role,
        credit.character,
        credit.department,
        credit.order,
      );
    }
  });

  run();
}

export interface MovieMetadata {
  details: TmdbMovieDetails;
  overview: string | null;
  tagline: string | null;
  /** Logo du titre, ou null si TMDB n'en propose aucun. */
  logoPath: string | null;
  /** Classification par âge, ou null si aucun pays retenu n'en publie. */
  certification: string | null;
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
         logo_path      = @logo_path,
         release_date   = @release_date,
         runtime        = @runtime,
         vote_average   = @vote_average,
         original_title = @original_title,
         certification  = @certification,
         updated_at     = @updated_at
       WHERE id = @id`,
    ).run({
      id: movieId,
      tmdb_id: details.id,
      overview: data.overview,
      tagline: data.tagline,
      certification: data.certification,
      poster_path: details.poster_path ?? null,
      backdrop_path: details.backdrop_path ?? null,
      logo_path: data.logoPath,
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
  /** Logo du titre, ou null si TMDB n'en propose aucun. */
  logoPath: string | null;
  /** Classification par âge, ou null si aucun pays retenu n'en publie. */
  certification: string | null;
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
         logo_path         = @logo_path,
         first_air_date    = @first_air_date,
         status            = @status,
         number_of_seasons = @number_of_seasons,
         vote_average      = @vote_average,
         original_title    = @original_title,
         certification     = @certification,
         updated_at        = @updated_at
       WHERE id = @id`,
    ).run({
      id: showId,
      tmdb_id: details.id,
      overview: data.overview,
      certification: data.certification,
      poster_path: details.poster_path ?? null,
      backdrop_path: details.backdrop_path ?? null,
      logo_path: data.logoPath,
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
