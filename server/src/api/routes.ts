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

    const items = db
      .prepare(
        `SELECT id, library_id AS libraryId, title, year, poster_path AS posterPath, added_at AS addedAt,
                (SELECT COUNT(*) FROM media_file f WHERE f.movie_id = movie.id AND f.present = 1) AS fileCount
         FROM movie ${whereSql}
         ORDER BY ${buildOrderBy(sort, order)}
         LIMIT ? OFFSET ?`,
      )
      .all(...allParameters, PAGE_SIZE, (page - 1) * PAGE_SIZE);

    return buildPage(items, page, total);
  });

  // -------------------------------------------------------------------------
  // GET /api/movies/:id
  // -------------------------------------------------------------------------
  app.get('/api/movies/:id', (request, reply) => {
    const { id } = request.params as { id: string };

    const movie = db
      .prepare(
        `SELECT id, library_id AS libraryId, title, year, overview, poster_path AS posterPath,
                backdrop_path AS backdropPath, added_at AS addedAt
         FROM movie WHERE id = ?`,
      )
      .get(id);

    if (movie === undefined) return reply.code(404).send({ error: 'Film introuvable' });

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
      ...movie,
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

    const items = db
      .prepare(
        `SELECT id, library_id AS libraryId, title, year, poster_path AS posterPath, added_at AS addedAt,
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
      .all(...allParameters, PAGE_SIZE, (page - 1) * PAGE_SIZE);

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
                backdrop_path AS backdropPath, added_at AS addedAt
         FROM show WHERE id = ?`,
      )
      .get(id);

    if (show === undefined) return reply.code(404).send({ error: 'Série introuvable' });

    const episodes = db
      .prepare(
        `SELECT e.id, e.season_number AS seasonNumber, e.episode_number AS episodeNumber,
                e.episode_number_end AS episodeNumberEnd, e.title, e.overview,
                COUNT(f.id) AS fileCount
         FROM episode e
         JOIN media_file f ON f.episode_id = e.id AND f.present = 1
         WHERE e.show_id = ?
         GROUP BY e.id
         ORDER BY e.season_number, e.episode_number`,
      )
      .all(id) as { seasonNumber: number }[];

    const seasonTitles = db
      .prepare('SELECT season_number AS seasonNumber, title FROM season WHERE show_id = ?')
      .all(id) as { seasonNumber: number; title: string | null }[];
    const titleByNumber = new Map(seasonTitles.map((row) => [row.seasonNumber, row.title]));

    // Regroupement en saisons côté serveur : le front reçoit l'arbre déjà prêt.
    const seasons: { seasonNumber: number; title: string | null; episodes: unknown[] }[] = [];
    for (const episode of episodes) {
      let season = seasons.at(-1);
      if (season === undefined || season.seasonNumber !== episode.seasonNumber) {
        season = {
          seasonNumber: episode.seasonNumber,
          title: titleByNumber.get(episode.seasonNumber) ?? null,
          episodes: [],
        };
        seasons.push(season);
      }
      season.episodes.push(episode);
    }

    return { ...show, seasons };
  });
}
