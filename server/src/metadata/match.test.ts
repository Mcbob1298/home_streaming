/**
 * Tests de l'appariement TMDB.
 *
 * L'enjeu n'est pas de trouver la bonne réponse à tout prix : c'est de ne
 * jamais appliquer une correspondance douteuse sans le dire.
 */
import { describe, expect, it } from 'vitest';

import { CONFIDENCE_THRESHOLD, matchResults, scoreCandidate, titleSimilarity, toCandidate } from './match.js';
import type { TmdbSearchResult } from './tmdb.js';

function result(partial: Partial<TmdbSearchResult> & { id: number }): TmdbSearchResult {
  return { popularity: 1, ...partial };
}

describe('titleSimilarity', () => {
  it('vaut 1 pour deux écritures du même titre', () => {
    expect(titleSimilarity('Amélie', 'AMELIE')).toBe(1);
    expect(titleSimilarity('Le.Roi.Lion', 'Le Roi Lion')).toBe(1);
  });

  it('reste élevée quand un sous-titre est ajouté', () => {
    expect(titleSimilarity('Le Seigneur des Anneaux', 'Le Seigneur des Anneaux : La Communauté de l’Anneau')).toBeGreaterThan(0.6);
  });

  it('est faible entre deux titres sans rapport', () => {
    expect(titleSimilarity('Dune', 'Titanic')).toBe(0);
  });

  it('reconnaît une apostrophe remplacée par une espace sur le disque', () => {
    // Windows n'aime pas les apostrophes : « À l'ancienne » est stocké
    // « A l ancienne ». Les deux doivent se reconnaître.
    expect(titleSimilarity('A l ancienne', 'À l’ancienne')).toBe(1);
    expect(titleSimilarity('Bienvenue Chez Les Ch tis', "Bienvenue chez les Ch'tis")).toBe(1);
  });

  it('reconnaît toujours une apostrophe simplement supprimée', () => {
    expect(titleSimilarity("Ocean's Eleven", 'Oceans Eleven')).toBe(1);
  });
});

function candidateOf(title: string, year: number | null, originalTitle: string | null = null) {
  return toCandidate(
    result({
      id: 1,
      title,
      original_title: originalTitle ?? undefined,
      release_date: year === null ? undefined : `${year}-01-01`,
    }),
  );
}

