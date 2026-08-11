/**
 * Tests de la file de review et de la persistance des décisions.
 *
 * L'enjeu : une décision prise à la main ne doit JAMAIS être défaite par une
 * passe automatique, et une entrée ignorée ne doit jamais réapparaître.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig, LibraryConfig } from '../config.js';
import { openDatabase, syncLibrariesFromConfig, type Db } from '../db/index.js';
import { indexLibrary } from '../scan/indexer.js';
import type { WalkedFile } from '../scan/walk.js';
import { ignoreWork } from './enrich.js';
import { isManuallyResolved, manualDecision, recordMatch } from './store.js';
import { nextInQueue, parseReviewKey, reviewEntry, reviewQueue, reviewQueueKeys } from './review.js';

const LIBRARY: LibraryConfig = { id: 'films', label: 'Films', type: 'movie', paths: ['R:\\films'] };
const CONFIG: AppConfig = { databasePath: ':memory:', imagesPath: './data/images', libraries: [LIBRARY] };

function file(relativePath: string): WalkedFile {
  const absolutePath = `R:\\films\\${relativePath}`;
  return {
    absolutePath,
    storedPath: absolutePath,
    relativePath,
    fileName: relativePath.split('\\').at(-1) ?? relativePath,
    extension: '.mkv',
    directoryKey: absolutePath.slice(0, absolutePath.lastIndexOf('\\')).toLowerCase(),
    sizeBytes: 900 * 1024 * 1024,
    mtimeMs: 1_700_000_000_000,
  };
}

let db: Db;

/** Deux films indexés, sans aucun appariement. */
beforeEach(() => {
  db = openDatabase(':memory:');
  const roots = syncLibrariesFromConfig(db, CONFIG).get('films') ?? [];
  indexLibrary(
    db,
    LIBRARY,
    [
      {
        libraryRootId: (roots[0] as { id: number }).id,
        videos: [file('Flow (2024)\\Flow (2024).mkv'), file('Five (2016)\\Five (2016).mkv')],
        subtitles: [],
      },
    ],
    new Date().toISOString(),
  );
});

function movieIdOf(title: string): number {
  return (db.prepare('SELECT id FROM movie WHERE title = ?').get(title) as { id: number }).id;
}

function putMatch(title: string, status: 'needs_review' | 'not_found' | 'applied', manual = false): number {
  const id = movieIdOf(title);
  recordMatch(db, {
    type: 'movie',
    id,
    status,
    tmdbId: status === 'applied' ? 111 : null,
    confidence: status === 'applied' ? 1 : 0.5,
    reason: 'test',
    candidates: [],
    searchedTitle: title,
    searchedYear: null,
    manual,
  });
  return id;
}

describe('clé de review', () => {
  it('lit « movie-123 » et « show-45 »', () => {
    expect(parseReviewKey('movie-123')).toEqual({ type: 'movie', id: 123 });
    expect(parseReviewKey('show-45')).toEqual({ type: 'show', id: 45 });
  });

  it('refuse ce qui n’est pas une clé', () => {
    expect(parseReviewKey('episode-1')).toBeNull();
    expect(parseReviewKey('movie-')).toBeNull();
    expect(parseReviewKey('123')).toBeNull();
  });
});

describe('composition de la file', () => {
  it('contient les entrées à trancher et rien d’autre', () => {
    putMatch('Flow', 'needs_review');
    putMatch('Five', 'applied');

    const queue = reviewQueue(db);
    expect(queue.map((entry) => entry.parsedTitle)).toEqual(['Flow']);
  });

  it('inclut les entrées introuvables sur TMDB', () => {
    putMatch('Flow', 'not_found');
    expect(reviewQueue(db)).toHaveLength(1);
  });

  it('expose le chemin complet des fichiers', () => {
    putMatch('Flow', 'needs_review');
    const [entry] = reviewQueue(db);
    expect(entry?.filePaths[0]).toContain('Flow (2024).mkv');
  });

  it('écarte les œuvres qui n’ont plus de fichier présent', () => {
    putMatch('Flow', 'needs_review');
    db.prepare('UPDATE media_file SET present = 0').run();
    expect(reviewQueue(db)).toHaveLength(0);
  });
});

