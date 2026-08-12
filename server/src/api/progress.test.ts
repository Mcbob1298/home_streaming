/**
 * Tests des routes de progression, par injection Fastify.
 *
 * Ce qui se joue ici et nulle part ailleurs : le ROUTAGE. `/api/progress/show/:id`
 * et `/api/progress/:type/:id` ont la même forme, et « show » n'est pas un type
 * de média — si le routeur choisissait la route paramétrée, la fiche série
 * recevrait un 400 sans que rien d'autre ne le signale.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nowIso, openDatabase, type Db } from '../db/index.js';
import { forgetCurrentUser } from '../progress/user.js';
import { registerProgressRoutes } from './progress.js';

const EPISODE = 2400;

let db: Db;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDatabase(':memory:');
  // L'identité est mise en cache : sans cet oubli, le test suivant garderait
  // l'identifiant d'une base déjà fermée.
  forgetCurrentUser();

  const now = nowIso();
  db.prepare("INSERT INTO library (id, label, type) VALUES ('series', 'Séries', 'show')").run();
  db.prepare(
    "INSERT INTO library_root (id, library_id, path, path_key) VALUES (1, 'series', 'R:\\s', 'r:\\s')",
  ).run();
  db.prepare(
    `INSERT INTO show (id, library_id, title, title_key, year, sort_title, added_at, updated_at)
     VALUES (1, 'series', 'One Piece', 'one piece', 1999, 'one piece', ?, ?)`,
  ).run(now, now);
  db.prepare('INSERT INTO season (id, show_id, season_number, added_at) VALUES (1, 1, 1, ?)').run(now);

  for (const number of [1, 2]) {
    db.prepare(
      `INSERT INTO episode (id, show_id, season_id, season_number, episode_number, title, added_at, updated_at)
       VALUES (?, 1, 1, 1, ?, ?, ?, ?)`,
    ).run(number, number, `Épisode ${number}`, now, now);
    db.prepare(
      `INSERT INTO media_file
         (id, library_id, library_root_id, path, path_key, relative_path, file_name, extension,
          size_bytes, mtime_ms, present, first_seen_at, last_seen_at, episode_id)
       VALUES (?, 'series', 1, ?, ?, ?, ?, '.mkv', 1000, 1, 1, ?, ?, ?)`,
    ).run(100 + number, `R:\\E${number}.mkv`, `r:\\e${number}.mkv`, `E${number}.mkv`, `E${number}.mkv`, now, now, number);
  }

  app = Fastify();
  registerProgressRoutes(app, db);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  forgetCurrentUser();
});

describe('POST /api/progress', () => {
  it('enregistre une position et renvoie le verdict du serveur', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/progress',
      payload: { mediaFileId: 101, positionSeconds: 1200, durationSeconds: EPISODE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ watched: false, mediaType: 'episode', mediaId: 1 });
  });

  it('refuse une requête sans position', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/progress', payload: { mediaFileId: 101 } });
    expect(response.statusCode).toBe(400);
  });

  it('signale un fichier inconnu', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/progress',
      payload: { mediaFileId: 9999, positionSeconds: 10, durationSeconds: EPISODE },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/progress/show/:id', () => {
  it('rend la grille ET le point de reprise', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/progress',
      payload: { mediaFileId: 101, positionSeconds: 1200, durationSeconds: EPISODE },
    });

    const response = await app.inject({ method: 'GET', url: '/api/progress/show/1' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      episodes: { episodeId: number; ratio: number }[];
      resume: { kind: string; mediaFileId: number; numbering: string; label: string } | null;
    };

    expect(body.episodes).toEqual([
      { episodeId: 1, positionSeconds: 1200, durationSeconds: EPISODE, watched: false, ratio: 0.5 },
    ]);
    expect(body.resume).toEqual({
      kind: 'resume',
      episodeId: 1,
      mediaFileId: 101,
      label: 'S01:E1 Épisode 1',
      numbering: 'S01:E1',
      positionSeconds: 1200,
    });
  });

  it('propose l’épisode suivant quand le précédent est terminé', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/progress',
      payload: { mediaFileId: 101, positionSeconds: EPISODE * 0.95, durationSeconds: EPISODE },
    });

    const body = response(await app.inject({ method: 'GET', url: '/api/progress/show/1' }));
    expect(body.resume).toMatchObject({ kind: 'next', mediaFileId: 102, positionSeconds: 0 });
  });

  it('rend une série jamais commencée sans point de reprise', async () => {
    const body = response(await app.inject({ method: 'GET', url: '/api/progress/show/1' }));
    expect(body).toEqual({ episodes: [], resume: null });
  });
});

describe('GET /api/progress/:type/:id', () => {
  it('rend une progression à zéro plutôt qu’un 404', async () => {
    // Ne jamais avoir commencé est un ÉTAT, pas une erreur : la fiche doit
    // pouvoir l'afficher sans traiter un cas particulier.
    const result = await app.inject({ method: 'GET', url: '/api/progress/episode/1' });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ positionSeconds: 0, watched: false, mediaFileId: null });
  });

  it('refuse un type de média inventé', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/progress/saison/1' })).statusCode).toBe(400);
  });
});

describe('marquage et oubli', () => {
  it('marque vu, puis démarque', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/progress/episode/1/watched' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/progress/episode/1' })).json().watched).toBe(true);

    await app.inject({ method: 'POST', url: '/api/progress/episode/1/unwatched' });
    expect((await app.inject({ method: 'GET', url: '/api/progress/episode/1' })).json().watched).toBe(false);
  });

  it('retire de la liste sans prétendre que c’est vu', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/progress',
      payload: { mediaFileId: 101, positionSeconds: 1200, durationSeconds: EPISODE },
    });

    expect((await app.inject({ method: 'DELETE', url: '/api/progress/episode/1' })).statusCode).toBe(204);
    const continued = (await app.inject({ method: 'GET', url: '/api/progress/continue' })).json();
    expect(continued).toEqual([]);
  });
});

describe('GET /api/progress/continue', () => {
  it('ne rend qu’une entrée par série', async () => {
    for (const mediaFileId of [101, 102]) {
      await app.inject({
        method: 'POST',
        url: '/api/progress',
        payload: { mediaFileId, positionSeconds: 1200, durationSeconds: EPISODE },
      });
    }

    const entries = (await app.inject({ method: 'GET', url: '/api/progress/continue' })).json() as {
      kind: string;
      mediaId: number;
    }[];

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'show', mediaId: 2 });
  });
});

/** Raccourci de lecture du corps, typé pour les seuls champs utilisés ici. */
function response(raw: { json: () => unknown }): {
  episodes: unknown[];
  resume: { kind: string; mediaFileId: number; positionSeconds: number } | null;
} {
  return raw.json() as {
    episodes: unknown[];
    resume: { kind: string; mediaFileId: number; positionSeconds: number } | null;
  };
}
