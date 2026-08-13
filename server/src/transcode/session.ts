/**
 * Sessions de transcodage : des processus ffmpeg, leurs segments, leur fin de vie.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE DÉFAUT À NE PAS AVOIR : un ffmpeg orphelin qui tourne indéfiniment.
 *
 * Trois filets, parce qu'un seul ne suffit pas :
 *   1. un balayage périodique tue les sessions inactives ;
 *   2. le lecteur prévient explicitement quand il quitte la page ;
 *   3. l'arrêt du serveur tue tout ce qui reste.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNE SESSION, PLUSIEURS SORTIES.
 *
 * Depuis les pistes audio multiples, une session n'est plus un processus mais
 * un ensemble : une sortie vidéo, et zéro ou plusieurs sorties audio produites
 * À LA DEMANDE — une piste n'est encodée qu'à partir du moment où quelqu'un en
 * réclame un segment. Chacune a son propre répertoire, son propre plan, son
 * propre enchaînement d'exécutions et son propre cycle de vie.
 *
 * Le prix : sur un fichier multipiste, deux processus lisent le MÊME fichier.
 * C'est ce qui achète le changement de langue sans relancer la vidéo, et c'est
 * pourquoi on ne le paie qu'à partir de deux pistes.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { buildAudioArgs, buildRemuxArgs, planRuns, type AudioChoice, type RunPlan } from './args.js';
import type { ToneMapBackend } from './capabilities.js';
import { buildTranscodeArgs, type HardwareBackend, type HdrKind } from './encode.js';
import {
  AUDIO_SEGMENT_DURATION,
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
  /** Accélération retenue au démarrage, après essai réel. */
  hardware: HardwareBackend;
  device: string;
  /** Moteur de tone mapping retenu au démarrage, après essai réel. */
  toneMap: ToneMapBackend | null;
  onLog: (message: string, details?: Record<string, unknown>) => void;
}

/**
 * Ce qu'il faut savoir de la source pour la réencoder.
 *
 * Absent en remux, où la vidéo est copiée sans jamais être regardée.
 */
export interface SourceInfo {
  width: number | null;
  height: number | null;
  frameRate: number | null;
  hdr: HdrKind;
}

/** Une piste audio produite à part, telle que la session doit la connaître. */
export interface AudioRendition {
  /** Index ABSOLU du flux dans le fichier. */
  streamIndex: number;
  channels: number | null;
}

export interface SessionInput {
  mediaFileId: number;
  /** Chemin EXACT du fichier, tel que readdir l'a rendu. */
  inputPath: string;
  /** Découpe de la vidéo. */
  plan: PlannedSegment[];
  /**
   * `remux` copie la vidéo, `transcode` la réencode. La distinction vient de la
   * décision de lecture et ne se devine pas ici : réencoder une vidéo déjà en
   * H.264 coûterait des minutes au lieu de secondes.
   */
  mode: 'remux' | 'transcode';
  source?: SourceInfo;
  /**
   * Piste audio muxée DANS la vidéo.
   *
   * `{ kind: 'none' }` quand les pistes sont rendues à part : la sortie vidéo
   * ne porte alors aucun son, et c'est ce que le manifeste maître annonce.
   */
  muxedAudio: AudioChoice;
  /** Découpe des rendus audio séparés. Vide quand l'audio reste muxé. */
  audioPlan: PlannedSegment[];
  /** Pistes que le manifeste expose comme rendus. Vide quand l'audio est muxé. */
  audioRenditions: AudioRendition[];
}

export type SessionState = 'idle' | 'running' | 'finished' | 'failed';

/**
 * Une sortie ffmpeg : un répertoire, un plan, une chaîne d'exécutions.
 *
 * C'est le cœur commun de la vidéo et de chaque piste audio. Ce qui les
 * distingue — les arguments et la façon de découper les exécutions — est passé
 * en paramètre plutôt que testé à l'intérieur.
 */
class SegmentProducer {
  private child: ChildProcess | null = null;
  /** Exécutions restantes de la chaîne en cours (amorce puis croisière). */
  private queue: RunPlan[] = [];
  private currentStart = 0;
  private state: SessionState = 'idle';
  private lastError: string | null = null;
  private closed = false;

  /** Instant du lancement, pour mesurer le délai jusqu'au premier segment. */
  startedAt = 0;

  constructor(
    readonly dir: string,
    private readonly plan: PlannedSegment[],
    private readonly runsFrom: (startIndex: number) => RunPlan[],
    private readonly argsFor: (run: RunPlan) => string[],
    private readonly options: SessionOptions,
    private readonly label: string,
  ) {}

  get status(): { state: SessionState; producedFrom: number; error: string | null } {
    return { state: this.state, producedFrom: this.currentStart, error: this.lastError };
  }

  get segmentCountPlanned(): number {
    return this.plan.length;
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

    this.queue = this.runsFrom(index);

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

    const child = spawn(this.options.ffmpegBinary, this.argsFor(run), { stdio: ['ignore', 'ignore', 'pipe'] });
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
      this.options.onLog('ffmpeg n’a pas pu démarrer', { sortie: this.label, error: error.message });
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
      this.options.onLog('ffmpeg en échec', { sortie: this.label, code, stderr: this.lastError });
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

  async segmentCount(): Promise<number> {
    try {
      return (await readdir(this.dir)).filter((name) => name.endsWith('.m4s')).length;
    } catch {
      return 0;
    }
  }
}

export class TranscodeSession {
  readonly mediaFileId: number;
  readonly dir: string;

  private readonly input: SessionInput;
  private readonly options: SessionOptions;

