/**
 * Lecture et écriture de la progression.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA PROGRESSION EST PORTÉE PAR L'ŒUVRE, PAS PAR LE FICHIER.
 *
 * Un film peut avoir deux fichiers — version longue et version cinéma, ou le
 * même encodage sur les deux partages. `playback_progress` est donc indexée par
 * `media_id` + `media_type`, où `media_id` désigne un `movie.id` ou un
 * `episode.id`. Reprendre l'une des versions reprend l'autre au même endroit.
 *
 * Le `media_file_id` est mémorisé à part, uniquement pour rouvrir le fichier
 * qu'on écoutait — jamais pour identifier la progression.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';
import { buildSrcSet, defaultImagePath } from '../metadata/images.js';
import {
  belongsInContinue,
  episodeLabel,
  isFinished,
  pickShowEntry,
  ratioOf,
  remainingLabel,
  type EpisodeState,
  type MediaType,
} from './rules.js';

export interface SaveInput {
  userId: number;
  mediaFileId: number;
  positionSeconds: number;
  durationSeconds: number | null;
}

export interface SaveResult {
  mediaType: MediaType;
  mediaId: number;
  watched: boolean;
}

/** À quelle œuvre appartient ce fichier ? */
function workOf(db: Db, mediaFileId: number): { mediaType: MediaType; mediaId: number } | null {
  const row = db
    .prepare('SELECT movie_id AS movieId, episode_id AS episodeId FROM media_file WHERE id = ?')
    .get(mediaFileId) as { movieId: number | null; episodeId: number | null } | undefined;

  if (row === undefined) return null;
  if (row.movieId !== null) return { mediaType: 'movie', mediaId: row.movieId };
  if (row.episodeId !== null) return { mediaType: 'episode', mediaId: row.episodeId };
  return null;
}

/**
 * Enregistre une position.
 *
 * C'est le SERVEUR qui décide de l'état « vu », à partir du seuil de 90 % — le
 * lecteur envoie des faits, pas des verdicts. Une œuvre terminée voit sa
 * position remise à zéro : elle sort de la rangée, et la rouvrir repart du
 * début plutôt que du générique de fin.
 */
export function saveProgress(db: Db, input: SaveInput): SaveResult | null {
  const work = workOf(db, input.mediaFileId);
  if (work === null) return null;

  const watched = isFinished(input.positionSeconds, input.durationSeconds);
  const position = watched ? 0 : Math.max(0, input.positionSeconds);

  db.prepare(
    `INSERT INTO playback_progress
       (user_id, media_id, media_type, position_seconds, duration_seconds, media_file_id, updated_at, watched)
     VALUES (@userId, @mediaId, @mediaType, @position, @duration, @mediaFileId, @updatedAt, @watched)
     ON CONFLICT(user_id, media_id, media_type) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       duration_seconds = COALESCE(excluded.duration_seconds, playback_progress.duration_seconds),
       media_file_id    = excluded.media_file_id,
       updated_at       = excluded.updated_at,
       watched          = excluded.watched`,
  ).run({
    userId: input.userId,
    mediaId: work.mediaId,
    mediaType: work.mediaType,
    position,
    duration: input.durationSeconds,
    mediaFileId: input.mediaFileId,
    updatedAt: nowIso(),
    watched: watched ? 1 : 0,
  });

  return { ...work, watched };
}

/** Marque ou démarque une œuvre à la main. */
export function setWatched(
  db: Db,
  userId: number,
  mediaType: MediaType,
  mediaId: number,
  watched: boolean,
): void {
  db.prepare(
    `INSERT INTO playback_progress
       (user_id, media_id, media_type, position_seconds, updated_at, watched)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(user_id, media_id, media_type) DO UPDATE SET
       position_seconds = 0,
       updated_at       = excluded.updated_at,
       watched          = excluded.watched`,
  ).run(userId, mediaId, mediaType, nowIso(), watched ? 1 : 0);
}

