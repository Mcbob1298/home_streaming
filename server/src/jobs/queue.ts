/**
 * File de travaux persistée en base.
 *
 * C'est le mécanisme commun aux passes d'enrichissement (ffprobe, TMDB, et
 * celles qui viendront). Il tient en une table `job` et répond à trois besoins :
 *
 * 1. **Reprendre après interruption.** Une passe qui s'arrête au milieu laisse
 *    ses travaux en base. Au relancement, seuls les travaux non terminés sont
 *    repris — rien n'est refait.
 * 2. **Ne pas retraiter l'identique.** Chaque travail porte l'empreinte
 *    (`fingerprint`) de sa cible au moment du traitement : pour un fichier, sa
 *    taille et sa date de modification. Si l'empreinte n'a pas bougé, le
 *    travail reste `done` ; si elle change, il repasse en attente tout seul.
 * 3. **Garder la trace des échecs.** Un travail en échec conserve son compteur
 *    d'essais et le dernier message d'erreur, ce qui alimente le rapport de fin
 *    de passe au lieu de disparaître dans le terminal.
 *
 * Les passes se lancent en ligne de commande, jamais depuis une requête HTTP.
 */
import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type JobTargetType = 'media_file' | 'movie' | 'show' | 'episode';

export interface JobRow {
  id: number;
  queue: string;
  target_type: JobTargetType;
  target_id: number;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  fingerprint: string | null;
}

export interface JobTarget {
  targetType: JobTargetType;
  targetId: number;
  /**
   * Empreinte de la cible. Deux passages avec la même empreinte ne refont pas
   * le travail. Laisser `null` pour une cible sans notion de version.
   */
  fingerprint?: string | null;
}

export interface QueueCounts {
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
  total: number;
}

export class JobQueue {
  constructor(
    private readonly db: Db,
    /** Nom de la file : `probe`, `metadata`… */
    readonly name: string,
  ) {}

