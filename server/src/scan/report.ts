/**
 * Rapport de fin de scan : affiché dans le terminal et écrit dans
 * ./data/scan-report.txt.
 *
 * Deux parties méritent l'attention :
 *
 * - la liste COMPLÈTE des fichiers que le parser n'a pas su interpréter, qui
 *   dit quelle convention de nommage ajouter (ou quel fichier renommer) ;
 * - la liste des chemins inaccessibles, qui dit ce que le scan n'a PAS pu voir.
 *   Un fichier illisible ne doit jamais disparaître en silence.
 *
 * La liste des films part dans un fichier séparé (./data/movies-list.txt), au
 * format « un titre par ligne », pour se comparer facilement à un autre
 * inventaire.
 */
import type { Db } from '../db/index.js';
import type { LibraryConfig } from '../config.js';
import type { SkipReason } from './filters.js';
import type { IndexStats } from './indexer.js';
import type { WalkError } from './walk.js';

export interface LibraryScanSummary {
  library: LibraryConfig;
  stats: IndexStats;
  directoriesVisited: number;
  entriesSeen: number;
  skipped: Map<SkipReason, number>;
  errors: WalkError[];
  durationMs: number;
}

interface UnparsedRow {
  path: string;
  parse_reason: string | null;
}

interface DuplicateRow {
  label: string;
  roots: number;
  files: number;
}

interface ShowRow {
  title: string;
  year: number | null;
  seasons: number;
  episodes: number;
}

interface MovieRow {
  title: string;
  year: number | null;
}

function line(character = '─', width = 78): string {
  return character.repeat(width);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** « Titre (2019) », ou « Titre » quand l'année est inconnue. */
function labelWithYear(title: string, year: number | null): string {
  return year === null ? title : `${title} (${year})`;
}

function countMovies(db: Db, libraryId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT m.id) AS total
       FROM movie m
       JOIN media_file f ON f.movie_id = m.id AND f.present = 1
       WHERE m.library_id = ?`,
    )
    .get(libraryId) as { total: number };
  return row.total;
}

/** Toutes les séries de la bibliothèque, avec saisons et épisodes réellement présents. */
function listShows(db: Db, libraryId: string): ShowRow[] {
  return db
    .prepare(
      `SELECT s.title, s.year,
              COUNT(DISTINCT e.season_number) AS seasons,
              COUNT(DISTINCT e.id) AS episodes
       FROM show s
       JOIN episode e ON e.show_id = s.id
       JOIN media_file f ON f.episode_id = e.id AND f.present = 1
       WHERE s.library_id = ?
       GROUP BY s.id
       ORDER BY s.sort_title, IFNULL(s.year, -1)`,
    )
    .all(libraryId) as ShowRow[];
}

/**
 * Séries partageant le même titre normalisé mais pas la même année.
 *
 * Deux cas très différents se cachent derrière :
 * - deux œuvres homonymes réellement distinctes (l'animé et la série live) ;
 * - le même dossier nommé avec l'année sur une racine et sans année sur
 *   l'autre, qui produit alors deux fiches à tort.
 *
 * Le scanner ne tranche pas : il signale, et c'est au propriétaire de la
 * bibliothèque de renommer si besoin.
 */
function findHomonymShows(db: Db, libraryId: string): { title_key: string; variants: string }[] {
  return db
    .prepare(
      `SELECT s.title_key,
              GROUP_CONCAT(s.title || ' — ' || IFNULL('année ' || s.year, 'sans année'), '  |  ') AS variants
       FROM show s
       WHERE s.library_id = ?
         AND EXISTS (SELECT 1 FROM episode e
                     JOIN media_file f ON f.episode_id = e.id AND f.present = 1
                     WHERE e.show_id = s.id)
       GROUP BY s.title_key
       HAVING COUNT(*) > 1
       ORDER BY s.title_key`,
    )
    .all(libraryId) as { title_key: string; variants: string }[];
}

function countShows(db: Db, libraryId: string): { shows: number; seasons: number; episodes: number } {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT s.id)  AS shows,
              COUNT(DISTINCT e.season_id) AS seasons,
              COUNT(DISTINCT e.id) AS episodes
       FROM show s
       JOIN episode e ON e.show_id = s.id
       JOIN media_file f ON f.episode_id = e.id AND f.present = 1
       WHERE s.library_id = ?`,
    )
    .get(libraryId) as { shows: number; seasons: number; episodes: number };
  return row;
}