/** Retire une œuvre de la rangée sans la marquer vue. */
export function forget(db: Db, userId: number, mediaType: MediaType, mediaId: number): void {
  db.prepare('DELETE FROM playback_progress WHERE user_id = ? AND media_type = ? AND media_id = ?').run(
    userId,
    mediaType,
    mediaId,
  );
}

export interface StoredProgress {
  positionSeconds: number;
  durationSeconds: number | null;
  watched: boolean;
  updatedAt: string;
  mediaFileId: number | null;
}

export function progressOf(
  db: Db,
  userId: number,
  mediaType: MediaType,
  mediaId: number,
): StoredProgress | null {
  const row = db
    .prepare(
      `SELECT position_seconds AS positionSeconds, duration_seconds AS durationSeconds,
              watched, updated_at AS updatedAt, media_file_id AS mediaFileId
       FROM playback_progress WHERE user_id = ? AND media_type = ? AND media_id = ?`,
    )
    .get(userId, mediaType, mediaId) as
    | { positionSeconds: number; durationSeconds: number | null; watched: number; updatedAt: string; mediaFileId: number | null }
    | undefined;

  return row === undefined ? null : { ...row, watched: row.watched === 1 };
}

/** Progression de tous les épisodes d'une série, pour la fiche. */
export function episodeProgressOf(db: Db, userId: number, showId: number): Map<number, StoredProgress> {
  const rows = db
    .prepare(
      `SELECT p.media_id AS episodeId, p.position_seconds AS positionSeconds,
              p.duration_seconds AS durationSeconds, p.watched,
              p.updated_at AS updatedAt, p.media_file_id AS mediaFileId
       FROM playback_progress p
       JOIN episode e ON e.id = p.media_id
       WHERE p.user_id = ? AND p.media_type = 'episode' AND e.show_id = ?`,
    )
    .all(userId, showId) as {
    episodeId: number;
    positionSeconds: number;
    durationSeconds: number | null;
    watched: number;
    updatedAt: string;
    mediaFileId: number | null;
  }[];

  return new Map(rows.map((row) => [row.episodeId, { ...row, watched: row.watched === 1 }]));
}

// ---------------------------------------------------------------------------
// « Continuer à regarder »
// ---------------------------------------------------------------------------

export interface ContinueEntry {
  kind: 'movie' | 'show';
  /** Identifiant de l'œuvre : movie.id ou show.id. */
  workId: number;
  title: string;
  /** « S01:E04 Le goût du risque » pour une série, null pour un film. */
  subtitle: string | null;
  /** Fichier à ouvrir. */
  mediaFileId: number;
  /** Position de reprise, en secondes. Zéro pour un épisode suivant. */
  positionSeconds: number;
  /** Avancement entre 0 et 1, pour la barre de la vignette. */
  ratio: number;
  /** « Il reste 36 min », ou « Épisode suivant ». */
  label: string;
  updatedAt: string;
  backdropPath: string | null;
  backdropSrcSet: string | null;
  logoPath: string | null;
  logoSrcSet: string | null;
  posterPath: string | null;
  posterSrcSet: string | null;
  year: number | null;
  genres: string[];
  /** Type et identifiant à passer aux routes de marquage. */
  mediaType: MediaType;
  mediaId: number;
}

function images(raw: string | null, kind: 'backdrop' | 'logo' | 'poster'): [string | null, string | null] {
  if (raw === null || raw === '') return [null, null];
  return [defaultImagePath(raw, kind), buildSrcSet(raw, kind)];
}

function genresOf(db: Db, table: 'movie' | 'show', id: number): string[] {
  const link = table === 'movie' ? 'movie_genre' : 'show_genre';
  const column = table === 'movie' ? 'movie_id' : 'show_id';
  return (
    db
      .prepare(
        `SELECT g.name FROM genre g JOIN ${link} l ON l.genre_id = g.id
         WHERE l.${column} = ? ORDER BY g.name`,
      )
      .all(id) as { name: string }[]
  ).map((row) => row.name);
}

