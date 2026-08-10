/**
 * Commande `npm run probe` — passe A de l'enrichissement.
 *
 * Sonde chaque fichier avec ffprobe et remplit les colonnes techniques laissées
 * NULL par le scan, plus les tables `audio_track` et `embedded_subtitle`.
 *
 * Comme le scan, cette passe ne se déclenche JAMAIS depuis une requête HTTP.
 * Elle est reprenable : la file de travaux est persistée en base, un fichier
 * déjà sondé dont la taille et la date n'ont pas bougé n'est pas re-sondé.
 *
 * Options :
 *   --full            re-sonde tout, même les fichiers déjà traités
 *   --retry-failed    rejoue uniquement les fichiers en échec
 *   --concurrency=<n> fichiers sondés en parallèle (défaut : 5)
 *   --timeout=<s>     délai maximum par fichier (défaut : 120 s)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DATA_DIR, loadConfig, resolveDatabasePath } from '../config.js';
import { openDatabase } from '../db/index.js';
import { JobQueue } from '../jobs/queue.js';
import { runQueue, type JobOutcome } from '../jobs/runner.js';
import { checkFfprobe, FfprobeMissingError, probeFile } from './ffprobe.js';
import { buildProbeReport } from './report.js';
import { fingerprintOf, getProbeTarget, listProbeTargets, saveProbeResult } from './store.js';

const QUEUE_NAME = 'probe';

/** Le NAS n'aime pas la foule : 5 lectures simultanées est un bon compromis. */
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_SECONDS = 120;

interface CliOptions {
  full: boolean;
  retryFailed: boolean;
  concurrency: number;
  timeoutMs: number;
}

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = {
    full: false,
    retryFailed: false,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
  };

  for (const argument of argv) {
    if (argument === '--full') options.full = true;
    else if (argument === '--retry-failed') options.retryFailed = true;
    else if (argument.startsWith('--concurrency=')) {
      const value = Number(argument.slice('--concurrency='.length));
      if (Number.isFinite(value) && value > 0) options.concurrency = Math.floor(value);
    } else if (argument.startsWith('--timeout=')) {
      const value = Number(argument.slice('--timeout='.length));
      if (Number.isFinite(value) && value > 0) options.timeoutMs = Math.floor(value) * 1000;
    }
  }

  return options;
}

function createProgressPrinter(total: number): (processed: number, done: number, failed: number) => void {
  const isTty = process.stdout.isTTY === true;
  let lastPrintedAt = 0;
  const startedAt = Date.now();

  return (processed, done, failed) => {
    const now = Date.now();
    const finished = processed >= total;
    if (!finished && now - lastPrintedAt < 250) return;
    lastPrintedAt = now;

    const share = total === 0 ? 1 : processed / total;
    const elapsed = (now - startedAt) / 1000;
    const remaining = share > 0 ? Math.round(elapsed / share - elapsed) : 0;
    const message =
      `  ${processed}/${total} (${Math.round(share * 100)} %)` +
      `  ·  ${done} ok  ·  ${failed} échec(s)` +
      (processed > 0 && !finished ? `  ·  reste ~${remaining} s` : '');

    if (isTty) process.stdout.write(`\r${message.padEnd(78)}`);
    else process.stdout.write(`${message}\n`);
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const databasePath = resolveDatabasePath(config);

  // FFPROBE_PATH permet de désigner un binaire hors du PATH.
  const binary = process.env.FFPROBE_PATH ?? 'ffprobe';
  const version = await checkFfprobe(binary);
  console.log(version);
  console.log(`Base   : ${databasePath}`);

  const db = openDatabase(databasePath);
  const queue = new JobQueue(db, QUEUE_NAME);

  // Une passe interrompue laisse des travaux « running » que plus personne ne
  // traite : on les remet en attente avant de commencer.
  const stale = queue.requeueStale();
  if (stale > 0) console.log(`${stale} travail(aux) repris d'une passe interrompue.`);

  const targets = listProbeTargets(db);
  const enqueued = queue.enqueue(
    targets.map((row) => ({
      targetType: 'media_file' as const,
      targetId: row.id,
      fingerprint: fingerprintOf(row),
    })),
  );

  if (options.full) {
    const reset = queue.requeueAll();
    console.log(`Mode complet : ${reset} fichier(s) remis en attente.`);
  } else if (options.retryFailed) {
    const reset = queue.requeueFailed();
    console.log(`${reset} fichier(s) en échec remis en attente.`);
  }

  console.log(
    `Fichiers : ${targets.length} présents — ${enqueued.added} nouveaux, ` +
      `${enqueued.reactivated} modifiés, ${enqueued.unchanged} déjà à jour.`,
  );

  const pending = queue.counts().pending;
  if (pending === 0) {
    console.log('Rien à sonder. Utilisez --full pour tout re-sonder.');
  } else {
    console.log(`À sonder : ${pending} fichier(s), ${options.concurrency} en parallèle.\n`);
  }

  const printProgress = createProgressPrinter(pending);

  const summary = await runQueue(
    queue,
    async (job): Promise<JobOutcome> => {
      const target = getProbeTarget(db, job.target_id);
      if (target === undefined) return { status: 'skipped', reason: 'fichier absent de l’index' };

      /*
       * RÈGLE CRITIQUE : on donne à ffprobe le chemin EXACT issu de readdir
       * (`raw_path`), jamais la forme NFC (`path`). NTFS et SMB comparent les
       * noms octet à octet, sans normalisation Unicode : un chemin recomposé
       * peut ne pas exister sur le disque.
       *
       * Le repli sur `path` ne sert qu'aux bases créées avant l'introduction de
       * `raw_path` ; un simple `npm run scan` le renseigne.
       */
      const filePath = target.raw_path ?? target.path;

      try {
        const result = await probeFile(binary, filePath, options.timeoutMs);
        saveProbeResult(db, target.id, result);
        return { status: 'done' };
      } catch (error) {
        const message = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
          ? `délai dépassé (> ${options.timeoutMs / 1000} s)`
          : (error as Error).message.split('\n')[0] ?? 'erreur inconnue';
        return { status: 'failed', error: message };
      }
    },
    {
      concurrency: options.concurrency,
      onProgress: (progress) => printProgress(progress.processed, progress.done, progress.failed),
    },
  );

  if (process.stdout.isTTY === true) process.stdout.write('\n');

  const report = buildProbeReport(db, {
    counts: queue.counts(),
    summary,
    failures: queue.failures(),
    ffprobeVersion: version,
  });

  console.log(`\n${report}`);

  mkdirSync(DATA_DIR, { recursive: true });
  const reportPath = path.join(DATA_DIR, 'probe-report.txt');
  writeFileSync(reportPath, `${report}\n`, 'utf8');
  console.log(`\nRapport écrit dans ${reportPath}`);

  db.close();
}

main().catch((error: unknown) => {
  if (error instanceof FfprobeMissingError) {
    console.error(`\n${error.message}`);
  } else {
    console.error(`\n${(error as Error).message}`);
  }
  process.exitCode = 1;
});
