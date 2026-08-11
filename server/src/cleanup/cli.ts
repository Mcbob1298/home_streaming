/**
 * Commande `npm run cleanup` — retire les fiches devenues vides.
 *
 * D'où viennent-elles : un `npm run scan -- --full` re-parse tous les fichiers.
 * Si le parser a été corrigé entre-temps, un film change de titre — « darkino
 * com-1141515-Star Wars 1 » devient « Star Wars 1 » — et comme une œuvre est
 * identifiée par (titre, année), une NOUVELLE fiche est créée. L'ancienne reste
 * en base, sans plus aucun fichier. Invisible dans l'interface, mais elle
 * occupe la table, garde ses images et fausse les comptages bruts.
 *
 * Rien n'est supprimé sans avoir été montré d'abord.
 *
 * Options :
 *   --yes         ne pas demander confirmation
 *   --dry-run     montrer sans rien supprimer
 */
import { createInterface } from 'node:readline/promises';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig, resolveDatabasePath, resolveImagesPath } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';

interface OrphanWork {
  type: 'movie' | 'show';
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
}

/** Œuvres sans aucun fichier présent sur le disque. */
function findOrphans(db: Db): OrphanWork[] {
  const movies = db
    .prepare(
      `SELECT id, title, year, poster_path AS posterPath, backdrop_path AS backdropPath
       FROM movie m
       WHERE NOT EXISTS (SELECT 1 FROM media_file f WHERE f.movie_id = m.id AND f.present = 1)
       ORDER BY title`,
    )
    .all() as Omit<OrphanWork, 'type'>[];

  const shows = db
    .prepare(
      `SELECT id, title, year, poster_path AS posterPath, backdrop_path AS backdropPath
       FROM show s
       WHERE NOT EXISTS (
         SELECT 1 FROM episode e JOIN media_file f ON f.episode_id = e.id AND f.present = 1
         WHERE e.show_id = s.id)
       ORDER BY title`,
    )
    .all() as Omit<OrphanWork, 'type'>[];

  return [
    ...movies.map((row) => ({ ...row, type: 'movie' as const })),
    ...shows.map((row) => ({ ...row, type: 'show' as const })),
  ];
}

/**
 * Tous les chemins d'images encore référencés, une fois les orphelines parties.
 *
 * La base stocke le chemin TMDB (« /abc.jpg ») ; sur le disque, le même nom se
 * retrouve dans plusieurs dossiers de taille. On raisonne donc sur le nom de
 * fichier seul, indépendamment de la taille.
 */
function referencedImageFiles(db: Db, removed: OrphanWork[]): Set<string> {
  const removedMovies = removed.filter((work) => work.type === 'movie').map((work) => work.id);
  const removedShows = removed.filter((work) => work.type === 'show').map((work) => work.id);

  const skipMovies = removedMovies.length === 0 ? '' : `AND id NOT IN (${removedMovies.join(',')})`;
  const skipShows = removedShows.length === 0 ? '' : `AND id NOT IN (${removedShows.join(',')})`;
  const skipShowsForChildren =
    removedShows.length === 0 ? '' : `AND show_id NOT IN (${removedShows.join(',')})`;

  const queries = [
    `SELECT poster_path AS p FROM movie WHERE poster_path IS NOT NULL ${skipMovies}`,
    `SELECT backdrop_path AS p FROM movie WHERE backdrop_path IS NOT NULL ${skipMovies}`,
    `SELECT poster_path AS p FROM show WHERE poster_path IS NOT NULL ${skipShows}`,
    `SELECT backdrop_path AS p FROM show WHERE backdrop_path IS NOT NULL ${skipShows}`,
    `SELECT poster_path AS p FROM season WHERE poster_path IS NOT NULL ${skipShowsForChildren}`,
    `SELECT still_path AS p FROM episode WHERE still_path IS NOT NULL ${skipShowsForChildren}`,
  ];

  const kept = new Set<string>();
  for (const sql of queries) {
    for (const row of db.prepare(sql).all() as { p: string }[]) {
      kept.add(path.basename(row.p));
    }
  }
  return kept;
}

