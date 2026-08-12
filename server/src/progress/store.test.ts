/**
 * Tests de la persistance de la progression.
 *
 * Les règles elles-mêmes sont couvertes dans rules.test.ts ; ici on vérifie ce
 * que SQL fait vraiment — les colonnes existent, les conflits sont bien
 * résolus, et la rangée « Continuer à regarder » ne propose jamais une œuvre
 * dont plus aucun fichier n'est sur le disque.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { nowIso, openDatabase, type Db } from '../db/index.js';
import {
  continueWatching,
  episodeStatesOf,
  forget,
  progressOf,
  saveProgress,
  setWatched,
} from './store.js';

const FILM = 7200;
const EPISODE = 2400;

let db: Db;
let userId: number;

/** Un film à deux fichiers, une série de trois épisodes en une saison. */
beforeEach(() => {
  db = openDatabase(':memory:');
  userId = (db.prepare("SELECT id FROM user WHERE name = 'default'").get() as { id: number }).id;

  const now = nowIso();
  db.prepare("INSERT INTO library (id, label, type) VALUES ('films', 'Films', 'movie')").run();
  db.prepare("INSERT INTO library (id, label, type) VALUES ('series', 'Séries', 'show')").run();
  db.prepare(
    `INSERT INTO library_root (id, library_id, path, path_key)
     VALUES (1, 'films', 'R:\\films', 'r:\\films'), (2, 'series', 'R:\\series', 'r:\\series')`,
  ).run();

  db.prepare(
    `INSERT INTO movie (id, library_id, title, title_key, year, sort_title, added_at, updated_at)
     VALUES (1, 'films', 'Avatar', 'avatar', 2009, 'avatar', ?, ?)`,
  ).run(now, now);

  db.prepare(
    `INSERT INTO show (id, library_id, title, title_key, year, sort_title, added_at, updated_at)
     VALUES (1, 'series', 'One Piece', 'one piece', 1999, 'one piece', ?, ?)`,
  ).run(now, now);
  db.prepare("INSERT INTO season (id, show_id, season_number, added_at) VALUES (1, 1, 1, ?)").run(now);
  for (const number of [1, 2, 3]) {
    db.prepare(
      `INSERT INTO episode (id, show_id, season_id, season_number, episode_number, title, added_at, updated_at)
       VALUES (?, 1, 1, 1, ?, ?, ?, ?)`,
    ).run(number, number, `Épisode ${number}`, now, now);
  }

  // Deux fichiers pour le film — version cinéma et version longue —, un par
  // épisode. Les identifiants sont fixés pour rendre les tests lisibles.
  addFile(101, { movieId: 1, name: 'Avatar.mkv' });
  addFile(102, { movieId: 1, name: 'Avatar.Longue.mkv' });
  addFile(201, { episodeId: 1, name: 'OP.S01E01.mkv' });
  addFile(202, { episodeId: 2, name: 'OP.S01E02.mkv' });
  addFile(203, { episodeId: 3, name: 'OP.S01E03.mkv' });
});

