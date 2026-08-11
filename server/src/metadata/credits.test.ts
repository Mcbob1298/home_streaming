import { describe, expect, it } from 'vitest';

import {
  CAST_LIMIT,
  selectCast,
  selectCreators,
  selectDirectors,
  selectMovieCredits,
  selectShowCredits,
} from './credits.js';

describe('selectCast', () => {
  it('retient les six premiers rôles dans l’ordre de TMDB', () => {
    const cast = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Acteur ${index + 1}`,
      order: index,
    }));

    const selected = selectCast({ cast });
    expect(selected).toHaveLength(CAST_LIMIT);
    expect(selected.map((credit) => credit.name)).toEqual([
      'Acteur 1',
      'Acteur 2',
      'Acteur 3',
      'Acteur 4',
      'Acteur 5',
      'Acteur 6',
    ]);
  });

  it('trie sur « order » et non sur la position dans le tableau', () => {
    const selected = selectCast({
      cast: [
        { id: 3, name: 'Troisième', order: 2 },
        { id: 1, name: 'Premier', order: 0 },
        { id: 2, name: 'Deuxième', order: 1 },
      ],
    });
    expect(selected.map((credit) => credit.name)).toEqual(['Premier', 'Deuxième', 'Troisième']);
  });

  it('renvoie en fin de liste les entrées sans rang', () => {
    const selected = selectCast({
      cast: [
        { id: 1, name: 'Sans rang' },
        { id: 2, name: 'Tête d’affiche', order: 0 },
      ],
    });
    expect(selected.map((credit) => credit.name)).toEqual(['Tête d’affiche', 'Sans rang']);
    expect(selected[1]?.order).toBeNull();
  });

  it('ne compte qu’une fois un acteur jouant deux personnages', () => {
    // Cas réel : un acteur crédité pour un rôle et sa version jeune.
    const selected = selectCast({
      cast: [
        { id: 7, name: 'Doublure', character: 'Le père', order: 0 },
        { id: 7, name: 'Doublure', character: 'Le fils', order: 1 },
        { id: 8, name: 'Autre', order: 2 },
      ],
    });
    expect(selected).toHaveLength(2);
    expect(selected[0]?.character).toBe('Le père');
  });

  it('écarte les entrées sans identifiant ou sans nom', () => {
    const selected = selectCast({
      cast: [
        { name: 'Sans identifiant', order: 0 },
        { id: 2, name: '   ', order: 1 },
        { id: 3, name: 'Valide', order: 2 },
      ],
    });
    expect(selected.map((credit) => credit.name)).toEqual(['Valide']);
  });

  it('ramène le personnage vide à null', () => {
    const selected = selectCast({ cast: [{ id: 1, name: 'Acteur', character: '', order: 0 }] });
    expect(selected[0]?.character).toBeNull();
  });

  it('accepte l’absence totale de crédits', () => {
    expect(selectCast(undefined)).toEqual([]);
    expect(selectCast({})).toEqual([]);
  });
});

describe('selectDirectors', () => {
  it('retient le poste de réalisateur, pas tout le département', () => {
    const selected = selectDirectors({
      crew: [
        { id: 1, name: 'La réalisatrice', department: 'Directing', job: 'Director' },
        { id: 2, name: 'Premier assistant', department: 'Directing', job: 'First Assistant Director' },
        { id: 3, name: 'La scripte', department: 'Directing', job: 'Script Supervisor' },
        { id: 4, name: 'Le monteur', department: 'Editing', job: 'Editor' },
      ],
    });
    expect(selected.map((credit) => credit.name)).toEqual(['La réalisatrice']);
    expect(selected[0]?.role).toBe('director');
  });

  it('retient plusieurs réalisateurs', () => {
    const selected = selectDirectors({
      crew: [
        { id: 1, name: 'Joel Coen', department: 'Directing', job: 'Director' },
        { id: 2, name: 'Ethan Coen', department: 'Directing', job: 'Director' },
      ],
    });
    expect(selected).toHaveLength(2);
  });

  it('ne double pas une personne créditée deux fois au même poste', () => {
    const selected = selectDirectors({
      crew: [
        { id: 1, name: 'Une réalisatrice', department: 'Directing', job: 'Director' },
        { id: 1, name: 'Une réalisatrice', department: 'Directing', job: 'Director' },
      ],
    });
    expect(selected).toHaveLength(1);
  });

  it('accepte une équipe absente', () => {
    expect(selectDirectors(undefined)).toEqual([]);
    expect(selectDirectors({ cast: [] })).toEqual([]);
  });
});

describe('selectCreators', () => {
  it('reprend created_by tel quel', () => {
    const selected = selectCreators([
      { id: 10, name: 'Eiichiro Oda', profile_path: '/oda.jpg' },
      { id: 11, name: 'Coauteur' },
    ]);
    expect(selected.map((credit) => credit.name)).toEqual(['Eiichiro Oda', 'Coauteur']);
    expect(selected[0]?.role).toBe('creator');
    expect(selected[0]?.profilePath).toBe('/oda.jpg');
    expect(selected[1]?.profilePath).toBeNull();
  });

  it('accepte une série sans créateur déclaré', () => {
    expect(selectCreators(undefined)).toEqual([]);
    expect(selectCreators([])).toEqual([]);
  });
});

describe('selectMovieCredits', () => {
  it('met la réalisation devant la distribution', () => {
    const selected = selectMovieCredits({
      credits: {
        cast: [{ id: 2, name: 'Une actrice', order: 0 }],
        crew: [{ id: 1, name: 'Un réalisateur', department: 'Directing', job: 'Director' }],
      },
    });
    expect(selected.map((credit) => credit.role)).toEqual(['director', 'cast']);
  });

  it('accepte un film sans bloc credits', () => {
    expect(selectMovieCredits({})).toEqual([]);
  });
});

describe('selectShowCredits', () => {
  it('met la création devant la distribution', () => {
    const selected = selectShowCredits({
      created_by: [{ id: 1, name: 'Un créateur' }],
      credits: { cast: [{ id: 2, name: 'Une actrice', order: 0 }] },
    });
    expect(selected.map((credit) => credit.role)).toEqual(['creator', 'cast']);
  });

  it('accepte une série sans bloc credits', () => {
    expect(selectShowCredits({})).toEqual([]);
  });
});