/**
 * La rangée « Continuer à regarder ».
 *
 * Les films viennent de leur propre progression ; les séries passent par
 * `pickShowEntry`, qui n'en retient qu'un épisode. Le tri final est par date de
 * mise à jour décroissante, films et séries confondus.
 */
export function continueWatching(db: Db, userId: number, now = new Date()): ContinueEntry[] {
  const entries: ContinueEntry[] = [];

  // --- Films ---------------------------------------------------------------
  const movies = db
    .prepare(
      `SELECT p.media_id AS movieId, p.position_seconds AS positionSeconds,
              p.duration_seconds AS durationSeconds, p.updated_at AS updatedAt,
              p.media_file_id AS mediaFileId, p.watched,
              m.title, m.year, m.backdrop_path AS backdropPath,
              m.logo_path AS logoPath, m.poster_path AS posterPath
       FROM playback_progress p
       JOIN movie m ON m.id = p.media_id
       WHERE p.user_id = ? AND p.media_type = 'movie'`,
    )
    .all(userId) as {
    movieId: number;
    positionSeconds: number;
    durationSeconds: number | null;
    updatedAt: string;
    mediaFileId: number | null;
    watched: number;
    title: string;
    year: number | null;
    backdropPath: string | null;
    logoPath: string | null;
    posterPath: string | null;
  }[];

  for (const row of movies) {
    const entry = {
      mediaId: row.movieId,
      mediaType: 'movie' as const,
      positionSeconds: row.positionSeconds,
      durationSeconds: row.durationSeconds,
      updatedAt: row.updatedAt,
      watched: row.watched === 1,
    };
    // Les seuils vivent dans le module de règles, testé à part.
    if (!belongsInContinue({ ...entry, mediaId: row.movieId, mediaType: 'movie' }, now)) continue;

    /*
     * Le fichier mémorisé peut avoir disparu du disque depuis. On retombe sur
     * n'importe quel fichier présent de la même œuvre — la position, elle,
     * appartient à l'œuvre et reste valable.
     */
    const file = playableFile(db, 'movie', row.movieId, row.mediaFileId);
    if (file === null) continue;

    const [backdropPath, backdropSrcSet] = images(row.backdropPath, 'backdrop');
    const [logoPath, logoSrcSet] = images(row.logoPath, 'logo');
    const [posterPath, posterSrcSet] = images(row.posterPath, 'poster');

    entries.push({
      kind: 'movie',
      workId: row.movieId,
      title: row.title,
      subtitle: null,
      mediaFileId: file,
      positionSeconds: row.positionSeconds,
      ratio: ratioOf(row.positionSeconds, row.durationSeconds),
      label: remainingLabel(row.positionSeconds, row.durationSeconds) ?? 'Reprendre',
      updatedAt: row.updatedAt,
      backdropPath,
      backdropSrcSet,
      logoPath,
      logoSrcSet,
      posterPath,
      posterSrcSet,
      year: row.year,
      genres: genresOf(db, 'movie', row.movieId),
      mediaType: 'movie',
      mediaId: row.movieId,
    });
  }

  // --- Séries --------------------------------------------------------------
  const shows = db
    .prepare(
      `SELECT DISTINCT e.show_id AS showId
       FROM playback_progress p JOIN episode e ON e.id = p.media_id
       WHERE p.user_id = ? AND p.media_type = 'episode'`,
    )
    .all(userId) as { showId: number }[];

  for (const { showId } of shows) {
    const states = episodeStatesOf(db, userId, showId);
    const picked = pickShowEntry(states, now);
    if (picked === null || picked.episode.mediaFileId === null) continue;

    const show = db
      .prepare(
        `SELECT title, year, backdrop_path AS backdropPath, logo_path AS logoPath,
                poster_path AS posterPath FROM show WHERE id = ?`,
      )
      .get(showId) as
      | { title: string; year: number | null; backdropPath: string | null; logoPath: string | null; posterPath: string | null }
      | undefined;
    if (show === undefined) continue;

    const episode = db
      .prepare('SELECT title FROM episode WHERE id = ?')
      .get(picked.episode.episodeId) as { title: string | null } | undefined;

    const [backdropPath, backdropSrcSet] = images(show.backdropPath, 'backdrop');
    const [logoPath, logoSrcSet] = images(show.logoPath, 'logo');
    const [posterPath, posterSrcSet] = images(show.posterPath, 'poster');

    entries.push({
      kind: 'show',
      workId: showId,
      title: show.title,
      subtitle: episodeLabel(
        picked.episode.seasonNumber,
        picked.episode.episodeNumber,
        episode?.title ?? null,
      ),
      mediaFileId: picked.episode.mediaFileId,
      // Un épisode suivant repart du début : on n'a rien à y reprendre.
      positionSeconds: picked.kind === 'next' ? 0 : picked.episode.positionSeconds,
      ratio: picked.kind === 'next' ? 0 : ratioOf(picked.episode.positionSeconds, picked.episode.durationSeconds),
      label:
        picked.kind === 'next'
          ? 'Épisode suivant'
          : (remainingLabel(picked.episode.positionSeconds, picked.episode.durationSeconds) ?? 'Reprendre'),
      updatedAt: picked.episode.updatedAt ?? new Date(0).toISOString(),
      backdropPath,
      backdropSrcSet,
      logoPath,
      logoSrcSet,
      posterPath,
      posterSrcSet,
      year: show.year,
      genres: genresOf(db, 'show', showId),
      mediaType: 'episode',
      mediaId: picked.episode.episodeId,
    });
  }

  return entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * Un fichier réellement présent pour cette œuvre.
 *
 * Celui qu'on écoutait en priorité ; sinon n'importe lequel. Une œuvre dont
 * tous les fichiers ont disparu n'apparaît pas dans la rangée : cliquer dessus
 * mènerait à une erreur.
 */
function playableFile(
  db: Db,
  type: MediaType,
  workId: number,
  preferred: number | null,
): number | null {
  if (preferred !== null) {
    const kept = db
      .prepare('SELECT id FROM media_file WHERE id = ? AND present = 1')
      .get(preferred) as { id: number } | undefined;
    if (kept !== undefined) return kept.id;
  }

  const column = type === 'movie' ? 'movie_id' : 'episode_id';
  const row = db
    .prepare(`SELECT MIN(id) AS id FROM media_file WHERE ${column} = ? AND present = 1`)
    .get(workId) as { id: number | null };

  return row.id;
}

/** État de tous les épisodes d'une série, progression comprise. */
export function episodeStatesOf(db: Db, userId: number, showId: number): EpisodeState[] {
  return db
    .prepare(
      `SELECT e.id AS episodeId, e.season_number AS seasonNumber, e.episode_number AS episodeNumber,
              (SELECT MIN(f.id) FROM media_file f WHERE f.episode_id = e.id AND f.present = 1) AS mediaFileId,
              COALESCE(p.position_seconds, 0) AS positionSeconds,
              p.duration_seconds AS durationSeconds,
              p.updated_at AS updatedAt,
              COALESCE(p.watched, 0) AS watched
       FROM episode e
       LEFT JOIN playback_progress p
         ON p.media_id = e.id AND p.media_type = 'episode' AND p.user_id = ?
       WHERE e.show_id = ?
       ORDER BY e.season_number, e.episode_number`,
    )
    .all(userId, showId)
    .map((raw) => {
      // SQLite rend les booléens en entiers : la conversion est ici, une fois.
      const row = raw as Omit<EpisodeState, 'watched'> & { watched: number };
      return { ...row, watched: row.watched === 1 };
    });
}
