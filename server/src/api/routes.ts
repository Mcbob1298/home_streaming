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
import { buildSrcSet, defaultImagePath, type ImageKind } from '../metadata/images.js';
import { fileSummaryOf, type WorkType } from './fileSummary.js';
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
 *
 * Chaque champ produit DEUX valeurs : `xxxPath`, l'URL de repli, et
 * `xxxSrcSet`, la liste des tailles disponibles. Le composant y ajoute son
 * attribut `sizes`, qu'il est seul à connaître : la largeur d'affichage dépend
 * de la mise en page, pas de la donnée.
 */
function withImages<T extends Record<string, unknown>>(
  row: T,
  mapping: Partial<Record<'posterPath' | 'backdropPath' | 'stillPath' | 'logoPath', ImageKind>>,
): T {
  const result: Record<string, unknown> = { ...row };
  for (const [field, kind] of Object.entries(mapping)) {
    const raw = row[field];
    const usable = typeof raw === 'string' && raw !== '';
    result[field] = usable ? defaultImagePath(raw, kind as ImageKind) : null;
    result[`${field.replace(/Path$/, '')}SrcSet`] = usable ? buildSrcSet(raw, kind as ImageKind) : null;
  }
  return result as T;
}

/**
 * Genres d'une œuvre, concaténés en une chaîne triée.
 *
 * La sous-requête ordonnée est nécessaire : `GROUP_CONCAT` ne garantit pas
 * l'ordre, et sa clause `ORDER BY` interne n'existe que depuis SQLite 3.44.
 */
function genresOf(table: 'movie' | 'show'): string {
  const link = table === 'movie' ? 'movie_genre' : 'show_genre';
  const column = table === 'movie' ? 'movie_id' : 'show_id';
  return `(SELECT GROUP_CONCAT(name, ', ') FROM (
             SELECT g.name FROM genre g
             JOIN ${link} l ON l.genre_id = g.id
             WHERE l.${column} = ${table}.id
             ORDER BY g.name)) AS genres`;
}

/** Transforme la chaîne de genres en tableau, plus simple à consommer côté front. */
function withGenres<T extends Record<string, unknown>>(row: T): T {
  const raw = row.genres;
  return {
    ...row,
    genres: typeof raw === 'string' && raw !== '' ? raw.split(', ') : [],
  };
}

/** Filtre optionnel par genre, appliqué aux listes. */
function genreClause(table: 'movie' | 'show', genreId: number | null): string {
  if (genreId === null) return '';
  const link = table === 'movie' ? 'movie_genre' : 'show_genre';
  const column = table === 'movie' ? 'movie_id' : 'show_id';
  return `AND EXISTS (SELECT 1 FROM ${link} l WHERE l.${column} = ${table}.id AND l.genre_id = ${genreId})`;
}

function readGenreId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Fichiers d'une œuvre, avec tout ce que ffprobe en a tiré.
 *
 * C'est ce qui alimente l'onglet « Détails » : codecs, pistes audio, sous-titres
 * embarqués. Les sous-titres externes viennent d'une table distincte, les
 * embarqués d'une autre — les deux sont rassemblés ici pour que le front n'ait
 * qu'un seul objet à parcourir.
 */
function filesOf(db: Db, type: 'movie' | 'episode', workId: number): unknown[] {
  const where = type === 'movie' ? 'f.movie_id = ?' : 'f.episode_id = ?';

  const files = db
    .prepare(
      `SELECT f.id, f.path, f.file_name AS fileName, f.extension, f.size_bytes AS sizeBytes,
              f.resolution, f.duration_seconds AS durationSeconds, f.container,
              f.video_codec AS videoCodec, f.audio_codec AS audioCodec, f.bitrate, f.hdr,
              f.first_seen_at AS addedAt, r.path AS rootPath
       FROM media_file f
       JOIN library_root r ON r.id = f.library_root_id
       WHERE ${where} AND f.present = 1
       ORDER BY f.path`,
    )
    .all(workId) as { id: number }[];

  const subtitles = db.prepare(
    `SELECT id, file_name AS fileName, format, language, forced, hearing_impaired AS hearingImpaired
     FROM subtitle WHERE media_file_id = ? AND present = 1 ORDER BY language, file_name`,
  );
  const audioTracks = db.prepare(
    `SELECT codec, channels, language, title FROM audio_track WHERE media_file_id = ? ORDER BY stream_index`,
  );
  const embedded = db.prepare(
    `SELECT codec, language, is_forced AS isForced, is_image_based AS isImageBased
     FROM embedded_subtitle WHERE media_file_id = ? ORDER BY stream_index`,
  );

  return files.map((file) => ({
    ...file,
    subtitles: subtitles.all(file.id),
    audioTracks: audioTracks.all(file.id),
    embeddedSubtitles: embedded.all(file.id),
  }));
}

interface CreditRow {
  id: number;
  name: string;
  character: string | null;
  role: 'cast' | 'director' | 'creator';
}

/**
 * Crédits d'une œuvre, groupés par rôle.
 *
 * Le groupement est fait ici plutôt que côté front : c'est une propriété de la
 * donnée, pas de l'affichage, et les deux fiches en ont besoin à l'identique.
 *
 * Les photos ne sont pas exposées : elles ne sont pas téléchargées, et pointer
 * vers TMDB contredirait la règle qui veut que toute image serve en local.
 */
