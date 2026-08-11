/**
 * Configuration du nettoyage des marques de sites de téléchargement.
 *
 * Ce fichier est fait pour être modifié sans toucher au code : ajoutez un nom
 * de site ou une extension de domaine dans les listes ci-dessous, les tests
 * couvrent la mécanique.
 *
 * Deux formes sont traitées, et pas de la même manière :
 *
 * 1. « darkino com-1141515-Star Wars 1 » — un domaine suivi d'un identifiant
 *    numérique entre tirets. Cette forme est reconnue de façon GÉNÉRIQUE : la
 *    séquence « -chiffres- » collée à un domaine n'existe pas dans un vrai
 *    titre, donc aucun nom de site n'a besoin d'être connu à l'avance.
 *
 * 2. « …infernale1080p darkino com » — le domaine seul, en bout de nom. Là il
 *    FAUT une liste : sans elle, « Le Grand Art » se ferait amputer de « Grand
 *    Art » (« art » est une extension de domaine), et « Le Bal des Folles » de
 *    « des Folles » si « folles » était un TLD. Une règle générique serait
 *    activement nuisible ici.
 */

/**
 * Extensions de domaine rencontrées dans les noms de release.
 * Sert uniquement à reconnaître la forme 1 (avec identifiant numérique).
 */
export const DOMAIN_SUFFIXES = [
  'com',
  'net',
  'org',
  'info',
  'biz',
  'club',
  'site',
  'link',
  'online',
  'xyz',
  'art',
  'tv',
  'cc',
  'io',
  'co',
  'me',
  'to',
  'ws',
  'st',
  'sx',
  'nz',
  'eu',
  'fr',
  'be',
  'ch',
  'ca',
  'ru',
];

/**
 * Noms de sites connus, à retirer même sans identifiant numérique.
 * Ajoutez les vôtres ici — la casse n'a pas d'importance.
 */
export const KNOWN_RELEASE_SITES = [
  'darkino',
  'tirexo',
  'wawacity',
  'zone-telechargement',
  'zone telechargement',
  'extreme-download',
  'annuaire-telechargement',
  'oxtorrent',
  'cpasbien',
  'yggtorrent',
  'torrent9',
  'gktorrent',
  'rarbg',
  'yts',
  'ettv',
  'eztv',
];

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DOMAIN_GROUP = DOMAIN_SUFFIXES.map(escapeForRegExp).join('|');
const SITE_GROUP = KNOWN_RELEASE_SITES.map(escapeForRegExp).join('|');

/**
 * Forme générique : un mot, un séparateur, une extension de domaine, puis un
 * identifiant numérique entre tirets. Reconnue où qu'elle soit dans le nom.
 *
 *   « darkino com-1141515- »   « www2.tirexo.art-4242- »
 */
const SITE_WITH_ID_RE = new RegExp(
  `(?:^|[\\s._-])[\\p{L}\\p{N}][\\p{L}\\p{N}-]*[\\s.](?:${DOMAIN_GROUP})\\s*-\\s*\\d{2,}\\s*-\\s*`,
  'giu',
);

/**
 * Forme nommée : un site connu, avec ou sans extension de domaine, seulement
 * en tout début ou en toute fin de nom — là où une marque de site se pose.
 */
const KNOWN_SITE_RE = new RegExp(
  `(?:^\\s*(?:www\\d*[\\s.])?(?:${SITE_GROUP})(?:[\\s.](?:${DOMAIN_GROUP}))?\\s*[-_.]?\\s*)` +
    `|(?:[\\s._-]+(?:www\\d*[\\s.])?(?:${SITE_GROUP})(?:[\\s.](?:${DOMAIN_GROUP}))?\\s*$)`,
  'giu',
);

/** Retire les marques de sites de téléchargement d'un nom de fichier. */
export function stripReleaseSites(value: string): string {
  return value.replace(SITE_WITH_ID_RE, ' ').replace(KNOWN_SITE_RE, ' ').replace(/\s+/g, ' ').trim();
}
