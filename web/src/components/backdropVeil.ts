/**
 * Opacités des deux calques posés sur l'image de fond d'une fiche.
 *
 * L'image ne défile pas : elle est fixée derrière toute la page. Ce qui change
 * au défilement, ce sont deux calques superposés, et rien d'autre :
 *
 * - `hero` porte les dégradés de composition — sombre à gauche pour que le
 *   titre reste lisible, sombre en bas pour amener les onglets. Ils n'ont de
 *   sens qu'en haut de page et s'effacent quand on descend.
 * - `veil` est un aplat sombre uniforme qui monte en puissance à mesure qu'on
 *   descend, jusqu'à un plafond volontairement inférieur à 1 : l'image doit
 *   rester devinable derrière le texte.
 *
 * Deux opacités sur deux éléments déjà composités, donc : aucun dégradé n'est
 * recalculé au défilement, le navigateur ne fait que mélanger des calques.
 */

/**
 * Plafond du voile. À 1, on aurait un fond uni et l'image ne servirait plus à
 * rien passé le premier écran ; à 0,86 elle reste perceptible sans gêner la
 * lecture.
 */
export const MAX_VEIL = 0.86;

/** Course du dégradé, en proportion de la hauteur de fenêtre. */
export const VEIL_SPAN_RATIO = 0.85;

export interface BackdropLayers {
  /** Opacité de l'aplat sombre. */
  veil: number;
  /** Opacité des dégradés de composition. */
  hero: number;
}

/** Course en pixels sur laquelle le voile passe de rien à son plafond. */
export function veilSpan(viewportHeight: number): number {
  return Math.max(1, viewportHeight * VEIL_SPAN_RATIO);
}

export function backdropLayers(scrollY: number, span: number): BackdropLayers {
  const progress = Math.min(1, Math.max(0, scrollY / Math.max(1, span)));
  return {
    veil: Number((progress * MAX_VEIL).toFixed(3)),
    hero: Number((1 - progress).toFixed(3)),
  };
}
