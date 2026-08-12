import { describe, expect, it } from 'vitest';

import {
  EXPIRY_DAYS,
  STARTED_RATIO,
  WATCHED_RATIO,
  belongsInContinue,
  isExpired,
  isFinished,
  pickShowEntry,
  ratioOf,
  remainingLabel,
  type EpisodeState,
  type ProgressEntry,
} from './rules.js';

const NOW = new Date('2026-08-12T12:00:00Z');
const HIER = '2026-08-11T12:00:00Z';

/** Un film de deux heures, le cas de référence. */
const FILM = 7200;

function entry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    mediaId: 1,
    mediaType: 'movie',
    positionSeconds: FILM * 0.5,
    durationSeconds: FILM,
    updatedAt: HIER,
    watched: false,
    ...overrides,
  };
}

describe('ratioOf', () => {
  it('mesure l’avancement', () => {
    expect(ratioOf(3600, 7200)).toBe(0.5);
    expect(ratioOf(0, 7200)).toBe(0);
  });

  it('ne dépasse jamais 1', () => {
    expect(ratioOf(9999, 7200)).toBe(1);
  });

  it('rend zéro sans durée exploitable', () => {
    // La durée vient du lecteur : elle peut manquer sur un flux non analysé.
    expect(ratioOf(3600, null)).toBe(0);
    expect(ratioOf(3600, 0)).toBe(0);
    expect(ratioOf(3600, Number.NaN)).toBe(0);
    expect(ratioOf(Number.NaN, 7200)).toBe(0);
  });
});

describe('isFinished — le seuil de 90 %', () => {
  it('marque vu au-delà du seuil', () => {
    expect(isFinished(FILM * WATCHED_RATIO, FILM)).toBe(true);
    expect(isFinished(FILM * 0.95, FILM)).toBe(true);
    expect(isFinished(FILM, FILM)).toBe(true);
  });

  it('ne marque pas juste en dessous', () => {
    expect(isFinished(FILM * 0.899, FILM)).toBe(false);
  });

  it('ne conclut rien sans durée', () => {
    // Mieux vaut ne rien marquer que de marquer vu à tort.
    expect(isFinished(99999, null)).toBe(false);
  });
});

describe('belongsInContinue — les deux seuils', () => {
  it('retient une œuvre entre 5 % et 90 %', () => {
    expect(belongsInContinue(entry({ positionSeconds: FILM * 0.5 }), NOW)).toBe(true);
    expect(belongsInContinue(entry({ positionSeconds: FILM * STARTED_RATIO }), NOW)).toBe(true);
    expect(belongsInContinue(entry({ positionSeconds: FILM * 0.89 }), NOW)).toBe(true);
  });

  it('écarte ce qui est à peine commencé', () => {
    // Ouvrir un film deux minutes puis changer d'avis.
    expect(belongsInContinue(entry({ positionSeconds: 120 }), NOW)).toBe(false);
    expect(belongsInContinue(entry({ positionSeconds: 0 }), NOW)).toBe(false);
  });

  it('écarte ce qui est terminé', () => {
    expect(belongsInContinue(entry({ positionSeconds: FILM * 0.91 }), NOW)).toBe(false);
  });

  it('écarte ce qui est marqué vu à la main', () => {
    // Même à 50 % : la décision humaine l'emporte sur la position.
    expect(belongsInContinue(entry({ watched: true }), NOW)).toBe(false);
  });

  it('écarte ce qui dort depuis six mois', () => {
    const vieux = new Date(NOW.getTime() - (EXPIRY_DAYS + 1) * 24 * 3600 * 1000).toISOString();
    expect(belongsInContinue(entry({ updatedAt: vieux }), NOW)).toBe(false);
  });

  it('garde ce qui date de cinq mois', () => {
    const recent = new Date(NOW.getTime() - 150 * 24 * 3600 * 1000).toISOString();
    expect(belongsInContinue(entry({ updatedAt: recent }), NOW)).toBe(true);
  });

  it('écarte une œuvre dont la durée est inconnue', () => {
    // Sans durée, le ratio vaut zéro : sous le seuil de départ.
    expect(belongsInContinue(entry({ durationSeconds: null }), NOW)).toBe(false);
  });
});

