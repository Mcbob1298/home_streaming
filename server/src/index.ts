/**
 * Démarrage du serveur HTTP.
 *
 * En développement, le front tourne à part (Vite, port 5173) et proxie
 * `/api` vers ici — voir web/vite.config.ts.
 *
 * En production, si `web/dist` existe (après `npm run build`), le serveur sert
 * aussi le front : une seule adresse à retenir.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import { registerReviewRoutes } from './api/review.js';
import { registerRoutes } from './api/routes.js';
import { ImageDownloader } from './metadata/images.js';
import { TmdbClient } from './metadata/tmdb.js';
import type { EnrichContext } from './metadata/enrich.js';
import { loadConfig, loadEnvFile, REPO_ROOT, resolveDatabasePath, resolveImagesPath } from './config.js';
import { openDatabase } from './db/index.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  loadEnvFile();

  const config = loadConfig();
  const databasePath = resolveDatabasePath(config);
  const imagesPath = resolveImagesPath(config);
  const db = openDatabase(databasePath);

  const app = Fastify({ logger: { transport: undefined, level: 'info' } });

  registerRoutes(app, db);

  /*
   * Le client TMDB est construit à la première demande, et une seule fois.
   *
   * Le construire au démarrage ferait échouer le serveur entier quand le jeton
   * manque, alors que seul l'écran de review en a besoin : la consultation de
   * la bibliothèque, elle, n'appelle jamais TMDB.
   */
  let enrichContext: EnrichContext | null = null;
  registerReviewRoutes(app, db, () => {
    enrichContext ??= {
      db,
      client: new TmdbClient({ cacheDir: path.join(REPO_ROOT, 'data', 'tmdb-cache') }),
      images: new ImageDownloader(imagesPath),
    };
    return enrichContext;
  });

  /*
   * Affiches téléchargées par `npm run metadata`.
   *
   * Le nom de fichier vient de TMDB et ne change jamais pour une image donnée :
   * on peut donc dire au navigateur de la garder très longtemps en cache.
   * `mkdirSync` évite que Fastify refuse de démarrer si la passe métadonnées
   * n'a pas encore tourné.
   */
  mkdirSync(imagesPath, { recursive: true });
  await app.register(fastifyStatic, {
    root: imagesPath,
    prefix: '/images/',
    decorateReply: false,
    maxAge: '365d',
    immutable: true,
  });

  const webDist = path.join(REPO_ROOT, 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    // React Router gère les URL côté navigateur : toute route inconnue renvoie
    // index.html, sinon un rechargement sur /library/films donnerait un 404.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Route inconnue' });
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Base SQLite : ${databasePath}`);
  if (!existsSync(webDist)) {
    app.log.info('web/dist absent : seule l’API est servie (normal en développement).');
  }

  const shutdown = (): void => {
    app
      .close()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
