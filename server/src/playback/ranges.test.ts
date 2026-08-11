import { describe, expect, it } from 'vitest';

import { contentRange, etagFor, matchesEtag, parseRange, unsatisfiableRange } from './ranges.js';

const SIZE = 1000;

describe('parseRange — plages fermées', () => {
  it('lit une plage classique', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ kind: 'partial', start: 0, end: 499 });
    expect(parseRange('bytes=500-999', SIZE)).toEqual({ kind: 'partial', start: 500, end: 999 });
  });

  it('borne la fin à la taille du fichier', () => {
    // Demander plus que ce qui existe est légitime : on donne ce qu'on a.
    expect(parseRange('bytes=900-5000', SIZE)).toEqual({ kind: 'partial', start: 900, end: 999 });
  });

  it('accepte un seul octet', () => {
    expect(parseRange('bytes=42-42', SIZE)).toEqual({ kind: 'partial', start: 42, end: 42 });
  });

  it('tolère les espaces', () => {
    expect(parseRange('  bytes= 10 - 20 ', SIZE)).toEqual({ kind: 'partial', start: 10, end: 20 });
  });
});

describe('parseRange — plages ouvertes', () => {
  it('lit « à partir de »', () => {
    expect(parseRange('bytes=1000-', 5000)).toEqual({ kind: 'partial', start: 1000, end: 4999 });
  });

  it('lit un suffixe, qui compte depuis la FIN', () => {
    expect(parseRange('bytes=-500', SIZE)).toEqual({ kind: 'partial', start: 500, end: 999 });
  });

  it('borne un suffixe plus grand que le fichier', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });
});

describe('parseRange — plages insatisfiables', () => {
  it('refuse un début au-delà du dernier octet', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=2000-3000', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuse une plage à l’envers', () => {
    expect(parseRange('bytes=500-100', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuse un suffixe nul', () => {
    expect(parseRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuse toute plage sur un fichier vide', () => {
    expect(parseRange('bytes=0-100', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('parseRange — en-têtes ignorés', () => {
  /*
   * La RFC est explicite : un en-tête Range illisible doit être IGNORÉ, pas
   * rejeté. Répondre 416 sur une syntaxe inconnue casserait des clients que
   * servir le fichier entier satisferait très bien.
   */
  it('ignore l’absence d’en-tête', () => {
    expect(parseRange(undefined, SIZE)).toEqual({ kind: 'full' });
    expect(parseRange(null, SIZE)).toEqual({ kind: 'full' });
  });

  it('ignore une unité qui n’est pas l’octet', () => {
    expect(parseRange('items=0-10', SIZE)).toEqual({ kind: 'full' });
  });

  it('ignore une syntaxe cassée', () => {
    expect(parseRange('bytes=abc', SIZE)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=1.5-2', SIZE)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=+10-20', SIZE)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=-', SIZE)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=', SIZE)).toEqual({ kind: 'full' });
  });

  it('ignore les plages multiples', () => {
    // Elles exigeraient une réponse multipart ; aucun lecteur vidéo n'en émet.
    expect(parseRange('bytes=0-100,200-300', SIZE)).toEqual({ kind: 'full' });
  });

  it('accepte « bytes » en majuscules', () => {
    expect(parseRange('BYTES=0-9', SIZE)).toEqual({ kind: 'partial', start: 0, end: 9 });
  });
});

describe('en-têtes de réponse', () => {
  it('formate Content-Range', () => {
    expect(contentRange(0, 499, 1000)).toBe('bytes 0-499/1000');
  });

  it('annonce la taille réelle sur un 416', () => {
    expect(unsatisfiableRange(1000)).toBe('bytes */1000');
  });
});

describe('etagFor', () => {
  it('change quand la taille change', () => {
    expect(etagFor(100, 5000)).not.toBe(etagFor(101, 5000));
  });

  it('change quand la date de modification change', () => {
    expect(etagFor(100, 5000)).not.toBe(etagFor(100, 5001));
  });

  it('est un validateur FORT, sans préfixe W/', () => {
    // Un validateur faible interdirait les requêtes de plage.
    expect(etagFor(100, 5000).startsWith('"')).toBe(true);
  });

  it('ignore les fractions de milliseconde', () => {
    // stat rend un mtimeMs fractionnaire sur certains systèmes de fichiers ;
    // sans troncature, l'ETag changerait à chaque lecture.
    expect(etagFor(100, 5000.7)).toBe(etagFor(100, 5000));
  });
});

describe('matchesEtag', () => {
  const etag = etagFor(100, 5000);

  it('reconnaît une correspondance exacte', () => {
    expect(matchesEtag(etag, etag)).toBe(true);
  });

  it('reconnaît la même valeur renvoyée en faible', () => {
    expect(matchesEtag(`W/${etag}`, etag)).toBe(true);
  });

  it('reconnaît l’astérisque', () => {
    expect(matchesEtag('*', etag)).toBe(true);
  });

  it('cherche dans une liste', () => {
    expect(matchesEtag(`"autre", ${etag}`, etag)).toBe(true);
  });

  it('rejette une valeur différente ou absente', () => {
    expect(matchesEtag('"autre"', etag)).toBe(false);
    expect(matchesEtag(undefined, etag)).toBe(false);
    expect(matchesEtag('', etag)).toBe(false);
  });
});