describe('isExpired', () => {
  it('ne fait pas disparaître une entrée sur une date illisible', () => {
    expect(isExpired('pas une date', NOW)).toBe(false);
    expect(isExpired('', NOW)).toBe(false);
  });
});

describe('remainingLabel', () => {
  it('donne les minutes restantes', () => {
    expect(remainingLabel(FILM - 36 * 60, FILM)).toBe('Il reste 36 min');
    expect(remainingLabel(0, 45 * 60)).toBe('Il reste 45 min');
  });

  it('passe aux heures au-delà de soixante minutes', () => {
    expect(remainingLabel(0, 72 * 60)).toBe('Il reste 1 h 12');
    expect(remainingLabel(0, 120 * 60)).toBe('Il reste 2 h');
  });

  it('ne dit rien quand il ne reste rien', () => {
    expect(remainingLabel(FILM, FILM)).toBeNull();
    expect(remainingLabel(FILM + 100, FILM)).toBeNull();
    expect(remainingLabel(0, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function episode(overrides: Partial<EpisodeState> = {}): EpisodeState {
  return {
    episodeId: 1,
    seasonNumber: 1,
    episodeNumber: 1,
    mediaFileId: 100,
    positionSeconds: 0,
    durationSeconds: 2400,
    updatedAt: null,
    watched: false,
    ...overrides,
  };
}

/** Une saison de trois épisodes, plus une seconde saison de deux. */
function saison(): EpisodeState[] {
  return [
    episode({ episodeId: 1, seasonNumber: 1, episodeNumber: 1, mediaFileId: 101 }),
    episode({ episodeId: 2, seasonNumber: 1, episodeNumber: 2, mediaFileId: 102 }),
    episode({ episodeId: 3, seasonNumber: 1, episodeNumber: 3, mediaFileId: 103 }),
    episode({ episodeId: 4, seasonNumber: 2, episodeNumber: 1, mediaFileId: 104 }),
    episode({ episodeId: 5, seasonNumber: 2, episodeNumber: 2, mediaFileId: 105 }),
  ];
}

describe('pickShowEntry — une série, UNE vignette', () => {
  it('reprend l’épisode en cours', () => {
    const episodes = saison();
    episodes[1] = { ...(episodes[1] as EpisodeState), positionSeconds: 1200, updatedAt: HIER };

    const entry = pickShowEntry(episodes, NOW);
    expect(entry?.kind).toBe('resume');
    expect(entry?.episode.episodeId).toBe(2);
  });

  it('départage deux épisodes touchés à la même milliseconde', () => {
    // Deux enregistrements peuvent tomber sur la même date : c'est alors
    // l'épisode le plus avancé dans la série qui fait foi, et le résultat ne
    // dépend pas de l'ordre dans lequel la base a rendu les lignes.
    const episodes = saison();
    episodes[0] = { ...(episodes[0] as EpisodeState), positionSeconds: 2400, watched: true, updatedAt: HIER };
    episodes[1] = { ...(episodes[1] as EpisodeState), positionSeconds: 1200, updatedAt: HIER };

    expect(pickShowEntry(episodes, NOW)?.episode.episodeId).toBe(2);
    expect(pickShowEntry([...episodes].reverse(), NOW)?.episode.episodeId).toBe(2);
  });

  it('propose le suivant quand le dernier est terminé', () => {
    const episodes = saison();
    episodes[1] = { ...(episodes[1] as EpisodeState), positionSeconds: 2400, watched: true, updatedAt: HIER };

    const entry = pickShowEntry(episodes, NOW);
    expect(entry?.kind).toBe('next');
    expect(entry?.episode.episodeId).toBe(3);
  });

  it('traverse la fin de saison', () => {
    // Dernier épisode de la saison 1 terminé : on passe au premier de la 2.
    const episodes = saison();
    episodes[2] = { ...(episodes[2] as EpisodeState), positionSeconds: 2400, watched: true, updatedAt: HIER };

    const entry = pickShowEntry(episodes, NOW);
    expect(entry?.kind).toBe('next');
    expect(entry?.episode.seasonNumber).toBe(2);
    expect(entry?.episode.episodeNumber).toBe(1);
  });

  it('reconnaît un épisode terminé sans marquage explicite', () => {
    // 95 % de la durée : terminé de fait, même si « watched » est resté faux.
    const episodes = saison();
    episodes[0] = { ...(episodes[0] as EpisodeState), positionSeconds: 2400 * 0.95, updatedAt: HIER };

    expect(pickShowEntry(episodes, NOW)?.episode.episodeId).toBe(2);
  });

  it('ne propose rien après le dernier épisode de la série', () => {
    const episodes = saison();
    episodes[4] = { ...(episodes[4] as EpisodeState), watched: true, updatedAt: HIER };
    expect(pickShowEntry(episodes, NOW)).toBeNull();
  });

  it('saute un épisode suivant déjà vu', () => {
    const episodes = saison();
    episodes[0] = { ...(episodes[0] as EpisodeState), watched: true, updatedAt: HIER };
    episodes[1] = { ...(episodes[1] as EpisodeState), watched: true };

    expect(pickShowEntry(episodes, NOW)?.episode.episodeId).toBe(3);
  });

  it('saute un épisode qui n’est plus sur le disque', () => {
    const episodes = saison();
    episodes[0] = { ...(episodes[0] as EpisodeState), watched: true, updatedAt: HIER };
    episodes[1] = { ...(episodes[1] as EpisodeState), mediaFileId: null };

    expect(pickShowEntry(episodes, NOW)?.episode.episodeId).toBe(3);
  });

  /**
   * Le dernier épisode TOUCHÉ, pas le plus avancé : quelqu'un qui revient en
   * arrière pour revoir un épisode doit reprendre là, pas où il s'était
   * arrêté la semaine précédente.
   */
  it('suit le dernier épisode touché, pas le plus avancé', () => {
    const episodes = saison();
    episodes[3] = { ...(episodes[3] as EpisodeState), positionSeconds: 1200, updatedAt: '2026-08-01T12:00:00Z' };
    episodes[0] = { ...(episodes[0] as EpisodeState), positionSeconds: 600, updatedAt: '2026-08-10T12:00:00Z' };

    const entry = pickShowEntry(episodes, NOW);
    expect(entry?.episode.episodeId).toBe(1);
    expect(entry?.kind).toBe('resume');
  });

  it('ne montre rien pour un épisode à peine ouvert', () => {
    const episodes = saison();
    episodes[0] = { ...(episodes[0] as EpisodeState), positionSeconds: 30, updatedAt: HIER };
    expect(pickShowEntry(episodes, NOW)).toBeNull();
  });

  it('ne montre rien sur une série jamais commencée', () => {
    expect(pickShowEntry(saison(), NOW)).toBeNull();
    expect(pickShowEntry([], NOW)).toBeNull();
  });

  it('disparaît après six mois', () => {
    const vieux = new Date(NOW.getTime() - (EXPIRY_DAYS + 1) * 24 * 3600 * 1000).toISOString();
    const episodes = saison();
    episodes[1] = { ...(episodes[1] as EpisodeState), positionSeconds: 1200, updatedAt: vieux };
    expect(pickShowEntry(episodes, NOW)).toBeNull();
  });

  it('ne reprend pas un épisode dont le fichier a disparu', () => {
    const episodes = saison();
    episodes[1] = {
      ...(episodes[1] as EpisodeState),
      positionSeconds: 1200,
      updatedAt: HIER,
      mediaFileId: null,
    };
    expect(pickShowEntry(episodes, NOW)).toBeNull();
  });
});