/** Œuvres dont les fichiers proviennent de plus d'une racine. */
function findDuplicates(db: Db, library: LibraryConfig): DuplicateRow[] {
  if (library.type === 'movie') {
    return db
      .prepare(
        `SELECT m.title || CASE WHEN m.year IS NULL THEN '' ELSE ' (' || m.year || ')' END AS label,
                COUNT(DISTINCT f.library_root_id) AS roots,
                COUNT(f.id) AS files
         FROM movie m
         JOIN media_file f ON f.movie_id = m.id AND f.present = 1
         WHERE m.library_id = ?
         GROUP BY m.id
         HAVING COUNT(DISTINCT f.library_root_id) > 1
         ORDER BY label`,
      )
      .all(library.id) as DuplicateRow[];
  }

  return db
    .prepare(
      `SELECT s.title || ' - S' || printf('%02d', e.season_number) || 'E' || printf('%02d', e.episode_number) AS label,
              COUNT(DISTINCT f.library_root_id) AS roots,
              COUNT(f.id) AS files
       FROM show s
       JOIN episode e ON e.show_id = s.id
       JOIN media_file f ON f.episode_id = e.id AND f.present = 1
       WHERE s.library_id = ?
       GROUP BY e.id
       HAVING COUNT(DISTINCT f.library_root_id) > 1
       ORDER BY label`,
    )
    .all(library.id) as DuplicateRow[];
}

/**
 * Fichiers dont le nom contient le caractère de remplacement Unicode (U+FFFD).
 *
 * Ce caractère est ce que produit un décodage raté : un nom écrit en CP1252 ou
 * Latin-1, relu comme de l'UTF-8. Vérification faite, il est bel et bien stocké
 * tel quel dans le nom sur le NAS — ce n'est pas notre lecture qui le fabrique,
 * `readdir` le restitue fidèlement.
 *
 * On ne devine pas le caractère perdu : « Super H□ros » peut être « Héros »,
 * mais l'affirmer serait inventer. Ces fichiers sont donc listés pour être
 * renommés à la main sur le NAS.
 */
function findMisdecodedNames(db: Db, libraryId: string): { path: string }[] {
  return db
    .prepare(
      `SELECT path FROM media_file
       WHERE library_id = ? AND present = 1 AND path LIKE '%' || char(65533) || '%'
       ORDER BY path`,
    )
    .all(libraryId) as { path: string }[];
}

function findUnparsed(db: Db, libraryId: string): UnparsedRow[] {
  return db
    .prepare(
      `SELECT path, parse_reason
       FROM media_file
       WHERE library_id = ? AND present = 1 AND parse_status = 'unparsed'
       ORDER BY path`,
    )
    .all(libraryId) as UnparsedRow[];
}

/**
 * Contenu de ./data/movies-list.txt : un titre par ligne, avec l'année, trié
 * alphabétiquement. Pas d'en-tête ni de décoration, pour rester comparable
 * ligne à ligne avec un autre inventaire.
 */
export function buildMoviesList(db: Db): string {
  const rows = db
    .prepare(
      `SELECT DISTINCT m.title, m.year
       FROM movie m
       JOIN media_file f ON f.movie_id = m.id AND f.present = 1
       ORDER BY m.sort_title, IFNULL(m.year, -1)`,
    )
    .all() as MovieRow[];

  return rows.map((row) => labelWithYear(row.title, row.year)).join('\n');
}