interface UnusedImage {
  fullPath: string;
  bytes: number;
}

/** Fichiers image que plus aucune œuvre ne référence. */
async function findUnusedImages(imagesRoot: string, kept: Set<string>): Promise<UnusedImage[]> {
  const unused: UnusedImage[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (kept.has(entry.name)) continue;
      try {
        const info = await stat(full);
        unused.push({ fullPath: full, bytes: info.size });
      } catch {
        // Fichier disparu entre-temps : rien à supprimer.
      }
    }
  }

  await walk(imagesRoot);
  return unused;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${Math.round(bytes / 1024)} Ko`;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [o/N] `);
    return /^(o|oui|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const assumeYes = argv.includes('--yes');
  const dryRun = argv.includes('--dry-run');

  const config = loadConfig();
  const databasePath = resolveDatabasePath(config);
  const imagesRoot = resolveImagesPath(config);

  console.log(`Base   : ${databasePath}`);
  console.log(`Images : ${imagesRoot}`);

  const db = openDatabase(databasePath);

  const orphans = findOrphans(db);
  const kept = referencedImageFiles(db, orphans);
  const unused = await findUnusedImages(imagesRoot, kept);
  const freed = unused.reduce((total, image) => total + image.bytes, 0);

  // --- On montre TOUT avant de proposer quoi que ce soit ------------------
  console.log(`\nŒuvres sans aucun fichier présent : ${orphans.length}`);
  for (const work of orphans) {
    const label = work.type === 'movie' ? 'film ' : 'série';
    console.log(`  [${label}] ${work.title}${work.year === null ? '' : ` (${work.year})`}`);
  }

  console.log(`\nImages qu'aucune œuvre ne référence : ${unused.length}  (${formatBytes(freed)})`);
  for (const image of unused.slice(0, 15)) {
    console.log(`  ${path.relative(imagesRoot, image.fullPath)}`);
  }
  if (unused.length > 15) console.log(`  … et ${unused.length - 15} autres`);

  if (orphans.length === 0 && unused.length === 0) {
    console.log('\nRien à nettoyer.');
    db.close();
    return;
  }

  if (dryRun) {
    console.log('\n--dry-run : rien n’a été supprimé.');
    db.close();
    return;
  }

  if (!assumeYes) {
    const accepted = await confirm('\nSupprimer tout ce qui précède ?');
    if (!accepted) {
      console.log('Annulé, rien n’a été supprimé.');
      db.close();
      return;
    }
  }

  // --- Suppression ---------------------------------------------------------
  const deleteMovie = db.prepare('DELETE FROM movie WHERE id = ?');
  const deleteShow = db.prepare('DELETE FROM show WHERE id = ?');
  const deleteMatch = db.prepare('DELETE FROM tmdb_match WHERE target_type = ? AND target_id = ?');
  const deleteJob = db.prepare('DELETE FROM job WHERE target_type = ? AND target_id = ?');

  const removeWorks = db.transaction(() => {
    for (const work of orphans) {
      // Saisons, épisodes et liaisons de genre partent en cascade ; les
      // appariements et travaux, eux, ne sont rattachés que par convention.
      if (work.type === 'movie') deleteMovie.run(work.id);
      else deleteShow.run(work.id);
      deleteMatch.run(work.type, work.id);
      deleteJob.run(work.type, work.id);
    }
  });
  removeWorks();

  let removedImages = 0;
  let removedBytes = 0;
  for (const image of unused) {
    try {
      await rm(image.fullPath);
      removedImages += 1;
      removedBytes += image.bytes;
    } catch {
      // Une image verrouillée n'empêche pas le reste.
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`Œuvres supprimées : ${orphans.length}`);
  console.log(`Images supprimées : ${removedImages}`);
  console.log(`Espace libéré     : ${formatBytes(removedBytes)}`);
  console.log('─────────────────────────────────────────────');

  db.close();
}

main().catch((error: unknown) => {
  console.error(`\n${(error as Error).message}`);
  process.exitCode = 1;
});
