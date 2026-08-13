/**
 * La passe de préparation des sous-titres, et son suivi.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * UNE SEULE FILE, DEUX ENTRÉES, ET ELLE SURVIT À TOUT.
 *
 * `npm run subtitles` y met la bibliothèque entière ; la fin d'un scan y met les
 * nouveaux fichiers. C'est la même file persistée que `probe` et `metadata`,
 * avec les mêmes garanties — reprise après interruption, pas de retraitement à
 * empreinte inchangée, échecs conservés.
 *
 * Ce que cette passe ajoute, et qui vient de sa durée — seize heures sur cette
 * bibliothèque :
 *
 *   • un ORDRE réfléchi : les ajouts récents d'abord, puis les plus petits ;
 *   • une PAUSE qui rend le disque immédiatement, en tuant ffmpeg ;
 *   • une REPRISE AUTOMATIQUE au démarrage, sans attendre qu'on la réveille ;
 *   • un suivi en OCTETS, seule mesure qui veuille dire quelque chose ici.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import type { Db } from '../db/index.js';
import { JobQueue } from '../jobs/queue.js';
import { fingerprintOf, markPending, markReady } from './readiness.js';
import {
  INTERRUPTED,
  extractSubtitles,
  extractableTracksByFile,
  extractableTracksOf,
  missingTracks,
  readyStreams,
  type ExtractableTrack,
  type SubtitleSource,
} from './subtitles.js';

export const SUBTITLE_QUEUE = 'subtitles';

/** Une seule extraction à la fois : chacune sature déjà la lecture du disque. */
const CONCURRENCY = 1;

/** Nombre de fichiers sur lesquels le débit est moyenné, par racine. */
const THROUGHPUT_WINDOW = 5;

export function subtitleQueue(db: Db): JobQueue {
  return new JobQueue(db, SUBTITLE_QUEUE);
}

const MEDIA_COLUMNS = `
  f.id, f.path, f.raw_path AS rawPath, f.size_bytes AS sizeBytes, f.mtime_ms AS mtimeMs,
  f.library_root_id AS rootId, f.file_name AS fileName
`;

export interface QueuedFile extends SubtitleSource {
  rootId: number;
  fileName: string;
}

export function subtitleSourceOf(db: Db, mediaFileId: number): QueuedFile | undefined {
  return db.prepare(`SELECT ${MEDIA_COLUMNS} FROM media_file f WHERE f.id = ? AND f.present = 1`).get(mediaFileId) as
    | QueuedFile
    | undefined;
}

/**
 * Les fichiers à préparer, DANS L'ORDRE OÙ ILS DOIVENT L'ÊTRE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LES RÉCENTS D'ABORD, PUIS LES PLUS PETITS.
 *
 * Les ajouts récents sont ce qu'on voudra regarder le soir même : les préparer
 * en premier, c'est rendre la passe utile avant qu'elle ne soit finie. À date
 * égale, les petits fichiers passent devant — ils font monter le compteur vite,
 * et une progression qui avance est une progression lisible.
 *
 * Conséquence assumée : le fichier de 94 Go passe en dernier. Il coûterait à lui
 * seul seize minutes pendant lesquelles rien d'autre n'avancerait.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Tous les fichiers présents sont inscrits, pas seulement ceux qui portent des
 * sous-titres : un fichier sans piste texte doit être marqué PRÊT, ce qui est
 * instantané mais doit quand même arriver.
 */
export function filesToPrepare(db: Db): { file: QueuedFile; fingerprint: string }[] {
  const rows = db
    .prepare(
      `SELECT ${MEDIA_COLUMNS}, f.first_seen_at AS firstSeenAt
       FROM media_file f
       WHERE f.present = 1
       ORDER BY f.first_seen_at DESC, f.size_bytes ASC`,
    )
    .all() as (QueuedFile & { firstSeenAt: string })[];

  return rows.map((file) => ({ file, fingerprint: fingerprintOf(file.sizeBytes, file.mtimeMs) }));
}

