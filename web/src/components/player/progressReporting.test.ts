import { describe, expect, it } from 'vitest';

import { MIN_REPORTED_SECONDS, resumeAt, usableDuration, worthReporting } from './progressReporting';

describe('worthReporting — la lecture a-t-elle réellement démarré', () => {
  it('se tait sous le seuil de démarrage', () => {
    expect(worthReporting(0, null)).toBe(false);
    expect(worthReporting(MIN_REPORTED_SECONDS - 0.1, null)).toBe(false);
  });

  it('envoie le premier point dès le seuil atteint', () => {
    expect(worthReporting(MIN_REPORTED_SECONDS, null)).toBe(true);
    expect(worthReporting(42, null)).toBe(true);
  });

  it('refuse une position absurde', () => {
    expect(worthReporting(Number.NaN, null)).toBe(false);
    expect(worthReporting(Number.POSITIVE_INFINITY, null)).toBe(false);
  });
});

describe('worthReporting — position inchangée', () => {
  it('ne renvoie pas la même position deux fois', () => {
    expect(worthReporting(120, 120)).toBe(false);
    expect(worthReporting(120.4, 120)).toBe(false);
  });

  it('envoie dès que la position a bougé d’une seconde', () => {
    expect(worthReporting(121, 120)).toBe(true);
    expect(worthReporting(600, 120)).toBe(true);
  });

  it('envoie aussi après un retour en arrière', () => {
    // Un saut en arrière est un changement comme un autre : la position
    // enregistrée doit suivre, sinon reprendre ramènerait plus loin que voulu.
    expect(worthReporting(60, 600)).toBe(true);
  });
});

describe('usableDuration', () => {
  it('garde une durée finie et positive', () => {
    expect(usableDuration(1234.5)).toBe(1234.5);
  });

  it('écarte ce qu’un flux peut annoncer', () => {
    expect(usableDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(usableDuration(Number.NaN)).toBeNull();
    expect(usableDuration(0)).toBeNull();
    expect(usableDuration(null)).toBeNull();
    expect(usableDuration(undefined)).toBeNull();
  });
});

describe('resumeAt', () => {
  it('reprend à la position enregistrée', () => {
    expect(resumeAt(1800, 7200)).toBe(1800);
  });

  it('repart du début sous le seuil de démarrage', () => {
    expect(resumeAt(0, 7200)).toBe(0);
    expect(resumeAt(2, 7200)).toBe(0);
  });

  it('repart du début à deux secondes de la fin', () => {
    // Sans ce garde-fou, rouvrir l’œuvre rejouerait le générique en boucle.
    expect(resumeAt(7198, 7200)).toBe(0);
  });

  it('accepte une position sans durée connue', () => {
    expect(resumeAt(1800, null)).toBe(1800);
  });
});
