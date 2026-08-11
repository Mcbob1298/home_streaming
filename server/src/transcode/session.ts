/**
 * Sessions de transcodage : un processus ffmpeg, ses segments, sa fin de vie.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE DÉFAUT À NE PAS AVOIR : un ffmpeg orphelin qui tourne indéfiniment.
 *
 * Trois filets, parce qu'un seul ne suffit pas :
 *   1. un balayage périodique tue les sessions inactives ;
 *   2. le lecteur prévient explicitement quand il quitte la page ;
 *   3. l'arrêt du serveur tue tout ce qui reste.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { buildRemuxArgs, planRuns, type RunPlan } from './args.js';
import {
  INIT_FILE_NAME,
  PRIMER_COUNT,
  PRIMER_DURATION,
  SEGMENT_DURATION,
  segmentFileName,
  type PlannedSegment,
} from './segments.js';

/**
 * Copie stable du segment d'initialisation.
 *
 * Chaque exécution ffmpeg réécrit `init.mp4`. Comme la vidéo est copiée, son
 * contenu est identique d'une exécution à l'autre — mais le servir pendant sa
 * réécriture donnerait un fichier tronqué. On en fige donc une copie.
 */
const INIT_SNAPSHOT = 'init-stable.mp4';

/** Attente maximale d'un segment avant d'abandonner la requête. */
const SEGMENT_TIMEOUT_MS = 30_000;

/** Rythme de scrutation du répertoire de travail. */
const POLL_MS = 50;

/**
 * Tolérance de relance, en nombre de segments.
 *
 * Un lecteur demande toujours un peu en avance. Relancer ffmpeg pour trois
 * segments d'écart coûterait plus cher que d'attendre qu'il les produise — le
 * remux va bien plus vite que le temps réel. Au-delà, l'attente serait plus
 * longue qu'une relance : c'est là qu'on relance.
 */
const RESTART_TOLERANCE = 12;

export interface SessionOptions {
  ffmpegBinary: string;
  workDir: string;
  onLog: (message: string, details?: Record<string, unknown>) => void;
}

export interface SessionInput {
  mediaFileId: number;
  /** Chemin EXACT du fichier, tel que readdir l'a rendu. */
  inputPath: string;
  plan: PlannedSegment[];
}

export type SessionState = 'idle' | 'running' | 'finished' | 'failed';

export class TranscodeSession {
  readonly mediaFileId: number;
  readonly dir: string;

  private readonly input: SessionInput;
  private readonly options: SessionOptions;

  private child: ChildProcess | null = null;
  /** Exécutions restantes de la chaîne en cours (amorce puis croisière). */
  private queue: RunPlan[] = [];
  private currentStart = 0;

  private lastAccessAt = Date.now();
  private state: SessionState = 'idle';
  private lastError: string | null = null;
  private closed = false;

  /** Instant du lancement, pour mesurer le délai jusqu'au premier segment. */
  startedAt = 0;

  constructor(input: SessionInput, options: SessionOptions) {
    this.input = input;
    this.options = options;
    this.mediaFileId = input.mediaFileId;
    this.dir = path.join(options.workDir, `mf-${input.mediaFileId}`);
  }

  get idleMs(): number {
    return Date.now() - this.lastAccessAt;
  }

  get status(): { state: SessionState; producedFrom: number; error: string | null } {
    return { state: this.state, producedFrom: this.currentStart, error: this.lastError };
  }

  touch(): void {
    this.lastAccessAt = Date.now();
  }

  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Garantit qu'un segment est disponible, en relançant ffmpeg s'il le faut.
   *
   * C'est ici que se joue le déplacement dans la vidéo. Trois cas :
   *   • le segment est là          → on le sert ;
   *   • il est bientôt produit     → on attend, le remux va vite ;
   *   • il est loin devant/derrière → on relance ffmpeg à sa position.
   */
  async ensureSegment(index: number): Promise<string | null> {
    this.touch();

    const file = path.join(this.dir, segmentFileName(index));
    if (existsSync(file)) return file;

    const reachable = index >= this.currentStart && index <= this.currentStart + this.produced() + RESTART_TOLERANCE;
    if (this.state !== 'running' || !reachable) {
      await this.startAt(index);
    }

    return this.waitFor(file);
  }

