/**
 * Écriture du résultat d'un parcours dans la base.
 *
 * Deux idées à retenir :
 *
 * - Le scan est INCRÉMENTAL. On garde la taille et la date de modification de
 *   chaque fichier ; si elles n'ont pas bougé, on ne re-parse pas. Seule
 *   exception : un fichier resté « non interprété » est retenté à chaque scan,
 *   puisque le parser, lui, évolue — et que ça ne coûte rien (aucun accès disque).
 *
 * - Rien n'est supprimé. Un fichier absent du disque passe à `present = 0`.
 *   On repère les absents avec `last_seen_at` : tous les fichiers vus pendant
 *   ce scan portent l'horodatage du scan, les autres sont plus anciens.
 */
import type { Db } from '../db/index.js';
import type { LibraryConfig } from '../config.js';
import { parseMediaPath, parseSubtitleName, type ParseResult } from '../parser/index.js';
import { pathKey, sortTitle, titleKey } from '../util/text.js';
import { matchSubtitles } from './subtitles.js';
import type { WalkedFile } from './walk.js';

export interface IndexStats {
  videos: number;
  unchanged: number;
  parsed: number;
  unparsed: number;
  subtitlesLinked: number;
  subtitlesOrphan: number;
}

interface ExistingFile {
  id: number;
  size_bytes: number;
  mtime_ms: number;
  parse_status: string;
}

