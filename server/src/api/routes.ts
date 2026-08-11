/**
 * Routes de l'API.
 *
 * Toutes les listes ne montrent que les œuvres ayant au moins un fichier
 * `present = 1` : un film dont le fichier a disparu du NAS reste en base (on ne
 * perd pas l'historique) mais ne s'affiche plus.
 *
 * Aucune route ne déclenche de scan : c'est une opération longue, réservée à
 * `npm run scan`.
 */
import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.js';
import { publicImagePath, type ImageKind } from '../metadata/images.js';
import {
  buildOrderBy,
  buildPage,
  buildSearchClause,
  PAGE_SIZE,
  readOrder,
  readPage,
  readSort,
  readString,
} from './pagination.js';

interface LibraryRow {
  id: string;
  label: string;
  type: 'movie' | 'show';
}

/**
 * La base stocke le chemin TMDB brut (« /abc.jpg »). L'API le transforme en URL
 * servie localement — l'image a été rapatriée par `npm run metadata`, on ne
 * renvoie jamais le navigateur vers TMDB.
 */
function imageUrl(tmdbPath: unknown, kind: ImageKind): string | null {
  return typeof tmdbPath === 'string' && tmdbPath !== '' ? publicImagePath(tmdbPath, kind) : null;
}

/** Applique `imageUrl` aux champs d'image d'une ligne de résultat. */
function withImages<T extends Record<string, unknown>>(
  row: T,
  mapping: Partial<Record<'posterPath' | 'backdropPath' | 'stillPath', ImageKind>>,
): T {
  const result = { ...row };
  for (const [field, kind] of Object.entries(mapping)) {
    result[field as keyof T] = imageUrl(row[field], kind as ImageKind) as T[keyof T];
  }
  return result;
}

/** Ne garde que les fichiers encore présents sur le disque. */
const MOVIE_HAS_FILE = 'EXISTS (SELECT 1 FROM media_file f WHERE f.movie_id = movie.id AND f.present = 1)';
const SHOW_HAS_FILE = `EXISTS (
  SELECT 1 FROM episode e
  JOIN media_file f ON f.episode_id = e.id AND f.present = 1
  WHERE e.show_id = show.id
)`;

