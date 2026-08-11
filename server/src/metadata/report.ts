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
         (SELECT COUNT(*) FROM movie WHERE logo_path IS NOT NULL) AS films_logo,
         (SELECT COUNT(*) FROM show WHERE logo_path IS NOT NULL) AS series_logo,
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

  /*
   * Le logo de titre remplace le titre en texte sur les vignettes. Sans lui
   * l'interface perd son identité visuelle, donc ce taux compte : chaque œuvre
   * qui en manque affichera un repli textuel.
   */
  // `coverage` est un Record, donc chaque accès est potentiellement absent.
  const count = (key: string): number => coverage[key] ?? 0;

  const filmsAppariés = count('films_apparies');
  const seriesAppariées = count('series_appariees');
  const filmsLogo = count('films_logo');
  const seriesLogo = count('series_logo');

  out.push('');
  out.push(
    `  films avec logo de titre      ${String(filmsLogo).padStart(5)} / ${filmsAppariés}` +
      `   ${percent(filmsLogo, filmsAppariés)} des films appariés`,
  );
  out.push(
    `  séries avec logo de titre     ${String(seriesLogo).padStart(5)} / ${seriesAppariées}` +
      `   ${percent(seriesLogo, seriesAppariées)} des séries appariées`,
  );
  out.push(
    `  -> ${filmsAppariés + seriesAppariées - filmsLogo - seriesLogo}` +
      ` œuvre(s) afficheront leur titre en texte.`,
  );

  /*
   * Couverture des crédits.
   *
   * Le dénominateur est le nombre d'œuvres APPARIÉES, pas le nombre d'œuvres :
   * une œuvre sans identifiant TMDB n'a jamais eu l'occasion d'avoir des
   * crédits, la compter comme un manque ferait passer un problème
   * d'appariement pour un problème de crédits.
   */
  const credits = db
    .prepare(
      `SELECT
         (SELECT COUNT(DISTINCT work_id) FROM credit WHERE work_type = 'movie' AND role = 'director')  AS films_realisation,
         (SELECT COUNT(DISTINCT work_id) FROM credit WHERE work_type = 'movie' AND role = 'cast')      AS films_distribution,
         (SELECT COUNT(DISTINCT work_id) FROM credit WHERE work_type = 'show'  AND role = 'creator')   AS series_creation,
         (SELECT COUNT(DISTINCT work_id) FROM credit WHERE work_type = 'show'  AND role = 'cast')      AS series_distribution,
         (SELECT COUNT(*) FROM person)                                                                 AS personnes,
         (SELECT COUNT(*) FROM credit)                                                                 AS lignes,
         (SELECT COUNT(*) FROM movie WHERE certification IS NOT NULL)                                  AS films_classification,
         (SELECT COUNT(*) FROM show  WHERE certification IS NOT NULL)                                  AS series_classification`,
    )
    .get() as Record<string, number>;

  const creditCount = (key: string): number => credits[key] ?? 0;

  out.push('');
  out.push(line());
  out.push('CRÉDITS');
  out.push(line());
  out.push(
    `  films avec réalisation        ${String(creditCount('films_realisation')).padStart(5)} / ${filmsAppariés}` +
      `   ${percent(creditCount('films_realisation'), filmsAppariés)}`,
  );
  out.push(
    `  films avec distribution       ${String(creditCount('films_distribution')).padStart(5)} / ${filmsAppariés}` +
      `   ${percent(creditCount('films_distribution'), filmsAppariés)}`,
  );
  out.push(
    `  séries avec création          ${String(creditCount('series_creation')).padStart(5)} / ${seriesAppariées}` +
      `   ${percent(creditCount('series_creation'), seriesAppariées)}`,
  );
  out.push(
    `  séries avec distribution      ${String(creditCount('series_distribution')).padStart(5)} / ${seriesAppariées}` +
      `   ${percent(creditCount('series_distribution'), seriesAppariées)}`,
  );
  out.push('');
  out.push(
    `  films avec classification     ${String(creditCount('films_classification')).padStart(5)} / ${filmsAppariés}` +
      `   ${percent(creditCount('films_classification'), filmsAppariés)}`,
  );
  out.push(
    `  séries avec classification    ${String(creditCount('series_classification')).padStart(5)} / ${seriesAppariées}` +
      `   ${percent(creditCount('series_classification'), seriesAppariées)}`,
  );
  out.push('');
  out.push(`  personnes distinctes en base  ${String(creditCount('personnes')).padStart(5)}`);
  out.push(`  lignes de crédit             ${String(creditCount('lignes')).padStart(6)}`);

  /*
   * Une série sans créateur déclaré n'est pas une anomalie : TMDB laisse
   * `created_by` vide pour beaucoup d'animes et de productions anciennes. On le
   * dit, pour que le taux ne soit pas lu comme un défaut de la passe.
   */
  const sansCréation = seriesAppariées - creditCount('series_creation');
  if (sansCréation > 0) {
    out.push('');
    out.push(
      `  ${sansCréation} série(s) sans créateur déclaré chez TMDB — fréquent sur les animes`,
    );
    out.push('  et les productions anciennes. La fiche masque alors la ligne.');
  }

  /*
   * Les deux comptages sont faits en sous-requêtes et additionnés.
   *
   * Une double jointure produirait un produit cartésien : « Comédie » avec 172
   * films et 20 séries donnait 3 440 au lieu de 192, et le rapport annonçait
   * huit fois plus de genres que la bibliothèque n'a d'œuvres.
   */
  const genres = db
    .prepare(
      `SELECT g.name,
              (SELECT COUNT(*) FROM movie_genre mg WHERE mg.genre_id = g.id)
            + (SELECT COUNT(*) FROM show_genre sg WHERE sg.genre_id = g.id) AS n
       FROM genre g
       WHERE n > 0
       ORDER BY n DESC, g.name LIMIT 15`,
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
