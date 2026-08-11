/**
 * Non pas une assertion, mais un relevé : ce test imprime les dimensions
 * obtenues à chaque largeur de fenêtre. Il sert à vérifier le hero de visu sans
 * ouvrir onze fenêtres, et à documenter le comportement attendu.
 */
import { describe, it } from 'vitest';

import { computeContentLayout, computeSlideLayout } from './heroLayout';

const VIEWPORT = 900;
const WIDTHS = [1920, 1600, 1400, 1200, 1000, 900, 860, 800, 768, 600, 375];

describe('relevé des dimensions du hero', () => {
  it('imprime le tableau', () => {
    const lines: string[] = [
      '',
      'fenêtre  diapositive   mode     logo  bloc  synopsis  marge haute restante',
      '─'.repeat(74),
    ];

    for (const width of WIDTHS) {
      const slide = computeSlideLayout(width, VIEWPORT);
      const content = computeContentLayout(slide.slide, slide.height, {
        compact: slide.compact,
        hasBadge: true,
      });
      const remaining = slide.height - content.padY - content.estimatedHeight;

      lines.push(
        `${String(width).padStart(5)}   ` +
          `${String(slide.slide).padStart(4)} × ${String(slide.height).padStart(3)}  ` +
          `${(slide.compact ? 'compact' : 'large').padEnd(8)} ` +
          `${String(content.logoMax).padStart(4)}  ` +
          `${String(content.width).padStart(4)}  ` +
          `${(content.showSynopsis ? 'oui' : 'non').padEnd(8)}  ` +
          `${String(remaining).padStart(6)} px`,
      );
    }

    console.log(lines.join('\n'));
  });
});
