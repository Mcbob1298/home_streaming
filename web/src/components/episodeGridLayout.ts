/**
 * Calculs de la grille d'épisodes, sans DOM.
 *
 * La virtualisation d'une grille est plus fragile que celle d'une liste : la
 * hauteur d'une rangée dépend de la largeur disponible (vignettes 16:9) ET de
 * la hauteur de la légende, qui dépend de la police du navigateur. Une
 * constante finit toujours par dériver de quelques pixels, et cette dérive
 * multipliée par le nombre de rangées non rendues fait sauter le défilement.
 *
 * D'où le partage en deux temps : une estimation pour le premier rendu, puis
 * une correction mesurée sur le rendu réel. Le tout est isolé ici pour être
 * vérifiable sans navigateur.
 */

/** Écart entre vignettes, identique en largeur et en hauteur. */
export const GAP = 20;

/**
 * Deux colonnes au maximum, jamais plus.
 *
 * Trois ou quatre colonnes donnaient des vignettes trop petites et un texte
 * tassé : à deux, l'image porte enfin l'épisode et la légende a la place de
 * s'écrire.
 */
export const MAX_COLUMNS = 2;

/** En deçà de cette largeur par vignette, on repasse à une seule colonne. */
export const MIN_TILE_WIDTH = 360;

/**
 * Hauteur du bloc de texte sous la vignette.
 *
 * 16 (pt-4) + 46 (deux lignes de titre) + 8 + 44 (deux lignes de synopsis)
 * + 8 + 18 (durée). Les quatre lignes sont RÉSERVÉES même quand le synopsis
 * manque : sans cela une carte serait plus courte que ses voisines, les
 * rangées cesseraient d'être uniformes et le défilement sauterait.
 *
 * Ce n'est qu'une estimation — la police du navigateur peut décaler le total
 * d'un pixel ou deux — d'où la correction mesurée dans EpisodeGrid.
 */
export const CAPTION_HEIGHT = 140;

/** En deçà, tout est rendu : virtualiser coûterait plus que ça ne rapporte. */
export const VIRTUALIZE_ABOVE = 50;

/** Rangées rendues au-delà de l'écran, de part et d'autre. */
export const OVERSCAN_ROWS = 2;

/** Nombre de colonnes tenant dans la largeur donnée. */
export function columnsFor(width: number): number {
  const fitting = Math.floor((width + GAP) / (MIN_TILE_WIDTH + GAP));
  return Math.max(1, Math.min(MAX_COLUMNS, fitting));
}

/** Hauteur d'une rangée, écart compris, avant toute mesure du rendu. */
export function estimateRowHeight(width: number, columns: number): number {
  if (width <= 0 || columns <= 0) return 0;
  const tileWidth = (width - GAP * (columns - 1)) / columns;
  return Math.round((tileWidth * 9) / 16) + CAPTION_HEIGHT + GAP;
}

/**
 * Hauteur d'une rangée déduite de la hauteur réelle de la grille.
 *
 * La grille mesure « n rangées de contenu + (n − 1) écarts » ; on y rajoute un
 * écart pour obtenir un pas de rangée uniforme. Renvoie null quand la mesure
 * n'a rien à dire — grille vide, ou pas encore peinte.
 */
export function measuredRowHeight(gridHeight: number, renderedRows: number): number | null {
  if (renderedRows <= 0 || gridHeight <= 0) return null;
  return (gridHeight + GAP) / renderedRows;
}

export interface Range {
  start: number;
  end: number;
}

/**
 * Tranche d'épisodes à rendre.
 *
 * `offsetTop` est la position du haut de la grille par rapport au haut de la
 * fenêtre, telle que la renvoie getBoundingClientRect : négative dès qu'on a
 * défilé au-delà.
 */
export function computeRange({
  count,
  columns,
  rowHeight,
  offsetTop,
  viewportHeight,
}: {
  count: number;
  columns: number;
  rowHeight: number;
  offsetTop: number;
  viewportHeight: number;
}): Range {
  if (rowHeight <= 0 || columns <= 0) return { start: 0, end: count };

  const totalRows = Math.ceil(count / columns);
  const firstRow = Math.floor(Math.max(0, -offsetTop) / rowHeight);
  const visibleRows = Math.ceil(viewportHeight / rowHeight);

  // Le début est borné au nombre de rangées : défiler bien au-delà de la
  // grille ne doit pas produire de cale plus haute que la grille elle-même.
  const startRow = Math.min(totalRows, Math.max(0, firstRow - OVERSCAN_ROWS));
  const endRow = firstRow + visibleRows + OVERSCAN_ROWS;

  return {
    start: startRow * columns,
    end: Math.min(count, endRow * columns),
  };
}

/**
 * Hauteur des cales qui remplacent les rangées non rendues.
 *
 * Leur somme avec les rangées rendues vaut toujours la hauteur totale de la
 * grille : c'est ce qui garantit une barre de défilement juste et un contenu
 * qui ne saute pas.
 */
export function spacers({
  count,
  columns,
  range,
  rowHeight,
}: {
  count: number;
  columns: number;
  range: Range;
  rowHeight: number;
}): { before: number; after: number } {
  if (columns <= 0) return { before: 0, after: 0 };
  const rowsBefore = Math.floor(range.start / columns);
  const rowsAfter = Math.max(0, Math.ceil((count - range.end) / columns));
  return { before: rowsBefore * rowHeight, after: rowsAfter * rowHeight };
}
