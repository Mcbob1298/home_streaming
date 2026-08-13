/**
 * La file d'extraction des sous-titres, et son travailleur.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEUX ENTRÉES, UNE SEULE FILE.
 *
 * Le serveur y met un fichier quand quelqu'un l'ouvre ; `npm run subtitles` y
 * met toute la bibliothèque. C'est la MÊME file persistée que `probe` et
 * `metadata`, avec les mêmes garanties : reprise après interruption, pas de
 * retraitement à empreinte inchangée, échecs conservés pour le rapport.
 *
 * Conséquence utile : un fichier déjà préparé par la passe de préchauffage ne
 * sera pas re-extrait quand on l'ouvrira, et une extraction interrompue par un
 * arrêt du serveur reprend au démarrage suivant sans que personne ne redemande.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Db } from '../db/index.js';
import { JobQueue } from '../jobs/queue.js';
import { extractSubtitles, extractableTracksOf, readyStreams, type SubtitleSource } from './subtitles.js';

export const SUBTITLE_QUEUE = 'subtitles';

/** Une seule extraction à la fois : chacune sature déjà la lecture du partage. */
const CONCURRENCY = 1;

export function subtitleQueue(db: Db): JobQueue {
  return new JobQueue(db, SUBTITLE_QUEUE);
}

const MEDIA_COLUMNS = `
  id, path, raw_path AS rawPath, size_bytes AS sizeBytes, mtime_ms AS mtimeMs
`;

export function subtitleSourceOf(db: Db, mediaFileId: number): SubtitleSource | undefined {
  return db
    .prepare(`SELECT ${MEDIA_COLUMNS} FROM media_file WHERE id = ? AND present = 1`)
    .get(mediaFileId) as SubtitleSource | undefined;
}

/**
 * Tous les fichiers présents ayant au moins une piste texte extractible.
 *
 * L'empreinte est le couple taille + date de modification, la même que celle du
 * nom de répertoire du cache : un fichier réencodé repasse en attente tout seul.
 */
export function filesWithTextSubtitles(db: Db): { source: SubtitleSource; fingerprint: string }[] {
  const rows = db
    .prepare(
      `SELECT ${MEDIA_COLUMNS} FROM media_file f
       WHERE f.present = 1
         AND EXISTS (SELECT 1 FROM embedded_subtitle s
                     WHERE s.media_file_id = f.id AND s.is_image_based = 0 AND s.codec IS NOT NULL)
       ORDER BY f.id`,
    )
    .all() as SubtitleSource[];

  return rows
    .filter((source) => extractableTracksOf(db, source.id).length > 0)
    .map((source) => ({ source, fingerprint: `${source.sizeBytes}-${Math.round(source.mtimeMs)}` }));
}

/**
 * Inscrit un fichier dans la file, s'il a quelque chose à extraire.
 *
 * Appelée depuis une requête HTTP — mais elle n'extrait RIEN : elle écrit une
 * ligne en base et rend la main. C'est tout ce qu'une requête a le droit de
 * faire d'une opération qui dure cinq minutes.
 */
export function requestExtraction(db: Db, mediaFileId: number): boolean {
  const source = subtitleSourceOf(db, mediaFileId);
  if (source === undefined) return false;
  if (extractableTracksOf(db, source.id).length === 0) return false;

  subtitleQueue(db).enqueue([
    {
      targetType: 'media_file',
      targetId: source.id,
      fingerprint: `${source.sizeBytes}-${Math.round(source.mtimeMs)}`,
    },
  ]);
  return true;
}

export interface WorkerOptions {
  ffmpegBinary: string;
  cacheDir: string;
  onLog: (message: string, details?: Record<string, unknown>) => void;
}

/**
 * Le travailleur de fond du serveur.
 *
 * Il draine la file sans jamais bloquer une requête. Le rythme est volontairement
 * paresseux : quand la file est vide, on ne regarde que toutes les dix secondes,
 * et une inscription réveille immédiatement le travailleur — la lecture qui vient
 * de démarrer n'a pas à attendre le prochain réveil.
 */
export class SubtitleWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly options: WorkerOptions,
  ) {}

  start(): void {
    this.stopped = false;
    // Une extraction laissée « running » par un arrêt brutal n'est suivie par
    // personne : elle doit repartir, sinon elle bloquerait la file à jamais.
    subtitleQueue(this.db).requeueStale();

    this.timer = setInterval(() => void this.drain(), 10_000);
    this.timer.unref();
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Réveil immédiat, après une inscription venue d'une requête. */
  wake(): void {
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;

    try {
      const queue = subtitleQueue(this.db);
      for (;;) {
        const jobs = queue.claim(CONCURRENCY);
        if (jobs.length === 0 || this.stopped) break;

        for (const job of jobs) {
          const source = subtitleSourceOf(this.db, job.target_id);
          if (source === undefined) {
            queue.skip(job.id, 'fichier absent de l’index ou disparu du disque');
            continue;
          }

          const started = Date.now();
          try {
            const count = await extractSubtitles(
              this.db,
              this.options.ffmpegBinary,
              this.options.cacheDir,
              source,
            );
            queue.complete(job.id);
            this.options.onLog('sous-titres extraits', {
              mediaFileId: source.id,
              pistes: count,
              ms: Date.now() - started,
            });
          } catch (error) {
            queue.fail(job.id, (error as Error).message);
            this.options.onLog('extraction de sous-titres en échec', {
              mediaFileId: source.id,
              error: (error as Error).message,
            });
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Le travailleur du processus courant.
 *
 * Un singleton assumé, comme l'identité de l'utilisateur : il n'y a qu'un
 * travailleur par serveur, et les routes doivent pouvoir le réveiller sans
 * qu'on fasse traverser sa référence à toute la pile d'enregistrement des
 * routes. Absent dans les tests et dans les commandes en ligne, où réveiller
 * n'a aucun sens.
 */
let worker: SubtitleWorker | null = null;

export function setSubtitleWorker(instance: SubtitleWorker | null): void {
  worker = instance;
}

/** Réveille le travailleur, s'il y en a un. Sans effet ailleurs. */
export function wakeSubtitleWorker(): void {
  worker?.wake();
}

/** Ce que le sélecteur du lecteur doit savoir de l'état d'un fichier. */
export interface SubtitleReadiness {
  ready: number[];
  /** Vrai tant qu'il reste des pistes à produire. */
  preparing: boolean;
  total: number;
}

export function readinessOf(db: Db, cacheDir: string, mediaFileId: number): SubtitleReadiness {
  const source = subtitleSourceOf(db, mediaFileId);
  if (source === undefined) return { ready: [], preparing: false, total: 0 };

  const total = extractableTracksOf(db, source.id).length;
  const ready = [...readyStreams(cacheDir, source)].sort((a, b) => a - b);

  return { ready, preparing: ready.length < total, total };
}
