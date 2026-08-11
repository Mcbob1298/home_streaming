/**
 * Routes HLS : manifeste, segment d'initialisation, segments.
 *
 * Le manifeste est publié COMPLET dès la première requête, calculé à partir de
 * la durée déjà en base. Le lecteur peut donc viser n'importe quelle position,
 * y compris une qui n'est pas encore produite : c'est alors au serveur de
 * relancer ffmpeg là-bas.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { Db } from '../db/index.js';
import type { SessionManager } from '../transcode/manager.js';
import { segmentPlanOf } from '../transcode/plan.js';
import { buildPlaylist, segmentFileName, type PlannedSegment } from '../transcode/segments.js';

interface MediaRow {
  id: number;
  path: string;
  rawPath: string | null;
  durationSeconds: number | null;
  sizeBytes: number;
  mtimeMs: number;
}

function findMedia(db: Db, id: number): MediaRow | undefined {
  return db
    .prepare(
      `SELECT id, path, raw_path AS rawPath, duration_seconds AS durationSeconds,
              size_bytes AS sizeBytes, mtime_ms AS mtimeMs
       FROM media_file WHERE id = ? AND present = 1`,
    )
    .get(id) as MediaRow | undefined;
}

/**
 * Plan de découpe d'un fichier, calqué sur ses images clés.
 *
 * Le premier appel énumère les images clés (~2 s pour un film de deux heures) ;
 * les suivants lisent le cache en base. Le plan doit être IDENTIQUE pour le
 * manifeste et pour la session, sinon le lecteur réclamerait des segments que
 * ffmpeg ne produira jamais.
 */
async function planOf(
  db: Db,
  manager: SessionManager,
  media: MediaRow,
): Promise<PlannedSegment[]> {
  if (media.durationSeconds === null || media.durationSeconds <= 0) return [];

  const { segments } = await segmentPlanOf(db, manager.ffmpegBinary, {
    id: media.id,
    inputPath: media.rawPath ?? media.path,
    durationSeconds: media.durationSeconds,
    sizeBytes: media.sizeBytes,
    mtimeMs: media.mtimeMs,
  });

  return segments;
}

function readId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** URL du manifeste d'un fichier. Point d'entrée du lecteur. */
export function hlsUrlOf(mediaFileId: number): string {
  return `/api/hls/${mediaFileId}/index.m3u8`;
}

/**
 * Sert un fichier du répertoire de travail.
 *
 * Ces fichiers sont éphémères et propres à une session : le navigateur ne doit
 * surtout pas les garder en cache, il rejouerait un segment d'une session morte
 * après une relance de ffmpeg à une autre position.
 */
async function sendWorkFile(reply: FastifyReply, file: string, contentType: string): Promise<unknown> {
  const stats = await stat(file);
  void reply.header('Content-Type', contentType);
  void reply.header('Content-Length', stats.size);
  void reply.header('Cache-Control', 'no-store');
  return reply.send(createReadStream(file));
}