  private readonly video: SegmentProducer;
  /** Rendus audio réellement démarrés, indexés par index de flux. */
  private readonly audio = new Map<number, SegmentProducer>();

  private lastAccessAt = Date.now();
  private closed = false;

  constructor(input: SessionInput, options: SessionOptions) {
    this.input = input;
    this.options = options;
    this.mediaFileId = input.mediaFileId;
    this.dir = path.join(options.workDir, `mf-${input.mediaFileId}`);

    this.video = new SegmentProducer(
      path.join(this.dir, 'v'),
      input.plan,
      (startIndex) => planRuns(startIndex, input.plan, PRIMER_COUNT, SEGMENT_DURATION, PRIMER_DURATION),
      (run) => this.videoArgs(run),
      options,
      'vidéo',
    );
  }

  get idleMs(): number {
    return Date.now() - this.lastAccessAt;
  }

  get status(): { state: SessionState; producedFrom: number; error: string | null } {
    return this.video.status;
  }

  /** Délai jusqu'au premier segment vidéo, pour les mesures. */
  get startedAt(): number {
    return this.video.startedAt;
  }

  touch(): void {
    this.lastAccessAt = Date.now();
  }

  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.video.prepare();
  }

  // --- Vidéo ---------------------------------------------------------------

  async ensureSegment(index: number): Promise<string | null> {
    this.touch();
    return this.video.ensureSegment(index);
  }

  async ensureInit(): Promise<string | null> {
    this.touch();
    return this.video.ensureInit();
  }

  async startAt(index: number): Promise<void> {
    return this.video.startAt(index);
  }

  // --- Audio ---------------------------------------------------------------

  /**
   * Rendu d'une piste audio, créé à la PREMIÈRE demande.
   *
   * C'est ce qui évite d'encoder les six pistes du fichier #365 pour n'en
   * écouter qu'une. Une piste qui n'est pas dans le manifeste n'a pas de rendu :
   * rendre null vaut mieux que d'encoder ce qu'on n'a jamais annoncé.
   */
  private producerFor(streamIndex: number): SegmentProducer | null {
    const existing = this.audio.get(streamIndex);
    if (existing !== undefined) return existing;

    const rendition = this.input.audioRenditions.find((track) => track.streamIndex === streamIndex);
    if (rendition === undefined || this.closed) return null;

    const plan = this.input.audioPlan;
    const producer = new SegmentProducer(
      path.join(this.dir, `a-${streamIndex}`),
      plan,
      // Pas d'amorce courte : un segment audio de huit secondes se produit en
      // quelques dizaines de millisecondes, le démarrage est tenu par la vidéo.
      (startIndex) => planRuns(startIndex, plan, 0, AUDIO_SEGMENT_DURATION, AUDIO_SEGMENT_DURATION),
      (run) =>
        buildAudioArgs({
          input: this.input.inputPath,
          startTime: run.startTime,
          startNumber: run.startNumber,
          endTime: run.endTime,
          outputDir: path.join(this.dir, `a-${streamIndex}`),
          streamIndex,
          channels: rendition.channels,
          segmentDuration: run.segmentDuration,
        }),
      this.options,
      `audio ${streamIndex}`,
    );

    this.audio.set(streamIndex, producer);
    return producer;
  }

  async ensureAudioSegment(streamIndex: number, index: number): Promise<string | null> {
    this.touch();
    const producer = this.producerFor(streamIndex);
    if (producer === null) return null;
    await producer.prepare();
    return producer.ensureSegment(index);
  }

  async ensureAudioInit(streamIndex: number): Promise<string | null> {
    this.touch();
    const producer = this.producerFor(streamIndex);
    if (producer === null) return null;
    await producer.prepare();
    return producer.ensureInit();
  }

  /** Erreur du rendu audio, pour la réponse HTTP. */
  audioError(streamIndex: number): string | null {
    return this.audio.get(streamIndex)?.status.error ?? null;
  }

  // --- Arguments -----------------------------------------------------------

  private videoArgs(run: RunPlan): string[] {
    const common = {
      input: this.input.inputPath,
      startTime: run.startTime,
      startNumber: run.startNumber,
      segmentDuration: run.segmentDuration,
      endTime: run.endTime,
      outputDir: this.video.dir,
      audio: this.input.muxedAudio,
    };

    const source = this.input.source;
    return this.input.mode === 'transcode'
      ? buildTranscodeArgs({
          ...common,
          sourceWidth: source?.width ?? null,
          sourceHeight: source?.height ?? null,
          frameRate: source?.frameRate ?? null,
          hdr: source?.hdr ?? null,
          hardware: this.options.hardware,
          device: this.options.device,
          toneMap: this.options.toneMap,
        })
      : buildRemuxArgs(common);
  }

  // --- Fin de vie ----------------------------------------------------------

  /** Tue TOUS les processus de la session et efface son répertoire. */
  async close(): Promise<void> {
    this.closed = true;

    await Promise.all([this.video.close(), ...[...this.audio.values()].map((producer) => producer.close())]);
    this.audio.clear();

    try {
      await rm(this.dir, { recursive: true, force: true });
    } catch {
      // Un répertoire non effacé sera repris au démarrage suivant.
    }
  }

  /** Nombre de processus ffmpeg que cette session fait tourner. */
  get outputCount(): number {
    return 1 + this.audio.size;
  }

  /** Segments produits, toutes sorties confondues, pour l'état du cache. */
  async segmentCount(): Promise<number> {
    const counts = await Promise.all([
      this.video.segmentCount(),
      ...[...this.audio.values()].map((producer) => producer.segmentCount()),
    ]);
    return counts.reduce((total, count) => total + count, 0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