describe('persistance des décisions', () => {
  it('protège un appariement choisi à la main', () => {
    const id = putMatch('Flow', 'applied', true);
    expect(isManuallyResolved(db, 'movie', id)).toBe(true);
  });

  it('ne protège pas un appariement automatique', () => {
    const id = putMatch('Flow', 'applied', false);
    expect(isManuallyResolved(db, 'movie', id)).toBe(false);
  });

  it('horodate la décision', () => {
    const id = putMatch('Flow', 'applied', true);
    const row = db.prepare('SELECT decided_at FROM tmdb_match WHERE target_id = ?').get(id) as {
      decided_at: string | null;
    };
    expect(row.decided_at).not.toBeNull();
  });

  it('conserve l’identifiant choisi pour permettre un ré-enrichissement', () => {
    // La protection fige QUEL identifiant, pas le droit de rafraîchir ses
    // métadonnées : sans ça, une œuvre triée à la main resterait à jamais
    // privée des champs ajoutés par les passes suivantes — les logos, par ex.
    const id = putMatch('Flow', 'applied', true);
    const decision = manualDecision(db, 'movie', id);
    expect(decision).toEqual({ status: 'applied', tmdbId: 111 });
  });

  it('ne rend aucune décision pour un appariement automatique', () => {
    const id = putMatch('Flow', 'applied', false);
    expect(manualDecision(db, 'movie', id)).toBeNull();
  });

  it('retire définitivement une entrée ignorée de la file', () => {
    const id = putMatch('Flow', 'needs_review');
    expect(reviewQueue(db)).toHaveLength(1);

    ignoreWork(db, 'movie', id);

    expect(reviewQueue(db)).toHaveLength(0);
    expect(isManuallyResolved(db, 'movie', id)).toBe(true);
  });

  it('survit à un nouveau scan du même fichier', () => {
    const id = putMatch('Flow', 'applied', true);

    // Le fichier disparaît, puis revient au même chemin.
    const roots = db.prepare('SELECT id FROM library_root').all() as { id: number }[];
    db.prepare('UPDATE media_file SET present = 0').run();
    indexLibrary(
      db,
      LIBRARY,
      [
        {
          libraryRootId: (roots[0] as { id: number }).id,
          videos: [file('Flow (2024)\\Flow (2024).mkv')],
          subtitles: [],
        },
      ],
      new Date().toISOString(),
    );

    // Même œuvre, même identifiant : la décision est retrouvée.
    expect(movieIdOf('Flow')).toBe(id);
    expect(isManuallyResolved(db, 'movie', id)).toBe(true);
  });
});

describe('enchaînement', () => {
  it('donne l’entrée suivante une fois la courante traitée', () => {
    const flow = putMatch('Flow', 'needs_review');
    putMatch('Five', 'needs_review');

    // « Five » passe avant « Flow » dans l'ordre alphabétique.
    expect(reviewQueueKeys(db)).toHaveLength(2);

    ignoreWork(db, 'movie', flow);
    const next = nextInQueue(db, { type: 'movie', id: flow });
    expect(next?.parsedTitle).toBe('Five');
  });

  it('rend null quand la file est épuisée', () => {
    const flow = putMatch('Flow', 'needs_review');
    ignoreWork(db, 'movie', flow);
    expect(nextInQueue(db, { type: 'movie', id: flow })).toBeNull();
  });

  it('fabrique une entrée pour une œuvre hors file, sans rien écrire', () => {
    const id = putMatch('Five', 'applied');
    const before = db.prepare('SELECT COUNT(*) AS n FROM tmdb_match').get() as { n: number };

    const entry = reviewEntry(db, { type: 'movie', id });
    expect(entry?.status).toBe('applied');

    const after = db.prepare('SELECT COUNT(*) AS n FROM tmdb_match').get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
