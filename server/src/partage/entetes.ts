/**
 * LES EN-TÊTES QUE LE FRONT ET LE SERVEUR SE PARTAGENT.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * UN SEUL LITTÉRAL, PARCE QUE DEUX ONT DÉJÀ MENTI.
 *
 * Le nom de l'en-tête de capacité était écrit deux fois : `'X-Client-Hevc'`
 * côté navigateur, `'x-client-hevc'` côté serveur. Les deux étaient JUSTES —
 * Node met les en-têtes reçus en minuscules, la comparaison fonctionnait — mais
 * la vérification, elle, s'y est trompée : un `grep x-client-hevc` sur le bundle
 * servi n'a rien trouvé et a laissé croire un instant que la sonde manquait.
 *
 * Le défaut n'était donc pas dans le code, il était dans ce que le code permet
 * de vérifier. Une chaîne écrite deux fois se cherche deux fois.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE FICHIER EST DANS `server/src` ALORS QU'IL SERT AUX DEUX.
 *
 * Le serveur compile avec `rootDir: "src"` : un module placé au-dessus le ferait
 * échouer. Le front, lui, est bundlé par Vite, qui sait suivre un alias hors de
 * `web/` — c'est donc lui qui vient chercher, par `@partage`.
 *
 * Contrainte à respecter ici : ce fichier part DANS LE NAVIGATEUR. Aucun import
 * Node, aucun accès au système de fichiers, rien qui ne soit une constante ou
 * une fonction pure.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Ce client sait-il décoder le HEVC 10 bits ?
 *
 * Posé par le lecteur sur chacune de ses requêtes, lu par le serveur pour
 * décider si le HDR peut voyager intact. Voir `web/src/capacites.ts` pour la
 * sonde et `server/src/playback/capacites.ts` pour la lecture.
 *
 * La casse est celle de l'écriture HTTP habituelle. Elle n'a aucune importance
 * pour le protocole — les noms d'en-tête sont insensibles à la casse — mais elle
 * en a pour qui cherche cette chaîne dans un bundle minifié.
 */
export const HEVC_HEADER = 'X-Client-Hevc';

/**
 * Le même nom, en minuscules.
 *
 * Node normalise les en-têtes REÇUS en minuscules : c'est sous cette forme qu'ils
 * apparaissent dans `request.headers`. Dérivé plutôt que réécrit — c'est
 * exactement la duplication qu'on vient de supprimer.
 */
export const HEVC_HEADER_RECU = HEVC_HEADER.toLowerCase();