  /**
   * Déclare les travaux à faire.
   *
   * - cible inconnue          → créée en attente ;
   * - empreinte différente    → remise en attente (la cible a changé) ;
   * - empreinte identique     → laissée telle quelle, même si elle est `done`.
   *
   * Renvoie ce qui a été ajouté et ce qui a été réactivé, pour l'affichage.
   */
  enqueue(targets: readonly JobTarget[]): { added: number; reactivated: number; unchanged: number } {
    const select = this.db.prepare(
      'SELECT id, status, fingerprint FROM job WHERE queue = ? AND target_type = ? AND target_id = ?',
    );
    const insert = this.db.prepare(
      `INSERT INTO job (queue, target_type, target_id, status, attempts, fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    );
    const reactivate = this.db.prepare(
      `UPDATE job SET status = 'pending', attempts = 0, last_error = NULL, fingerprint = ?, updated_at = ?
       WHERE id = ?`,
    );

    const result = { added: 0, reactivated: 0, unchanged: 0 };
    const now = nowIso();

    const run = this.db.transaction(() => {
      for (const target of targets) {
        const fingerprint = target.fingerprint ?? null;
        const existing = select.get(this.name, target.targetType, target.targetId) as
          | { id: number; status: JobStatus; fingerprint: string | null }
          | undefined;

        if (existing === undefined) {
          insert.run(this.name, target.targetType, target.targetId, fingerprint, now, now);
          result.added += 1;
          continue;
        }

        if (existing.fingerprint !== fingerprint) {
          reactivate.run(fingerprint, now, existing.id);
          result.reactivated += 1;
          continue;
        }

        result.unchanged += 1;
      }
    });

    run();
    return result;
  }

  /**
   * Remet en attente des cibles PRÉCISES, quelle que soit leur empreinte.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * `enqueue` NE SAIT PAS QUE LE RÉSULTAT A DISPARU.
   *
   * Il ne réveille que ce qui a changé, et c'est ce qu'on veut au scan : une
   * empreinte identique signifie « déjà fait, ne recommence pas ». Mais un
   * travail `done` dont le produit s'est volatilisé — cache effacé, volume
   * recréé, extraction partielle — a toujours la bonne empreinte. Il resterait
   * `done` indéfiniment pendant que le fichier annonce des pistes qu'aucun
   * disque ne porte.
   *
   * Le rattrapage a donc besoin de passer outre : c'est lui qui a regardé le
   * disque, la file ne le fait jamais.
   * ───────────────────────────────────────────────────────────────────────────
   */
  requeueTargets(targets: readonly JobTarget[]): number {
    const insert = this.db.prepare(
      `INSERT INTO job (queue, target_type, target_id, status, attempts, fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    );
    const update = this.db.prepare(
      `UPDATE job SET status = 'pending', attempts = 0, last_error = NULL, fingerprint = ?, updated_at = ?
       WHERE queue = ? AND target_type = ? AND target_id = ?`,
    );

    let count = 0;
    const now = nowIso();

    const run = this.db.transaction(() => {
      for (const target of targets) {
        const fingerprint = target.fingerprint ?? null;
        const changed = update.run(fingerprint, now, this.name, target.targetType, target.targetId).changes;
        if (changed === 0) insert.run(this.name, target.targetType, target.targetId, fingerprint, now, now);
        count += 1;
      }
    });

    run();
    return count;
  }

  /**
   * Remet en attente les travaux restés `running`.
   *
   * Un travail `running` au démarrage vient forcément d'une passe interrompue
   * (plantage, Ctrl-C) : personne ne le traite plus. À appeler avant de
   * commencer.
   */
  requeueStale(): number {
    const result = this.db
      .prepare(`UPDATE job SET status = 'pending', updated_at = ? WHERE queue = ? AND status = 'running'`)
      .run(nowIso(), this.name);
    return result.changes;
  }

  /**
   * Remet UN travail en attente, sans le compter en échec.
   *
   * Pour une interruption VOLONTAIRE — une passe mise en pause pour rendre le
   * disque. Le travail n'a pas échoué, il n'a pas fini : le compter en échec
   * gonflerait le rapport et demanderait un `--retry-failed` pour rien. Le
   * compteur d'essais est décrémenté d'autant, sinon une pause répétée finirait
   * par ressembler à un fichier qui résiste.
   */
  requeueOne(jobId: number): void {
    this.db
      .prepare(
        `UPDATE job SET status = 'pending', attempts = MAX(0, attempts - 1), updated_at = ?
         WHERE id = ?`,
      )
      .run(nowIso(), jobId);
  }

  /** Remet en attente les travaux en échec, pour un nouvel essai (`--retry-failed`). */
  requeueFailed(): number {
    const result = this.db
      .prepare(
        `UPDATE job SET status = 'pending', last_error = NULL, updated_at = ?
         WHERE queue = ? AND status = 'failed'`,
      )
      .run(nowIso(), this.name);
    return result.changes;
  }

  /** Remet TOUT en attente, y compris ce qui est terminé (`--full`). */
  requeueAll(): number {
    const result = this.db
      .prepare(
        `UPDATE job SET status = 'pending', attempts = 0, last_error = NULL, updated_at = ?
         WHERE queue = ?`,
      )
      .run(nowIso(), this.name);
    return result.changes;
  }

  /**
   * Réserve jusqu'à `limit` travaux et les passe en `running`.
   *
   * La réservation est faite dans une transaction : deux appels concurrents ne
   * peuvent pas prendre le même travail.
   */
  claim(limit: number): JobRow[] {
    const select = this.db.prepare(
      `SELECT id, queue, target_type, target_id, status, attempts, last_error, fingerprint
       FROM job WHERE queue = ? AND status = 'pending' ORDER BY id LIMIT ?`,
    );
    const markRunning = this.db.prepare(
      `UPDATE job SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
    );

    const claim = this.db.transaction(() => {
      const rows = select.all(this.name, limit) as JobRow[];
      const now = nowIso();
      for (const row of rows) markRunning.run(now, row.id);
      return rows;
    });

    return claim();
  }

  private setStatus(jobId: number, status: JobStatus, error: string | null): void {
    this.db
      .prepare('UPDATE job SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(status, error, nowIso(), jobId);
  }

  /** Travail réussi. */
  complete(jobId: number): void {
    this.setStatus(jobId, 'done', null);
  }

  /** Travail impossible, mais ce n'est pas une erreur (rien à faire pour cette cible). */
  skip(jobId: number, reason: string): void {
    this.setStatus(jobId, 'skipped', reason);
  }

  /** Travail en erreur. Le message est conservé pour le rapport. */
  fail(jobId: number, error: string): void {
    this.setStatus(jobId, 'failed', error);
  }

  counts(): QueueCounts {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM job WHERE queue = ? GROUP BY status')
      .all(this.name) as { status: JobStatus; n: number }[];

    const counts: QueueCounts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0, total: 0 };
    for (const row of rows) {
      counts[row.status] = row.n;
      counts.total += row.n;
    }
    return counts;
  }

  /** Travaux en échec, pour le rapport de fin de passe. */
  failures(limit = 1000): { target_id: number; last_error: string | null; attempts: number }[] {
    return this.db
      .prepare(
        `SELECT target_id, last_error, attempts FROM job
         WHERE queue = ? AND status = 'failed' ORDER BY target_id LIMIT ?`,
      )
      .all(this.name, limit) as { target_id: number; last_error: string | null; attempts: number }[];
  }
}
