/**
 * Quand enregistrer une position, et où reprendre.
 *
 * Le lecteur envoie des FAITS — une position, une durée — jamais un verdict :
 * c'est le serveur qui décide si l'œuvre est vue, à partir du seuil de 90 %.
 * Ce module ne tranche donc qu'une chose : faut-il envoyer, ou se taire.
 *
 * Il est pur, et testé à part : la cadence d'enregistrement est exactement le
 * genre de règle qu'on ne peut pas vérifier à l'œil dans un lecteur vidéo.
 */

/** Cadence pendant la lecture. Dix secondes perdues au pire, c'est acceptable. */
export const REPORT_INTERVAL_MS = 10_000;

/**
 * En deçà, la lecture n'a pas réellement démarré.
 *
 * Ouvrir une fiche par curiosité, voir trois secondes et refermer ne doit pas
 * remplir « Continuer à regarder » : la rangée deviendrait un historique de
 * clics au lieu d'une liste de choses commencées.
 */
export const MIN_REPORTED_SECONDS = 5;

/** En deçà de cet écart, la position n'a pas bougé assez pour valoir un envoi. */
const MIN_DELTA_SECONDS = 1;

/**
 * Le tout dernier instant d'un fichier n'est pas une position de reprise.
 *
 * Le serveur remet déjà à zéro une œuvre terminée ; ce garde-fou couvre le cas
 * d'une durée absente à l'enregistrement — reprendre à deux secondes de la fin
 * rejouerait le générique en boucle.
 */
const END_GUARD_SECONDS = 5;

export interface Report {
  mediaFileId: number;
  positionSeconds: number;
  durationSeconds: number | null;
}

/** Une durée exploitable, ou null. Un flux annonce volontiers Infinity ou NaN. */
export function usableDuration(duration: number | undefined | null): number | null {
  if (duration === undefined || duration === null) return null;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

/**
 * Faut-il envoyer cette position ?
 *
 * `lastReported` est la dernière position déjà partie, ou null si rien n'est
 * encore parti pour ce fichier.
 */
export function worthReporting(positionSeconds: number, lastReported: number | null): boolean {
  if (!Number.isFinite(positionSeconds)) return false;
  if (positionSeconds < MIN_REPORTED_SECONDS) return false;
  if (lastReported === null) return true;
  return Math.abs(positionSeconds - lastReported) >= MIN_DELTA_SECONDS;
}

/**
 * Où placer la tête de lecture à l'ouverture.
 *
 * Zéro veut dire « depuis le début » : on ne touche alors pas à `currentTime`,
 * ce qui évite un aller-retour de mise en tampon inutile.
 */
export function resumeAt(resumeSeconds: number, durationSeconds: number | null): number {
  if (!Number.isFinite(resumeSeconds) || resumeSeconds < MIN_REPORTED_SECONDS) return 0;
  if (durationSeconds === null) return resumeSeconds;
  return resumeSeconds > durationSeconds - END_GUARD_SECONDS ? 0 : resumeSeconds;
}
