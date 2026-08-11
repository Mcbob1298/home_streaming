import { describe, expect, it } from 'vitest';

import { pickMovieCertification, pickShowCertification } from './certification.js';

describe('pickMovieCertification', () => {
  it('préfère la classification française', () => {
    expect(
      pickMovieCertification({
        results: [
          { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', type: 3 }] },
          { iso_3166_1: 'FR', release_dates: [{ certification: '12', type: 3 }] },
        ],
      }),
    ).toBe('12');
  });

  it('se rabat sur les États-Unis en l’absence de classification française', () => {
    expect(
      pickMovieCertification({
        results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R', type: 3 }] }],
      }),
    ).toBe('R');
  });

  it('ignore les entrées sans classification', () => {
    // TMDB liste souvent plusieurs sorties par pays, dont certaines vides.
    expect(
      pickMovieCertification({
        results: [
          {
            iso_3166_1: 'FR',
            release_dates: [
              { certification: '', type: 1 },
              { certification: '   ', type: 4 },
              { certification: 'Tous publics', type: 3 },
            ],
          },
        ],
      }),
    ).toBe('Tous publics');
  });

  it('rend null quand aucun pays retenu n’est classé', () => {
    expect(pickMovieCertification(undefined)).toBeNull();
    expect(pickMovieCertification({ results: [] })).toBeNull();
    expect(
      pickMovieCertification({ results: [{ iso_3166_1: 'DE', release_dates: [{ certification: '16' }] }] }),
    ).toBeNull();
  });
});

describe('pickShowCertification', () => {
  it('préfère la classification française', () => {
    expect(
      pickShowCertification({
        results: [
          { iso_3166_1: 'US', rating: 'TV-14' },
          { iso_3166_1: 'FR', rating: '10' },
        ],
      }),
    ).toBe('10');
  });

  it('se rabat sur les États-Unis', () => {
    expect(pickShowCertification({ results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] })).toBe('TV-MA');
  });

  it('rend null quand la classification est vide', () => {
    expect(pickShowCertification({ results: [{ iso_3166_1: 'FR', rating: '' }] })).toBeNull();
    expect(pickShowCertification(undefined)).toBeNull();
  });
});
