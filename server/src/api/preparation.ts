/**
 * Routes de la préparation des sous-titres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CES ROUTES PILOTENT, ELLES NE TRAVAILLENT PAS.
 *
 * Aucune n'extrait quoi que ce soit : elles lisent un état, ou elles disent à la
 * passe de s'arrêter et de reprendre. L'extraction reste dans la file persistée,
 * hors de tout cycle de requête — c'est la règle du projet depuis `probe`, et
 * elle vaut d'autant plus ici que la passe dure seize heures.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.js';
import { enqueueFiles, filesToPrepare, preparation, subtitleQueue } from '../transcode/subtitleQueue.js';

export function registerPreparationRoutes(app: FastifyInstance, db: Db): void {
  // -------------------------------------------------------------------------
  // GET /api/preparation/status — interrogée toutes les 5 s PENDANT une passe
  // -------------------------------------------------------------------------
  /*
   * Volontairement minuscule : c'est la seule route que le front interroge en
   * boucle, et il ne le fait que tant qu'une passe tourne. Elle ne lit que des
   * compteurs — jamais le disque, jamais un répertoire de cache.
   */
  app.get('/api/preparation/status', (_request, reply) => {
    void reply.header('Cache-Control', 'no-store');

    const passe = preparation();
    if (passe === null) {
      const counts = subtitleQueue(db).counts();
      return {
        available: false,
        running: false,
        paused: false,
        current: null,
        filesDone: counts.done + counts.skipped,
        filesTotal: counts.total,
        bytesDone: 0,
        bytesTotal: 0,
        throughput: null,
        remainingSeconds: null,
        failures: [],
      };
    }

    return { available: true, ...passe.status() };
  });

  // -------------------------------------------------------------------------
  // POST /api/preparation/pause — rendre le disque, tout de suite
  // -------------------------------------------------------------------------
  /*
   * Ce n'est pas « ne plus prendre de travail » : le ffmpeg en cours est TUÉ.
   * Attendre la fin de l'extraction courante, ce serait attendre jusqu'à seize
   * minutes sur le plus gros fichier — or la pause existe précisément pour
   * pouvoir regarder un film maintenant.
   *
   * Le travail interrompu retourne en attente, il n'est pas compté en échec.
   */
  app.post('/api/preparation/pause', (_request, reply) => {
    const passe = preparation();
    if (passe === null) return reply.code(503).send({ error: 'Aucune préparation n’est active sur ce serveur.' });

    passe.pause();
    return { paused: true };
  });

  // -------------------------------------------------------------------------
  // POST /api/preparation/resume
  // -------------------------------------------------------------------------
  app.post('/api/preparation/resume', (_request, reply) => {
    const passe = preparation();
    if (passe === null) return reply.code(503).send({ error: 'Aucune préparation n’est active sur ce serveur.' });

    passe.resume();
    return { paused: false };
  });

  // -------------------------------------------------------------------------
  // POST /api/preparation/enqueue — inscrire ce qui manque
  // -------------------------------------------------------------------------
  /*
   * Le seul déclenchement admis depuis l'interface, et il n'extrait rien : il
   * inscrit dans la file ce qui n'y est pas encore. Utile après un scan lancé
   * ailleurs, ou pour rattraper une bibliothèque jamais préparée sans avoir à
   * ouvrir un terminal.
   */
  app.post('/api/preparation/enqueue', (_request, reply) => {
    const inscrits = enqueueFiles(db, filesToPrepare(db));
    preparation()?.wake();

    void reply.header('Cache-Control', 'no-store');
    return inscrits;
  });
}
