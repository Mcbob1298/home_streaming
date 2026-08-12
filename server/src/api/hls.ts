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
import { findMedia, resolvePlayback, type MediaRow, type ResolvedPlayback } from '../playback/resolve.js';
import type { SessionManager } from '../transcode/manager.js';
import { buildPlaylist, segmentFileName } from '../transcode/segments.js';
import { streamUrlOf } from './stream.js';

/**
 * Résout une lecture pour les routes HLS.
 *
 * La décision, le plan et les paramètres de session viennent tous de la même
 * fonction que la route de playability : deux résolutions divergentes
 * produiraient un manifeste que la session ne sait pas honorer.
 */
async function resolve(db: Db, manager: SessionManager, media: MediaRow): Promise<ResolvedPlayback> {
  return resolvePlayback(
    db,
    manager.ffmpegBinary,
    media,
    { file: streamUrlOf(media.id), hls: hlsUrlOf(media.id) },
    { transcodeAvailable: true },
  );
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

    const resolved = await resolve(db, manager, media);
    const plan = resolved.plan;

    if (plan.length === 0) {
      return reply.code(409).send({
        error:
          resolved.decision.mode === 'unsupported'
            ? resolved.decision.reason
            : 'Le découpage de ce fichier est impossible : sa durée est inconnue, ou ffprobe n’y a ' +
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
      mode: resolved.decision.mode === 'transcode' ? 'transcode' : 'remux',
      source: resolved.source,
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

    const resolved = await resolve(db, manager, media);
    const session = await manager.acquire({
      mediaFileId: id,
      inputPath: media.rawPath ?? media.path,
      plan: resolved.plan,
      mode: resolved.decision.mode === 'transcode' ? 'transcode' : 'remux',
      source: resolved.source,
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

    const resolved = await resolve(db, manager, media);
    if (index >= resolved.plan.length) return reply.code(404).send({ error: 'Segment hors du fichier.' });

    const session = await manager.acquire({
      mediaFileId: id,
      inputPath: media.rawPath ?? media.path,
      plan: resolved.plan,
      mode: resolved.decision.mode === 'transcode' ? 'transcode' : 'remux',
      source: resolved.source,
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
