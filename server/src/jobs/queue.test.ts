/**
 * Tests du mécanisme de file de travaux.
 *
 * Ce qui compte ici, ce sont les garanties de reprise : ne pas refaire ce qui
 * est fait, reprendre ce qui a été interrompu, et refaire ce qui a changé.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../db/index.js';
import { JobQueue, type JobRow } from './queue.js';
import { runQueue, type JobOutcome } from './runner.js';

let db: Db;
let queue: JobQueue;

beforeEach(() => {
  db = openDatabase(':memory:');
  queue = new JobQueue(db, 'probe');
});

function targets(ids: number[], fingerprint: (id: number) => string | null = () => null) {
  return ids.map((id) => ({ targetType: 'media_file' as const, targetId: id, fingerprint: fingerprint(id) }));
}

describe('enqueue', () => {
  it('crée un travail par cible inconnue', () => {
    expect(queue.enqueue(targets([1, 2, 3]))).toEqual({ added: 3, reactivated: 0, unchanged: 0 });
    expect(queue.counts()).toMatchObject({ pending: 3, total: 3 });
  });

  it('ne recrée rien au deuxième appel', () => {
    queue.enqueue(targets([1, 2, 3]));
    expect(queue.enqueue(targets([1, 2, 3]))).toEqual({ added: 0, reactivated: 0, unchanged: 3 });
    expect(queue.counts().total).toBe(3);
  });

  it('laisse tranquille un travail déjà terminé dont l’empreinte n’a pas changé', () => {
    queue.enqueue(targets([1], () => 'taille:1000|mtime:42'));
    const [job] = queue.claim(1);
    queue.complete((job as JobRow).id);

    expect(queue.enqueue(targets([1], () => 'taille:1000|mtime:42'))).toMatchObject({ unchanged: 1 });
    expect(queue.counts()).toMatchObject({ done: 1, pending: 0 });
  });

  it('remet en attente un travail dont l’empreinte a changé', () => {
    queue.enqueue(targets([1], () => 'taille:1000|mtime:42'));
    const [job] = queue.claim(1);
    queue.complete((job as JobRow).id);

    // Le fichier a été remplacé : nouvelle taille, nouvelle date.
    expect(queue.enqueue(targets([1], () => 'taille:2000|mtime:99'))).toMatchObject({ reactivated: 1 });
    expect(queue.counts()).toMatchObject({ pending: 1, done: 0 });
  });

  it('sépare les files : deux passes ne se marchent pas dessus', () => {
    queue.enqueue(targets([1, 2]));
    const other = new JobQueue(db, 'metadata');
    other.enqueue(targets([1, 2]));

    expect(queue.counts().total).toBe(2);
    expect(other.counts().total).toBe(2);

    const [job] = queue.claim(1);
    queue.complete((job as JobRow).id);
    expect(queue.counts()).toMatchObject({ done: 1 });
    expect(other.counts()).toMatchObject({ done: 0, pending: 2 });
  });
});

describe('reprise après interruption', () => {
  it('remet en attente les travaux restés « running »', () => {
    queue.enqueue(targets([1, 2, 3]));
    queue.claim(2); // passe en running, puis « le processus meurt »
    expect(queue.counts()).toMatchObject({ running: 2, pending: 1 });

    expect(queue.requeueStale()).toBe(2);
    expect(queue.counts()).toMatchObject({ running: 0, pending: 3 });
  });

  it('ne reprend pas les travaux déjà terminés', () => {
    queue.enqueue(targets([1, 2, 3]));
    const claimed = queue.claim(3);
    queue.complete((claimed[0] as JobRow).id);
    queue.fail((claimed[1] as JobRow).id, 'fichier illisible');
    // Le troisième reste running : la passe a été interrompue.

    queue.requeueStale();
    expect(queue.counts()).toMatchObject({ done: 1, failed: 1, pending: 1 });
  });

  it('rejoue les échecs à la demande, sans toucher au reste', () => {
    queue.enqueue(targets([1, 2]));
    const claimed = queue.claim(2);
    queue.complete((claimed[0] as JobRow).id);
    queue.fail((claimed[1] as JobRow).id, 'timeout');

    expect(queue.requeueFailed()).toBe(1);
    expect(queue.counts()).toMatchObject({ done: 1, pending: 1, failed: 0 });
  });

  it('compte les essais et conserve le dernier message d’erreur', () => {
    queue.enqueue(targets([1]));
    queue.fail((queue.claim(1)[0] as JobRow).id, 'premier échec');
    queue.requeueFailed();
    queue.fail((queue.claim(1)[0] as JobRow).id, 'deuxième échec');

    expect(queue.failures()).toEqual([{ target_id: 1, last_error: 'deuxième échec', attempts: 2 }]);
  });
});

describe('runQueue', () => {
  it('traite tous les travaux et rend le bilan', async () => {
    queue.enqueue(targets([1, 2, 3, 4, 5]));

    const seen: number[] = [];
    const summary = await runQueue(
      queue,
      async (job): Promise<JobOutcome> => {
        seen.push(job.target_id);
        if (job.target_id === 3) return { status: 'failed', error: 'illisible' };
        if (job.target_id === 4) return { status: 'skipped', reason: 'rien à faire' };
        return { status: 'done' };
      },
      { concurrency: 2 },
    );

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(summary).toMatchObject({ processed: 5, done: 3, skipped: 1, failed: 1 });
    expect(queue.counts()).toMatchObject({ done: 3, skipped: 1, failed: 1, pending: 0 });
  });

  it('ne retraite rien au deuxième lancement', async () => {
    queue.enqueue(targets([1, 2, 3]));
    await runQueue(queue, async () => ({ status: 'done' }), { concurrency: 2 });

    let calls = 0;
    const summary = await runQueue(
      queue,
      async () => {
        calls += 1;
        return { status: 'done' };
      },
      { concurrency: 2 },
    );

    expect(calls).toBe(0);
    expect(summary.processed).toBe(0);
  });

  it('transforme une exception du traitement en échec, sans interrompre la passe', async () => {
    queue.enqueue(targets([1, 2, 3]));

    const summary = await runQueue(
      queue,
      async (job) => {
        if (job.target_id === 2) throw new Error('ffprobe a explosé');
        return { status: 'done' };
      },
      { concurrency: 1 },
    );

    expect(summary).toMatchObject({ processed: 3, done: 2, failed: 1 });
    expect(queue.failures()).toEqual([{ target_id: 2, last_error: 'ffprobe a explosé', attempts: 1 }]);
  });

  it('respecte la limite de concurrence', async () => {
    queue.enqueue(targets([1, 2, 3, 4, 5, 6, 7, 8]));

    let active = 0;
    let peak = 0;
    await runQueue(
      queue,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { status: 'done' };
      },
      { concurrency: 3 },
    );

    expect(peak).toBeLessThanOrEqual(3);
  });
});
