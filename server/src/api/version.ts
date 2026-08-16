/**
 * `GET /api/version` — QUEL CODE CE CONTENEUR SERT-IL RÉELLEMENT ?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DEUX FOIS DU TEMPS PERDU SUR UN CONTENEUR QUI SERVAIT DU CODE PÉRIMÉ.
 *
 * Rien ne le signalait : le serveur répondait, l'interface s'affichait, et les
 * symptômes qu'on croyait corrigés revenaient à l'identique. On cherchait le
 * défaut dans le code qu'on venait d'écrire, alors que le conteneur exécutait
 * celui d'avant.
 *
 * Un serveur doit pouvoir dire ce qu'il exécute. C'est la première question à
 * poser après chaque mise en service, et la seule dont la réponse invalide
 * toutes les autres mesures si elle est fausse.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INJECTÉ À LA CONSTRUCTION, LU AU DÉMARRAGE. JAMAIS CALCULÉ À LA VOLÉE.
 *
 * Le commit ne peut PAS être déduit à l'exécution : le NAS n'a pas git, l'image
 * ne contient pas `.git` — le `.dockerignore` l'exclut — et une valeur qu'on
 * irait chercher dans un fichier monté en volume décrirait le dépôt de l'hôte,
 * pas le code compilé dans l'image. Ce sont précisément deux choses différentes,
 * et leur confusion est le défaut qu'on cherche à détecter.
 *
 * La valeur entre donc par un `ARG` du Dockerfile, devient une variable
 * d'environnement de l'étage d'exécution, et est capturée ICI au chargement du
 * module. Une constante figée à l'import : rien ne peut la faire varier ensuite,
 * et deux appels à distance d'heures rendent forcément la même chose.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { FastifyInstance } from 'fastify';

/**
 * Capturé À L'IMPORT, une fois pour la vie du processus.
 *
 * `process.env` reste modifiable ; une lecture à chaque requête laisserait la
 * réponse dériver de ce qui a été construit. C'est une photo, pas un capteur.
 */
const VERSION = Object.freeze({
  /** Le commit dont le JavaScript de `server/dist` a été compilé. */
  commit: process.env.GIT_COMMIT ?? 'inconnu',
  /** Horodatage de la construction de l'image, en ISO 8601. */
  builtAt: process.env.BUILD_DATE ?? 'inconnu',
  /** Instant du démarrage : distingue « reconstruit » de « seulement relancé ». */
  startedAt: new Date().toISOString(),
});

export function registerVersionRoute(app: FastifyInstance): void {
  /*
   * Sans cache, et pour une raison précise : cette route sert à constater l'état
   * d'un déploiement. Une réponse mise en cache par un mandataire dirait l'état
   * d'AVANT, ce qui est exactement le mensonge qu'elle existe pour empêcher.
   */
  app.get('/api/version', (_request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    return {
      ...VERSION,
      /** Depuis combien de temps ce processus tourne, en secondes. */
      uptimeSeconds: Math.round(process.uptime()),
    };
  });
}