export function registerHlsRoutes(app: FastifyInstance, db: Db, sessions: () => SessionManager | null): void {
  /** Le manifeste et les segments n'existent que si ffmpeg a été trouvé. */
  function requireManager(reply: FastifyReply): SessionManager | null {
    const manager = sessions();
    if (manager === null) {
      void reply.code(503).send({
        error:
          'ffmpeg est introuvable sur le serveur : aucun remux n’est possible. ' +
          'Renseigner FFMPEG_PATH dans .env, puis relancer le serveur.',
      });
      return null;
    }
    return manager;
  }

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/index.m3u8 — le manifeste, complet dès la première requête
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/index.m3u8', async (request, reply) => {
    const manager = requireManager(reply);
    if (manager === null) return reply;

    const id = readId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'Identifiant de fichier invalide.' });

    const media = findMedia(db, id);
    if (media === undefined) {
      return reply.code(404).send({ error: 'Ce fichier n’est pas dans l’index, ou il n’est plus sur le disque.' });
    }

    const plan = await planOf(db, manager, media);
    if (plan.length === 0) {
      return reply.code(409).send({
        error:
          'Le découpage de ce fichier est impossible : sa durée est inconnue, ou ffprobe n’y a ' +
          'trouvé aucune image clé. Lancer « npm run probe » puis réessayer.',
      });
    }

    /*
     * La session démarre DÈS la demande du manifeste, sans attendre la première
     * requête de segment : ffmpeg a ainsi une longueur d'avance sur le lecteur,
     * qui met de toute façon quelques dizaines de millisecondes à analyser le
     * manifeste avant de réclamer le segment zéro.
     */
    const session = await manager.acquire({
      mediaFileId: id,
      inputPath: media.rawPath ?? media.path,
      plan,
    });
    if (session.status.state === 'idle') void session.startAt(0);

    void reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    void reply.header('Cache-Control', 'no-store');
    return buildPlaylist(plan, {
      init: `/api/hls/${id}/init.mp4`,
      segment: (index) => `/api/hls/${id}/${segmentFileName(index)}`,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/init.mp4 — en-tête fMP4, commun à tous les segments
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/init.mp4', async (request, reply) => {
    const manager = requireManager(reply);
    if (manager === null) return reply;

    const id = readId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'Identifiant de fichier invalide.' });

    const media = findMedia(db, id);
    if (media === undefined) return reply.code(404).send({ error: 'Fichier inconnu.' });

    const session = await manager.acquire({
      mediaFileId: id,
      inputPath: media.rawPath ?? media.path,
      plan: await planOf(db, manager, media),
    });

    const file = await session.ensureInit();
    if (file === null) {
      return reply.code(503).send({ error: session.status.error ?? 'ffmpeg n’a pas produit l’en-tête.' });
    }

    return sendWorkFile(reply, file, 'video/mp4');
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/seg-NNNNN.m4s — un segment, produit à la demande
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/seg-:index.m4s', async (request, reply) => {
    const manager = requireManager(reply);
    if (manager === null) return reply;

    const parameters = request.params as { id: string; index: string };
    const id = readId(parameters.id);
    if (id === null) return reply.code(400).send({ error: 'Identifiant de fichier invalide.' });

    const index = Number(parameters.index);
    if (!Number.isSafeInteger(index) || index < 0) {
      return reply.code(400).send({ error: 'Numéro de segment invalide.' });
    }

    const media = findMedia(db, id);
    if (media === undefined) return reply.code(404).send({ error: 'Fichier inconnu.' });

    const plan = await planOf(db, manager, media);
    if (index >= plan.length) return reply.code(404).send({ error: 'Segment hors du fichier.' });

    const session = await manager.acquire({
      mediaFileId: id,
      inputPath: media.rawPath ?? media.path,
      plan,
    });

    const file = await session.ensureSegment(index);
    if (file === null) {
      return reply.code(503).send({
        error: session.status.error ?? `Le segment ${index} n’a pas pu être produit à temps.`,
      });
    }

    return sendWorkFile(reply, file, 'video/iso.segment');
  });

  // -------------------------------------------------------------------------
  // DELETE /api/hls/:id/session — le lecteur prévient qu'il s'en va
  // -------------------------------------------------------------------------
  // Premier des trois filets contre le ffmpeg orphelin : c'est le plus rapide,
  // les deux autres (balayage, arrêt du serveur) rattrapent ce qu'il rate.
  app.delete('/api/hls/:id/session', async (request, reply) => {
    const manager = sessions();
    const id = readId((request.params as { id: string }).id);
    if (manager !== null && id !== null) await manager.release(id, 'le lecteur a quitté la page');
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // GET /api/transcode/sessions — état, pour la mise au point
  // -------------------------------------------------------------------------
  app.get('/api/transcode/sessions', () => {
    const manager = sessions();
    return manager === null ? { available: false, sessions: [] } : { available: true, sessions: manager.list() };
  });
}