/** Inscrit des fichiers dans la file. Rend ce qui a été ajouté ou réactivé. */
export function enqueueFiles(
  db: Db,
  files: { file: QueuedFile; fingerprint: string }[],
): { added: number; reactivated: number; unchanged: number } {
  return subtitleQueue(db).enqueue(
    files.map(({ file, fingerprint }) => ({
      targetType: 'media_file' as const,
      targetId: file.id,
      fingerprint,
    })),
  );
}

/**
 * Les fichiers dont il MANQUE des WebVTT sur le disque.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LA SEULE FONCTION QUI VÉRIFIE, AU LIEU DE FAIRE CONFIANCE.
 *
 * Tout le reste raisonne sur des empreintes : la file compare celle du travail,
 * la disponibilité compare celle du fichier. C'est rapide et c'est juste tant
 * que le cache suit — mais rien ne le garantit. Un volume recréé, un `data/`
 * effacé, une extraction à moitié écrite, et la base affirme « prêt » pendant
 * qu'aucun `.vtt` n'existe. C'est précisément ce qui s'était produit : 2 306
 * fichiers annonçaient des pistes que la lecture renvoyait en 409.
 *
 * Elle coûte un `readdir` par fichier — quelques centaines de millisecondes sur
 * la bibliothèque entière, le cache étant local. C'est pour cela qu'elle n'est
 * appelée que sur demande explicite, jamais dans une boucle de statut.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function filesMissingAssets(db: Db, cacheRoot: string): { file: QueuedFile; fingerprint: string }[] {
  const tracksByFile = extractableTracksByFile(db);
  if (tracksByFile.size === 0) return [];

  /*
   * Les échecs connus sont écartés, et c'est ce qui empêche une boucle.
   *
   * Un fichier dont une piste ne produira jamais rien manquera toujours quelque
   * chose : le remettre en file à chaque clic ferait relire ses 94 Go
   * indéfiniment, pour échouer de la même façon. Il est déjà nommé dans la liste
   * des échecs — c'est de là qu'on le relance, délibérément.
   */
  const echecs = new Set(
    (
      db
        .prepare(
          `SELECT target_id AS targetId FROM job
           WHERE queue = ? AND target_type = 'media_file' AND status = 'failed'`,
        )
        .all(SUBTITLE_QUEUE) as { targetId: number }[]
    ).map((row) => row.targetId),
  );

  const manquants: { file: QueuedFile; fingerprint: string }[] = [];

  for (const { file, fingerprint } of filesToPrepare(db)) {
    const tracks = tracksByFile.get(file.id);
    // Sans piste texte, il n'y a rien à trouver sur le disque : rien ne manque.
    if (tracks === undefined) continue;
    if (echecs.has(file.id)) continue;
    if (missingTracks(readyStreams(cacheRoot, file), tracks).length === 0) continue;
    manquants.push({ file, fingerprint });
  }

  return manquants;
}

/**
 * Les fichiers qu'on OUVRE réellement : ceux qui portent une piste texte.
 *
 * Un fichier sans piste texte n'est jamais lu par ffmpeg — il est marqué prêt
 * instantanément. Il ne représente aucun travail.
 */
const LUS = `EXISTS (SELECT 1 FROM embedded_subtitle s
                     WHERE s.media_file_id = f.id AND s.is_image_based = 0 AND s.codec IS NOT NULL)`;

