/**
 * Réécriture des chemins d'une racine à l'autre.
 *
 * La base a été construite sous Windows, avec des chemins UNC :
 *
 *     \\NASSSITO\Plex S1\Vidéos\films\Avatar\Avatar.mkv
 *
 * Sur le NAS, le même fichier est :
 *
 *     /mnt/@usb/sdb1/Vidéos/films/Avatar/Avatar.mkv
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI RÉÉCRIRE PLUTÔT QUE RESCANNER
 *
 * Un scan complet reconstruirait l'index, mais il ne reconstruirait PAS les
 * décisions humaines : 62 appariements TMDB validés à la main et les entrées
 * volontairement ignorées vivent dans `tmdb_match`, rattachées à des œuvres dont
 * les identifiants changeraient. Ces décisions ne sont pas reproductibles.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Module pur : une chaîne entre, une chaîne sort. Aucun accès disque, aucune
 * requête — c'est ce qui permet de le tester sans NAS sous la main.
 */

export interface RootMapping {
  /** Préfixe à remplacer, tel qu'il est en base. */
  from: string;
  /** Préfixe de remplacement, sur le système cible. */
  to: string;
}

/**
 * Sépare un chemin en segments, quel que soit le style de séparateur.
 *
 * Les segments VIDES sont conservés : ce sont eux qui portent la double barre
 * initiale d'un chemin UNC, et les retirer décalerait tout le reste.
 */
function segmentsOf(value: string): string[] {
  return value.split(/[\\/]/);
}

/**
 * Forme comparable d'un chemin.
 *
 * Insensible à la casse — Windows l'est — et aux séparateurs, pour qu'une
 * correspondance écrite avec des antislashs reconnaisse un chemin stocké avec
 * des slashs. La normalisation NFC met les accents composés et décomposés sous
 * la même forme : « Vidéos » écrit des deux façons doit correspondre.
 */
function comparable(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

/** Convertit les séparateurs en slashs et retire celui de fin. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

/**
 * Trie les correspondances de la plus spécifique à la plus générale.
 *
 * Sans ce tri, une racine « …\Vidéos » traiterait les fichiers de
 * « …\Vidéos\films » avant que la correspondance dédiée n'ait sa chance, et les
 * enverrait au mauvais endroit.
 */
export function orderMappings(mappings: RootMapping[]): RootMapping[] {
  return [...mappings].sort((a, b) => comparable(b.from).length - comparable(a.from).length);
}

/**
 * Réécrit un chemin, ou rend null si aucune correspondance ne s'applique.
 *
 * Null n'est pas une erreur en soi : c'est ce qui permet au rapport de dire
 * exactement quelles lignes n'ont pas été traitées, plutôt que de les réécrire
 * de travers.
 */
export function migratePath(value: string, mappings: RootMapping[]): string | null {
  const target = comparable(value);

  for (const mapping of orderMappings(mappings)) {
    const prefix = comparable(mapping.from);
    if (prefix === '') continue;

    // La comparaison porte sur des SEGMENTS entiers : sans cela,
    // « …\Vidéos\films » correspondrait aussi à « …\Vidéos\films-bonus ».
    if (target !== prefix && !target.startsWith(`${prefix}/`)) continue;

    /*
     * Le reste est repris TEL QUEL — casse et forme de normalisation d'origine
     * préservées — seuls les séparateurs changent.
     *
     * Le découpage garde les segments vides : « \\SERVEUR\partage » donne
     * ['', '', 'SERVEUR', 'partage'], et c'est cette longueur-là qu'il faut
     * retrancher au chemin complet.
     */
    const prefixSegments = segmentsOf(mapping.from);
    while (prefixSegments.length > 0 && prefixSegments.at(-1) === '') prefixSegments.pop();

    const rest = segmentsOf(value)
      .slice(prefixSegments.length)
      .filter((segment) => segment !== '');

    const base = toPosix(mapping.to).replace(/(.)\/$/, '$1');
    return rest.length === 0 ? base : `${base}/${rest.join('/')}`;
  }

  return null;
}

/** Une correspondance est-elle exploitable ? */
export function validateMapping(mapping: RootMapping): string | null {
  if (mapping.from.trim() === '') return 'la source est vide';
  if (mapping.to.trim() === '') return 'la destination est vide';
  if (!mapping.to.startsWith('/')) return `la destination « ${mapping.to} » n’est pas un chemin absolu`;
  return null;
}

/**
 * Analyse un argument `--map=<source>=><destination>`.
 *
 * Le séparateur est `=>` et non `=` : les chemins Windows n'en contiennent
 * jamais, alors qu'un simple `=` se retrouve dans des noms de fichiers.
 */
export function parseMapping(argument: string): RootMapping | null {
  const separator = argument.indexOf('=>');
  if (separator === -1) return null;

  const from = argument.slice(0, separator).trim();
  const to = argument.slice(separator + 2).trim();
  if (from === '' || to === '') return null;

  return { from, to };
}
