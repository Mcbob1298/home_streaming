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

import { SUBTITLE_CACHE_DIR } from '../config.js';
import type { Db } from '../db/index.js';
import {
  enqueueFiles,
  filesToPrepare,
  preparation,
  recentFailures,
  requeueMissing,
  subtitleQueue,
  workTotals,
} from '../transcode/subtitleQueue.js';

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
      // Même population que la passe elle-même : sans ffmpeg on ne peut rien
      // préparer, mais on doit dire la vérité sur ce qui reste à faire.
      const totals = workTotals(db);
      return {
        available: false,
        running: false,
        paused: false,
        current: null,
        filesDone: totals.filesDone,
        filesTotal: totals.files,
        bytesDone: totals.bytesDone,
        bytesTotal: totals.bytes,
        throughput: null,
        remainingSeconds: null,
        failures: recentFailures(db),
        unreachableRoot: null,
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
   *
   * ───────────────────────────────────────────────────────────────────────────
   * DEUX PASSES, PARCE QUE « MANQUANT » A DEUX SENS.
   *
   * `enqueueFiles` inscrit ce que la BASE ignore : un fichier jamais vu, ou
   * modifié depuis. Il compare des empreintes, et un travail `done` à empreinte
   * inchangée lui paraît à jour — même si son cache a disparu.
   *
   * `requeueMissing` inscrit ce que le DISQUE dément : les fichiers dont il
   * manque au moins un WebVTT. C'est la seule vérification qui aille regarder,
   * et c'est ce que le bouton « Rechercher ce qui manque » promet. Sans elle il
   * répondait « 0 nouveaux, 0 modifiés » sur une bibliothèque entière restée
   * sans sous-titres.
   *
   * Dans cet ordre : le rattrapage remet des travaux en attente, l'inscription
   * qui suit les compte alors pour ce qu'ils sont — déjà en file.
   * ───────────────────────────────────────────────────────────────────────────
   */
  app.post('/api/preparation/enqueue', (_request, reply) => {
    const rattrapes = requeueMissing(db, SUBTITLE_CACHE_DIR);
    const inscrits = enqueueFiles(db, filesToPrepare(db));
    preparation()?.wake();

    void reply.header('Cache-Control', 'no-store');
    return { ...inscrits, missing: rattrapes.missing, missingBytes: rattrapes.bytes };
  });

  // -------------------------------------------------------------------------
  // POST /api/preparation/retry-failed — relancer ce qui a résisté
  // -------------------------------------------------------------------------
  /*
   * La liste des échecs serait sans issue sans ce bouton : le rattrapage les
   * écarte volontairement — sinon un fichier définitivement impossible ferait
   * relire ses 94 Go à chaque clic — et il faudrait donc ouvrir un terminal pour
   * réessayer après avoir corrigé la cause.
   *
   * Le geste reste DÉLIBÉRÉ, et c'est la différence : c'est l'utilisateur qui
   * décide de retenter, pas une boucle automatique.
   */
  app.post('/api/preparation/retry-failed', (_request, reply) => {
    const relances = subtitleQueue(db).requeueFailed();
    preparation()?.wake();

    void reply.header('Cache-Control', 'no-store');
    return { retried: relances };
  });
}