/**
 * L'avancement, fichiers ET octets, sur UNE SEULE population.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DEUX COMPTEURS SUR DEUX POPULATIONS ANNONCENT DEUX AVANCEMENTS.
 *
 * Les octets excluaient déjà les fichiers jamais lus — les inclure gonflait le
 * total à 5,78 Tio au lieu de 5,13 et faussait surtout le temps restant, qui
 * divisait par le débit des octets qu'on n'allait pas lire. Mais les FICHIERS,
 * eux, comptaient toujours tout le monde.
 *
 * Résultat mesuré en production : « 1 324 / 2 796 » soit 47,4 % pendant que la
 * barre affichait 14,2 %. Au démarrage c'était pire — les 490 fichiers sans
 * piste texte se terminent instantanément, et la page annonçait « 490 œuvres
 * préparées » avec une barre à zéro.
 *
 * Une seule population, donc, et c'est celle du travail réel. Les 490 autres
 * n'apparaissent nulle part : ils ne demandent rien.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function workTotals(db: Db): { files: number; filesDone: number; bytes: number; bytesDone: number } {
  return db
    .prepare(
      `SELECT COUNT(*) AS files,
              COALESCE(SUM(CASE WHEN j.status IN ('done','skipped') THEN 1 ELSE 0 END), 0) AS filesDone,
              COALESCE(SUM(f.size_bytes), 0) AS bytes,
              COALESCE(SUM(CASE WHEN j.status IN ('done','skipped') THEN f.size_bytes ELSE 0 END), 0) AS bytesDone
       FROM job j JOIN media_file f ON f.id = j.target_id
       WHERE j.queue = ? AND j.target_type = 'media_file' AND ${LUS}`,
    )
    .get(SUBTITLE_QUEUE) as { files: number; filesDone: number; bytes: number; bytesDone: number };
}

/** Nombre d'échecs affichés. Au-delà, la liste cesse d'être lisible. */
const FAILURE_LIMIT = 20;

/**
 * Les échecs, lus dans la FILE et non dans la mémoire du processus.
 *
 * Le nom du fichier vient de la jointure : un identifiant seul n'aide pas à
 * savoir lequel des 2 796 a résisté.
 */
export function recentFailures(db: Db): { mediaFileId: number; fileName: string; error: string }[] {
  return db
    .prepare(
      `SELECT f.id AS mediaFileId, f.file_name AS fileName,
              COALESCE(j.last_error, 'cause inconnue') AS error
       FROM job j JOIN media_file f ON f.id = j.target_id
       WHERE j.queue = ? AND j.target_type = 'media_file' AND j.status = 'failed'
       ORDER BY j.updated_at DESC
       LIMIT ?`,
    )
    .all(SUBTITLE_QUEUE, FAILURE_LIMIT) as { mediaFileId: number; fileName: string; error: string }[];
}

/**
 * Ce qu'une extraction n'a pas produit, dit en une phrase. Null quand tout est là.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNE EXTRACTION SANS ERREUR N'EST PAS UNE EXTRACTION RÉUSSIE.
 *
 * ffmpeg peut sortir avec le code 0 en n'écrivant rien pour une piste : flux
 * vide, ASS que la conversion refuse. Déclarer le fichier prêt là-dessus, c'est
 * reproduire le défaut qu'on vient de corriger — une piste annoncée à la
 * lecture, un `.vtt` qui répond 409.
 *
 * Le message nomme les flux : c'est lui qui s'affiche dans la liste des échecs
 * de la page d'administration, et « 1 piste sur 3 » n'aide personne à trouver
 * laquelle.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function verdictExtraction(ready: Set<number>, tracks: ExtractableTrack[]): string | null {
  const absentes = missingTracks(ready, tracks);
  if (absentes.length === 0) return null;

  const detail = absentes.map((track) => `flux ${track.streamIndex} (${track.codec})`).join(', ');
  return `${absentes.length} piste(s) sur ${tracks.length} n’ont rien produit : ${detail}.`;
}

/**
 * Rattrape ce qui manque : remet en file ET remet en préparation.
 *
 * Les deux vont ensemble. Réinscrire le travail sans effacer l'empreinte du
 * fichier laisserait celui-ci se déclarer prêt et servir des pistes vides
 * jusqu'à ce que la file y arrive ; effacer l'empreinte sans réinscrire le
 * travail le rendrait indisponible sans que rien ne le prépare jamais.
 */
