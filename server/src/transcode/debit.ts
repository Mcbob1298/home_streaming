/**
 * BRIDER LA PRODUCTION, PARCE QUE LE RÉPERTOIRE DE TRAVAIL EST EN MÉMOIRE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * À 49× LE TEMPS RÉEL, FFMPEG REMPLIT LA PARTITION EN SECONDES.
 *
 * Le remux ne réencode rien : il copie le flux, donc il va aussi vite que le
 * disque le permet — 49× mesuré sur Avatar. Un segment de dix secondes pèse
 * alors 78 Mo, et le `workDir` est un tmpfs d'un gigaoctet : douze segments,
 * deux minutes de film. Laissé libre, ffmpeg sature la partition avant que le
 * lecteur n'ait consommé la première minute.
 *
 * Le transcodage n'avait pas ce problème — à 1,2× il ne prend jamais d'avance.
 * C'est le remux qui le crée, et c'est pour lui que ce bridage existe.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Deux réglages, et ils se complètent :
 *
 *   • une RAFALE initiale à pleine vitesse, pour que le lecteur dispose tout de
 *     suite d'une avance confortable — c'est ce qui manquait, et c'est le seul
 *     avantage que Plex avait sur nous : son client attend d'avoir soixante
 *     secondes avant de jouer, quand nous servions avec trois ;
 *   • un DÉBIT plafonné ensuite, à peine plus rapide que la lecture, pour que
 *     l'avance se maintienne sans jamais croître.
 *
 * `-readrate` fait dormir le fil de lecture : le processus reste vivant et
 * aucune relance n'est nécessaire. C'est préférable à un découpage en exécutions
 * bornées, qui multiplierait les en-têtes et les jonctions.
 */

/**
 * Secondes lues à pleine vitesse avant que le plafond ne s'applique.
 *
 * Quarante secondes pèsent 297 Mo en remux 4K — le tiers du tmpfs — et donnent
 * au lecteur de quoi absorber un à-coup réseau. C'est aussi ce dont il dispose
 * après un déplacement, puisque chaque relance repart avec sa propre rafale.
 */
export const RAFALE_SECONDES = 40;

/**
 * Plafond de production, en multiples du temps réel.
 *
 * 1,5× laisse l'avance se reconstituer après un à-coup sans jamais l'emballer.
 * Le transcodage tourne à 1,2× et n'atteint donc pas ce plafond : le réglage est
 * sans effet sur lui, ce qui évite d'avoir deux chemins à maintenir.
 */
export const DEBIT_MAXIMAL = 1.5;

/**
 * Secondes de film CONSERVÉES DERRIÈRE la tête de lecture.
 *
 * Un petit recul — les dix secondes d'un bouton « reculer », un ajustement de la
 * barre de progression — ne doit pas relancer ffmpeg. En deçà de cette marge on
 * garde tout ; au-delà, les segments sont effacés au fil de la lecture.
 *
 * Trente secondes coûtent 223 Mo en remux 4K. Avec la rafale, le pire cas tient
 * dans 520 Mo, soit la moitié du tmpfs — la marge est délibérée : deux sessions
 * simultanées doivent y tenir.
 */
export const RECUL_SECONDES = 30;

/**
 * Arguments d'ENTRÉE qui brident la lecture du fichier source.
 *
 * À placer avant `-i`, comme tout ce qui concerne l'entrée.
 */
/**
 * Quels fichiers de segment effacer, d'après ce que le répertoire CONTIENT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PARTIR DES FICHIERS PRÉSENTS, ET NON DES INDEX ATTENDUS.
 *
 * La première version descendait les index depuis la position lue et s'arrêtait
 * au premier fichier absent. Après un déplacement, les segments juste avant la
 * nouvelle position n'ont jamais été produits : elle s'arrêtait aussitôt et
 * n'atteignait jamais ceux des positions précédentes. Mesuré en conditions
 * réelles — huit sauts, 58 segments accumulés, 2742 Mo occupés, zéro effacé.
 *
 * Une lecture linéaire ne l'aurait jamais montré, puisque les index s'y suivent
 * sans trou. D'où la forme de cette fonction : elle prend la liste réelle.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function aElaguer(
  noms: string[],
  plan: { start: number }[],
  indexLu: number,
): string[] {
  const position = plan[indexLu]?.start;
  if (position === undefined) return [];

  const limite = position - RECUL_SECONDES;
  if (limite <= 0) return [];

  return noms.filter((nom) => {
    const m = /^seg-(\d+)\.m4s$/.exec(nom);
    if (m === null) return false;

    const segment = plan[Number(m[1])];
    // Un segment hors plan ne se date pas : on le garde plutôt que d'effacer ce
    // qu'on ne sait pas situer.
    return segment !== undefined && segment.start < limite;
  });
}

export function bridageArgs(): string[] {
  return [
    '-readrate_initial_burst',
    String(RAFALE_SECONDES),
    '-readrate',
    String(DEBIT_MAXIMAL),
  ];
}
