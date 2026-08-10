/**
 * Démarrage du serveur HTTP.
 *
 * En développement, le front tourne à part (Vite, port 5173) et proxie
 * `/api` vers ici — voir web/vite.config.ts.
 *
 * En production, si `web/dist` existe (après `npm run build`), le serveur sert
 * aussi le front : une seule adresse à retenir.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import { registerRoutes } from './api/routes.js';
import { loadConfig, REPO_ROOT, resolveDatabasePath } from './config.js';
import { openDatabase } from './db/index.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const config = loadConfig();
  const databasePath = resolveDatabasePath(config);
  const db = openDatabase(databasePath);

  const app = Fastify({ logger: { transport: undefined, level: 'info' } });

  registerRoutes(app, db);

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
