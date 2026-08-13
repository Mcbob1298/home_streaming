/**
 * Diffusion des fichiers et décision de lecture.
 *
 * Trois règles qui comptent plus que le reste :
 *
 * 1. **Le chemin ne vient JAMAIS du client.** La route reçoit un identifiant de
 *    `media_file`, et le chemin est lu en base. Aucune traversée de répertoire
 *    n'est possible, il n'y a rien à assainir.
 * 2. **L'accès disque passe par `raw_path`**, le chemin exact rendu par readdir.
 *    `path` est en NFC pour les comparaisons ; NTFS et SMB comparent octet à
 *    octet, et un chemin recomposé peut ne pas exister. Règle de la phase 1.
 * 3. **Le fichier n'est jamais chargé en mémoire.** Un flux, une plage d'octets,
 *    et un flux détruit dès que le client s'en va — sinon chaque déplacement du
 *    curseur laisserait un descripteur ouvert derrière lui.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.js';
import { mimeTypeFor, type PlaybackDecision } from '../playback/playability.js';
import { preferenceFor, savePreference } from '../playback/preferences.js';
import { findMedia as findResolvable, resolveDecision, tracksOf } from '../playback/resolve.js';
import { preferenceFrom, resolveAudioChoice, resolveSubtitleChoice } from '../playback/tracks.js';
import { episodeLabel } from '../progress/rules.js';
import { progressOf } from '../progress/store.js';
import { currentUserId } from '../progress/user.js';
import { hlsUrlOf } from './hls.js';
import { contentRange, etagFor, matchesEtag, parseRange, unsatisfiableRange } from '../playback/ranges.js';
import { isConvertible, subtitleLabel, toVtt } from '../playback/vtt.js';
import { buildSrcSet, defaultImagePath } from '../metadata/images.js';

interface MediaFileRow {
  id: number;
  path: string;
  rawPath: string | null;
  fileName: string;
  extension: string;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  durationSeconds: number | null;
  movieId: number | null;
  episodeId: number | null;
}

/** Identifiant de ressource : entier positif, sinon rien. */
function readId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Index de flux facultatif : entier positif ou nul, ou rien.
 *
 * `null` et l'absence signifient tous deux « aucune piste » — c'est ce que le
 * lecteur envoie pour « Sous-titres désactivés ».
 */
