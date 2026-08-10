/**
 * Exécution d'une file de travaux, avec concurrence limitée et progression.
 *
 * Séparé de `JobQueue` pour une raison simple : la file décide QUOI faire, le
 * runner décide COMMENT le faire tourner. Les deux passes d'enrichissement
 * partagent ce runner et ne fournissent que leur fonction de traitement.
 */
import { JobQueue, type JobRow } from './queue.js';

export type JobOutcome =
  | { status: 'done' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export interface RunnerOptions {
  /** Nombre de travaux traités en parallèle. Le NAS n'aime pas la foule. */
  concurrency: number;
  /** Appelée régulièrement pour l'affichage. */
  onProgress?: (progress: RunProgress) => void;
}

export interface RunProgress {
  processed: number;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  /** Ce qui est en train d'être traité, pour donner un repère à l'écran. */
  current: string | null;
}

export interface RunSummary {
  processed: number;
  done: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Traite la file jusqu'à épuisement.
 *
 * `handle` ne doit jamais lever : une exception est rattrapée et transformée en
 * échec, pour qu'un fichier illisible n'interrompe pas la passe entière.
 */
export async function runQueue(
  queue: JobQueue,
  handle: (job: JobRow) => Promise<JobOutcome>,
  options: RunnerOptions,
): Promise<RunSummary> {
  const startedAt = Date.now();
  const total = queue.counts().pending;

  const progress: RunProgress = {
    processed: 0,
    total,
    done: 0,
    skipped: 0,
    failed: 0,
    current: null,
  };

  // Les travaux sont réservés par petits lots plutôt qu'un par un : moins
  // d'allers-retours avec SQLite, et la file reste reprenable à tout moment.
  const batchSize = Math.max(options.concurrency * 4, 16);
  let batch: JobRow[] = [];
  let cursor = 0;

  function nextJob(): JobRow | undefined {
    if (cursor >= batch.length) {
      batch = queue.claim(batchSize);
      cursor = 0;
      if (batch.length === 0) return undefined;
    }
    const job = batch[cursor];
    cursor += 1;
    return job;
  }

  async function worker(): Promise<void> {
    while (true) {
      const job = nextJob();
      if (job === undefined) return;

      let outcome: JobOutcome;
      try {
        outcome = await handle(job);
      } catch (error) {
        outcome = { status: 'failed', error: (error as Error).message };
      }

      if (outcome.status === 'done') {
        queue.complete(job.id);
        progress.done += 1;
      } else if (outcome.status === 'skipped') {
        queue.skip(job.id, outcome.reason);
        progress.skipped += 1;
      } else {
        queue.fail(job.id, outcome.error);
        progress.failed += 1;
      }

      progress.processed += 1;
      options.onProgress?.(progress);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

  return {
    processed: progress.processed,
    done: progress.done,
    skipped: progress.skipped,
    failed: progress.failed,
    durationMs: Date.now() - startedAt,
  };
}
