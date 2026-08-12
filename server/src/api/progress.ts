/**
 * Routes de reprise de lecture.
 *
 * L'identifiant d'utilisateur ne figure dans AUCUNE de ces requêtes : il vient
 * de `currentUserId()`, seul endroit qui sait qui regarde. Le jour où une vraie
 * session existera, rien ici ne changera.
 */
import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.js';
import type { MediaType } from '../progress/rules.js';
import { episodeLabel, pickShowEntry, ratioOf } from '../progress/rules.js';
import {
  continueWatching,
  episodeProgressOf,
  episodeStatesOf,
  forget,
  progressOf,
  saveProgress,
  setWatched,
} from '../progress/store.js';
import { currentUserId } from '../progress/user.js';

function readId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function titleOfEpisode(db: Db, episodeId: number): string | null {
  const row = db.prepare('SELECT title FROM episode WHERE id = ?').get(episodeId) as
    | { title: string | null }
    | undefined;
  return row?.title ?? null;
}

function readMediaType(value: unknown): MediaType | null {
  return value === 'movie' || value === 'episode' ? value : null;
}

/** Nombre fini et positif, ou null. Le lecteur peut envoyer NaN sur un flux. */
function readSeconds(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function registerProgressRoutes(app: FastifyInstance, db: Db): void {
  // -------------------------------------------------------------------------
  // POST /api/progress — appelée toutes les dix secondes pendant la lecture
  // -------------------------------------------------------------------------
  app.post('/api/progress', (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const mediaFileId = readId(body?.mediaFileId);
    const positionSeconds = readSeconds(body?.positionSeconds);

    if (mediaFileId === null || positionSeconds === null) {
      return reply.code(400).send({ error: 'mediaFileId et positionSeconds sont requis.' });
    }

    const result = saveProgress(db, {
      userId: currentUserId(db, request),
      mediaFileId,
      positionSeconds,
      durationSeconds: readSeconds(body?.durationSeconds),
    });

    if (result === null) {
      return reply.code(404).send({ error: 'Ce fichier n’est rattaché à aucune œuvre.' });
    }

    /*
     * Un enregistrement de position part toutes les dix secondes : la réponse
     * doit rester minuscule. Elle ne porte que ce que le lecteur ne sait pas
     * déjà — le verdict « vu », qui est décidé par le serveur.
     */
    return { watched: result.watched, mediaType: result.mediaType, mediaId: result.mediaId };
  });

  // -------------------------------------------------------------------------
  // GET /api/progress/continue — la rangée « Continuer à regarder »
  // -------------------------------------------------------------------------
  app.get('/api/progress/continue', (request) => {
    return continueWatching(db, currentUserId(db, request));
  });

  // -------------------------------------------------------------------------
  // GET /api/progress/show/:id — la grille d'épisodes, et où reprendre
  // -------------------------------------------------------------------------
  // Déclarée AVANT la route paramétrée : « show » n'est pas un type de média,
  // et Fastify fait de toute façon primer le segment littéral sur le paramètre.
  app.get('/api/progress/show/:id', (request, reply) => {
    const showId = readId((request.params as { id: string }).id);
    if (showId === null) {
      return reply.code(400).send({ error: 'Identifiant de série invalide.' });
    }

    const userId = currentUserId(db, request);

    const episodes = [...episodeProgressOf(db, userId, showId)].map(([episodeId, entry]) => ({
      episodeId,
      positionSeconds: entry.positionSeconds,
      durationSeconds: entry.durationSeconds,
      watched: entry.watched,
      ratio: ratioOf(entry.positionSeconds, entry.durationSeconds),
    }));

    /*
     * Le point de reprise vient de la MÊME règle que la rangée « Continuer à
     * regarder » : la fiche et l'accueil doivent désigner le même épisode, sans
     * quoi le bouton de la fiche et la vignette de l'accueil se contrediraient.
     */
    const picked = pickShowEntry(episodeStatesOf(db, userId, showId), new Date());
    const resume =
      picked === null || picked.episode.mediaFileId === null
        ? null
        : {
            kind: picked.kind,
            episodeId: picked.episode.episodeId,
            mediaFileId: picked.episode.mediaFileId,
            label: episodeLabel(
              picked.episode.seasonNumber,
              picked.episode.episodeNumber,
              titleOfEpisode(db, picked.episode.episodeId),
            ),
            // Sans le titre : sur un bouton, « S02:E01 » suffit et tient dans
            // la largeur, là où « S02:E01 Le goût du risque » déborderait.
            numbering: episodeLabel(picked.episode.seasonNumber, picked.episode.episodeNumber, null),
            // Un épisode suivant repart du début : rien à y reprendre.
            positionSeconds: picked.kind === 'next' ? 0 : picked.episode.positionSeconds,
          };

    return { episodes, resume };
  });

  // -------------------------------------------------------------------------
  // GET /api/progress/:type/:id — l'état d'une œuvre, pour le bouton « Reprendre »
  // -------------------------------------------------------------------------
  app.get('/api/progress/:type/:id', (request, reply) => {
    const parameters = request.params as { type: string; id: string };
    const mediaType = readMediaType(parameters.type);
    const mediaId = readId(parameters.id);

    if (mediaType === null || mediaId === null) {
      return reply.code(400).send({ error: 'Type ou identifiant d’œuvre invalide.' });
    }

    /*
     * Jamais commencé n'est pas une erreur : c'est un état, et la fiche doit
     * pouvoir l'afficher sans traiter un 404. On renvoie donc une progression
     * à zéro plutôt qu'une absence.
     */
    const stored = progressOf(db, currentUserId(db, request), mediaType, mediaId);
    return (
      stored ?? { positionSeconds: 0, durationSeconds: null, watched: false, mediaFileId: null }
    );
  });

  // -------------------------------------------------------------------------
  // POST /api/progress/:type/:id/watched — marquage manuel
  // -------------------------------------------------------------------------
  for (const [suffix, watched] of [
    ['watched', true],
    ['unwatched', false],
  ] as const) {
    app.post(`/api/progress/:type/:id/${suffix}`, (request, reply) => {
      const parameters = request.params as { type: string; id: string };
      const mediaType = readMediaType(parameters.type);
      const mediaId = readId(parameters.id);

      if (mediaType === null || mediaId === null) {
        return reply.code(400).send({ error: 'Type ou identifiant d’œuvre invalide.' });
      }

      setWatched(db, currentUserId(db, request), mediaType, mediaId, watched);
      return reply.code(204).send();
    });
  }

  // -------------------------------------------------------------------------
  // DELETE /api/progress/:type/:id — « Retirer de la liste »
  // -------------------------------------------------------------------------
  // Différent de « marquer comme vu » : on oublie l'œuvre sans prétendre
  // qu'elle a été regardée. Elle ne réapparaîtra qu'à la prochaine lecture.
  app.delete('/api/progress/:type/:id', (request, reply) => {
    const parameters = request.params as { type: string; id: string };
    const mediaType = readMediaType(parameters.type);
    const mediaId = readId(parameters.id);

    if (mediaType === null || mediaId === null) {
      return reply.code(400).send({ error: 'Type ou identifiant d’œuvre invalide.' });
    }

    forget(db, currentUserId(db, request), mediaType, mediaId);
    return reply.code(204).send();
  });
}