describe('scoreCandidate', () => {
  const candidate = candidateOf;

  it('donne la confiance maximale sur titre et année identiques', () => {
    expect(scoreCandidate({ title: 'Amélie', year: 2001 }, candidate('Amélie', 2001)).confidence).toBe(1);
  });

  it('tolère un an d’écart, courant entre sortie salle et sortie nationale', () => {
    const score = scoreCandidate({ title: 'Dune', year: 2021 }, candidate('Dune', 2020));
    expect(score.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  it('refuse un titre identique éloigné de plusieurs années — c’est un remake', () => {
    const score = scoreCandidate({ title: 'Dune', year: 2021 }, candidate('Dune', 1984));
    expect(score.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('reconnaît le titre original quand notre fichier est nommé en anglais', () => {
    const score = scoreCandidate(
      { title: 'The Lion King', year: 1994 },
      candidate('Le Roi Lion', 1994, 'The Lion King'),
    );
    expect(score.confidence).toBe(1);
  });

  it('n’est jamais confiant sans année, pris isolément', () => {
    const score = scoreCandidate({ title: 'Amélie', year: null }, candidate('Amélie', 2001));
    expect(score.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(score.reason).toContain('aucune année');
  });

  it('apparie malgré une apostrophe perdue par le système de fichiers', () => {
    const score = scoreCandidate({ title: 'A l ancienne', year: 2024 }, candidate('À l’ancienne', 2024));
    expect(score.confidence).toBe(1);
  });
});

describe('séries sans année dans le nom de dossier', () => {
  const show = (name: string, year: number, popularity = 10) =>
    result({ id: Math.round(Math.random() * 1e6), name, first_air_date: `${year}-01-01`, popularity });

  it('apparie une série sans année quand TMDB n’a qu’un seul titre identique', () => {
    // Cas très courant : le dossier s'appelle juste « Breaking bad ».
    const outcome = matchResults({ title: 'Breaking bad', year: null }, [
      show('Breaking Bad', 2008, 148),
      show('Breaking Bad: Original Minisodes', 2009, 1),
    ]);

    expect(outcome.confident).toBe(true);
    expect(outcome.best?.title).toBe('Breaking Bad');
  });

  it('refuse de trancher entre deux séries homonymes sans année', () => {
    const outcome = matchResults({ title: 'One Piece', year: null }, [
      show('One Piece', 1999, 100),
      show('One Piece', 2023, 90),
    ]);

    expect(outcome.confident).toBe(false);
  });

  it('reste prudent quand aucun titre n’est exactement identique', () => {
    const outcome = matchResults({ title: 'Bienvenue à Derry', year: null }, [
      show('Ça : Bienvenue à Derry', 2025, 38),
    ]);

    expect(outcome.confident).toBe(false);
  });
});

describe('règle 4 — titres alternatifs', () => {
  // TMDB répond en français, le titre original est en japonais, et le fichier
  // porte le titre anglais. Seuls les titres alternatifs font le lien.
  const chihiro = toCandidate(
    result({ id: 129, title: 'Le Voyage de Chihiro', original_title: '千と千尋の神隠し', release_date: '2001-07-20' }),
  );

  it('échoue sans les titres alternatifs', () => {
    const score = scoreCandidate({ title: 'Spirited Away', year: 2001 }, chihiro);
    expect(score.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('réussit avec les titres alternatifs', () => {
    const score = scoreCandidate({ title: 'Spirited Away', year: 2001 }, chihiro, [
      'Spirited Away',
      'Sen to Chihiro no kamikakushi',
    ]);
    expect(score.confidence).toBe(1);
    expect(score.matchedOn).toBe('alternatif');
    expect(score.matchedTitle).toBe('Spirited Away');
  });

  it('indique quel titre a servi', () => {
    const busan = toCandidate(
      result({ id: 1, title: 'Dernier train pour Busan', original_title: '부산행', release_date: '2016-07-20' }),
    );
    const score = scoreCandidate({ title: 'Train to Busan', year: 2016 }, busan, ['Train to Busan']);
    expect(score.matchedOn).toBe('alternatif');
    expect(score.reason).toContain('Train to Busan');
  });

  it('utilise le titre original quand c’est lui qui correspond', () => {
    const score = scoreCandidate(
      { title: 'The Lion King', year: 1994 },
      toCandidate(result({ id: 1, title: 'Le Roi Lion', original_title: 'The Lion King', release_date: '1994-01-01' })),
    );
    expect(score.matchedOn).toBe('original');
  });

  it('ignore un titre alternatif dans un alphabet non latin', () => {
    // « პლატფორმა 2 » se réduit à « 2 » une fois normalisé, et partageait donc
    // 100 % de ses mots avec « The Platform 2 » — mieux noté que le vrai titre.
    const platform = toCandidate(
      result({ id: 1, title: 'La Plateforme 2', original_title: 'El hoyo 2', release_date: '2024-10-04' }),
    );
    const withGeorgian = scoreCandidate({ title: 'The Platform 2', year: 2024 }, platform, ['პლატფორმა 2']);
    expect(withGeorgian.matchedOn).not.toBe('alternatif');

    const withEnglish = scoreCandidate({ title: 'The Platform 2', year: 2024 }, platform, [
      'პლატფორმა 2',
      'The Platform 2',
    ]);
    expect(withEnglish.confidence).toBe(1);
    expect(withEnglish.matchedTitle).toBe('The Platform 2');
  });

  it('ne dégrade pas une correspondance déjà exacte sur le titre localisé', () => {
    const score = scoreCandidate({ title: 'Amélie', year: 2001 }, candidateOf('Amélie', 2001), ['Amelie from Montmartre']);
    expect(score.confidence).toBe(1);
    expect(score.matchedOn).toBe('localisé');
  });
});

describe('règle 5 — l’année identique ne suffit pas', () => {
  it('ne donne pas un demi-point à deux titres sans rapport', () => {
    // Cas réel : « bac nord » notait 0,50 face à « Norm of the North », dont il
    // ne partage aucun mot, uniquement parce que l'année coïncidait.
    const score = scoreCandidate(
      { title: 'bac nord', year: 2020 },
      toCandidate(result({ id: 1, title: 'Norm of the North: Family Vacation', release_date: '2020-01-01' })),
    );
    expect(score.confidence).toBeLessThan(0.2);
  });

  it('récompense toujours une année identique avec un titre très proche', () => {
    const score = scoreCandidate(
      { title: 'Asterix et Obelix Mission Cleopatre', year: 2002 },
      toCandidate(result({ id: 1, title: 'Astérix et Obélix : Mission Cléopâtre', release_date: '2002-01-01' })),
    );
    expect(score.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('laisse intacte une correspondance parfaite', () => {
    const score = scoreCandidate({ title: 'Amélie', year: 2001 }, candidateOf('Amélie', 2001));
    expect(score.confidence).toBe(1);
  });
});

describe('matchResults', () => {
  it('retient le bon film parmi plusieurs homonymes', () => {
    const outcome = matchResults({ title: 'Dune', year: 2021 }, [
      result({ id: 1, title: 'Dune', release_date: '1984-12-14', popularity: 20 }),
      result({ id: 2, title: 'Dune', release_date: '2021-09-15', popularity: 90 }),
    ]);

    expect(outcome.best?.tmdbId).toBe(2);
    expect(outcome.confident).toBe(true);
  });

  it('conserve au plus cinq candidats pour l’écran de review', () => {
    const outcome = matchResults(
      { title: 'Titre', year: 2000 },
      Array.from({ length: 12 }, (_, index) => result({ id: index, title: `Titre ${index}`, release_date: '2000-01-01' })),
    );
    expect(outcome.candidates).toHaveLength(5);
  });

  it('demande une vérification quand TMDB ne renvoie rien de proche', () => {
    const outcome = matchResults({ title: 'Un film très obscur', year: 1998 }, [
      result({ id: 1, title: 'Autre chose', release_date: '2015-01-01' }),
    ]);
    expect(outcome.confident).toBe(false);
  });

  it('ne tranche pas entre deux candidats aussi crédibles', () => {
    // Deux œuvres de même titre et même année : c'est exactement le cas où
    // deviner serait une faute.
    const outcome = matchResults({ title: 'Le Piège', year: 2019 }, [
      result({ id: 1, title: 'Le Piège', release_date: '2019-03-01', popularity: 10 }),
      result({ id: 2, title: 'Le Piège', release_date: '2019-09-01', popularity: 9 }),
    ]);

    expect(outcome.best).not.toBeNull();
    expect(outcome.confident).toBe(false);
  });

  it('rend un résultat vide quand TMDB ne renvoie aucun candidat', () => {
    const outcome = matchResults({ title: 'Inconnu', year: 2000 }, []);
    expect(outcome.best).toBeNull();
    expect(outcome.confident).toBe(false);
  });

  it('apparie une série sur son nom et sa première diffusion', () => {
    const outcome = matchResults({ title: 'Kaamelott', year: 2005 }, [
      result({ id: 1, name: 'Kaamelott', first_air_date: '2005-01-03', popularity: 30 }),
    ]);

    expect(outcome.confident).toBe(true);
    expect(outcome.best?.title).toBe('Kaamelott');
    expect(outcome.best?.year).toBe(2005);
  });
});
