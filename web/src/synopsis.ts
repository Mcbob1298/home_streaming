/**
 * Réduction d'un synopsis à son accroche.
 *
 * La fiche affiche une phrase, pas un paragraphe : « Un homme part à l'aventure
 * dans un monde nouveau qui l'adopte et il se bat pour le protéger. » Le
 * synopsis complet, lui, vit dans l'onglet Détails.
 *
 * Module pur : une chaîne entre, une chaîne sort.
 */

/** Longueur visée. Approximative : on coupe sur une frontière, pas au caractère. */
export const SHORT_SYNOPSIS_LIMIT = 150;

/**
 * Longueur minimale d'une phrase pour que son point soit pris au sérieux.
 *
 * Sans ce garde-fou, « M. Smith part en guerre. » serait coupé à « M. » : le
 * point d'une initiale ou d'une abréviation ressemble en tout point à celui
 * d'une fin de phrase.
 */
const MIN_SENTENCE = 25;

/** Ponctuations sur lesquelles on accepte de couper une phrase trop longue. */
const SOFT_BREAKS = [',', ';', ':', '—', '–'];

/** Première phrase du texte, ou le texte entier s'il n'en contient qu'une. */
export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();

  for (const match of clean.matchAll(/[.!?…]+/g)) {
    const end = (match.index ?? 0) + match[0].length;
    const after = clean.slice(end);

    // Un point suivi d'un chiffre ou d'une lettre est une décimale ou une
    // abréviation collée, pas une fin de phrase.
    if (after !== '' && !after.startsWith(' ')) continue;
    if (end < MIN_SENTENCE) continue;

    return clean.slice(0, end);
  }

  return clean;
}

/** Retire ce qui ne doit pas précéder des points de suspension. */
function trimForEllipsis(value: string): string {
  return value.replace(/[\s.,;:!?—–]+$/, '');
}

/**
 * Coupe une phrase trop longue sur une frontière lisible.
 *
 * On préfère une ponctuation — la coupure y est naturelle — et on se rabat sur
 * l'espace précédent. Jamais au milieu d'un mot.
 */
function truncateAtBoundary(sentence: string, limit: number): string {
  const window = sentence.slice(0, limit);

  let cut = -1;
  for (const character of SOFT_BREAKS) {
    const index = window.lastIndexOf(character);
    // Une virgule dans les vingt premiers caractères donnerait un fragment
    // inutilisable : on ne coupe que dans la seconde moitié.
    if (index > cut && index >= limit * 0.55) cut = index;
  }

  if (cut === -1) cut = window.lastIndexOf(' ');
  if (cut === -1) cut = window.length;

  return `${trimForEllipsis(window.slice(0, cut))}…`;
}

/** Accroche affichée sur la fiche : première phrase, plafonnée. */
export function shortSynopsis(text: string | null | undefined, limit = SHORT_SYNOPSIS_LIMIT): string | null {
  if (text === null || text === undefined) return null;

  const sentence = firstSentence(text);
  if (sentence === '') return null;
  if (sentence.length <= limit) return sentence;

  return truncateAtBoundary(sentence, limit);
}
