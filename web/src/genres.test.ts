import { describe, expect, it } from 'vitest';

import type { Genre } from './api';
import { findGenreBySlug, isNew, slugifyGenre } from './genres';

const genre = (id: number, name: string): Genre => ({ id, name, movieCount: 1, showCount: 1 });

describe('slugifyGenre', () => {
  it('met en minuscules et remplace les espaces', () => {
    expect(slugifyGenre('Science-Fiction')).toBe('science-fiction');
    expect(slugifyGenre('Action & Adventure')).toBe('action-adventure');
  });

  it('retire les accents', () => {
    expect(slugifyGenre('Comédie')).toBe('comedie');
    expect(slugifyGenre('Téléfilm')).toBe('telefilm');
  });

  it('donne le même slug en NFC et en NFD', () => {
    // Le nom arrive du serveur : rien ne garantit sa forme de normalisation.
    expect(slugifyGenre('Comédie'.normalize('NFC'))).toBe(slugifyGenre('Comédie'.normalize('NFD')));
  });

  it('ne laisse pas de tiret aux extrémités', () => {
    expect(slugifyGenre(' Drame ')).toBe('drame');
    expect(slugifyGenre('Guerre & Politique')).toBe('guerre-politique');
  });
});

describe('findGenreBySlug', () => {
  const genres = [genre(35, 'Comédie'), genre(878, 'Science-Fiction')];

  it('retrouve un genre par son slug', () => {
    expect(findGenreBySlug(genres, 'comedie')?.id).toBe(35);
    expect(findGenreBySlug(genres, 'science-fiction')?.id).toBe(878);
  });

  it('rend null pour « tout » comme pour un slug inconnu', () => {
    expect(findGenreBySlug(genres, null)).toBeNull();
    expect(findGenreBySlug(genres, '')).toBeNull();
    expect(findGenreBySlug(genres, 'western')).toBeNull();
  });
});

describe('isNew', () => {
  const now = new Date('2026-08-10T12:00:00Z').getTime();

  it('marque ce qui a été ajouté dans les trente jours', () => {
    expect(isNew('2026-08-09T12:00:00Z', now)).toBe(true);
    expect(isNew('2026-07-20T12:00:00Z', now)).toBe(true);
  });

  it('ne marque pas ce qui est plus ancien', () => {
    expect(isNew('2026-06-01T12:00:00Z', now)).toBe(false);
  });

  it('ne marque pas une date illisible', () => {
    expect(isNew('', now)).toBe(false);
    expect(isNew('pas une date', now)).toBe(false);
  });
});
