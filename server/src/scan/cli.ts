/**
 * Commande `npm run scan`.
 *
 * Le scan n'est JAMAIS déclenché par une requête HTTP : c'est une opération
 * longue, qui écrit en base et martyrise le NAS. Elle se lance à la main (ou
 * plus tard par une tâche planifiée), jamais depuis l'API.
 *
 * Options :
 *   --full              re-parse tous les fichiers, même inchangés
 *   --library=<id>      ne scanne qu'une bibliothèque
 *   --concurrency=<n>   nombre d'accès disque simultanés (défaut : 8)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR, loadConfig, resolveDatabasePath, type LibraryConfig } from '../config.js';
import { enqueueFiles, filesToPrepare } from '../transcode/subtitleQueue.js';
import { openDatabase, syncLibrariesFromConfig, type LibraryRootRow } from '../db/index.js';
import { DEFAULT_CONCURRENCY } from '../util/concurrency.js';
import type { SkipReason } from './filters.js';
import { indexLibrary, type RootWalk } from './indexer.js';
import { buildMoviesList, buildReport, type LibraryScanSummary } from './report.js';
import { walkRoot, type WalkError } from './walk.js';

interface CliOptions {
  full: boolean;
  libraryId: string | null;
  concurrency: number;
}

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = { full: false, libraryId: null, concurrency: DEFAULT_CONCURRENCY };

  for (const argument of argv) {
    if (argument === '--full') options.full = true;
    else if (argument.startsWith('--library=')) options.libraryId = argument.slice('--library='.length);
    else if (argument.startsWith('--concurrency=')) {
      const value = Number(argument.slice('--concurrency='.length));
      if (Number.isFinite(value) && value > 0) options.concurrency = Math.floor(value);
    }
  }

  return options;
}

/** Affichage de progression : une ligne réécrite en place quand on est dans un vrai terminal. */
function createProgressPrinter(): { update: (message: string) => void; done: () => void } {
  const isTty = process.stdout.isTTY === true;
  let lastPrintedAt = 0;

  return {
    update(message: string): void {
      const now = Date.now();
      if (now - lastPrintedAt < 200) return;
      lastPrintedAt = now;
      if (isTty) process.stdout.write(`\r${message.padEnd(78)}`);
      else process.stdout.write(`${message}\n`);
    },
    done(): void {
      if (isTty) process.stdout.write('\r'.padEnd(80) + '\r');
    },
  };
}

/**
 * Vérifie qu'une racine est joignable AVANT de scanner.
 *
 * Sans ce garde-fou, un NAS éteint ou un partage non monté ferait passer toute
 * la bibliothèque en « absent » — ce serait le pire moment pour croire que les
 * fichiers ont disparu.
 */
