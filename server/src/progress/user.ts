/**
 * Qui regarde.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UN SEUL ENDROIT RÉPOND À CETTE QUESTION.
 *
 * Tant qu'il n'y a pas d'authentification, tout est rattaché à l'utilisateur
 * « default » créé au premier lancement. Mais aucune requête ne code ce nom en
 * dur : elles demandent toutes l'identifiant à `currentUserId()`.
 *
 * Le jour où une vraie session existera, cette fonction lira le jeton de la
 * requête et rien d'autre ne bougera. C'est pour cela qu'elle prend déjà la
 * requête en paramètre, même si elle l'ignore encore.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Db } from '../db/index.js';
import { DEFAULT_USER_NAME } from '../db/index.js';

/** Ce que la fonction saura lire un jour. Ignoré pour l'instant. */
export interface RequestIdentity {
  headers?: Record<string, string | string[] | undefined>;
}

let cachedId: number | null = null;

/**
 * Identifiant de l'utilisateur courant.
 *
 * L'identifiant est mémorisé : la table `user` ne change pas en cours
 * d'exécution, et cette fonction est appelée à chaque enregistrement de
 * position — toutes les dix secondes par lecteur actif.
 */
export function currentUserId(db: Db, _request?: RequestIdentity): number {
  if (cachedId !== null) return cachedId;

  const row = db.prepare('SELECT id FROM user WHERE name = ?').get(DEFAULT_USER_NAME) as
    | { id: number }
    | undefined;

  if (row !== undefined) {
    cachedId = row.id;
    return cachedId;
  }

  /*
   * L'utilisateur par défaut est créé à l'ouverture de la base. S'il manque
   * — base restaurée d'une sauvegarde ancienne, par exemple — on le recrée
   * plutôt que de faire échouer toute la lecture.
   */
  const created = db
    .prepare('INSERT INTO user (name, created_at) VALUES (?, ?) RETURNING id')
    .get(DEFAULT_USER_NAME, new Date().toISOString()) as { id: number };

  cachedId = created.id;
  return cachedId;
}

/** Vide le cache. Utile aux tests, et au jour où les sessions arriveront. */
export function forgetCurrentUser(): void {
  cachedId = null;
}