function creditsOf(db: Db, type: WorkType, workId: number): {
  directors: { id: number; name: string }[];
  creators: { id: number; name: string }[];
  cast: { id: number; name: string; character: string | null }[];
} {
  const rows = db
    .prepare(
      `SELECT p.tmdb_id AS id, p.name, c.character, c.role
       FROM credit c
       JOIN person p ON p.tmdb_id = c.person_id
       WHERE c.work_type = ? AND c.work_id = ?
       ORDER BY c.role, COALESCE(c.credit_order, 9999), p.name`,
    )
    .all(type, workId) as CreditRow[];

  return {
    directors: rows.filter((row) => row.role === 'director').map(({ id, name }) => ({ id, name })),
    creators: rows.filter((row) => row.role === 'creator').map(({ id, name }) => ({ id, name })),
    cast: rows
      .filter((row) => row.role === 'cast')
      .map(({ id, name, character }) => ({ id, name, character })),
  };
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

    // L'identifiant de genre est validé comme entier avant d'entrer dans le SQL.
    const whereSql = `WHERE ${where.join(' AND ')} ${search.sql} ${genreClause('movie', readGenreId(query.genre))}`;
    const allParameters = [...parameters, ...search.parameters];

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM movie ${whereSql}`).get(...allParameters) as {
      total: number;
    };

    const items = (
      db
        .prepare(
          `SELECT id, library_id AS libraryId, title, year, poster_path AS posterPath,
                  backdrop_path AS backdropPath, logo_path AS logoPath, added_at AS addedAt,
                  vote_average AS voteAverage, runtime, tagline, overview,
                  ${genresOf('movie')},
                  (SELECT COUNT(*) FROM media_file f WHERE f.movie_id = movie.id AND f.present = 1) AS fileCount
           FROM movie ${whereSql}
           ORDER BY ${buildOrderBy(sort, order)}
           LIMIT ? OFFSET ?`,
        )
        .all(...allParameters, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Record<string, unknown>[]
    ).map((row) =>
      // Les vignettes sont construites sur le backdrop avec le logo incrusté :
      // les trois images partent donc dès la liste.
      withGenres(withImages(row, { posterPath: 'poster', backdropPath: 'backdrop', logoPath: 'logo' })),
    );

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
                backdrop_path AS backdropPath, logo_path AS logoPath, added_at AS addedAt, tmdb_id AS tmdbId,
                release_date AS releaseDate, runtime, vote_average AS voteAverage,
                original_title AS originalTitle, certification
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

    return {
      ...withImages(movie, { posterPath: 'poster', backdropPath: 'backdrop', logoPath: 'logo' }),
      genres,
      credits: creditsOf(db, 'movie', Number(id)),
      files: filesOf(db, 'movie', Number(id)),
      fileSummary: fileSummaryOf(db, 'movie', Number(id)),
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

    const whereSql = `WHERE ${where.join(' AND ')} ${search.sql} ${genreClause('show', readGenreId(query.genre))}`;
    const allParameters = [...parameters, ...search.parameters];

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM show ${whereSql}`).get(...allParameters) as {
      total: number;
    };

    const items = (
      db
        .prepare(
          `SELECT id, library_id AS libraryId, title, year, poster_path AS posterPath,
                  backdrop_path AS backdropPath, logo_path AS logoPath, added_at AS addedAt,
                  vote_average AS voteAverage, status, overview,
                  ${genresOf('show')},
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
    ).map((row) =>
      withGenres(withImages(row, { posterPath: 'poster', backdropPath: 'backdrop', logoPath: 'logo' })),
    );

    return buildPage(items, page, total);
  });

  // -------------------------------------------------------------------------
  // GET /api/genres — genres présents, avec leur nombre d'œuvres
  // -------------------------------------------------------------------------
  app.get('/api/genres', () => {
    return db
      .prepare(
        `SELECT g.id, g.name,
                (SELECT COUNT(*) FROM movie_genre mg JOIN movie m ON m.id = mg.movie_id
                  WHERE mg.genre_id = g.id
                    AND EXISTS (SELECT 1 FROM media_file f WHERE f.movie_id = m.id AND f.present = 1)) AS movieCount,
                (SELECT COUNT(*) FROM show_genre sg JOIN show s ON s.id = sg.show_id
                  WHERE sg.genre_id = g.id
                    AND EXISTS (SELECT 1 FROM episode e
                                JOIN media_file f ON f.episode_id = e.id AND f.present = 1
                                WHERE e.show_id = s.id)) AS showCount
         FROM genre g
         ORDER BY (movieCount + showCount) DESC, g.name`,
      )
      .all()
      .filter((row) => {
        const genre = row as { movieCount: number; showCount: number };
        return genre.movieCount + genre.showCount > 0;
      });
  });

  // -------------------------------------------------------------------------
  // GET /api/shows/:id — la série, ses saisons et leurs épisodes
  // -------------------------------------------------------------------------
  app.get('/api/shows/:id', (request, reply) => {
    const { id } = request.params as { id: string };

    const show = db
      .prepare(
        `SELECT id, library_id AS libraryId, title, year, overview, poster_path AS posterPath,
                backdrop_path AS backdropPath, logo_path AS logoPath, added_at AS addedAt, tmdb_id AS tmdbId,
                first_air_date AS firstAirDate, status, number_of_seasons AS numberOfSeasons,
                vote_average AS voteAverage, original_title AS originalTitle, certification
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
          posterPath:
            info?.posterPath === null || info?.posterPath === undefined
              ? null
              : defaultImagePath(info.posterPath, 'poster'),
          airDate: info?.airDate ?? null,
          episodes: [],
        };
        seasons.push(season);
      }
      season.episodes.push(episode);
    }

    return {
      ...withImages(show, { posterPath: 'poster', backdropPath: 'backdrop', logoPath: 'logo' }),
      genres,
      credits: creditsOf(db, 'show', Number(id)),
      // Une série n'a pas de fichier : la synthèse agrège ceux de ses épisodes.
      fileSummary: fileSummaryOf(db, 'show', Number(id)),
      seasons,
    };
  });
}
