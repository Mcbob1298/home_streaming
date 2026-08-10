/**
 * Parcours récursif d'une racine de bibliothèque.
 *
 * Deux temps, pour bien maîtriser les accès au NAS :
 *
 * 1. on liste les dossiers (readdir), avec un petit pool de workers ;
 * 2. on interroge la taille et la date des fichiers retenus (stat), avec le
 *    même plafond de concurrence.
 *
 * Séparer les deux évite de mélanger un readdir lent et des dizaines de stat,
 * et rend la progression lisible : « je liste » puis « je mesure ».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RÈGLE IMPORTANTE : deux formes pour chaque nom.
 *
 *   • `absolutePath`  — construit avec le nom EXACT renvoyé par readdir.
 *                       C'est le seul chemin qu'on donne à readdir et stat.
 *   • `storedPath` / `relativePath` / `fileName` — en NFC, pour la base, les
 *                       comparaisons et le parser.
 *
 * Pourquoi : NTFS et SMB comparent les noms de fichiers octet à octet (à la
 * casse près), sans appliquer de normalisation Unicode. Un dossier dont le nom
 * est stocké en forme décomposée (« Séries ») devient introuvable si on
 * le normalise en NFC (« Séries ») avant de rouvrir le chemin : les deux
 * s'affichent pareil, mais seul le premier existe pour le système de fichiers.
 * Normaliser puis reconstruire le chemin produit exactement les ENOENT
 * intermittents observés sur le NAS.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_CONCURRENCY, mapLimit, sleep } from '../util/concurrency.js';
import { nfc, pathKey } from '../util/text.js';
import { classifyFile, MIN_VIDEO_SIZE_BYTES, shouldIgnoreDirectory, type SkipReason } from './filters.js';

export interface WalkedFile {
  /** Chemin exact sur le disque, tel que readdir l'a renvoyé. Sert aux accès disque. */
  absolutePath: string;
  /** Même chemin en NFC. C'est celui qu'on enregistre et qu'on compare. */
  storedPath: string;
  /** Chemin relatif à la racine, en NFC — c'est lui qu'on donne au parser. */
  relativePath: string;
  /** Nom du fichier en NFC. */
  fileName: string;
  extension: string;
  /** Dossier contenant le fichier, en clé insensible à la casse. */
  directoryKey: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface WalkError {
  /** Chemin complet, tel qu'on a essayé de l'ouvrir. */
  path: string;
  /** Ce qu'a répondu le système (code ENOENT, EPERM, EBUSY…). */
  message: string;
  /** `readdir` pour un dossier, `stat` pour un fichier. */
  operation: 'readdir' | 'stat';
}

export interface WalkProgress {
  directories: number;
  files: number;
}

export interface WalkOptions {
  concurrency?: number;
  onProgress?: (progress: WalkProgress) => void;
}

export interface WalkResult {
  videos: WalkedFile[];
  subtitles: WalkedFile[];
  directoriesVisited: number;
  /** Toutes entrées confondues, avant filtrage. */
  entriesSeen: number;
  skipped: Map<SkipReason, number>;
  /** Chemins réellement inaccessibles. Le scan continue, ils sont listés dans le rapport. */
  errors: WalkError[];
}

interface Candidate {
  absolutePath: string;
  storedPath: string;
  relativePath: string;
  fileName: string;
  extension: string;
  /** Dossier parent, en clé insensible à la casse — pour rattacher les sous-titres. */
  directoryKey: string;
  kind: 'video' | 'subtitle';
}

interface PendingDirectory {
  /** Chemin brut, pour readdir. */
  absolutePath: string;
  /** Chemin relatif en NFC, pour le parser. */
  relativePath: string;
}

function increment(counter: Map<SkipReason, number>, reason: SkipReason): void {
  counter.set(reason, (counter.get(reason) ?? 0) + 1);
}