export function requeueMissing(db: Db, cacheRoot: string): { missing: number; bytes: number } {
  const manquants = filesMissingAssets(db, cacheRoot);

  const run = db.transaction(() => {
    for (const { file } of manquants) markPending(db, file.id);
  });
  run();

  subtitleQueue(db).requeueTargets(
    manquants.map(({ file, fingerprint }) => ({
      targetType: 'media_file' as const,
      targetId: file.id,
      fingerprint,
    })),
  );

  return {
    missing: manquants.length,
    bytes: manquants.reduce((sum, { file }) => sum + file.sizeBytes, 0),
  };
}

// ---------------------------------------------------------------------------
// L'état, tel que la page d'administration le lit
// ---------------------------------------------------------------------------

export interface PreparationStatus {
  /** Une extraction est-elle en cours en ce moment ? */
  running: boolean;
  paused: boolean;
  /** Le fichier en cours, avec sa taille. Null au repos. */
  current: { mediaFileId: number; fileName: string; sizeBytes: number } | null;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Débit observé, en octets par seconde. Null tant qu'on n'a rien mesuré. */
  throughput: number | null;
  /** Secondes restantes, estimées sur les OCTETS et le débit par racine. */
  remainingSeconds: number | null;
  failures: { mediaFileId: number; fileName: string; error: string }[];
}

/**
 * Une passe qui prépare, et qu'on peut arrêter.
 *
 * L'instance vit dans le serveur et dans la commande en ligne : les deux
 * drainent la même file, et la file les empêche de se marcher dessus.
 */
export class SubtitlePreparation {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;
  private pausedFlag = false;

  /** Tue le ffmpeg en cours quand la passe est mise en pause. */
  private abort: AbortController | null = null;
  private current: { mediaFileId: number; fileName: string; sizeBytes: number } | null = null;

  /**
   * Débits observés, par racine de bibliothèque.
   *
   * Séparés parce que l'écart est net : /volume1 tourne à 168 Mo/s, le disque
   * USB à 90. Une moyenne globale donnerait une estimation fausse dans les deux
   * sens selon ce qui reste à traiter.
   */
  private readonly samples = new Map<number, number[]>();
  /*
   * Les échecs ne sont PAS tenus en mémoire.
   *
   * Ils l'étaient, et ils disparaissaient à chaque redémarrage : la page
   * d'administration affichait « aucun échec » pendant que la base en portait
   * quatre. Une passe qui dure vingt heures redémarre — c'est même l'un de ses
   * cas normaux — et la seule liste qui survive doit être celle de la file.
   */

  constructor(
    private readonly db: Db,
    private readonly options: {
      ffmpegBinary: string;
      cacheDir: string;
      onLog: (message: string, details?: Record<string, unknown>) => void;
    },
  ) {}

  /**
   * Démarre le travailleur, et REPREND ce qui traînait.
   *
   * `requeueStale` remet en attente les travaux restés `running` : ils viennent
   * forcément d'un arrêt brutal, personne ne les traite plus. Sur une passe de
   * seize heures, un redémarrage du conteneur est probable — la reprise ne doit
   * pas attendre qu'une requête réveille le travailleur.
   */
  start(): void {
    this.stopped = false;
    const reprises = subtitleQueue(this.db).requeueStale();
    if (reprises > 0) {
      this.options.onLog('préparation reprise après interruption', { travaux: reprises });
    }

    this.timer = setInterval(() => void this.drain(), 10_000);
    this.timer.unref();
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.abort?.abort();
  }

  /** Réveil immédiat, après une inscription venue d'un scan. */
  wake(): void {
    void this.drain();
  }

