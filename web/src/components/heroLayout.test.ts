/**
 * Le bloc de contenu du hero doit tenir dans la diapositive, quelle que soit la
 * largeur de fenêtre. Le défaut corrigé ici apparaissait entre 800 et 1000 px :
 * les paliers réagissaient à la fenêtre, la diapositive n'en fait que 86 %.
 */
import { describe, expect, it } from 'vitest';

import { computeContentLayout, computeSlideLayout } from './heroLayout';

const VIEWPORT_HEIGHT = 900;

/** Les largeurs demandées, plus un balayage fin de la plage à problème. */
const WIDTHS = [1920, 1600, 1400, 1200, 1000, 900, 860, 800, 768, 600, 375];

function layoutAt(width: number, hasBadge = true) {
  const slide = computeSlideLayout(width, VIEWPORT_HEIGHT);
  const content = computeContentLayout(slide.slide, slide.height, {
    compact: slide.compact,
    hasBadge,
  });
  return { slide, content };
}

describe('dimensions de la diapositive', () => {
  it('reproduit la maquette à 1440 px', () => {
    const { slide } = layoutAt(1440);
    // Maquette : 1240 × 470, dépassement de 100 px de chaque côté.
    expect(slide.slide).toBe(1238);
    expect(slide.peek).toBe(101);
    expect(slide.height).toBe(469);
  });

  it('supprime le dépassement sous 768 px', () => {
    expect(layoutAt(767).slide.peek).toBe(0);
    expect(layoutAt(375).slide.peek).toBe(0);
    expect(layoutAt(768).slide.peek).toBeGreaterThan(0);
  });

  it('garde le dépassement identique des deux côtés', () => {
    for (const width of WIDTHS) {
      const { slide } = layoutAt(width);
      expect(slide.slide + slide.peek * 2).toBeGreaterThanOrEqual(width - 1);
      expect(slide.slide + slide.peek * 2).toBeLessThanOrEqual(width + 1);
    }
  });
});

describe('le bloc de contenu reste dans le cadre', () => {
  it.each(WIDTHS)('à %i px de large', (width) => {
    const { slide, content } = layoutAt(width);

    // Verticalement : le bloc est ancré en bas, il ne doit pas sortir en haut.
    expect(content.estimatedHeight + content.padY).toBeLessThanOrEqual(slide.height);

    // Horizontalement : marge gauche + bloc ne dépassent pas la diapositive.
    expect(content.padX + content.width).toBeLessThanOrEqual(slide.slide);

    // Le logo ne dépasse jamais le plafond ni la hauteur de la diapositive.
    expect(content.logoMax).toBeLessThanOrEqual(120);
    expect(content.logoMax).toBeLessThan(slide.height);
  });

  it('tient aussi sans pastille « Nouveau »', () => {
    for (const width of WIDTHS) {
      const { slide, content } = layoutAt(width, false);
      expect(content.estimatedHeight + content.padY).toBeLessThanOrEqual(slide.height);
    }
  });

  it('balaie la plage 760–1100 px sans jamais déborder', () => {
    for (let width = 760; width <= 1100; width += 4) {
      const { slide, content } = layoutAt(width);
      expect(content.estimatedHeight + content.padY).toBeLessThanOrEqual(slide.height);
      expect(content.padX + content.width).toBeLessThanOrEqual(slide.slide);
    }
  });

  it('n’occupe jamais plus de la moitié de la diapositive en mode large', () => {
    for (const width of [1920, 1600, 1400, 1200, 1000, 900, 860, 800, 768]) {
      const { slide, content } = layoutAt(width);
      expect(content.width).toBeLessThanOrEqual(Math.round(slide.slide * 0.5));
    }
  });
});

describe('le synopsis cède la place quand il le faut', () => {
  it('est affiché sur une grande diapositive', () => {
    expect(layoutAt(1920).content.showSynopsis).toBe(true);
    expect(layoutAt(1440).content.showSynopsis).toBe(true);
  });

  it('disparaît quand la hauteur ne suffit plus', () => {
    // 860 px : diapositive de 740 × 300, c'est le cas qui débordait.
    const { slide, content } = layoutAt(860);
    expect(slide.height).toBe(300);
    expect(content.showSynopsis).toBe(false);
  });

  it('ne dépend pas de la fenêtre mais de la place disponible', () => {
    // Même largeur de fenêtre, fenêtre très basse : le synopsis doit céder.
    const basse = computeSlideLayout(1440, 420);
    const content = computeContentLayout(basse.slide, basse.height, { compact: false, hasBadge: true });
    expect(content.showSynopsis).toBe(false);
  });
});
