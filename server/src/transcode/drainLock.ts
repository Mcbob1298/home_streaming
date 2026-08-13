/**
 * Le verrou de drainage : un seul processus tire de la file à la fois.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DEUX DRAINAGES SIMULTANÉS SE DÉTRUISENT MUTUELLEMENT.
 *
 * La file persistée empêche deux processus de prendre le MÊME travail — `claim`
 * est transactionnel. Elle ne les empêche pas de travailler en même temps, et
 * c'est là que ça casse :
 *
 *   • `requeueStale()` remet en attente TOUS les travaux `running` au démarrage.
 *     Son commentaire dit « un travail running vient forcément d'une passe
 *     interrompue » — vrai avec un seul processus, faux dès qu'il y en a deux.
 *     Lancer « npm run subtitles » pendant que le serveur tourne remet donc en
 *     attente l'extraction que le serveur est en train de faire ;
 *   • deux ffmpeg lisent le même disque, et chacun divise le débit de l'autre.
 *
 * Le verrou porte le PID de son détenteur. Un processus mort ne bloque donc
 * rien : c'est ce qui permet à la passe de repartir treize secondes après un
 * redémarrage de conteneur, sans attendre l'expiration d'un délai.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import type { Db } from '../db/index.js';

const KEY = 'subtitles_drain_lock';

/**
 * Au-delà, le verrou est considéré comme abandonné même si son PID existe.
 *
 * Le filet de sécurité du cas où un PID est réattribué à un autre programme.
 * Le rafraîchissement tourne toutes les 30 s, indépendamment des extractions :
 * une extraction de seize minutes ne fait donc pas expirer son propre verrou.
 */
export const LOCK_STALE_MS = 120_000;
export const LOCK_REFRESH_MS = 30_000;

interface Holder {
  pid: number;
  /** Distingue deux processus qui auraient le même PID à des moments différents. */
  token: string;
  at: number;
}

/**
 * Ce processus existe-t-il encore ?
 *
 * `process.kill(pid, 0)` n'envoie aucun signal : il teste l'existence. EPERM
 * signifie que le processus EXISTE mais appartient à quelqu'un d'autre — donc
 * vivant. Seul ESRCH veut dire « disparu ».
 */
export function processAlive(pid: number, kill: (p: number, s: number) => void = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function read(db: Db): Holder | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (row === undefined) return null;
  try {
    return JSON.parse(row.value) as Holder;
  } catch {
    // Valeur illisible : on la traite comme absente plutôt que de bloquer.
    return null;
  }
}

function write(db: Db, holder: Holder): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(holder));
}

export interface LockAttempt {
  acquired: boolean;
  /** Renseigné quand le verrou est refusé : de quoi l'expliquer à l'utilisateur. */
  heldBy: { pid: number; sinceSeconds: number } | null;
}

/**
 * Prend le verrou, ou explique pourquoi il est refusé.
 *
 * Il est repris sans attendre quand son détenteur a disparu — cas du
 * redémarrage — et après expiration quand le PID existe toujours mais que plus
 * rien ne le rafraîchit.
 */
export function acquireDrainLock(db: Db, token: string, now: number, pid = process.pid): LockAttempt {
  const holder = read(db);

  if (holder !== null && holder.token !== token) {
    const age = now - holder.at;
    if (processAlive(holder.pid) && age < LOCK_STALE_MS) {
      return { acquired: false, heldBy: { pid: holder.pid, sinceSeconds: Math.round(age / 1000) } };
    }
  }

  write(db, { pid, token, at: now });
  return { acquired: true, heldBy: null };
}

/** Repousse l'expiration. Sans effet si le verrou a été repris entre-temps. */
export function refreshDrainLock(db: Db, token: string, now: number, pid = process.pid): boolean {
  const holder = read(db);
  if (holder !== null && holder.token !== token) return false;

  write(db, { pid, token, at: now });
  return true;
}

/** Rend le verrou. Ne touche à rien si un autre l'a pris. */
export function releaseDrainLock(db: Db, token: string): void {
  const holder = read(db);
  if (holder === null || holder.token !== token) return;
  db.prepare('DELETE FROM meta WHERE key = ?').run(KEY);
}
