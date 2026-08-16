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
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildAudioArgs, buildRemuxArgs, planRuns, type AudioChoice, type RunPlan } from './args.js';
import { aElaguer, RECUL_SECONDES } from './debit.js';
import { enteteComplet } from './enteteComplet.js';
import { seedFromPrelude } from './prelude.js';
import type { ToneMapBackend } from './capabilities.js';
import { buildTranscodeArgs, type HardwareBackend, type HdrKind } from './encode.js';
import {
  AUDIO_SEGMENT_DURATION,
  INIT_FILE_NAME,
  SEGMENT_DURATION,
  segmentFileName,
  type PlannedSegment,
} from './segments.js';

/**
 * Copie stable du segment d'initialisation.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * L'AFFIRMATION QUI ÉTAIT ÉCRITE ICI ÉTAIT FAUSSE, ET C'ÉTAIT LA RACINE D'UN
 * DÉFAUT DE CORRECTION.
 *
 * On lisait : « comme la vidéo est copiée, son contenu est identique d'une
 * exécution à l'autre ». C'est faux dès qu'une exécution part d'une position non
 * nulle : elle porte alors `-output_ts_offset`, et ffmpeg inscrit ce décalage
 * DANS l'en-tête. Vérifié octet par octet sur deux `init.mp4` du même fichier :
 * deux octets d'écart, 6000 contre 41 — la longueur de l'amorce en
 * millisecondes. Vrai pour le transcodage comme pour le remux.
 *
 * La copie reste nécessaire pour une autre raison, elle bien réelle : ffmpeg
 * écrit `init.mp4` directement, sans fichier temporaire, et le servir pendant sa
 * réécriture donnerait un fichier tronqué.
 *
 * Ce qui change : la copie est refaite à CHAQUE exécution. L'en-tête servi est
 * donc toujours celui du run qui produit les segments servis, jamais celui d'un
 * run précédent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPUIS, LA CAUSE ELLE-MÊME A ÉTÉ RETIRÉE.
 *
 * Refaire la copie ne suffisait pas : le lecteur, lui, ne recharge JAMAIS
 * `EXT-X-MAP`. Réécrire l'en-tête servi ne change rien à celui qu'il détient
 * déjà, et les segments d'une relance restaient interprétés avec le mauvais —
 * décalés d'exactement la distance du saut.
 *
 * `-output_ts_offset` a donc été supprimé (voir `args.ts`). Tous les runs
 * écrivent désormais un en-tête identique au bit près, quelle que soit leur
 * position de départ. La copie garde son autre raison d'être — servir un
 * `init.mp4` en cours de réécriture donnerait un fichier tronqué — mais elle ne
 * porte plus aucune correction.
 * ─────────────────────────────────────────────────────────────────────────────
 * ═════════════════════════════════════════════════════════════════════════════
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
  /** Plafond du transport HDR, en pixels de hauteur. config.transcode.hdrMaxHeight. */
  hdrMaxHeight: number;
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
  /** Taille et date : l'empreinte qui nomme le prélude, et l'invalide. */
  sizeBytes: number;
  mtimeMs: number;
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
   * Transporter le HDR intact, sans tone mapping ni redimensionnement.
   *
   * Optionnel et absent par défaut : c'est ce qui permet à l'empreinte du
   * prélude de rester IDENTIQUE pour tout ce qui garde l'ancien chemin. Voir
   * `preludeSignature`.
   */
  hdrPassthrough?: boolean;
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
  /**
   * Prélude déjà encodé pour CE fichier et CES paramètres, ou null.
   *
   * Résolu par l'appelant, qui a seul de quoi vérifier l'empreinte. La session
   * ne décide pas s'il est valable : elle pose ce qu'on lui donne.
   */
  preludeDir?: string | null;
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

  /** Vrai une fois le prélude posé : on ne le pose qu'une fois par sortie. */
  private seeded = false;

  constructor(
    readonly dir: string,
    private readonly plan: PlannedSegment[],
    private readonly runsFrom: (startIndex: number) => RunPlan[],
    private readonly argsFor: (run: RunPlan) => string[],
    private readonly options: SessionOptions,
    private readonly label: string,
    /** Répertoire du prélude de CETTE sortie, ou null. */
    private readonly preludeDir: string | null = null,
  ) {}

  get status(): { state: SessionState; producedFrom: number; error: string | null } {
    return { state: this.state, producedFrom: this.currentStart, error: this.lastError };
  }

  get segmentCountPlanned(): number {
    return this.plan.length;
  }

  /**
   * Crée le répertoire, et y POSE LE PRÉLUDE s'il y en a un.
   *
   * Avant toute exécution ffmpeg, donc : `ensureSegment` trouvera les premiers
   * segments comme s'ils venaient d'être produits, et `startAt` ne sera appelé
   * qu'au premier segment absent — c'est-à-dire à la jonction, exactement comme
   * pour un déplacement.
   */
  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    if (this.preludeDir !== null && !this.seeded) {
      this.seeded = true;
      const poses = await seedFromPrelude(this.preludeDir, this.dir);
      if (poses > 0) this.options.onLog('prélude posé', { sortie: this.label, fichiers: poses });
    }
  }

  /**
   * Arrête ffmpeg SANS effacer le répertoire.
   *
   * Sert à la fabrication d'un prélude, dont les fichiers sont précisément ce
   * qu'on veut garder. `close()` fait l'inverse, et c'est ce qu'il doit faire
   * pour une session de lecture.
   */
  abandon(): void {
    this.closed = true;
    this.queue = [];
    this.stopChild();
    this.state = 'idle';
  }

  /**
   * Garantit qu'un segment est disponible, en relançant ffmpeg s'il le faut.
   *
   * C'est ici que se joue le déplacement dans la vidéo. Trois cas :
   *   • le segment est là          → on le sert ;
   *   • il est bientôt produit     → on attend, le remux va vite ;
   *   • il est loin devant/derrière → on relance ffmpeg à sa position.
   */
  /**
   * Efface les segments trop en arrière de la position lue.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * SANS CELA, UN REMUX 4K REMPLIT LE TMPFS EN DEUX MINUTES.
   *
   * Le répertoire de travail est un tmpfs d'un gigaoctet, donc de la mémoire
   * vive. Un segment de remux 4K pèse 78 Mo : douze tiennent, pas un de plus.
   * En transcodage la question ne se posait pas — 3 Mo le segment, une session
   * entière y tenait.
   *
   * On garde `RECUL_SECONDES` de film derrière la tête de lecture pour qu'un
   * petit retour en arrière — le bouton « −10 s », un ajustement de la barre —
   * ne relance pas ffmpeg. Au-delà, ce qui est passé ne servira plus.
   * ───────────────────────────────────────────────────────────────────────────
   */
  private elaguer(index: number): void {
    const position = this.plan[index]?.start;
    if (position === undefined) return;

    if (position - RECUL_SECONDES <= 0) return;

    /*
     * ON BALAIE LE RÉPERTOIRE. On ne descend PAS depuis la position lue.
     *
     * La première version parcourait les index à reculons et s'arrêtait au
     * premier fichier absent. Après un déplacement, les segments juste avant la
     * nouvelle position n'ont jamais été produits : la boucle s'arrêtait aussitôt
     * et n'atteignait jamais ceux des positions précédentes.
     *
     * Mesuré en conditions réelles — huit sauts, cinquante-huit segments
     * accumulés, 2742 Mo de tmpfs occupés et pas un seul fichier effacé. Une
     * lecture linéaire ne l'aurait jamais montré : c'est justement le cas où les
     * index se suivent sans trou.
     */
    let noms: string[];
    try {
      noms = readdirSync(this.dir);
    } catch {
      return;
    }

    for (const nom of aElaguer(noms, this.plan, index)) {
      rmSync(path.join(this.dir, nom), { force: true });
    }
  }

  async ensureSegment(index: number): Promise<string | null> {
    // La position demandée est la seule information dont on dispose sur la tête
    // de lecture : le serveur ne la connaît pas autrement.
    this.elaguer(index);

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
  /**
   * L'instantané de l'en-tête, publié seulement quand il est ENTIER.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * DEUX CORRECTIONS, ET LA PREMIÈRE EST LA CAUSE.
   *
   * ON ATTENDAIT LE PREMIER SEGMENT. Signal indirect : il valait tant que ffmpeg
   * produisait l'en-tête avant les segments. Le prélude a rompu ce lien — ses
   * segments sont posés AVANT que ffmpeg ne démarre, donc l'attente retournait
   * immédiatement et la copie partait pendant que ffmpeg écrivait encore
   * `init.mp4`, qu'il écrit directement. Mesuré : `init-stable.mp4` à zéro
   * octet, servi en HTTP 200. On vérifie désormais CE DONT L'INSTANTANÉ DÉPEND,
   * `ftyp` et `moov` entiers d'après la longueur déclarée des boîtes.
   *
   * ON SUPPRIMAIT AVANT DE RÉÉCRIRE. Entre les deux, le fichier était absent ou
   * partiel, et observable dans cet état. La publication se fait maintenant par
   * écriture dans un temporaire du MÊME répertoire — donc du même système de
   * fichiers, sans quoi `rename` ne serait pas atomique — puis `rename`, qui
   * remplace en une opération indivisible.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  async ensureInit(): Promise<string | null> {
    const snapshot = path.join(this.dir, INIT_SNAPSHOT);

    // Un instantané déjà publié est entier par construction : il n'a jamais
    // existé sous une forme partielle.
    if (existsSync(snapshot)) return snapshot;

    if (this.state === 'idle') await this.startAt(0);

    const source = path.join(this.dir, INIT_FILE_NAME);
    const deadline = Date.now() + SEGMENT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.state === 'failed') return null;

      try {
        const donnees = await readFile(source);
        if (enteteComplet(donnees)) return await this.publierEntete(snapshot, donnees);
      } catch {
        // Pas encore écrit : on attend, c'est le cas normal au démarrage.
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    return null;
  }

  /**
   * Écrit l'instantané dans un temporaire, puis le renomme.
   *
   * Le temporaire porte le PID pour que deux sessions du même fichier — une par
   * capacité client — ne se marchent pas dessus si elles publiaient au même
   * instant dans un répertoire partagé. Elles n'en partagent pas aujourd'hui,
   * mais un nom unique ne coûte rien et ferme la question.
   */
  private async publierEntete(snapshot: string, donnees: Buffer): Promise<string> {
    const temporaire = `${snapshot}.${process.pid}.tmp`;
    try {
      await writeFile(temporaire, donnees);
      await rename(temporaire, snapshot);
      return snapshot;
    } catch {
      await rm(temporaire, { force: true }).catch(() => undefined);
      // La publication a échoué, mais les octets sont bons : on sert la source.
      return path.join(this.dir, INIT_FILE_NAME);
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

    /*
     * ═════════════════════════════════════════════════════════════════════════
     * L'INSTANTANÉ N'EST PLUS SUPPRIMÉ ICI, ET C'EST LA MOITIÉ DE LA CORRECTION.
     *
     * On l'effaçait au motif que cette exécution allait écrire le sien. Entre la
     * suppression et la republication, le fichier était absent ou partiel — et
     * observable dans cet état par une requête. C'est ce qui a servi un en-tête
     * de zéro octet en HTTP 200.
     *
     * Le motif ne tient plus : `-output_ts_offset` supprimé, TOUS les runs
     * écrivent un en-tête identique au bit près, vérifié aux positions 0, 600,
     * 2400, 5000 et 9000 s, et à deux durées de segment. Un instantané publié
     * reste donc valable pour toutes les exécutions suivantes de cette session.
     *
     * Il n'est plus jamais réécrit : publié une fois, entier, par `rename`.
     * ═════════════════════════════════════════════════════════════════════════
     */

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
      const dernière = stderr.trim().split('\n').at(-1) ?? `ffmpeg a quitté avec le code ${code}`;

      /*
       * LA SATURATION DU RÉPERTOIRE DE TRAVAIL DOIT SE DIRE, PAS SE DEVINER.
       *
       * Le tmpfs fait un gigaoctet, et un segment de remux 4K en pèse 78 Mo.
       * S'il déborde, ffmpeg s'arrête sur un « No space left on device » noyé
       * dans sa sortie d'erreur — le lecteur, lui, ne voit qu'un segment qui
       * n'arrive pas, et attend trente secondes avant d'abandonner sans motif.
       *
       * On reconnaît donc le cas et on le nomme, pour que la cause soit lisible
       * dans les journaux comme dans la réponse HTTP.
       */
      const satureee = /no space left|ENOSPC/i.test(stderr);
      this.lastError = satureee
        ? 'Le répertoire de travail est plein : la production s’arrête. ' +
          'Augmenter la taille du tmpfs, ou réduire l’avance produite.'
        : dernière;

      this.child = null;
      this.options.onLog(satureee ? 'répertoire de travail saturé' : 'ffmpeg en échec', {
        sortie: this.label,
        code,
        stderr: dernière,
      });
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
    /*
     * Le répertoire porte la variante : deux sessions du même fichier — l'une
     * HEVC intacte, l'autre tone-mappée — écriraient sinon leurs segments l'une
     * sur l'autre, sous les mêmes noms.
     */
    const variante = input.hdrPassthrough === true ? '-hdr' : '';
    this.dir = path.join(options.workDir, `mf-${input.mediaFileId}${variante}`);

    this.video = new SegmentProducer(
      path.join(this.dir, 'v'),
      input.plan,
      (startIndex) => planRuns(startIndex, input.plan, SEGMENT_DURATION),
      (run) => this.videoArgs(run),
      options,
      'vidéo',
      input.preludeDir === undefined || input.preludeDir === null
        ? null
        : path.join(input.preludeDir, 'v'),
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
      (startIndex) => planRuns(startIndex, plan, AUDIO_SEGMENT_DURATION),
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
      this.input.preludeDir === undefined || this.input.preludeDir === null
        ? null
        : path.join(this.input.preludeDir, `a-${streamIndex}`),
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

  /*
   * Chemins des en-têtes, pour y lire la CADENCE de la piste.
   *
   * C'est l'unité des `tfdt`, et elle ne figure que dans l'en-tête — un fragment
   * seul ne la porte pas. La route en a besoin pour rendre les horodatages
   * absolus avant de servir (voir `tfdt.ts`). On expose le chemin plutôt que la
   * disposition des répertoires, qui reste l'affaire de la session.
   */
  videoInitPath(): string {
    return path.join(this.dir, 'v', INIT_FILE_NAME);
  }

  audioInitPath(streamIndex: number): string {
    return path.join(this.dir, `a-${streamIndex}`, INIT_FILE_NAME);
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
          hdrPassthrough: this.input.hdrPassthrough === true,
          hdrMaxHeight: this.options.hdrMaxHeight,
        })
      : buildRemuxArgs(common);
  }

  // --- Fin de vie ----------------------------------------------------------

  /** Tue tous les processus SANS rien effacer. Pour fabriquer un prélude. */
  abandon(): void {
    this.closed = true;
    this.video.abandon();
    for (const producer of this.audio.values()) producer.abandon();
  }

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