  /**
   * Segment d'initialisation, figé dès qu'il est complet.
   *
   * PIÈGE : `init.mp4` APPARAÎT vide dès que le muxer ouvre sa sortie, et n'est
   * rempli qu'ensuite — contrairement aux segments, il n'est pas écrit sous un
   * nom temporaire. Attendre sa seule existence servait donc un fichier de zéro
   * octet, et le lecteur n'avait aucun en-tête à quoi rattacher les segments.
   *
   * On attend donc le premier SEGMENT : quand il est là, l'en-tête qui le
   * précède est forcément écrit en entier.
   */
  async ensureInit(): Promise<string | null> {
    this.touch();

    const snapshot = path.join(this.dir, INIT_SNAPSHOT);
    if (existsSync(snapshot)) return snapshot;

    if (this.state === 'idle') await this.startAt(0);

    const firstSegment = await this.waitFor(path.join(this.dir, segmentFileName(this.currentStart)));
    if (firstSegment === null) return null;

    const source = path.join(this.dir, INIT_FILE_NAME);
    if (!existsSync(source)) return null;

    try {
      await copyFile(source, snapshot);
      return snapshot;
    } catch {
      // La copie a échoué : servir l'original vaut mieux que rien.
      return source;
    }
  }

  /** Nombre de segments produits depuis le début de l'exécution en cours. */
  private produced(): number {
    let count = 0;
    while (existsSync(path.join(this.dir, segmentFileName(this.currentStart + count)))) count += 1;
    return count;
  }

  /** (Re)lance la chaîne d'exécutions à partir d'un index de segment. */
  async startAt(index: number): Promise<void> {
    if (this.closed) return;

    this.stopChild();
    await this.prepare();

    this.queue = planRuns(index, this.input.plan, PRIMER_COUNT, SEGMENT_DURATION, PRIMER_DURATION);

    if (this.queue.length === 0) {
      this.state = 'failed';
      this.lastError = `Segment ${index} hors du fichier.`;
      return;
    }

    this.currentStart = index;
    this.startedAt = Date.now();
    this.state = 'running';
    this.lastError = null;
    this.runNext();
  }

  private runNext(): void {
    const run = this.queue.shift();
    if (run === undefined) {
      this.state = 'finished';
      this.child = null;
      return;
    }

    const args = buildRemuxArgs({
      input: this.input.inputPath,
      startTime: run.startTime,
      startNumber: run.startNumber,
      segmentDuration: run.segmentDuration,
      endTime: run.endTime,
      outputDir: this.dir,
      audioStreamIndex: null,
    });

    const child = spawn(this.options.ffmpegBinary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // On ne garde que la fin : un ffmpeg bavard ne doit pas gonfler la mémoire.
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });

    child.on('error', (error) => {
      if (this.child !== child) return;
      this.state = 'failed';
      this.lastError = error.message;
      this.options.onLog('ffmpeg n’a pas pu démarrer', { error: error.message });
    });

    child.on('exit', (code, signal) => {
      // Un enfant remplacé par une relance n'a plus voix au chapitre.
      if (this.child !== child) return;

      if (signal !== null) {
        // Arrêt volontaire : c'est nous qui l'avons tué.
        this.child = null;
        return;
      }

      if (code === 0) {
        this.runNext();
        return;
      }

      this.state = 'failed';
      this.lastError = stderr.trim().split('\n').at(-1) ?? `ffmpeg a quitté avec le code ${code}`;
      this.child = null;
      this.options.onLog('ffmpeg en échec', { mediaFileId: this.mediaFileId, code, stderr: this.lastError });
    });
  }

  /** Attend l'apparition d'un fichier, ou rend null si ffmpeg abandonne. */
  private async waitFor(file: string): Promise<string | null> {
    const deadline = Date.now() + SEGMENT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (existsSync(file)) return file;
      if (this.state === 'failed') return null;
      /*
       * `finished` sans le fichier signifie que ffmpeg est allé au bout sans le
       * produire : inutile d'attendre les trente secondes complètes.
       */
      if (this.state === 'finished' && this.child === null) {
        return existsSync(file) ? file : null;
      }
      await sleep(POLL_MS);
    }

    return null;
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null) return;

    child.kill('SIGKILL');
  }

  /** Tue ffmpeg et efface le répertoire de travail. */
  async close(): Promise<void> {
    this.closed = true;
    this.queue = [];
    this.stopChild();
    this.state = 'idle';

    try {
      await rm(this.dir, { recursive: true, force: true });
    } catch {
      // Un répertoire non effacé sera repris au démarrage suivant.
    }
  }

  /** Taille des segments produits, pour l'état du cache. */
  async segmentCount(): Promise<number> {
    try {
      return (await readdir(this.dir)).filter((name) => name.endsWith('.m4s')).length;
    } catch {
      return 0;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