export function registerRoutes(app: FastifyInstance, db: Db): void {
  // -------------------------------------------------------------------------
  // GET /api/libraries
  // -------------------------------------------------------------------------
  app.get('/api/libraries', () => {
    const libraries = db.prepare('SELECT id, label, type FROM library ORDER BY label').all() as LibraryRow[];

    const countMovies = db.prepare(`SELECT COUNT(*) AS total FROM movie WHERE library_id = ? AND ${MOVIE_HAS_FILE}`);
    const countShows = db.prepare(`SELECT COUNT(*) AS total FROM show WHERE library_id = ? AND ${SHOW_HAS_FILE}`);

    return libraries.map((library) => {
      const statement = library.type === 'movie' ? countMovies : countShows;
      const { total } = statement.get(library.id) as { total: number };
      return { ...library, itemCount: total };
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/movies?search=&library=&sort=&order=&page=
  // -------------------------------------------------------------------------
  app.get('/api/movies', (request) => {
    const query = request.query as Record<string, unknown>;
    const page = readPage(query.page);
    const libraryId = readString(query.library);
    const sort = readSort(query.sort);
    const order = readOrder(query.order, sort);
    const search = buildSearchClause(readString(query.search));

    const where = [MOVIE_HAS_FILE];
    const parameters: unknown[] = [];
    if (libraryId !== null) {
      where.push('library_id = ?');
      parameters.push(libraryId);
    }

    const whereSql = `WHERE ${where.join(' AND ')} ${search.sql}`;
    const allParameters = [...parameters, ...search.parameters];

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM movie ${whereSql}`).get(...allParameters) as {
      total: number;
    };

    const items = (
      db
        .prepare(
          `SELECT id, library_id AS libraryId, title, year, poster_path AS posterPath, added_at AS addedAt,
                  vote_average AS voteAverage, runtime,
                  (SELECT COUNT(*) FROM media_file f WHERE f.movie_id = movie.id AND f.present = 1) AS fileCount
           FROM movie ${whereSql}
           ORDER BY ${buildOrderBy(sort, order)}
           LIMIT ? OFFSET ?`,
        )
        .all(...allParameters, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Record<string, unknown>[]
    ).map((row) => withImages(row, { posterPath: 'posterSmall' }));

    return buildPage(items, page, total);
  });

  // -------------------------------------------------------------------------
  // GET /api/movies/:id
  // -------------------------------------------------------------------------
  app.get('/api/movies/:id', (request, reply) => {
    const { id } = request.params as { id: string };

    const movie = db
      .prepare(
        `SELECT id, library_id AS libraryId, title, year, overview, tagline, poster_path AS posterPath,
                backdrop_path AS backdropPath, added_at AS addedAt, tmdb_id AS tmdbId,
                release_date AS releaseDate, runtime, vote_average AS voteAverage,
                original_title AS originalTitle
         FROM movie WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (movie === undefined) return reply.code(404).send({ error: 'Film introuvable' });

    const genres = db
      .prepare(
        `SELECT g.id, g.name FROM genre g
         JOIN movie_genre mg ON mg.genre_id = g.id WHERE mg.movie_id = ? ORDER BY g.name`,
      )
      .all(id);

    const files = db
      .prepare(
        `SELECT f.id, f.path, f.file_name AS fileName, f.extension, f.size_bytes AS sizeBytes,
                f.resolution, f.duration_seconds AS durationSeconds, r.path AS rootPath
         FROM media_file f
         JOIN library_root r ON r.id = f.library_root_id
         WHERE f.movie_id = ? AND f.present = 1
         ORDER BY f.path`,
      )
      .all(id) as { id: number }[];

    const subtitles = db.prepare(
      `SELECT id, media_file_id AS mediaFileId, file_name AS fileName, format, language,
              forced, hearing_impaired AS hearingImpaired
       FROM subtitle WHERE media_file_id = ? AND present = 1 ORDER BY language, file_name`,
    );

    return {
      ...withImages(movie, { posterPath: 'posterLarge', backdropPath: 'backdrop' }),
      genres,
      files: files.map((file) => ({ ...file, subtitles: subtitles.all(file.id) })),
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/shows?search=&library=&sort=&order=&page=
  // -------------------------------------------------------------------------
  app.get('/api/shows', (request) => {
    const query = request.query as Record<string, unknown>;
    const page = readPage(query.page);
    const libraryId = readString(query.library);
    const sort = readSort(query.sort);
    const order = readOrder(query.order, sort);
    const search = buildSearchClause(readString(query.search));

    const where = [SHOW_HAS_FILE];
    const parameters: unknown[] = [];
    if (libraryId !== null) {
      where.push('library_id = ?');
      parameters.push(libraryId);
    }

    const whereSql = `WHERE ${where.join(' AND ')} ${search.sql}`;
    const allParameters = [...parameters, ...search.parameters];

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM show ${whereSql}`).get(...allParameters) as {
      total: number;
    };

    const items = (
      db
        .prepare(
          `SELECT id, library_id AS libraryId, title, year, poster_path AS posterPath, added_at AS addedAt,
                  vote_average AS voteAverage, status,
                  (SELECT COUNT(DISTINCT e.season_number) FROM episode e
                     JOIN media_file f ON f.episode_id = e.id AND f.present = 1
                    WHERE e.show_id = show.id) AS seasonCount,
                  (SELECT COUNT(DISTINCT e.id) FROM episode e
                     JOIN media_file f ON f.episode_id = e.id AND f.present = 1
                    WHERE e.show_id = show.id) AS episodeCount
           FROM show ${whereSql}
           ORDER BY ${buildOrderBy(sort, order)}
           LIMIT ? OFFSET ?`,
        )
        .all(...allParameters, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Record<string, unknown>[]
    ).map((row) => withImages(row, { posterPath: 'posterSmall' }));

    return buildPage(items, page, total);
  });

  // -------------------------------------------------------------------------
  // GET /api/shows/:id — la série, ses saisons et leurs épisodes
  // -------------------------------------------------------------------------
  app.get('/api/shows/:id', (request, reply) => {
    const { id } = request.params as { id: string };

    const show = db
      .prepare(
        `SELECT id, library_id AS libraryId, title, year, overview, poster_path AS posterPath,
                backdrop_path AS backdropPath, added_at AS addedAt, tmdb_id AS tmdbId,
                first_air_date AS firstAirDate, status, number_of_seasons AS numberOfSeasons,
                vote_average AS voteAverage, original_title AS originalTitle
         FROM show WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (show === undefined) return reply.code(404).send({ error: 'Série introuvable' });

    const genres = db
      .prepare(
        `SELECT g.id, g.name FROM genre g
         JOIN show_genre sg ON sg.genre_id = g.id WHERE sg.show_id = ? ORDER BY g.name`,
      )
      .all(id);

    const episodes = (
      db
        .prepare(
          `SELECT e.id, e.season_number AS seasonNumber, e.episode_number AS episodeNumber,
                  e.episode_number_end AS episodeNumberEnd, e.title, e.overview,
                  e.still_path AS stillPath, e.air_date AS airDate, e.runtime,
                  COUNT(f.id) AS fileCount
           FROM episode e
           JOIN media_file f ON f.episode_id = e.id AND f.present = 1
           WHERE e.show_id = ?
           GROUP BY e.id
           ORDER BY e.season_number, e.episode_number`,
        )
        .all(id) as Record<string, unknown>[]
    ).map((row) => withImages(row, { stillPath: 'still' })) as unknown as { seasonNumber: number }[];

    const seasonRows = db
      .prepare(
        `SELECT season_number AS seasonNumber, title, overview, poster_path AS posterPath, air_date AS airDate
         FROM season WHERE show_id = ?`,
      )
      .all(id) as { seasonNumber: number; title: string | null; overview: string | null; posterPath: string | null; airDate: string | null }[];
    const seasonByNumber = new Map(seasonRows.map((row) => [row.seasonNumber, row]));

    // Regroupement en saisons côté serveur : le front reçoit l'arbre déjà prêt.
    const seasons: {
      seasonNumber: number;
      title: string | null;
      overview: string | null;
      posterPath: string | null;
      airDate: string | null;
      episodes: unknown[];
    }[] = [];

    for (const episode of episodes) {
      let season = seasons.at(-1);
      if (season === undefined || season.seasonNumber !== episode.seasonNumber) {
        const info = seasonByNumber.get(episode.seasonNumber);
        season = {
          seasonNumber: episode.seasonNumber,
          title: info?.title ?? null,
          overview: info?.overview ?? null,
          posterPath: imageUrl(info?.posterPath, 'posterSmall'),
          airDate: info?.airDate ?? null,
          episodes: [],
        };
        seasons.push(season);
      }
      season.episodes.push(episode);
    }

    return { ...withImages(show, { posterPath: 'posterLarge', backdropPath: 'backdrop' }), genres, seasons };
  });
}