/** Toutes les requêtes préparées une fois pour toutes : SQLite est bien plus rapide comme ça. */
function prepareStatements(db: Db) {
  return {
    selectExistingByKey: db.prepare(
      'SELECT id, size_bytes, mtime_ms, parse_status FROM media_file WHERE path_key = ?',
    ),
    // `raw_path` est rafraîchi même quand le fichier n'a pas changé : c'est ce
    // qui permet de le renseigner sur une base créée avant son introduction,
    // sans imposer un scan complet.
    touchFile: db.prepare(
      'UPDATE media_file SET present = 1, last_seen_at = ?, raw_path = ? WHERE id = ?',
    ),
    upsertFile: db.prepare(`
      INSERT INTO media_file (
        library_id, library_root_id, path, path_key, raw_path, relative_path, file_name, extension,
        size_bytes, mtime_ms, present, first_seen_at, last_seen_at,
        movie_id, episode_id, parse_status, parse_reason
      ) VALUES (
        @library_id, @library_root_id, @path, @path_key, @raw_path, @relative_path, @file_name, @extension,
        @size_bytes, @mtime_ms, 1, @now, @now,
        @movie_id, @episode_id, @parse_status, @parse_reason
      )
      ON CONFLICT(path_key) DO UPDATE SET
        library_root_id = excluded.library_root_id,
        path            = excluded.path,
        raw_path        = excluded.raw_path,
        relative_path   = excluded.relative_path,
        file_name       = excluded.file_name,
        extension       = excluded.extension,
        size_bytes      = excluded.size_bytes,
        mtime_ms        = excluded.mtime_ms,
        present         = 1,
        last_seen_at    = excluded.last_seen_at,
        movie_id        = excluded.movie_id,
        episode_id      = excluded.episode_id,
        parse_status    = excluded.parse_status,
        parse_reason    = excluded.parse_reason
    `),
    markAbsentFiles: db.prepare(
      'UPDATE media_file SET present = 0 WHERE library_id = ? AND present = 1 AND last_seen_at < ?',
    ),

    selectMovie: db.prepare(
      'SELECT id FROM movie WHERE library_id = ? AND title_key = ? AND IFNULL(year, -1) = IFNULL(?, -1)',
    ),
    insertMovie: db.prepare(
      `INSERT INTO movie (library_id, title, title_key, year, sort_title, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),

    selectShowExact: db.prepare(
      'SELECT id, year FROM show WHERE library_id = ? AND title_key = ? AND IFNULL(year, -1) = IFNULL(?, -1)',
    ),
    insertShow: db.prepare(
      `INSERT INTO show (library_id, title, title_key, year, sort_title, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),

    selectSeason: db.prepare('SELECT id FROM season WHERE show_id = ? AND season_number = ?'),
    insertSeason: db.prepare('INSERT INTO season (show_id, season_number, added_at) VALUES (?, ?, ?)'),

    selectEpisode: db.prepare(
      'SELECT id, title, episode_number_end FROM episode WHERE show_id = ? AND season_number = ? AND episode_number = ?',
    ),
    insertEpisode: db.prepare(
      `INSERT INTO episode (show_id, season_id, season_number, episode_number, episode_number_end, title, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateEpisode: db.prepare(
      'UPDATE episode SET title = COALESCE(?, title), episode_number_end = COALESCE(?, episode_number_end), updated_at = ? WHERE id = ?',
    ),

    resetSubtitles: db.prepare(
      'UPDATE subtitle SET present = 0 WHERE media_file_id IN (SELECT id FROM media_file WHERE library_id = ?)',
    ),
    upsertSubtitle: db.prepare(`
      INSERT INTO subtitle (
        media_file_id, path, path_key, file_name, format, language,
        forced, hearing_impaired, size_bytes, mtime_ms, present
      ) VALUES (@media_file_id, @path, @path_key, @file_name, @format, @language,
        @forced, @hearing_impaired, @size_bytes, @mtime_ms, 1)
      ON CONFLICT(path_key) DO UPDATE SET
        media_file_id    = excluded.media_file_id,
        path             = excluded.path,
        file_name        = excluded.file_name,
        format           = excluded.format,
        language         = excluded.language,
        forced           = excluded.forced,
        hearing_impaired = excluded.hearing_impaired,
        size_bytes       = excluded.size_bytes,
        mtime_ms         = excluded.mtime_ms,
        present          = 1
    `),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

function findOrCreateMovie(
  statements: Statements,
  libraryId: string,
  title: string,
  year: number | null,
  now: string,
): number {
  const key = titleKey(title);
  const existing = statements.selectMovie.get(libraryId, key, year) as { id: number } | undefined;
  if (existing !== undefined) return existing.id;

  const result = statements.insertMovie.run(libraryId, title, key, year, sortTitle(title), now, now);
  return Number(result.lastInsertRowid);
}

/**
 * Les séries se regroupent sur (titre normalisé, année), exactement comme les
 * films. Deux séries homonymes d'années différentes restent donc distinctes —
 * « One Piece » 1999 (l'animé) et « One Piece » 2023 (la série Netflix) sont
 * deux œuvres, pas deux orthographes de la même.
 *
 * Une série SANS année ne rejoint jamais automatiquement une homonyme QUI a une
 * année : ce serait deviner. Les deux fiches coexistent et le rapport de scan
 * les signale, à charge de trancher en renommant le dossier sur le NAS.
 */
function findOrCreateShow(
  statements: Statements,
  libraryId: string,
  title: string,
  year: number | null,
  now: string,
): number {
  const key = titleKey(title);

  const exact = statements.selectShowExact.get(libraryId, key, year) as { id: number } | undefined;
  if (exact !== undefined) return exact.id;

  const result = statements.insertShow.run(libraryId, title, key, year, sortTitle(title), now, now);
  return Number(result.lastInsertRowid);
}

function findOrCreateEpisode(
  statements: Statements,
  showId: number,
  seasonNumber: number,
  episodeNumber: number,
  episodeNumberEnd: number | null,
  title: string | null,
  now: string,
): number {
  let season = statements.selectSeason.get(showId, seasonNumber) as { id: number } | undefined;
  if (season === undefined) {
    const inserted = statements.insertSeason.run(showId, seasonNumber, now);
    season = { id: Number(inserted.lastInsertRowid) };
  }

  const existing = statements.selectEpisode.get(showId, seasonNumber, episodeNumber) as
    | { id: number; title: string | null; episode_number_end: number | null }
    | undefined;

  if (existing !== undefined) {
    // COALESCE côté SQL : on complète ce qui manque, on n'écrase pas.
    if ((existing.title === null && title !== null) || (existing.episode_number_end === null && episodeNumberEnd !== null)) {
      statements.updateEpisode.run(title, episodeNumberEnd, now, existing.id);
    }
    return existing.id;
  }

  const inserted = statements.insertEpisode.run(
    showId,
    season.id,
    seasonNumber,
    episodeNumber,
    episodeNumberEnd,
    title,
    now,
    now,
  );
  return Number(inserted.lastInsertRowid);
}

export interface RootWalk {
  libraryRootId: number;
  videos: WalkedFile[];
  subtitles: WalkedFile[];
}

export interface IndexOptions {
  /** Force le re-parsing de tous les fichiers, même inchangés (option `--full`). */
  force?: boolean;
}

/**
 * Enregistre en base tout ce qui a été trouvé pour une bibliothèque.
 * Le tout dans une seule transaction : en cas d'interruption, la base reste
 * dans l'état d'avant le scan.
 */
export function indexLibrary(
  db: Db,
  library: LibraryConfig,
  walks: RootWalk[],
  scanTimestamp: string,
  options: IndexOptions = {},
): IndexStats {
  const statements = prepareStatements(db);
  const stats: IndexStats = {
    videos: 0,
    unchanged: 0,
    parsed: 0,
    unparsed: 0,
    subtitlesLinked: 0,
    subtitlesOrphan: 0,
  };

  const run = db.transaction(() => {
    statements.resetSubtitles.run(library.id);

    // id de fichier en base, par chemin normalisé : sert à rattacher les sous-titres.
    const fileIdByPathKey = new Map<string, number>();

    for (const walk of walks) {
      for (const video of walk.videos) {
        stats.videos += 1;
        // `storedPath` est la forme NFC : c'est elle qu'on enregistre et compare.
        // `absolutePath` (le chemin brut du disque) ne sert qu'au parcours.
        const key = pathKey(video.storedPath);

        const existing = statements.selectExistingByKey.get(key) as ExistingFile | undefined;
        const unchanged =
          existing !== undefined &&
          existing.size_bytes === video.sizeBytes &&
          existing.mtime_ms === video.mtimeMs &&
          existing.parse_status === 'ok' &&
          options.force !== true;

        if (unchanged) {
          statements.touchFile.run(scanTimestamp, video.absolutePath, existing.id);
          fileIdByPathKey.set(key, existing.id);
          stats.unchanged += 1;
          stats.parsed += 1;
          continue;
        }

        const parsed: ParseResult = parseMediaPath(video.relativePath, library.type);

        let movieId: number | null = null;
        let episodeId: number | null = null;

        if (parsed.kind === 'movie') {
          movieId = findOrCreateMovie(statements, library.id, parsed.title, parsed.year, scanTimestamp);
        } else if (parsed.kind === 'episode') {
          const showId = findOrCreateShow(statements, library.id, parsed.showTitle, parsed.showYear, scanTimestamp);
          episodeId = findOrCreateEpisode(
            statements,
            showId,
            parsed.seasonNumber,
            parsed.episodeNumber,
            parsed.episodeNumberEnd,
            parsed.episodeTitle,
            scanTimestamp,
          );
        }

        if (parsed.kind === 'unknown') stats.unparsed += 1;
        else stats.parsed += 1;

        statements.upsertFile.run({
          library_id: library.id,
          library_root_id: walk.libraryRootId,
          path: video.storedPath,
          path_key: key,
          // Chemin exact du disque : c'est lui que ffprobe et la lecture utiliseront.
          raw_path: video.absolutePath,
          relative_path: video.relativePath,
          file_name: video.fileName,
          extension: video.extension,
          size_bytes: video.sizeBytes,
          mtime_ms: video.mtimeMs,
          now: scanTimestamp,
          movie_id: movieId,
          episode_id: episodeId,
          parse_status: parsed.kind === 'unknown' ? 'unparsed' : 'ok',
          parse_reason: parsed.kind === 'unknown' ? parsed.reason : null,
        });

        const stored = statements.selectExistingByKey.get(key) as { id: number } | undefined;
        if (stored !== undefined) fileIdByPathKey.set(key, stored.id);
      }

      const { matches, orphans } = matchSubtitles(walk.videos, walk.subtitles);
      stats.subtitlesOrphan += orphans.length;

      for (const { subtitle, video } of matches) {
        const mediaFileId = fileIdByPathKey.get(pathKey(video.storedPath));
        if (mediaFileId === undefined) continue;

        const parsed = parseSubtitleName(subtitle.fileName, video.fileName);
        statements.upsertSubtitle.run({
          media_file_id: mediaFileId,
          path: subtitle.storedPath,
          path_key: pathKey(subtitle.storedPath),
          file_name: subtitle.fileName,
          format: subtitle.extension.replace('.', ''),
          language: parsed.language,
          forced: parsed.forced ? 1 : 0,
          hearing_impaired: parsed.hearingImpaired ? 1 : 0,
          size_bytes: subtitle.sizeBytes,
          mtime_ms: subtitle.mtimeMs,
        });
        stats.subtitlesLinked += 1;
      }
    }

    statements.markAbsentFiles.run(library.id, scanTimestamp);
  });

  run();
  return stats;
}