  /**
   * Rend le disque, tout de suite.
   *
   * On ne se contente pas de ne plus prendre de travail : on TUE l'extraction en
   * cours. Attendre qu'elle finisse, ce serait attendre jusqu'à seize minutes
   * sur le plus gros fichier — or la pause existe précisément pour pouvoir
   * regarder un film maintenant.
   */
  pause(): void {
    this.pausedFlag = true;
    this.abort?.abort();
    this.options.onLog('préparation des sous-titres en pause');
  }

  resume(): void {
    this.pausedFlag = false;
    this.options.onLog('préparation des sous-titres reprise');
    void this.drain();
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  /** Débit retenu pour une racine : sa propre moyenne, sinon la moyenne globale. */
  private throughputFor(rootId: number): number | null {
    const own = this.samples.get(rootId);
    if (own !== undefined && own.length > 0) {
      return own.reduce((sum, value) => sum + value, 0) / own.length;
    }

    const all = [...this.samples.values()].flat();
    return all.length === 0 ? null : all.reduce((sum, value) => sum + value, 0) / all.length;
  }

  private record(rootId: number, bytesPerSecond: number): void {
    const list = this.samples.get(rootId) ?? [];
    list.push(bytesPerSecond);
    if (list.length > THROUGHPUT_WINDOW) list.shift();
    this.samples.set(rootId, list);
  }

  /**
   * L'état complet, pour la page d'administration et le suivi web.
   *
   * Le temps restant est calculé sur les OCTETS restants divisés par le débit de
   * LEUR racine — jamais sur un nombre de fichiers. Le coût est proportionnel à
   * la taille : « 500 sur 2306 » ne dit rien s'il reste le fichier de 94 Go.
   */
  status(): PreparationStatus {
    const totals = workTotals(this.db);

    // Octets restants par racine, chacun divisé par le débit de SA racine.
    const parRacine = this.db
      .prepare(
        `SELECT f.library_root_id AS rootId, COALESCE(SUM(f.size_bytes), 0) AS bytes
         FROM job j JOIN media_file f ON f.id = j.target_id
         WHERE j.queue = ? AND j.target_type = 'media_file'
           AND j.status IN ('pending','running') AND ${LUS}
         GROUP BY f.library_root_id`,
      )
      .all(SUBTITLE_QUEUE) as { rootId: number; bytes: number }[];

    let remainingSeconds: number | null = null;
    if (parRacine.length > 0) {
      let secondes = 0;
      let estimable = true;
      for (const { rootId, bytes } of parRacine) {
        const debit = this.throughputFor(rootId);
        if (debit === null || debit <= 0) {
          estimable = false;
          break;
        }
        secondes += bytes / debit;
      }
      if (estimable) remainingSeconds = Math.round(secondes);
    }

    const global = [...this.samples.values()].flat();

    return {
      running: this.busy && !this.pausedFlag,
      paused: this.pausedFlag,
      current: this.current,
      filesDone: totals.filesDone,
      filesTotal: totals.files,
      bytesDone: totals.bytesDone,
      bytesTotal: totals.bytes,
      throughput: global.length === 0 ? null : global.reduce((s, v) => s + v, 0) / global.length,
      remainingSeconds,
      failures: recentFailures(this.db),
    };
  }

  /**
   * Prépare UN fichier : extraction si nécessaire, puis marquage.
   *
   * Un fichier sans piste texte est prêt sans qu'on lance quoi que ce soit —
   * c'est le cas de 490 fichiers sur 2 796, et les bloquer n'aurait aucun sens.
   */
  private async prepare(file: QueuedFile): Promise<number> {
    const tracks = extractableTracksOf(this.db, file.id);
    if (tracks.length === 0) {
      markReady(this.db, file.id);
      return 0;
    }

    this.abort = new AbortController();
    try {
      const count = await extractSubtitles(
        this.db,
        this.options.ffmpegBinary,
        this.options.cacheDir,
        file,
        this.abort.signal,
      );

      /*
       * ─────────────────────────────────────────────────────────────────────
       * ON NE DÉCLARE PRÊT QUE CE QUI EST SUR LE DISQUE.
       *
       * ffmpeg peut sortir sans erreur en n'écrivant rien pour une piste — flux
       * vide, ASS que la conversion refuse. Marquer le fichier prêt malgré tout,
       * c'est reproduire exactement le défaut qu'on vient de corriger : une
       * piste annoncée à la lecture, un `.vtt` qui répond 409.
       *
       * L'échec est bien plus utile : le fichier reste en préparation, il
       * apparaît nommé dans la liste des échecs, et le rattrapage le laisse
       * tranquille au lieu de relire ses 94 Go à chaque passage.
       * ─────────────────────────────────────────────────────────────────────
       */
      const manque = verdictExtraction(readyStreams(this.options.cacheDir, file), tracks);
      if (manque !== null) throw new Error(manque);

      markReady(this.db, file.id);
      return count;
    } finally {
      this.abort = null;
    }
  }

  /**
   * Traite UN travail, et rend `false` quand il n'y a plus rien à faire.
   *
   * Exposé pour que `npm run subtitles` emploie exactement la même mécanique que
   * le serveur — même ordre, même marquage, même comptabilité. Deux boucles de
   * traitement écrites séparément finiraient par diverger.
   */
  async runOnce(): Promise<boolean> {
    if (this.pausedFlag || this.stopped) return false;
    this.busy = true;
    try {
      return await this.processOne();
    } finally {
      this.busy = false;
    }
  }

  private async drain(): Promise<void> {
    if (this.busy || this.stopped || this.pausedFlag) return;
    this.busy = true;

    try {
      while (!this.stopped && !this.pausedFlag) {
        if (!(await this.processOne())) break;
      }
    } finally {
      this.busy = false;
    }
  }

  private async processOne(): Promise<boolean> {
    const queue = subtitleQueue(this.db);

    {
      {
        const [job] = queue.claim(CONCURRENCY);
        if (job === undefined) return false;

        const file = subtitleSourceOf(this.db, job.target_id);
        if (file === undefined) {
          queue.skip(job.id, 'fichier absent de l’index ou disparu du disque');
          return true;
        }

        this.current = { mediaFileId: file.id, fileName: file.fileName, sizeBytes: file.sizeBytes };
        const started = Date.now();

        try {
          const pistes = await this.prepare(file);
          const seconds = (Date.now() - started) / 1000;
          queue.complete(job.id);

          // Un fichier sans piste ne dit rien du débit du disque : il n'a pas
          // été lu. L'inclure gonflerait la moyenne et fausserait l'estimation.
          if (pistes > 0 && seconds > 0.5) this.record(file.rootId, file.sizeBytes / seconds);

          this.options.onLog('sous-titres préparés', {
            mediaFileId: file.id,
            pistes,
            secondes: Math.round(seconds),
          });
        } catch (error) {
          const message = (error as Error).message;

          if (message === INTERRUPTED) {
            /*
             * Interruption volontaire : le travail retourne en attente au lieu
             * d'être compté en échec. C'est ce qui fait qu'une pause ne perd
             * rien et qu'une reprise repart exactement là où on s'était arrêté.
             */
            queue.requeueOne(job.id);
            return false;
          }

          queue.fail(job.id, message);
          this.options.onLog('préparation en échec', { mediaFileId: file.id, error: message });
        } finally {
          this.current = null;
        }

        return true;
      }
    }
  }
}

/**
 * L'instance du processus courant.
 *
 * Un singleton assumé, comme l'identité de l'utilisateur : il n'y a qu'une passe
 * par serveur, et les routes doivent pouvoir l'interroger et la piloter sans
 * qu'on fasse traverser sa référence à toute la pile d'enregistrement.
 */
let instance: SubtitlePreparation | null = null;

export function setPreparation(preparation: SubtitlePreparation | null): void {
  instance = preparation;
}

export function preparation(): SubtitlePreparation | null {
  return instance;
}
