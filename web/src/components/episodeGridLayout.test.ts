import { describe, expect, it } from 'vitest';

import {
  CAPTION_HEIGHT,
  GAP,
  MAX_COLUMNS,
  columnsFor,
  computeRange,
  estimateRowHeight,
  measuredRowHeight,
  spacers,
} from './episodeGridLayout';

describe('columnsFor', () => {
  it('ne dépasse jamais deux colonnes, si large soit la fenêtre', () => {
    expect(MAX_COLUMNS).toBe(2);
    // 1920 puis 2560, moins les 2 × 64 de marge latérale.
    expect(columnsFor(1792)).toBe(2);
    expect(columnsFor(2432)).toBe(2);
  });

  it('garde deux colonnes en largeur moyenne', () => {
    // Fenêtre de 1024 puis de 900 : 896 et 772 de contenu.
    expect(columnsFor(896)).toBe(2);
    expect(columnsFor(772)).toBe(2);
  });

  it('repasse à une colonne en mobile', () => {
    // Fenêtre de 768 puis de 375.
    expect(columnsFor(640)).toBe(1);
    expect(columnsFor(247)).toBe(1);
  });

  it('garde une colonne même sans largeur mesurée', () => {
    expect(columnsFor(0)).toBe(1);
  });
});

describe('estimateRowHeight', () => {
  it('suit le 16:9 des vignettes', () => {
    // Une colonne de 400px : 225px de vignette, plus légende et écart.
    expect(estimateRowHeight(400, 1)).toBe(225 + CAPTION_HEIGHT + GAP);
  });

  it('tient compte de l’écart entre les deux colonnes', () => {
    // 2 colonnes dans 1380px : (1380 − 20) / 2 = 680 → 383px de vignette.
    expect(estimateRowHeight(1380, 2)).toBe(383 + CAPTION_HEIGHT + GAP);
  });

  it('ne renvoie rien d’exploitable avant la première mesure', () => {
    expect(estimateRowHeight(0, 2)).toBe(0);
  });
});

describe('measuredRowHeight', () => {
  it('déduit le pas de rangée de la hauteur rendue', () => {
    // 3 rangées de 300px séparées par 2 écarts = 928px de grille.
    expect(measuredRowHeight(3 * 300 + 2 * GAP, 3)).toBe(300 + GAP);
  });

  it('se tait quand il n’y a rien à mesurer', () => {
    expect(measuredRowHeight(0, 3)).toBeNull();
    expect(measuredRowHeight(500, 0)).toBeNull();
  });
});

/**
 * One Piece saison 1 : 59 épisodes, le cas qui a motivé la virtualisation.
 * Sur deux colonnes, cela fait 30 rangées — dont une incomplète.
 */
describe('One Piece — 59 épisodes sur 2 colonnes', () => {
  const count = 59;
  const columns = 2;
  const rowHeight = 543;
  const viewportHeight = 900;
  const totalRows = Math.ceil(count / columns); // 30

  /** Hauteur totale occupée, cales comprises, à une position de défilement donnée. */
  function totalHeight(offsetTop: number): number {
    const range = computeRange({ count, columns, rowHeight, offsetTop, viewportHeight });
    const { before, after } = spacers({ count, columns, range, rowHeight });
    const renderedRows = Math.ceil((range.end - range.start) / columns);
    return before + renderedRows * rowHeight + after;
  }

  it('occupe toujours la même hauteur, quelle que soit la position', () => {
    const expected = totalRows * rowHeight;
    // Du haut de la grille jusqu'au-delà de son bas, pas de 50px.
    for (let offset = 100; offset > -(totalRows * rowHeight + 500); offset -= 50) {
      expect(totalHeight(offset)).toBe(expected);
    }
  });

  it('rend la première rangée tant qu’on n’a pas défilé', () => {
    const range = computeRange({ count, columns, rowHeight, offsetTop: 0, viewportHeight });
    expect(range.start).toBe(0);
    expect(range.end).toBeGreaterThanOrEqual(columns);
  });

  it('couvre la fenêtre entière à mi-parcours', () => {
    // Quinze rangées défilées : la rangée 15 est en haut de l'écran.
    const offsetTop = -15 * rowHeight;
    const range = computeRange({ count, columns, rowHeight, offsetTop, viewportHeight });

    const firstVisibleRow = 15;
    const lastVisibleRow = firstVisibleRow + Math.ceil(viewportHeight / rowHeight);
    expect(range.start).toBeLessThanOrEqual(firstVisibleRow * columns);
    expect(range.end).toBeGreaterThanOrEqual(Math.min(count, lastVisibleRow * columns));
  });

  it('rend le dernier épisode une fois en bas', () => {
    const offsetTop = -(totalRows * rowHeight - viewportHeight);
    const range = computeRange({ count, columns, rowHeight, offsetTop, viewportHeight });
    expect(range.end).toBe(count);
  });

  it('garde une marge de rangées de part et d’autre', () => {
    const offsetTop = -15 * rowHeight;
    const range = computeRange({ count, columns, rowHeight, offsetTop, viewportHeight });
    // Deux rangées d'avance au-dessus : le haut de l'écran est déjà peint.
    expect(range.start).toBe(13 * columns);
  });

  it('gère la dernière rangée incomplète', () => {
    // 59 épisodes sur deux colonnes : la trentième rangée n'en porte qu'un.
    const range = computeRange({
      count,
      columns,
      rowHeight,
      offsetTop: -(totalRows * rowHeight),
      viewportHeight,
    });
    const { before, after } = spacers({ count, columns, range, rowHeight });
    const renderedRows = Math.ceil((range.end - range.start) / columns);
    expect(before + renderedRows * rowHeight + after).toBe(totalRows * rowHeight);
  });
});

describe('computeRange — cas limites', () => {
  it('rend tout tant que la hauteur de rangée est inconnue', () => {
    const range = computeRange({ count: 59, columns: 2, rowHeight: 0, offsetTop: 0, viewportHeight: 900 });
    expect(range).toEqual({ start: 0, end: 59 });
  });

  it('ne dépasse jamais le nombre d’épisodes', () => {
    const range = computeRange({ count: 7, columns: 2, rowHeight: 543, offsetTop: 0, viewportHeight: 4000 });
    expect(range.end).toBe(7);
  });

  it('ne produit pas de cale plus haute que la grille très en dessous', () => {
    const count = 59;
    const columns = 2;
    const rowHeight = 543;
    const range = computeRange({ count, columns, rowHeight, offsetTop: -100_000, viewportHeight: 900 });
    const { before, after } = spacers({ count, columns, range, rowHeight });
    expect(before).toBeLessThanOrEqual(Math.ceil(count / columns) * rowHeight);
    expect(after).toBe(0);
  });
});

describe('spacers — conservation de la hauteur', () => {
  // Une seule colonne rend le calcul le plus sensible : chaque épisode est
  // une rangée, donc chaque erreur d'arrondi se voit.
  it.each([1, 2])('conserve la hauteur totale sur %i colonne(s)', (columns) => {
    const count = 59;
    const rowHeight = 543;
    const totalRows = Math.ceil(count / columns);

    for (let row = 0; row <= totalRows + 2; row += 1) {
      const range = computeRange({
        count,
        columns,
        rowHeight,
        offsetTop: -row * rowHeight,
        viewportHeight: 900,
      });
      const { before, after } = spacers({ count, columns, range, rowHeight });
      const renderedRows = Math.ceil((range.end - range.start) / columns);
      expect(before + renderedRows * rowHeight + after).toBe(totalRows * rowHeight);
    }
  });
});
