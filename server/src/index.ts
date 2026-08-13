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

import { registerHlsRoutes } from './api/hls.js';
import { registerPreparationRoutes } from './api/preparation.js';
import { registerProgressRoutes } from './api/progress.js';
import { registerReviewRoutes } from './api/review.js';
import { registerRoutes } from './api/routes.js';
import { registerStreamRoutes } from './api/stream.js';
import { ImageDownloader } from './metadata/images.js';
import { TmdbClient } from './metadata/tmdb.js';
import type { EnrichContext } from './metadata/enrich.js';
import { SessionManager } from './transcode/manager.js';
import { SubtitlePreparation, setPreparation } from './transcode/subtitleQueue.js';
import {
  describeCapabilities,
  detectCapabilities,
  type FfmpegCapabilities,
} from './transcode/capabilities.js';
import { supportedBackend } from './transcode/encode.js';
import {
  DATA_DIR,
  loadConfig,
  loadEnvFile,
  REPO_ROOT,
  resolveDatabasePath,
  resolveImagesPath,
  resolveTranscodePath,
  SUBTITLE_CACHE_DIR,
} from './config.js';
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

  /*
   * Détection de ffmpeg, sans jamais la supposer réussie.
   *
   * Son absence n'empêche PAS le serveur de démarrer : les 143 fichiers déjà
   * compatibles restent lisibles, et la décision de lecture le dit clairement
   * pour les autres. Un serveur qui refuse de démarrer parce qu'un encodeur
   * manque serait un mauvais échange.
   */
  let sessionManager: SessionManager | null = null;
  let hardwareReport: FfmpegCapabilities | null = null;
  let preparation: SubtitlePreparation | null = null;

  const subtitleCacheDir = SUBTITLE_CACHE_DIR;

  registerRoutes(app, db);
  registerProgressRoutes(app, db);
  registerPreparationRoutes(app, db);
  registerStreamRoutes(app, db, () => ({
    available: sessionManager !== null,
    ffmpegBinary: hardwareReport?.binary ?? 'ffmpeg',
  }));
  registerHlsRoutes(app, db, () => sessionManager);

  /*
   * L'état de l'accélération, consultable sans lire les journaux. Il porte le
   * détail des essais : lequel a été retenu, et ce que les autres ont répondu.
   */
  app.get('/api/transcode/capabilities', () => {
    if (hardwareReport === null) return { available: false, reason: 'ffmpeg introuvable au démarrage.' };
    return {
      available: true,
      ffmpeg: hardwareReport.version,
      device: hardwareReport.device,
      hardware: hardwareReport.hardware,
      toneMap: hardwareReport.toneMap,
      toneMapProbes: hardwareReport.toneMapProbes,
      cached: hardwareReport.cached,
      probes: hardwareReport.probes,
      summary: describeCapabilities(hardwareReport),
    };
  });

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

  const transcodePath = resolveTranscodePath(config);
  try {
    /*
     * Les essais d'encodage sont mis en cache dans DATA_DIR, à côté de la base.
     * Le cache tombe de lui-même dès que la version de ffmpeg ou le
     * périphérique de rendu change — c'est-à-dire dès que la réponse pourrait
     * être différente.
     */
    const capabilities = await detectCapabilities({ dataDir: DATA_DIR });
    hardwareReport = capabilities;

    /*
     * Le moteur détecté n'est pas forcément un moteur qu'on sait piloter. La
     * différence est dite ICI, au démarrage, et non découverte par hasard en
     * comparant des mesures.
     */
    const backend = supportedBackend(capabilities.hardware);
    for (const line of describeCapabilities(capabilities, backend)) app.log.info(line);

    sessionManager = new SessionManager({
      ffmpegBinary: capabilities.binary,
      workDir: transcodePath,
      /*
       * Le cache de sous-titres vit dans DATA_DIR, à côté de la base, et NON
       * dans le répertoire de transcodage : celui-ci est effacé à chaque
       * démarrage et monté en tmpfs, alors qu'une extraction coûte une
       * traversée complète du fichier source.
       */
      subtitleCacheDir,
      maxSessions: config.transcode.maxSessions,
      idleSeconds: config.transcode.idleSeconds,
      /*
       * L'accélération vient de l'essai réel mené juste au-dessus, jamais d'une
       * liste d'encodeurs — et elle passe par `supportedBackend`, qui refuse de
       * convertir en silence un moteur détecté mais non implémenté. Le ternaire
       * qu'elle remplace faisait transcoder en logiciel à x0,47 sans un mot.
       */
      hardware: backend.backend,
      device: capabilities.device ?? '/dev/dri/renderD128',
      toneMap: capabilities.toneMap,
      onLog: (message, details) => app.log.info(details ?? {}, message),
    });
    await sessionManager.start();

    /*
     * La préparation des sous-titres draine la file persistée sans jamais
     * bloquer une requête, et REPREND d'elle-même ce qu'un arrêt a laissé en
     * plan. Sur une passe de seize heures, c'est ce qui évite de découvrir au
     * matin qu'elle s'est arrêtée à trois heures.
     */
    preparation = new SubtitlePreparation(db, {
      ffmpegBinary: capabilities.binary,
      cacheDir: subtitleCacheDir,
      onLog: (message: string, details?: Record<string, unknown>) => app.log.info(details ?? {}, message),
    });
    setPreparation(preparation);
    preparation.start();
    app.log.info(
      `Transcodage : ${transcodePath} — ${config.transcode.maxSessions} session(s), ` +
        `expiration après ${config.transcode.idleSeconds} s`,
    );
  } catch (error) {
    app.log.warn((error as Error).message);
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Base SQLite : ${databasePath}`);
  if (!existsSync(webDist)) {
    app.log.info('web/dist absent : seule l’API est servie (normal en développement).');
  }

  /*
   * Troisième filet contre le ffmpeg orphelin : quoi qu'il arrive, l'arrêt du
   * serveur tue les processus restants et vide le répertoire de travail.
   */
  const shutdown = (): void => {
    preparation?.stop();
    void (sessionManager?.stop() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => app.close())
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