function addFile(
  id: number,
  { movieId, episodeId, name }: { movieId?: number; episodeId?: number; name: string },
): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO media_file
       (id, library_id, library_root_id, path, path_key, relative_path, file_name, extension,
        size_bytes, mtime_ms, present, first_seen_at, last_seen_at, movie_id, episode_id)
     VALUES (@id, @libraryId, @rootId, @path, @pathKey, @name, @name, '.mkv',
             1000, 1, 1, @now, @now, @movieId, @episodeId)`,
  ).run({
    id,
    libraryId: movieId === undefined ? 'series' : 'films',
    rootId: movieId === undefined ? 2 : 1,
    path: `R:\\${name}`,
    pathKey: `r:\\${name}`.toLowerCase(),
    name,
    now,
    movieId: movieId ?? null,
    episodeId: episodeId ?? null,
  });
}

/** Force la date de dernière activité, pour tester le classement et l'oubli. */
function stamp(mediaType: 'movie' | 'episode', updatedAt: string): void {
  db.prepare('UPDATE playback_progress SET updated_at = ? WHERE media_type = ?').run(updatedAt, mediaType);
}

describe('saveProgress', () => {
  it('retient la position et le fichier ouvert', () => {
    const result = saveProgress(db, {
      userId,
      mediaFileId: 102,
      positionSeconds: 1800,
      durationSeconds: FILM,
    });

    expect(result).toEqual({ mediaType: 'movie', mediaId: 1, watched: false });
    expect(progressOf(db, userId, 'movie', 1)).toMatchObject({
      positionSeconds: 1800,
      durationSeconds: FILM,
      watched: false,
      mediaFileId: 102,
    });
  });

  it('marque vu au-delà de 90 % et remet la position à zéro', () => {
    // Rouvrir une œuvre terminée doit repartir du début, pas du générique.
    const result = saveProgress(db, {
      userId,
      mediaFileId: 101,
      positionSeconds: FILM * 0.95,
      durationSeconds: FILM,
    });

    expect(result?.watched).toBe(true);
    expect(progressOf(db, userId, 'movie', 1)).toMatchObject({ positionSeconds: 0, watched: true });
  });

  it('garde une seule ligne par œuvre, quel que soit le fichier', () => {
    // Les deux fichiers sont le MÊME film : la progression est celle de l'œuvre.
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 600, durationSeconds: FILM });
    saveProgress(db, { userId, mediaFileId: 102, positionSeconds: 900, durationSeconds: FILM });

    const rows = db
      .prepare("SELECT COUNT(*) AS count FROM playback_progress WHERE media_type = 'movie'")
      .get() as { count: number };
    expect(rows.count).toBe(1);
    expect(progressOf(db, userId, 'movie', 1)).toMatchObject({ positionSeconds: 900, mediaFileId: 102 });
  });

  it('conserve la durée déjà connue quand le lecteur ne l’envoie pas', () => {
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 600, durationSeconds: FILM });
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 700, durationSeconds: null });

    expect(progressOf(db, userId, 'movie', 1)?.durationSeconds).toBe(FILM);
  });

  it('refuse un fichier rattaché à aucune œuvre', () => {
    addFile(999, { name: 'Orphelin.mkv' });
    expect(saveProgress(db, { userId, mediaFileId: 999, positionSeconds: 60, durationSeconds: FILM })).toBeNull();
  });
});

describe('continueWatching — films', () => {
  it('propose un film commencé, avec son avancement', () => {
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 3600, durationSeconds: FILM });

    const [entry, ...rest] = continueWatching(db, userId);
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      kind: 'movie',
      workId: 1,
      title: 'Avatar',
      mediaFileId: 101,
      positionSeconds: 3600,
      ratio: 0.5,
      label: 'Il reste 1 h',
      mediaType: 'movie',
    });
  });

  it('écarte un film à peine commencé', () => {
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 120, durationSeconds: FILM });
    expect(continueWatching(db, userId)).toHaveLength(0);
  });

  it('écarte un film terminé', () => {
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: FILM * 0.95, durationSeconds: FILM });
    expect(continueWatching(db, userId)).toHaveLength(0);
  });

  it('retombe sur un autre fichier quand celui qu’on écoutait a disparu', () => {
    saveProgress(db, { userId, mediaFileId: 102, positionSeconds: 3600, durationSeconds: FILM });
    db.prepare('UPDATE media_file SET present = 0 WHERE id = 102').run();

    // La position appartient à l'œuvre : elle reste valable sur l'autre version.
    expect(continueWatching(db, userId)[0]).toMatchObject({ mediaFileId: 101, positionSeconds: 3600 });
  });

  it('retire l’œuvre dont plus aucun fichier n’est présent', () => {
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 3600, durationSeconds: FILM });
    db.prepare("UPDATE media_file SET present = 0 WHERE movie_id = 1").run();

    // Cliquer mènerait à une erreur : mieux vaut ne rien proposer.
    expect(continueWatching(db, userId)).toHaveLength(0);
  });

  it('oublie une entrée vieille de plus de six mois', () => {
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 3600, durationSeconds: FILM });
    db.prepare("UPDATE playback_progress SET updated_at = '2020-01-01T00:00:00.000Z'").run();

    expect(continueWatching(db, userId, new Date('2026-08-12T00:00:00.000Z'))).toHaveLength(0);
  });
});

describe('continueWatching — séries', () => {
  it('ne propose qu’une entrée par série, sur l’épisode en cours', () => {
    saveProgress(db, { userId, mediaFileId: 201, positionSeconds: EPISODE * 0.95, durationSeconds: EPISODE });
    saveProgress(db, { userId, mediaFileId: 202, positionSeconds: 1200, durationSeconds: EPISODE });

    const entries = continueWatching(db, userId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'show',
      workId: 1,
      title: 'One Piece',
      subtitle: 'S01:E2 Épisode 2',
      mediaFileId: 202,
      mediaType: 'episode',
      mediaId: 2,
    });
  });

  it('bascule sur l’épisode suivant quand le dernier est terminé', () => {
    saveProgress(db, { userId, mediaFileId: 202, positionSeconds: EPISODE * 0.95, durationSeconds: EPISODE });

    expect(continueWatching(db, userId)[0]).toMatchObject({
      mediaFileId: 203,
      mediaId: 3,
      positionSeconds: 0,
      ratio: 0,
      label: 'Épisode suivant',
    });
  });

  it('sort de la rangée après le dernier épisode', () => {
    saveProgress(db, { userId, mediaFileId: 203, positionSeconds: EPISODE * 0.95, durationSeconds: EPISODE });
    expect(continueWatching(db, userId)).toHaveLength(0);
  });

  it('classe films et séries ensemble, du plus récent au plus ancien', () => {
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 3600, durationSeconds: FILM });
    stamp('movie', '2026-08-01T00:00:00.000Z');
    saveProgress(db, { userId, mediaFileId: 201, positionSeconds: 1200, durationSeconds: EPISODE });
    stamp('episode', '2026-08-05T00:00:00.000Z');

    // Dates posées à la main et instant courant explicite : le classement ne
    // doit pas dépendre de l'horloge de la machine qui exécute les tests.
    const entries = continueWatching(db, userId, new Date('2026-08-06T00:00:00.000Z'));
    expect(entries.map((entry) => entry.kind)).toEqual(['show', 'movie']);
  });
});

describe('marquage manuel', () => {
  it('marque vu sans avoir jamais lu le fichier', () => {
    setWatched(db, userId, 'movie', 1, true);
    expect(progressOf(db, userId, 'movie', 1)).toMatchObject({ watched: true, positionSeconds: 0 });
    expect(continueWatching(db, userId)).toHaveLength(0);
  });

  it('démarque et laisse la position à zéro', () => {
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 3600, durationSeconds: FILM });
    setWatched(db, userId, 'movie', 1, false);

    expect(progressOf(db, userId, 'movie', 1)).toMatchObject({ watched: false, positionSeconds: 0 });
    // Position remise à zéro : plus rien à reprendre, donc plus dans la rangée.
    expect(continueWatching(db, userId)).toHaveLength(0);
  });

  it('oublie l’œuvre sans prétendre qu’elle a été vue', () => {
    saveProgress(db, { userId, mediaFileId: 101, positionSeconds: 3600, durationSeconds: FILM });
    forget(db, userId, 'movie', 1);

    expect(progressOf(db, userId, 'movie', 1)).toBeNull();
    expect(continueWatching(db, userId)).toHaveLength(0);
  });
});

describe('episodeStatesOf', () => {
  it('rend tous les épisodes, y compris ceux jamais ouverts', () => {
    saveProgress(db, { userId, mediaFileId: 202, positionSeconds: 1200, durationSeconds: EPISODE });

    const states = episodeStatesOf(db, userId, 1);
    expect(states.map((state) => state.episodeNumber)).toEqual([1, 2, 3]);
    expect(states[0]).toMatchObject({ positionSeconds: 0, updatedAt: null, watched: false, mediaFileId: 201 });
    expect(states[1]).toMatchObject({ positionSeconds: 1200, watched: false });
  });

  it('laisse mediaFileId nul quand l’épisode n’est plus sur le disque', () => {
    db.prepare('UPDATE media_file SET present = 0 WHERE id = 203').run();
    expect(episodeStatesOf(db, userId, 1)[2]?.mediaFileId).toBeNull();
  });
});
