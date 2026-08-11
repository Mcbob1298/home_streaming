/**
 * Rapport de la passe TMDB, écrit dans ./data/metadata-report.txt.
 *
 * Sa partie la plus utile est la liste des entrées à vérifier : ce sont
 * exactement celles que la passe a refusé de trancher toute seule.
 */
import type { Db } from '../db/index.js';
import type { ImageDownloadStats } from './images.js';
import type { RunSummary } from '../jobs/runner.js';

/**
 * Ne retient que les appariements d'œuvres encore présentes sur le disque.
 *
 * Un re-parsing peut renommer un film et créer une nouvelle fiche ; l'ancienne
 * garde son appariement mais n'a plus de fichier. La compter fausserait tous
 * les pourcentages du rapport.
 */
const LIVE_MATCH = `
  (m.target_type = 'movie' AND EXISTS (
     SELECT 1 FROM media_file f WHERE f.movie_id = m.target_id AND f.present = 1))
  OR
  (m.target_type = 'show' AND EXISTS (
     SELECT 1 FROM episode e JOIN media_file f ON f.episode_id = e.id AND f.present = 1
     WHERE e.show_id = m.target_id))
`;

function line(character = '─', width = 78): string {
  return character.repeat(width);
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0,0 %';
  return `${((part / whole) * 100).toFixed(1).replace('.', ',')} %`;
}

interface ReviewRow {
  target_type: string;
  target_id: number;
  searched_title: string;
  searched_year: number | null;
  confidence: number | null;
  reason: string | null;
  candidates_json: string | null;
  status: string;
}

export interface MetadataReportInput {
  summary: RunSummary;
  images: ImageDownloadStats;
  api: { requests: number; cacheHits: number; retries: number };
}