function readOptionalIndex(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function findMediaFile(db: Db, id: number): MediaFileRow | undefined {
  return db
    .prepare(
      `SELECT id, path, raw_path AS rawPath, file_name AS fileName, extension, container,
              video_codec AS videoCodec, audio_codec AS audioCodec,
              duration_seconds AS durationSeconds, movie_id AS movieId, episode_id AS episodeId
       FROM media_file WHERE id = ? AND present = 1`,
    )
    .get(id) as MediaFileRow | undefined;
}

/** Chemin à donner au système de fichiers. Voir la règle 2 en tête de fichier. */
function diskPathOf(file: MediaFileRow): string {
  return file.rawPath ?? file.path;
}

export function streamUrlOf(mediaFileId: number): string {
  return `/api/stream/${mediaFileId}`;
}

// ---------------------------------------------------------------------------
// Contexte de lecture : de quoi habiller le lecteur
// ---------------------------------------------------------------------------

interface MediaContext {
  kind: 'movie' | 'episode';
  /** Titre du film, ou de la série pour un épisode. */
  title: string;
  /** « S01:E04 Le goût du risque » pour un épisode, null pour un film. */
  subtitle: string | null;
  workId: number;
  backdropPath: string | null;
  backdropSrcSet: string | null;
  durationSeconds: number | null;
}

function withBackdrop(raw: string | null): { backdropPath: string | null; backdropSrcSet: string | null } {
  if (raw === null || raw === '') return { backdropPath: null, backdropSrcSet: null };
  return { backdropPath: defaultImagePath(raw, 'backdrop'), backdropSrcSet: buildSrcSet(raw, 'backdrop') };
}

function contextOf(db: Db, file: MediaFileRow): MediaContext | null {
  if (file.movieId !== null) {
    const movie = db
      .prepare('SELECT id, title, backdrop_path AS backdropPath FROM movie WHERE id = ?')
      .get(file.movieId) as { id: number; title: string; backdropPath: string | null } | undefined;
    if (movie === undefined) return null;

    return {
      kind: 'movie',
      title: movie.title,
      subtitle: null,
      workId: movie.id,
      ...withBackdrop(movie.backdropPath),
      durationSeconds: file.durationSeconds,
    };
  }

  if (file.episodeId !== null) {
    const episode = db
      .prepare(
        `SELECT e.season_number AS seasonNumber, e.episode_number AS episodeNumber, e.title,
                s.id AS showId, s.title AS showTitle, s.backdrop_path AS backdropPath
         FROM episode e JOIN show s ON s.id = e.show_id WHERE e.id = ?`,
      )
      .get(file.episodeId) as
      | {
          seasonNumber: number;
          episodeNumber: number;
          title: string | null;
          showId: number;
          showTitle: string;
          backdropPath: string | null;
        }
      | undefined;
    if (episode === undefined) return null;

    return {
      kind: 'episode',
      title: episode.showTitle,
      subtitle: episodeLabel(episode.seasonNumber, episode.episodeNumber, episode.title),
      workId: episode.showId,
      ...withBackdrop(episode.backdropPath),
      durationSeconds: file.durationSeconds,
    };
  }

  return null;
}

/**
 * Épisode suivant de la même série, s'il en existe un sur le disque.
 *
 * L'ordre est celui de la série entière, saisons comprises : après le dernier
 * épisode d'une saison vient le premier de la suivante, ce que le bouton
 * « épisode suivant » du lecteur doit refléter.
 */
function nextEpisodeOf(db: Db, file: MediaFileRow): { mediaFileId: number; label: string } | null {
  if (file.episodeId === null) return null;

  const row = db
    .prepare(
      `SELECT MIN(f.id) AS mediaFileId, e.season_number AS seasonNumber,
              e.episode_number AS episodeNumber, e.title
       FROM episode e
       JOIN media_file f ON f.episode_id = e.id AND f.present = 1
       WHERE e.show_id = (SELECT show_id FROM episode WHERE id = @episodeId)
         AND (e.season_number, e.episode_number) >
             (SELECT season_number, episode_number FROM episode WHERE id = @episodeId)
       GROUP BY e.id
       ORDER BY e.season_number, e.episode_number
       LIMIT 1`,
    )
    .get({ episodeId: file.episodeId }) as
    | { mediaFileId: number; seasonNumber: number; episodeNumber: number; title: string | null }
    | undefined;

  if (row === undefined) return null;
  return {
    mediaFileId: row.mediaFileId,
    label: episodeLabel(row.seasonNumber, row.episodeNumber, row.title),
  };
}

interface SubtitleTrack {
  id: number;
  url: string;
  language: string | null;
  label: string;
  format: string;
  forced: number;
  hearingImpaired: number;
}

/**
 * Pistes de sous-titres EXTERNES servables.
 *
 * Les pistes embarquées dans les MKV n'y figurent pas : les extraire demande
 * ffmpeg. Les formats qu'on ne sait pas convertir sont écartés ici plutôt que
 * proposés dans le menu pour échouer au clic.
 */
function subtitlesOf(db: Db, mediaFileId: number): SubtitleTrack[] {
  const rows = db
    .prepare(
      `SELECT id, language, format, forced, hearing_impaired AS hearingImpaired
       FROM subtitle WHERE media_file_id = ? AND present = 1
       ORDER BY forced, hearing_impaired, language, file_name`,
    )
    .all(mediaFileId) as {
    id: number;
    language: string | null;
    format: string;
    forced: number;
    hearingImpaired: number;
  }[];

  return rows
    .filter((row) => isConvertible(row.format))
    .map((row) => ({
      ...row,
      url: `/api/subtitles/${row.id}`,
      label: subtitleLabel(row),
    }));
}

/** Une piste proposée dans le menu de l'engrenage. */
export interface TrackOption {
  /** Index ABSOLU du flux dans le fichier. Sert d'identifiant côté lecteur. */
  streamIndex: number;
  label: string;
  language: string | null;
}

export interface SubtitleOption extends TrackOption {
  kind: 'forced' | 'sdh' | 'full';
}

export interface PlayabilityResponse extends PlaybackDecision {
  media: MediaContext | null;
  next: { mediaFileId: number; label: string } | null;
  subtitles: SubtitleTrack[];
  /** Position de reprise, en secondes. Zéro si l'œuvre n'a jamais été commencée. */
  resumeSeconds: number;
  /** Pistes audio du fichier, libellées. Vide sur un fichier muet. */
  audioTracks: TrackOption[];
  /** Piste audio à ouvrir : préférence mémorisée, sinon règle automatique. */
  defaultAudioStream: number | null;
  /** Sous-titres embarqués exposés, image écartée. */
  embeddedSubtitles: SubtitleOption[];
  /** Sous-titre à activer à l'ouverture. Null pour « Désactivés ». */
  defaultSubtitleStream: number | null;
  /**
   * Le fichier n'a QUE des sous-titres image.
   *
   * Le sélecteur l'annonce alors explicitement : ne rien afficher laisserait
   * croire que le fichier n'en a aucun, ce qui est faux.
   */
  imageOnlySubtitles: boolean;
}

/**
 * Où reprendre ce fichier.
 *
 * La position voyage AVEC la décision de lecture, dans la même réponse : si le
 * lecteur devait la demander à part, il démarrerait à zéro le temps du second
 * aller-retour, puis sauterait sous les yeux du spectateur.
 */
function resumeSecondsOf(db: Db, file: MediaFileRow, userId: number): number {
  const work =
    file.movieId !== null
      ? ({ mediaType: 'movie', mediaId: file.movieId } as const)
      : file.episodeId !== null
        ? ({ mediaType: 'episode', mediaId: file.episodeId } as const)
        : null;
  if (work === null) return 0;

  const stored = progressOf(db, userId, work.mediaType, work.mediaId);
  return stored === null || stored.watched ? 0 : stored.positionSeconds;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * `remuxAvailable` dit si ffmpeg a été trouvé au démarrage. Une fonction et non
 * un booléen : la détection est asynchrone, et les routes sont enregistrées
 * avant qu'elle ne se termine.
 */
export function registerStreamRoutes(
  app: FastifyInstance,
  db: Db,
  transcoding: () => { available: boolean; ffmpegBinary: string },
): void {
  // -------------------------------------------------------------------------
  // GET /api/stream/:id/playability — la décision, et de quoi habiller le lecteur
  // -------------------------------------------------------------------------
  app.get('/api/stream/:id/playability', async (request, reply) => {
    const id = readId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'Identifiant de fichier invalide.' });

    const file = findMediaFile(db, id);
    if (file === undefined) {
      return reply.code(404).send({ error: 'Ce fichier n’est pas dans l’index, ou il n’est plus sur le disque.' });
    }

    const { available, ffmpegBinary } = transcoding();
    const media = findResolvable(db, id);
    if (media === undefined) {
      return reply.code(404).send({ error: 'Ce fichier n’est pas dans l’index, ou il n’est plus sur le disque.' });
    }

    /*
     * La même résolution que les routes HLS : deux verdicts divergents
     * donneraient un lecteur qui reçoit « transcode » et un manifeste vide.
     * Le plan n'est PAS calculé ici — énumérer les images clés d'un film de
     * deux heures pour afficher une fiche coûterait plusieurs secondes.
     */
    const { decision, tracks } = await resolveDecision(
      db,
      ffmpegBinary,
      media,
      { file: streamUrlOf(file.id), hls: hlsUrlOf(file.id) },
      { transcodeAvailable: available },
    );

    const userId = currentUserId(db, request);
    const context = contextOf(db, file);

    /*
     * Le choix mémorisé porte sur l'ŒUVRE — le film, ou la SÉRIE entière —
     * jamais sur l'épisode : c'est ce qui le fait traverser une saison.
     */
    const preference = preferenceFor(
      db,
      userId,
      context === null ? null : context.kind === 'movie' ? 'movie' : 'show',
      context?.workId ?? null,
    );

    const response: PlayabilityResponse = {
      ...decision,
      media: context,
      next: nextEpisodeOf(db, file),
      subtitles: subtitlesOf(db, file.id),
      resumeSeconds: resumeSecondsOf(db, file, userId),
      audioTracks: tracks.audio.map((track) => ({
        streamIndex: track.streamIndex,
        label: track.label,
        language: track.language,
      })),
      defaultAudioStream: resolveAudioChoice(tracks.audioRows, preference),
      embeddedSubtitles: tracks.subtitles.map((track) => ({
        streamIndex: track.streamIndex,
        label: track.label,
        language: track.language,
        kind: track.kind,
      })),
      defaultSubtitleStream: resolveSubtitleChoice(tracks.subtitles, preference),
      imageOnlySubtitles: tracks.imageOnlySubtitles,
    };

    // La décision dépend de l'état de la base, qui peut changer à la passe
    // suivante : rien à mettre en cache côté navigateur.
    void reply.header('Cache-Control', 'no-store');
    return response;
  });

  // -------------------------------------------------------------------------
  // POST /api/stream/:id/tracks — le lecteur enregistre un choix de piste
  // -------------------------------------------------------------------------
  // Le corps porte des INDEX DE FLUX, ce que le lecteur connaît ; ce qui est
  // mémorisé est la LANGUE et la nature, qui traversent les épisodes.
  app.post('/api/stream/:id/tracks', (request, reply) => {
    const id = readId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'Identifiant de fichier invalide.' });

    const file = findMediaFile(db, id);
    if (file === undefined) return reply.code(404).send({ error: 'Fichier inconnu.' });

    const body = request.body as { audioStream?: unknown; subtitleStream?: unknown } | undefined;
    const audioStream = readOptionalIndex(body?.audioStream);
    const subtitleStream = readOptionalIndex(body?.subtitleStream);

    const tracks = tracksOf(db, id);
    const audio = tracks.audio.find((track) => track.streamIndex === audioStream);
    const subtitle = tracks.subtitles.find((track) => track.streamIndex === subtitleStream);

    // Un index qui ne correspond à rien est refusé plutôt qu'ignoré : mémoriser
    // silencieusement autre chose que ce qui a été demandé serait pire.
    if (audioStream !== null && audio === undefined) {
      return reply.code(400).send({ error: `Aucune piste audio pour le flux ${audioStream}.` });
    }
    if (subtitleStream !== null && subtitle === undefined) {
      return reply.code(400).send({ error: `Aucun sous-titre exposé pour le flux ${subtitleStream}.` });
    }

    const context = contextOf(db, file);
    savePreference(
      db,
      currentUserId(db, request),
      context === null ? null : context.kind === 'movie' ? 'movie' : 'show',
      context?.workId ?? null,
      preferenceFrom(audio, subtitle),
    );

    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // GET /api/stream/:id — le fichier, en flux, avec gestion des plages
  // -------------------------------------------------------------------------
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/stream/:id',
    handler: async (request, reply) => sendFile(db, request, reply),
  });

  // -------------------------------------------------------------------------
  // GET /api/subtitles/:id — converti en WebVTT à la volée
  // -------------------------------------------------------------------------
  app.get('/api/subtitles/:id', async (request, reply) => {
    const id = readId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'Identifiant de sous-titre invalide.' });

    const row = db
      .prepare(
        `SELECT id, path, raw_path AS rawPath, format
         FROM subtitle WHERE id = ? AND present = 1`,
      )
      .get(id) as { id: number; path: string; rawPath: string | null; format: string } | undefined;

    if (row === undefined) {
      return reply.code(404).send({ error: 'Ce sous-titre n’est pas dans l’index, ou il n’est plus sur le disque.' });
    }

    if (!isConvertible(row.format)) {
      return reply.code(415).send({
        error: `Le format « ${row.format} » n’est pas encore converti. Seuls SRT et WebVTT le sont.`,
      });
    }

    /*
     * Un sous-titre pèse quelques dizaines de kilo-octets : le lire en entier
     * est sans conséquence, et la conversion l'exige de toute façon.
     */
    try {
      const text = await readFile(row.rawPath ?? row.path, 'utf8');
      void reply.header('Content-Type', 'text/vtt; charset=utf-8');
      void reply.header('Cache-Control', 'private, max-age=3600');
      return toVtt(text);
    } catch {
      return reply.code(404).send({
        error: `Fichier de sous-titres introuvable sur le disque : ${row.path}`,
      });
    }
  });
}