async function isRootReachable(rootPath: string): Promise<boolean> {
  try {
    const info = await stat(rootPath);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function scanLibrary(
  library: LibraryConfig,
  roots: LibraryRootRow[],
  options: CliOptions,
): Promise<{ walks: RootWalk[]; summary: Omit<LibraryScanSummary, 'stats'> } | null> {
  const startedAt = Date.now();
  console.log(`\n▸ ${library.label} — ${roots.length} racine(s)`);

  for (const root of roots) {
    if (!(await isRootReachable(root.path))) {
      console.error(`  ✗ racine injoignable : ${root.path}`);
      console.error('    Bibliothèque ignorée pour ne pas marquer ses fichiers comme absents à tort.');
      return null;
    }
  }

  const progress = createProgressPrinter();
  const walks: RootWalk[] = [];
  const skipped = new Map<SkipReason, number>();
  const errors: WalkError[] = [];
  let directoriesVisited = 0;
  let entriesSeen = 0;

  for (const [index, root] of roots.entries()) {
    const label = `  [${index + 1}/${roots.length}] ${root.path}`;
    console.log(label);

    const result = await walkRoot(root.path, {
      concurrency: options.concurrency,
      onProgress: ({ directories, files }) => {
        progress.update(`      ${directories} dossiers · ${files} fichiers retenus`);
      },
    });
    progress.done();

    console.log(`      ${result.directoriesVisited} dossiers · ${result.videos.length} vidéos · ${result.subtitles.length} sous-titres`);

    walks.push({ libraryRootId: root.id, videos: result.videos, subtitles: result.subtitles });
    directoriesVisited += result.directoriesVisited;
    entriesSeen += result.entriesSeen;
    errors.push(...result.errors);
    for (const [reason, count] of result.skipped) skipped.set(reason, (skipped.get(reason) ?? 0) + count);
  }

  return {
    walks,
    summary: {
      library,
      directoriesVisited,
      entriesSeen,
      skipped,
      errors,
      durationMs: Date.now() - startedAt,
    },
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const databasePath = resolveDatabasePath(config);

  console.log(`Base   : ${databasePath}`);
  console.log(`Config : ${config.libraries.length} bibliothèque(s)`);
  if (options.full) console.log('Mode   : complet (re-parsing de tous les fichiers)');

  const db = openDatabase(databasePath);
  const rootsByLibrary = syncLibrariesFromConfig(db, config);

  // Un seul horodatage pour tout le scan : c'est lui qui distingue les fichiers
  // revus des fichiers disparus.
  const scanTimestamp = new Date().toISOString();
  const summaries: LibraryScanSummary[] = [];

  for (const library of config.libraries) {
    if (options.libraryId !== null && library.id !== options.libraryId) continue;

    const roots = rootsByLibrary.get(library.id) ?? [];
    if (roots.length === 0) {
      console.error(`\n▸ ${library.label} — aucune racine configurée, ignorée.`);
      continue;
    }

    const scanned = await scanLibrary(library, roots, options);
    if (scanned === null) continue;

    const stats = indexLibrary(db, library, scanned.walks, scanTimestamp, { force: options.full });
    summaries.push({ ...scanned.summary, stats });
  }

  const report = buildReport(db, summaries);
  console.log(`\n${report}`);

  mkdirSync(DATA_DIR, { recursive: true });

  const reportPath = path.join(DATA_DIR, 'scan-report.txt');
  writeFileSync(reportPath, `${report}\n`, 'utf8');
  console.log(`\nRapport écrit dans ${reportPath}`);

  // Inventaire des films à part, un titre par ligne : facile à comparer à un
  // autre inventaire avec un simple diff.
  const moviesListPath = path.join(DATA_DIR, 'movies-list.txt');
  const moviesList = buildMoviesList(db);
  writeFileSync(moviesListPath, moviesList === '' ? '' : `${moviesList}\n`, 'utf8');
  console.log(`Liste des films écrite dans ${moviesListPath}`);

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * LES NOUVEAUX FICHIERS PARTENT EN PRÉPARATION TOUT DE SUITE.
   *
   * C'est ce qui fait qu'un film ajouté ce soir sera regardable dans quelques
   * minutes sans qu'on ait à lancer quoi que ce soit : le scan l'inscrit, le
   * serveur draine la file en tâche de fond.
   *
   * Le scan n'extrait RIEN lui-même — il enregistre le travail et rend la main.
   * Un fichier inchangé garde son empreinte et n'est pas réinscrit.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const inscrits = enqueueFiles(db, filesToPrepare(db));
  if (inscrits.added + inscrits.reactivated > 0) {
    console.log(
      `\nPréparation des sous-titres : ${inscrits.added} nouveau(x), ` +
        `${inscrits.reactivated} modifié(s) depuis la dernière passe.`,
    );
    console.log('  Elle se fait en tâche de fond dès que le serveur tourne, ou par « npm run subtitles ».');
  }

  db.close();
}

main().catch((error: unknown) => {
  console.error(`\n${(error as Error).message}`);
  process.exitCode = 1;
});