export function buildMetadataReport(db: Db, input: MetadataReportInput): string {
  const out: string[] = [];

  const counts = db
    .prepare(
      `SELECT target_type, status, COUNT(*) AS n FROM tmdb_match m
       WHERE ${LIVE_MATCH} GROUP BY target_type, status`,
    )
    .all() as { target_type: string; status: string; n: number }[];

  const total = counts.reduce((sum, row) => sum + row.n, 0);
  const byStatus = (status: string): number =>
    counts.filter((row) => row.status === status).reduce((sum, row) => sum + row.n, 0);

  out.push(line('═'));
  out.push(`RAPPORT MÉTADONNÉES TMDB — ${new Date().toLocaleString('fr-FR')}`);
  out.push(line('═'));
  out.push('');
  out.push(`  œuvres traitées          ${input.summary.processed}`);
  out.push(`  durée de la passe        ${Math.round(input.summary.durationMs / 1000)} s`);
  out.push(`  en échec                 ${input.summary.failed}`);
  out.push('');
  out.push(`  appariées automatiquement ${String(byStatus('applied')).padStart(4)}   ${percent(byStatus('applied'), total)}`);
  out.push(`  à vérifier                ${String(byStatus('needs_review')).padStart(4)}   ${percent(byStatus('needs_review'), total)}`);
  out.push(`  introuvables sur TMDB     ${String(byStatus('not_found')).padStart(4)}   ${percent(byStatus('not_found'), total)}`);
  out.push(`  ignorées                  ${String(byStatus('ignored')).padStart(4)}   ${percent(byStatus('ignored'), total)}`);

  out.push('');
  out.push('  par type :');
  for (const row of counts.sort((a, b) => a.target_type.localeCompare(b.target_type) || a.status.localeCompare(b.status))) {
    out.push(`    ${row.target_type.padEnd(8)} ${row.status.padEnd(14)} ${String(row.n).padStart(4)}`);
  }

  out.push('');
  out.push(line());
  out.push('APPELS API ET IMAGES');
  out.push(line());
  out.push(`  requêtes TMDB            ${input.api.requests}`);
  out.push(`  servies par le cache     ${input.api.cacheHits}`);
  out.push(`  ré-essais (429 / 5xx)    ${input.api.retries}`);
  out.push(`  images téléchargées      ${input.images.downloaded}`);
  out.push(`  images déjà présentes    ${input.images.skipped}`);
  out.push(`  images en échec          ${input.images.failed}`);

  // --- Couverture ---------------------------------------------------------
  const coverage = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM movie WHERE tmdb_id IS NOT NULL) AS films_apparies,
         (SELECT COUNT(*) FROM movie WHERE overview IS NOT NULL) AS films_synopsis,
         (SELECT COUNT(*) FROM movie WHERE poster_path IS NOT NULL) AS films_affiche,
         (SELECT COUNT(*) FROM show WHERE tmdb_id IS NOT NULL) AS series_appariees,
         (SELECT COUNT(*) FROM show WHERE poster_path IS NOT NULL) AS series_affiche,
         (SELECT COUNT(*) FROM episode WHERE tmdb_id IS NOT NULL) AS episodes_apparies,
         (SELECT COUNT(*) FROM episode WHERE overview IS NOT NULL) AS episodes_synopsis,
         (SELECT COUNT(*) FROM episode WHERE still_path IS NOT NULL) AS episodes_vignette`,
    )
    .get() as Record<string, number>;

  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM movie) AS films,
         (SELECT COUNT(*) FROM show) AS series,
         (SELECT COUNT(*) FROM episode) AS episodes`,
    )
    .get() as Record<string, number>;

  out.push('');
  out.push(line());
  out.push('COUVERTURE');
  out.push(line());
  out.push(`  films avec identifiant TMDB   ${String(coverage.films_apparies).padStart(5)} / ${totals.films}`);
  out.push(`  films avec synopsis           ${String(coverage.films_synopsis).padStart(5)} / ${totals.films}`);
  out.push(`  films avec affiche            ${String(coverage.films_affiche).padStart(5)} / ${totals.films}`);
  out.push(`  séries avec identifiant TMDB  ${String(coverage.series_appariees).padStart(5)} / ${totals.series}`);
  out.push(`  séries avec affiche           ${String(coverage.series_affiche).padStart(5)} / ${totals.series}`);
  out.push(`  épisodes avec identifiant     ${String(coverage.episodes_apparies).padStart(5)} / ${totals.episodes}`);
  out.push(`  épisodes avec synopsis        ${String(coverage.episodes_synopsis).padStart(5)} / ${totals.episodes}`);
  out.push(`  épisodes avec vignette        ${String(coverage.episodes_vignette).padStart(5)} / ${totals.episodes}`);

  const genres = db
    .prepare(
      `SELECT g.name, COUNT(*) AS n FROM genre g
       LEFT JOIN movie_genre mg ON mg.genre_id = g.id
       LEFT JOIN show_genre sg ON sg.genre_id = g.id
       WHERE mg.movie_id IS NOT NULL OR sg.show_id IS NOT NULL
       GROUP BY g.id ORDER BY n DESC LIMIT 15`,
    )
    .all() as { name: string; n: number }[];
  if (genres.length > 0) {
    out.push('');
    out.push('  genres les plus représentés :');
    for (const genre of genres) out.push(`    ${genre.name.padEnd(24)} ${String(genre.n).padStart(4)}`);
  }

  // --- À vérifier ---------------------------------------------------------
  const review = db
    .prepare(
      `SELECT m.target_type, m.target_id, m.searched_title, m.searched_year, m.confidence,
              m.reason, m.candidates_json, m.status
       FROM tmdb_match m
       WHERE m.status IN ('needs_review', 'not_found') AND (${LIVE_MATCH})
       ORDER BY m.status, m.target_type, m.searched_title`,
    )
    .all() as ReviewRow[];

  out.push('');
  out.push(line());
  out.push(`À VÉRIFIER À LA MAIN : ${review.length}`);
  out.push(line());
  out.push('  Aucune métadonnée n’a été écrite pour ces entrées : la correspondance');
  out.push('  n’était pas assez sûre. L’écran /review permettra de trancher.');
  out.push('');

  for (const row of review) {
    const type = row.target_type === 'movie' ? 'film ' : 'série';
    const year = row.searched_year === null ? 'sans année' : String(row.searched_year);
    out.push(`  [${type}] ${row.searched_title} (${year})`);

    if (row.status === 'not_found') {
      out.push('      aucun résultat TMDB');
    } else {
      const score = row.confidence === null ? '?' : row.confidence.toFixed(2);
      out.push(`      confiance ${score} — ${row.reason ?? ''}`);

      const candidates = JSON.parse(row.candidates_json ?? '[]') as {
        title: string;
        year: number | null;
        tmdbId: number;
        confidence: number;
      }[];
      for (const candidate of candidates.slice(0, 3)) {
        out.push(
          `        · ${candidate.title} (${candidate.year ?? '?'})` +
            `  tmdb:${candidate.tmdbId}  ${candidate.confidence.toFixed(2)}`,
        );
      }
    }
  }

  if (review.length === 0) out.push('  aucune');

  out.push('');
  out.push(line('═'));
  out.push(
    `${byStatus('applied')} œuvre(s) enrichie(s), ${byStatus('needs_review') + byStatus('not_found')} à trancher.`,
  );
  out.push(line('═'));

  return out.join('\n');
}
