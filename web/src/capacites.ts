/**
 * CE QUE CE NAVIGATEUR SAIT DÉCODER — sondé une fois, envoyé partout.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI UN MODULE À PART PLUTÔT QU'UNE FONCTION DANS LE LECTEUR.
 *
 * Deux appelants ont besoin de la même réponse, et ils ne se connaissent pas :
 * le LECTEUR, qui pose l'en-tête sur chaque requête de hls.js, et le CLIENT
 * D'API, qui interroge la route de playability dont dépend le texte affiché à
 * l'utilisateur.
 *
 * Les laisser sonder chacun de leur côté, c'est la même faute que le dépôt a
 * corrigée trois fois cette semaine — la géométrie de sortie, le débit de
 * l'empreinte, les bornes de sonde : une règle écrite deux fois finit vraie à un
 * seul endroit. Ici, elle ferait annoncer du H.264 sur la fiche pendant que le
 * lecteur reçoit du HEVC.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { HEVC_HEADER } from '@partage/entetes.js';

export { HEVC_HEADER };

/**
 * Ce navigateur décode-t-il le HEVC 10 bits (Main 10, niveau 5.1) ?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `MediaSource.isTypeSupported`, ET SURTOUT PAS `canPlayType`.
 *
 * `canPlayType` répond « maybe » pour des flux qu'il ne lit pas. Ce « maybe »
 * lu comme un oui a déjà coûté des semaines ici : le lecteur croyait Chrome
 * capable de HLS natif, hls.js n'était jamais chargé, et le changement de piste
 * audio ne pouvait pas fonctionner — sans que rien ne le signale, puisque la
 * vidéo se lisait quand même.
 *
 * `isTypeSupported` est de surcroît la question que hls.js pose lui-même avant
 * d'ouvrir un SourceBuffer : si elle répond faux, aucun réglage serveur n'y
 * changera rien.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `hvc1.2.4.L153.B0` se lit : HEVC, profil Main 10 (le `2`), niveau 5.1
 * (`L153`). La forme `hev1` ne diffère que par le placement des jeux de
 * paramètres ; certains navigateurs n'acceptent que l'une des deux, et le flux
 * produit porte l'étiquette `hev1`. On accepte donc l'une OU l'autre.
 *
 * En cas de doute, NON : le serveur retombe sur le H.264 tone-mappé, que tout
 * décode. Sur des appareils qu'on ne connaît pas, mieux vaut une image moins
 * bonne qu'une image absente.
 */
function sonder(): boolean {
  if (typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') return false;
  return (
    MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"') ||
    MediaSource.isTypeSupported('video/mp4; codecs="hev1.2.4.L153.B0"')
  );
}

/**
 * Sondé UNE fois par chargement de page.
 *
 * Les décodeurs installés ne changent pas en cours de session, et l'en-tête part
 * sur chaque segment : refaire le test à chaque requête coûterait sans rien
 * apprendre.
 */
let reponse: boolean | null = null;

export function clientDecodesHevc(): boolean {
  if (reponse === null) reponse = sonder();
  return reponse;
}

/** L'en-tête prêt à poser, pour `fetch` comme pour `xhrSetup`. */
export function enTeteCapacites(): Record<string, string> {
  return { [HEVC_HEADER]: clientDecodesHevc() ? '1' : '0' };
}