export function buildReport(db: Db, summaries: LibraryScanSummary[]): string {
  const out: string[] = [];

  out.push(line('═'));
  out.push(`RAPPORT DE SCAN — ${new Date().toLocaleString('fr-FR')}`);
  out.push(line('═'));
  out.push('');

  let totalUnparsed = 0;
  let totalErrors = 0;

  for (const summary of summaries) {
    const { library, stats } = summary;
    out.push(line());
    out.push(`${library.label}  (${library.type === 'movie' ? 'films' : 'séries'})`);
    out.push(line());

    for (const rootPath of library.paths) out.push(`  racine   ${rootPath}`);
    out.push('');
    out.push(`  durée                  ${formatDuration(summary.durationMs)}`);
    out.push(`  dossiers parcourus     ${summary.directoriesVisited}`);
    out.push(`  entrées rencontrées    ${summary.entriesSeen}`);
    out.push(`  fichiers vidéo retenus ${stats.videos}`);
    out.push(`    dont inchangés       ${stats.unchanged}`);
    out.push(`    dont non interprétés ${stats.unparsed}`);
    out.push(`  sous-titres rattachés  ${stats.subtitlesLinked}`);
    if (stats.subtitlesOrphan > 0) {
      out.push(`  sous-titres orphelins  ${stats.subtitlesOrphan}`);
    }

    if (library.type === 'movie') {
      out.push(`  films détectés         ${countMovies(db, library.id)}`);
    } else {
      const { shows, seasons, episodes } = countShows(db, library.id);
      out.push(`  séries détectées       ${shows}`);
      out.push(`  saisons                ${seasons}`);
      out.push(`  épisodes               ${episodes}`);
    }

    if (summary.skipped.size > 0) {
      out.push('');
      out.push('  ignorés :');
      for (const [reason, count] of [...summary.skipped].sort((a, b) => b[1] - a[1])) {
        out.push(`    ${reason.padEnd(20)} ${count}`);
      }
    }

    // --- Liste détaillée des séries ---------------------------------------
    if (library.type === 'show') {
      const rows = listShows(db, library.id);
      out.push('');
      out.push(`  SÉRIES DÉTECTÉES : ${rows.length}`);
      for (const row of rows) {
        const name = labelWithYear(row.title, row.year).padEnd(52);
        out.push(
          `    ${name} ${String(row.seasons).padStart(3)} saison(s)  ${String(row.episodes).padStart(4)} épisode(s)`,
        );
      }

      const homonyms = findHomonymShows(db, library.id);
      if (homonyms.length > 0) {
        out.push('');
        out.push(`  SÉRIES HOMONYMES À VÉRIFIER : ${homonyms.length}`);
        out.push('    Même titre, années différentes. Soit deux œuvres distinctes (rien à faire),');
        out.push('    soit le même dossier nommé différemment sur les deux racines (à renommer).');
        for (const row of homonyms) {
          out.push(`    • ${row.variants}`);
        }
      }
    }

    const duplicates = findDuplicates(db, library);
    out.push('');
    out.push(`  doublons entre racines : ${duplicates.length}`);
    for (const duplicate of duplicates) {
      out.push(`    ${duplicate.label}  —  ${duplicate.files} fichiers sur ${duplicate.roots} racines`);
    }

    const unparsed = findUnparsed(db, library.id);
    totalUnparsed += unparsed.length;
    out.push('');
    out.push(`  FICHIERS NON INTERPRÉTÉS : ${unparsed.length}`);
    for (const row of unparsed) {
      out.push(`    [${row.parse_reason ?? 'inconnu'}] ${row.path}`);
    }

    // --- Noms mal décodés : à renommer sur le NAS -------------------------
    const misdecoded = findMisdecodedNames(db, library.id);
    if (misdecoded.length > 0) {
      out.push('');
      out.push(`  NOMS MAL DÉCODÉS : ${misdecoded.length}`);
      out.push('    Le caractère de remplacement Unicode (U+FFFD) est réellement présent');
      out.push('    dans le nom sur le NAS — ce n’est pas un problème de lecture. Le');
      out.push('    caractère d’origine est perdu et ne peut pas être deviné : renommez');
      out.push('    ces fichiers à la main.');
      for (const row of misdecoded) out.push(`    ${row.path}`);
    }

    // --- Chemins inaccessibles : liste complète, jamais tronquée -----------
    totalErrors += summary.errors.length;
    out.push('');
    out.push(`  CHEMINS INACCESSIBLES : ${summary.errors.length}`);
    for (const error of summary.errors) {
      out.push(`    [${error.operation}] ${error.path}`);
      out.push(`        ${error.message}`);
    }

    out.push('');
  }

  out.push(line('═'));
  out.push(
    totalUnparsed === 0
      ? 'Tous les fichiers ont été interprétés.'
      : `${totalUnparsed} fichier(s) non interprété(s) — voir la liste ci-dessus.`,
  );
  if (totalErrors > 0) {
    out.push(`${totalErrors} chemin(s) inaccessible(s) — leur contenu n'a PAS été indexé.`);
  }
  out.push(line('═'));

  return out.join('\n');
}
