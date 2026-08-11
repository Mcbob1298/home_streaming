/**
 * Commande `npm run metadata` — passe B de l'enrichissement.
 *
 * Apparie chaque film et chaque série avec TMDB, remplit les métadonnées et
 * télécharge les affiches en local.
 *
 * Comme le scan et le sondage, cette passe ne se déclenche JAMAIS depuis une
 * requête HTTP, et elle est reprenable : la file de travaux est persistée, les
 * réponses de l'API sont mises en cache sur disque.
 *
 * Rien n'est deviné : une correspondance douteuse est enregistrée en
 * « à vérifier » sans écrire une seule métadonnée.
 *
 * Options :
 *   --full            réapparie tout, y compris ce qui est déjà fait
 *   --retry-failed    rejoue uniquement les entrées en échec
 *   --refresh         ignore le cache disque et réinterroge TMDB
 *   --movies-only     ne traite que les films
 *   --shows-only      ne traite que les séries
 *   --concurrency=<n> œuvres traitées en parallèle (défaut : 4)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DATA_DIR, loadConfig, loadEnvFile, resolveDatabasePath, resolveImagesPath } from '../config.js';
import { openDatabase } from '../db/index.js';
import { JobQueue } from '../jobs/queue.js';
import { runQueue, type JobOutcome } from '../jobs/runner.js';
import { enrichWork, type EnrichContext } from './enrich.js';
import { ImageDownloader } from './images.js';
import { buildMetadataReport } from './report.js';
import { fingerprintOf, listMovies, listShows, type TargetType } from './store.js';
import { TmdbClient, TmdbHttpError, TmdbTokenMissingError } from './tmdb.js';

const QUEUE_NAME = 'metadata';

/**
 * Quatre œuvres en parallèle. Combiné à l'intervalle minimum du client, on
 * reste largement sous la limite de TMDB tout en gardant la passe rapide.
 */
const DEFAULT_CONCURRENCY = 4;

interface CliOptions {
  full: boolean;
  retryFailed: boolean;
  refresh: boolean;
  types: TargetType[];
  concurrency: number;
}

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = {
    full: false,
    retryFailed: false,
    refresh: false,
    types: ['movie', 'show'],
    concurrency: DEFAULT_CONCURRENCY,
  };

  for (const argument of argv) {
    if (argument === '--full') options.full = true;
    else if (argument === '--retry-failed') options.retryFailed = true;
    else if (argument === '--refresh') options.refresh = true;
    else if (argument === '--movies-only') options.types = ['movie'];
    else if (argument === '--shows-only') options.types = ['show'];
    else if (argument.startsWith('--concurrency=')) {
      const value = Number(argument.slice('--concurrency='.length));
      if (Number.isFinite(value) && value > 0) options.concurrency = Math.floor(value);
    }
  }

  return options;
}

function createProgressPrinter(total: number): (processed: number, failed: number) => void {
  const isTty = process.stdout.isTTY === true;
  let lastPrintedAt = 0;
  const startedAt = Date.now();

  return (processed, failed) => {
    const now = Date.now();
    const finished = processed >= total;
    if (!finished && now - lastPrintedAt < 250) return;
    lastPrintedAt = now;

    const share = total === 0 ? 1 : processed / total;
    const elapsed = (now - startedAt) / 1000;
    const remaining = share > 0 ? Math.round(elapsed / share - elapsed) : 0;
    const message =
      `  ${processed}/${total} (${Math.round(share * 100)} %)  ·  ${failed} échec(s)` +
      (processed > 0 && !finished ? `  ·  reste ~${remaining} s` : '');

    if (isTty) process.stdout.write(`\r${message.padEnd(78)}`);
    else process.stdout.write(`${message}\n`);
  };
}

async function main(): Promise<void> {
  loadEnvFile();

  const options = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const databasePath = resolveDatabasePath(config);
  const imagesPath = resolveImagesPath(config);
  const cacheDir = path.join(DATA_DIR, 'tmdb-cache');

  const client = new TmdbClient({ cacheDir, refresh: options.refresh });

  console.log(`Base    : ${databasePath}`);
  console.log(`Images  : ${imagesPath}`);
  console.log(`Cache   : ${cacheDir}${options.refresh ? '  (ignoré, --refresh)' : ''}`);

  const db = openDatabase(databasePath);
  const queue = new JobQueue(db, QUEUE_NAME);
  const images = new ImageDownloader(imagesPath);
  const context: EnrichContext = { db, client, images };

  const stale = queue.requeueStale();
  if (stale > 0) console.log(`${stale} travail(aux) repris d'une passe interrompue.`);

  const works: { type: TargetType; rows: ReturnType<typeof listMovies> }[] = [];
  if (options.types.includes('movie')) works.push({ type: 'movie', rows: listMovies(db) });
  if (options.types.includes('show')) works.push({ type: 'show', rows: listShows(db) });

  let added = 0;
  let reactivated = 0;
  for (const { type, rows } of works) {
    const result = queue.enqueue(
      rows.map((row) => ({ targetType: type, targetId: row.id, fingerprint: fingerprintOf(row) })),
    );
    added += result.added;
    reactivated += result.reactivated;
  }

  if (options.full) {
    console.log(`Mode complet : ${queue.requeueAll()} entrée(s) remises en attente.`);
  } else if (options.retryFailed) {
    console.log(`${queue.requeueFailed()} entrée(s) en échec remises en attente.`);
  }

  const totalWorks = works.reduce((sum, entry) => sum + entry.rows.length, 0);
  console.log(`Œuvres  : ${totalWorks} — ${added} nouvelles, ${reactivated} modifiées.`);

  const pending = queue.counts().pending;
  if (pending === 0) {
    console.log('Rien à apparier. Utilisez --full pour tout refaire.');
  } else {
    console.log(`À traiter : ${pending}, ${options.concurrency} en parallèle.\n`);
  }

  const printProgress = createProgressPrinter(pending);

  const summary = await runQueue(
    queue,
    async (job): Promise<JobOutcome> => {
      const type = job.target_type === 'movie' ? 'movie' : 'show';
      try {
        return await enrichWork(context, type, job.target_id);
      } catch (error) {
        // Un jeton refusé n'est pas un incident isolé : inutile de s'acharner
        // sur les 480 entrées suivantes.
        if (error instanceof TmdbHttpError && (error.status === 401 || error.status === 403)) throw error;
        return { status: 'failed', error: (error as Error).message.split('\n')[0] ?? 'erreur inconnue' };
      }
    },
    {
      concurrency: options.concurrency,
      onProgress: (progress) => printProgress(progress.processed, progress.failed),
    },
  );

  if (process.stdout.isTTY === true) process.stdout.write('\n');

  const report = buildMetadataReport(db, { summary, images: images.stats, api: client.stats });
  console.log(`\n${report}`);

  mkdirSync(DATA_DIR, { recursive: true });
  const reportPath = path.join(DATA_DIR, 'metadata-report.txt');
  writeFileSync(reportPath, `${report}\n`, 'utf8');
  console.log(`\nRapport écrit dans ${reportPath}`);

  db.close();
}

main().catch((error: unknown) => {
  if (error instanceof TmdbTokenMissingError || error instanceof TmdbHttpError) {
    console.error(`\n${error.message}`);
  } else {
    console.error(`\n${(error as Error).message}`);
  }
  process.exitCode = 1;
});
