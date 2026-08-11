import { describe, expect, it } from 'vitest';

import { MAX_VEIL, backdropLayers, veilSpan } from './backdropVeil';

describe('veilSpan', () => {
  it('suit la hauteur de fenêtre', () => {
    expect(veilSpan(1000)).toBe(850);
    expect(veilSpan(600)).toBe(510);
  });

  it('ne rend jamais zéro, même sans fenêtre mesurée', () => {
    // Une course nulle produirait une division par zéro plus bas.
    expect(veilSpan(0)).toBeGreaterThan(0);
  });
});

describe('backdropLayers', () => {
  const span = veilSpan(900);

  it('laisse l’image nette et la composition entière en haut de page', () => {
    expect(backdropLayers(0, span)).toEqual({ veil: 0, hero: 1 });
  });

  it('inverse les deux calques à mi-course', () => {
    const layers = backdropLayers(span / 2, span);
    expect(layers.veil).toBeCloseTo(MAX_VEIL / 2, 2);
    expect(layers.hero).toBeCloseTo(0.5, 2);
  });

  it('plafonne le voile en deçà de l’opacité totale', () => {
    // C'est la condition pour que l'image reste devinable derrière le texte.
    expect(backdropLayers(span, span).veil).toBe(MAX_VEIL);
    expect(backdropLayers(span * 40, span).veil).toBe(MAX_VEIL);
    expect(MAX_VEIL).toBeLessThan(1);
  });

  it('efface complètement les dégradés une fois la course parcourue', () => {
    expect(backdropLayers(span, span).hero).toBe(0);
    expect(backdropLayers(span * 3, span).hero).toBe(0);
  });

  it('reste borné sur un défilement négatif', () => {
    // Le rebond élastique de macOS et de Chrome rend un scrollY négatif.
    expect(backdropLayers(-500, span)).toEqual({ veil: 0, hero: 1 });
  });

  it('progresse de façon monotone', () => {
    let previous = backdropLayers(0, span);
    for (let scroll = 25; scroll <= span * 2; scroll += 25) {
      const current = backdropLayers(scroll, span);
      expect(current.veil).toBeGreaterThanOrEqual(previous.veil);
      expect(current.hero).toBeLessThanOrEqual(previous.hero);
      previous = current;
    }
  });
});
