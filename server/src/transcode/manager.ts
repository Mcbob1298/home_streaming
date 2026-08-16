/**
 * Réservoir de sessions : plafond, file d'attente, expiration.
 *
 * Le NAS a un seul processeur et un seul moteur QuickSync. Laisser dix
 * transcodages démarrer en parallèle les rendrait tous inutilisables. On plafonne
 * donc, et les demandes au-delà attendent leur tour plutôt que d'échouer.
 */
import { mkdir, rm } from 'node:fs/promises';

import { usablePrelude } from './prelude.js';
import { TranscodeSession, type SessionInput, type SessionOptions } from './session.js';

export interface ManagerOptions {
  ffmpegBinary: string;
  workDir: string;
  /**
   * Cache des sous-titres extraits.
   *
   * SÉPARÉ de `workDir`, qui est effacé à chaque démarrage et vit en tmpfs :
   * une extraction coûte une traversée complète du fichier, elle doit survivre
   * au redémarrage du serveur.
   */
  subtitleCacheDir: string;
  /**
   * Racine des préludes. Sur /volume1, JAMAIS dans workDir : celui-ci est
   * effacé à chaque démarrage et vit en tmpfs, alors qu'un prélude coûte un
   * encodage complet de ses vingt-quatre secondes.
   */
  preludeRoot: string;
  maxSessions: number;
  /** Une session sans requête depuis ce délai est tuée. */
  idleSeconds: number;
  /** Accélération retenue au démarrage, après essai réel. */
  hardware: SessionOptions['hardware'];
  device: string;
  toneMap: SessionOptions['toneMap'];
  onLog: SessionOptions['onLog'];
}

export class SessionManager {
  private readonly sessions = new Map<number, TranscodeSession>();
  private readonly waiting: (() => void)[] = [];
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly options: ManagerOptions) {}

  /** Binaire détecté au démarrage. Les routes en dérivent celui de ffprobe. */
  get ffmpegBinary(): string {
    return this.options.ffmpegBinary;
  }

  /** Où vivent les sous-titres extraits. Persiste d'un démarrage à l'autre. */
  get subtitleCacheDir(): string {
    return this.options.subtitleCacheDir;
  }

  /**
   * Accélération retenue au démarrage.
   *
   * Exposée parce que le MANIFESTE en dépend : le transport HDR intact n'existe
   * que sur VAAPI, et les dimensions comme le débit annoncés doivent suivre la
   * même branche que l'encodeur. Voir `outputGeometry`.
   */
  get hardware(): SessionOptions['hardware'] {
    return this.options.hardware;
  }

  /**
   * Efface le répertoire de travail et arme le balayage.
   *
   * Repartir d'un répertoire vide est volontaire : les segments d'une session
   * interrompue par un arrêt du serveur ne valent rien, et leur présence
   * ferait croire à des segments prêts alors qu'aucun ffmpeg ne les suit.
   */
  async start(): Promise<void> {
    await rm(this.options.workDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(this.options.workDir, { recursive: true });
    // Le cache de sous-titres, lui, n'est PAS effacé : il est le fruit d'une
    // traversée complète de chaque fichier.
    await mkdir(this.options.subtitleCacheDir, { recursive: true });
    // Les préludes non plus ne sont jamais effacés : chacun est un encodage.
    await mkdir(this.options.preludeRoot, { recursive: true });

    this.sweeper = setInterval(() => void this.sweep(), 10_000);
    this.sweeper.unref();
  }

  get count(): number {
    return this.sessions.size;
  }

  list(): { mediaFileId: number; idleSeconds: number; state: string }[] {
    return [...this.sessions.values()].map((session) => ({
      mediaFileId: session.mediaFileId,
      idleSeconds: Math.round(session.idleMs / 1000),
      state: session.status.state,
    }));
  }

  /**
   * Session d'un fichier, créée au besoin.
   *
   * Une session par fichier : deux onglets sur la même vidéo partagent le même
   * ffmpeg plutôt que d'en lancer deux qui produiraient les mêmes segments.
   */
  async acquire(input: SessionInput): Promise<TranscodeSession> {
    const existing = this.sessions.get(input.mediaFileId);
    if (existing !== undefined) {
      existing.touch();
      return existing;
    }

    await this.makeRoom();

    /*
     * Le prélude est résolu ICI, et pas dans la session : la vérification
     * d'empreinte a besoin des options matérielles — accélération, tone
     * mapping — que seul le réservoir connaît. Un prélude qui ne correspond
     * plus rend null, et la lecture démarre comme avant.
     */
    const options: SessionOptions = {
      ffmpegBinary: this.options.ffmpegBinary,
      workDir: this.options.workDir,
      hardware: this.options.hardware,
      device: this.options.device,
      toneMap: this.options.toneMap,
      onLog: this.options.onLog,
    };

    const preludeDir = usablePrelude(
      this.options.preludeRoot,
      input,
      options,
      input.sizeBytes,
      input.mtimeMs,
    );
    if (preludeDir !== null) this.options.onLog('prélude trouvé', { mediaFileId: input.mediaFileId });

    const session = new TranscodeSession({ ...input, preludeDir }, options);
    await session.prepare();
    this.sessions.set(input.mediaFileId, session);
    return session;
  }

  /**
   * Libère une place.
   *
   * On tue d'abord la session la plus anciennement sollicitée : c'est celle
   * dont personne ne se sert. Si toutes sont actives, on attend qu'une se
   * libère plutôt que de couper la lecture de quelqu'un.
   */
  private async makeRoom(): Promise<void> {
    while (this.sessions.size >= this.options.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => b.idleMs - a.idleMs)[0];

      // Une session inactive depuis plus de deux secondes n'est regardée par
      // personne : le lecteur réclame un segment bien plus souvent que ça.
      if (oldest !== undefined && oldest.idleMs > 2000) {
        await this.release(oldest.mediaFileId, 'place libérée pour une autre lecture');
        continue;
      }

      await this.waitForSlot();
    }
  }

  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      // Filet de sécurité : une attente ne doit jamais devenir éternelle.
      setTimeout(() => {
        const index = this.waiting.indexOf(resolve);
        if (index !== -1) {
          this.waiting.splice(index, 1);
          resolve();
        }
      }, 15_000).unref();
    });
  }

  async release(mediaFileId: number, reason: string): Promise<void> {
    const session = this.sessions.get(mediaFileId);
    if (session === undefined) return;

    this.sessions.delete(mediaFileId);
    await session.close();
    this.options.onLog('session fermée', { mediaFileId, reason });

    this.waiting.shift()?.();
  }

  /** Tue les sessions que plus personne ne sollicite. */
  private async sweep(): Promise<void> {
    const limit = this.options.idleSeconds * 1000;
    for (const session of [...this.sessions.values()]) {
      if (session.idleMs > limit) {
        await this.release(session.mediaFileId, `inactive depuis ${Math.round(session.idleMs / 1000)} s`);
      }
    }
  }

  /** Arrêt du serveur : rien ne doit survivre. */
  async stop(): Promise<void> {
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;

    await Promise.all([...this.sessions.keys()].map((id) => this.release(id, 'arrêt du serveur')));
    await rm(this.options.workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