/**
 * Sert un fichier, en flux, en honorant `Range` et `If-None-Match`.
 *
 * La taille et la date viennent d'un `stat` FRAIS, pas de la base : celle-ci
 * peut dater du dernier scan, et annoncer une longueur qui ne correspond plus
 * au fichier casserait la lecture bien plus sûrement qu'un aller-retour de
 * plus sur le partage.
 */
async function sendFile(db: Db, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const id = readId((request.params as { id: string }).id);
  if (id === null) return reply.code(400).send({ error: 'Identifiant de fichier invalide.' });

  const file = findMediaFile(db, id);
  if (file === undefined) {
    return reply.code(404).send({ error: 'Ce fichier n’est pas dans l’index, ou il n’est plus sur le disque.' });
  }

  const diskPath = diskPathOf(file);

  let size: number;
  let mtimeMs: number;
  try {
    const stats = await stat(diskPath);
    if (!stats.isFile()) return reply.code(404).send({ error: `Ce chemin n’est pas un fichier : ${file.path}` });
    size = stats.size;
    mtimeMs = stats.mtimeMs;
  } catch {
    return reply.code(404).send({
      error:
        `Fichier introuvable sur le disque : ${file.path}. ` +
        'Vérifier que le partage est monté, puis relancer « npm run scan ».',
    });
  }

  const etag = etagFor(size, mtimeMs);
  const headers = request.headers;

  void reply.header('Accept-Ranges', 'bytes');
  void reply.header('ETag', etag);
  void reply.header('Last-Modified', new Date(mtimeMs).toUTCString());
  // Un fichier de média n'a rien à faire dans un cache partagé, mais le
  // navigateur peut le revalider : d'où « private » plutôt que « no-store ».
  void reply.header('Cache-Control', 'private, max-age=0, must-revalidate');

  if (matchesEtag(headers['if-none-match'], etag)) return reply.code(304).send();

  const range = parseRange(headers.range, size);

  if (range.kind === 'unsatisfiable') {
    void reply.header('Content-Range', unsatisfiableRange(size));
    // Ce corps-là est du JSON, pas de la vidéo. Le type de contenu du média
    // n'est posé qu'après, sur les seules réponses qui en transportent —
    // annoncé trop tôt, Fastify refuse de sérialiser l'objet d'erreur.
    return reply.code(416).type('application/json').send({ error: 'Plage demandée hors du fichier.' });
  }

  void reply.header('Content-Type', mimeTypeFor(file.extension));

  const start = range.kind === 'partial' ? range.start : 0;
  const end = range.kind === 'partial' ? range.end : Math.max(0, size - 1);
  const length = size === 0 ? 0 : end - start + 1;

  if (range.kind === 'partial') {
    void reply.code(206);
    void reply.header('Content-Range', contentRange(start, end, size));
  }
  void reply.header('Content-Length', length);

  // Une requête HEAD reçoit les en-têtes et rien d'autre : ouvrir un flux pour
  // le jeter aussitôt coûterait un descripteur pour rien.
  if (request.method === 'HEAD' || size === 0) return reply.send();

  const stream = createReadStream(diskPath, { start, end });

  /*
   * Le client ferme la connexion à chaque déplacement du curseur : le navigateur
   * abandonne la plage en cours et en demande une autre. Sans cette destruction
   * explicite, un descripteur de fichier resterait ouvert à chaque fois, et sur
   * un partage SMB ils s'accumulent vite.
   */
  const abort = (): void => {
    if (!stream.destroyed) stream.destroy();
  };
  request.raw.on('close', abort);
  request.raw.on('aborted', abort);

  stream.on('error', (error: NodeJS.ErrnoException) => {
    // ERR_STREAM_PREMATURE_CLOSE est la conséquence normale de la destruction
    // ci-dessus, pas un incident : on ne pollue pas le journal avec.
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    request.log.warn({ err: error, path: file.path }, 'lecture interrompue');
  });

  return reply.send(stream);
}