export async function walkRoot(rootPath: string, options: WalkOptions = {}): Promise<WalkResult> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const queue: PendingDirectory[] = [{ absolutePath: rootPath, relativePath: '' }];
  const candidates: Candidate[] = [];
  const skipped = new Map<SkipReason, number>();
  const errors: WalkError[] = [];

  let directoriesVisited = 0;
  let entriesSeen = 0;
  let activeWorkers = 0;

  async function readOneDirectory(directory: PendingDirectory): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory.absolutePath, { withFileTypes: true });
    } catch (error) {
      // Un dossier illisible ne fait pas échouer le scan : on le note avec son
      // chemin complet et on continue.
      errors.push({ path: directory.absolutePath, message: (error as Error).message, operation: 'readdir' });
      increment(skipped, 'erreur-de-lecture');
      return;
    }

    directoriesVisited += 1;

    for (const entry of entries) {
      entriesSeen += 1;

      // Les liens symboliques et jonctions ne sont pas suivis : sur un NAS ils
      // pointent souvent vers un dossier déjà parcouru, voire en boucle.
      if (entry.isSymbolicLink()) continue;

      // `entry.name` tel quel pour le disque, sa forme NFC pour tout le reste.
      const absolutePath = path.join(directory.absolutePath, entry.name);
      const name = nfc(entry.name);
      const relativePath = directory.relativePath === '' ? name : `${directory.relativePath}\\${name}`;

      if (entry.isDirectory()) {
        const reason = shouldIgnoreDirectory(name);
        if (reason !== null) {
          increment(skipped, reason);
          continue;
        }
        queue.push({ absolutePath, relativePath });
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = path.extname(name).toLowerCase();
      const { kind, skipReason } = classifyFile(name, extension);
      if (kind === null) {
        if (skipReason !== null) increment(skipped, skipReason);
        continue;
      }

      candidates.push({
        absolutePath,
        storedPath: path.join(nfc(directory.absolutePath), name),
        relativePath,
        fileName: name,
        extension,
        // Construite depuis le dossier parent : deux fichiers du même dossier
        // obtiennent forcément la même clé, quelle que soit leur normalisation.
        directoryKey: pathKey(directory.absolutePath),
        kind,
      });
    }

    options.onProgress?.({ directories: directoriesVisited, files: candidates.length });
  }

  async function worker(): Promise<void> {
    while (true) {
      const next = queue.shift();
      if (next === undefined) {
        // File vide : soit tout est fini, soit un autre worker est en train de
        // lister un dossier qui va la remplir. On attend un instant pour voir.
        if (activeWorkers === 0) return;
        await sleep(5);
        continue;
      }

      activeWorkers += 1;
      try {
        await readOneDirectory(next);
      } finally {
        activeWorkers -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  // --- Deuxième temps : taille et date de modification ---
  const stats = await mapLimit(candidates, concurrency, async (candidate) => {
    try {
      const info = await stat(candidate.absolutePath);
      return { sizeBytes: info.size, mtimeMs: Math.round(info.mtimeMs) };
    } catch (error) {
      errors.push({ path: candidate.absolutePath, message: (error as Error).message, operation: 'stat' });
      return null;
    }
  });

  const videos: WalkedFile[] = [];
  const subtitles: WalkedFile[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const info = stats[index];
    if (info === null || info === undefined) {
      increment(skipped, 'erreur-de-lecture');
      continue;
    }

    if (candidate.kind === 'video' && info.sizeBytes < MIN_VIDEO_SIZE_BYTES) {
      increment(skipped, 'trop-petit');
      continue;
    }

    const file: WalkedFile = {
      absolutePath: candidate.absolutePath,
      storedPath: candidate.storedPath,
      relativePath: candidate.relativePath,
      fileName: candidate.fileName,
      extension: candidate.extension,
      directoryKey: candidate.directoryKey,
      sizeBytes: info.sizeBytes,
      mtimeMs: info.mtimeMs,
    };

    if (candidate.kind === 'video') videos.push(file);
    else subtitles.push(file);
  }

  return { videos, subtitles, directoriesVisited, entriesSeen, skipped, errors };
}
