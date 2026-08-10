/**
 * Rapport de la passe ffprobe, écrit dans ./data/probe-report.txt.
 *
 * Son but n'est pas de faire joli : c'est lui qui doit dimensionner les phases
 * suivantes. Combien de fichiers passent tels quels dans un navigateur ?
 * Combien de sous-titres sont des images et ne deviendront jamais du WebVTT ?
 * Combien d'heures faudra-t-il transcoder ?
 */
import type { Db } from '../db/index.js';
import type { QueueCounts } from '../jobs/queue.js';
import type { RunSummary } from '../jobs/runner.js';

/**
 * Un fichier est lisible tel quel par un navigateur s'il réunit les trois
 * conditions : conteneur MP4/M4V, vidéo H.264, audio AAC. Tout le reste devra
 * être transcodé (ou remuxé, ce qui est bien moins coûteux — mais cette
 * distinction viendra plus tard).
 */
const DIRECT_PLAY_SQL = `
  extension IN ('.mp4', '.m4v')
  AND video_codec = 'h264'
  AND audio_codec = 'aac'
`;

function line(character = '─', width = 78): string {
  return character.repeat(width);
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0,0 %';
  return `${((part / whole) * 100).toFixed(1).replace('.', ',')} %`;
}

function hours(seconds: number): string {
  return `${Math.round(seconds / 3600).toLocaleString('fr-FR')} h`;
}

/** Tableau « valeur : nombre », trié du plus fréquent au moins fréquent. */
function distribution(
  db: Db,
  column: string,
  options: { where?: string; label?: string } = {},
): { value: string; n: number }[] {
  const where = options.where === undefined ? '' : `AND ${options.where}`;
  return db
    .prepare(
      `SELECT COALESCE(${column}, '(inconnu)') AS value, COUNT(*) AS n
       FROM media_file
       WHERE present = 1 ${where}
       GROUP BY value ORDER BY n DESC, value`,
    )
    .all() as { value: string; n: number }[];
}

function renderDistribution(out: string[], title: string, rows: { value: string; n: number }[], total: number): void {
  out.push('');
  out.push(`  ${title}`);
  for (const row of rows) {
    out.push(`    ${row.value.padEnd(28)} ${String(row.n).padStart(5)}   ${percent(row.n, total)}`);
  }
}

/** Regroupe les définitions en paliers lisibles, à partir de la hauteur. */
function resolutionBuckets(db: Db): { value: string; n: number }[] {
  return db
    .prepare(
      `SELECT CASE
                WHEN resolution IS NULL THEN '(inconnue)'
                WHEN height <= 576  THEN 'SD (<= 576p)'
                WHEN height <= 720  THEN 'HD (720p)'
                WHEN height <= 1080 THEN 'Full HD (1080p)'
                WHEN height <= 1440 THEN 'QHD (1440p)'
                ELSE '4K et au-delà'
              END AS value,
              COUNT(*) AS n
       FROM (
         SELECT resolution,
                CAST(substr(resolution, instr(resolution, 'x') + 1) AS INTEGER) AS height
         FROM media_file WHERE present = 1
       )
       GROUP BY value ORDER BY n DESC`,
    )
    .all() as { value: string; n: number }[];
}

export interface ProbeReportInput {
  counts: QueueCounts;
  summary: RunSummary;
  failures: { target_id: number; last_error: string | null; attempts: number }[];
  ffprobeVersion: string;
}

export function buildProbeReport(db: Db, input: ProbeReportInput): string {
  const out: string[] = [];

  const { total } = db.prepare('SELECT COUNT(*) AS total FROM media_file WHERE present = 1').get() as {
    total: number;
  };
  const { probed } = db
    .prepare('SELECT COUNT(*) AS probed FROM media_file WHERE present = 1 AND container IS NOT NULL')
    .get() as { probed: number };

  out.push(line('═'));
  out.push(`RAPPORT FFPROBE — ${new Date().toLocaleString('fr-FR')}`);
  out.push(line('═'));
  out.push(`  ${input.ffprobeVersion}`);
  out.push('');
  out.push(`  fichiers présents        ${total}`);
  out.push(`  fichiers sondés          ${probed}   ${percent(probed, total)}`);
  out.push(`  traités dans cette passe ${input.summary.processed}`);
  out.push(`    réussis                ${input.summary.done}`);
  out.push(`    ignorés                ${input.summary.skipped}`);
  out.push(`    en échec               ${input.summary.failed}`);
  out.push(`  durée de la passe        ${Math.round(input.summary.durationMs / 1000)} s`);

  // --- Répartitions -------------------------------------------------------
  out.push('');
  out.push(line());
  out.push('RÉPARTITIONS');
  out.push(line());

  renderDistribution(out, 'Conteneur (extension)', distribution(db, 'extension'), total);
  renderDistribution(out, 'Conteneur (vu par ffprobe)', distribution(db, 'container'), total);
  renderDistribution(out, 'Codec vidéo', distribution(db, 'video_codec'), total);
  renderDistribution(out, 'Codec audio (piste par défaut)', distribution(db, 'audio_codec'), total);
  renderDistribution(out, 'Définition', resolutionBuckets(db), total);

  const exactResolutions = distribution(db, 'resolution').slice(0, 12);
  renderDistribution(out, 'Définitions exactes (12 plus fréquentes)', exactResolutions, total);

  // --- HDR ----------------------------------------------------------------
  const hdrRows = db
    .prepare(
      `SELECT hdr AS value, COUNT(*) AS n FROM media_file
       WHERE present = 1 AND hdr IS NOT NULL GROUP BY hdr ORDER BY n DESC`,
    )
    .all() as { value: string; n: number }[];
  const hdrTotal = hdrRows.reduce((sum, row) => sum + row.n, 0);

  out.push('');
  out.push(line());
  out.push('HDR');
  out.push(line());
  out.push(`  fichiers HDR             ${hdrTotal}   ${percent(hdrTotal, total)}`);
  for (const row of hdrRows) {
    out.push(`    ${row.value.padEnd(28)} ${String(row.n).padStart(5)}`);
  }
  if (hdrTotal === 0) out.push('    (aucun fichier HDR détecté)');

  // --- Durées -------------------------------------------------------------
  const durations = db
    .prepare(
      `SELECT l.type AS type, SUM(f.duration_seconds) AS seconds, COUNT(*) AS n
       FROM media_file f JOIN library l ON l.id = f.library_id
       WHERE f.present = 1 AND f.duration_seconds IS NOT NULL
       GROUP BY l.type`,
    )
    .all() as { type: string; seconds: number; n: number }[];

  out.push('');
  out.push(line());
  out.push('DURÉE TOTALE');
  out.push(line());
  let totalSeconds = 0;
  for (const row of durations) {
    totalSeconds += row.seconds;
    const label = row.type === 'movie' ? 'films' : 'séries';
    out.push(`  ${label.padEnd(24)} ${hours(row.seconds).padStart(10)}   (${row.n} fichiers)`);
  }
  out.push(`  ${'ensemble'.padEnd(24)} ${hours(totalSeconds).padStart(10)}`);

  // --- Direct play --------------------------------------------------------
  const { direct } = db
    .prepare(`SELECT COUNT(*) AS direct FROM media_file WHERE present = 1 AND ${DIRECT_PLAY_SQL}`)
    .get() as { direct: number };
  const transcode = probed - direct;

  out.push('');
  out.push(line());
  out.push('LECTURE DIRECTE EN NAVIGATEUR');
  out.push(line());
  out.push('  Règle : conteneur MP4/M4V + vidéo H.264 + audio AAC.');
  out.push('');
  out.push(`  lisibles tels quels      ${String(direct).padStart(5)}   ${percent(direct, probed)}`);
  out.push(`  à transcoder             ${String(transcode).padStart(5)}   ${percent(transcode, probed)}`);

  // Détail de ce qui bloque : utile pour savoir si un simple remux suffirait.
  const blockers = db
    .prepare(
      `SELECT
         SUM(CASE WHEN extension NOT IN ('.mp4', '.m4v') THEN 1 ELSE 0 END) AS conteneur,
         SUM(CASE WHEN video_codec IS NOT NULL AND video_codec <> 'h264' THEN 1 ELSE 0 END) AS video,
         SUM(CASE WHEN audio_codec IS NOT NULL AND audio_codec <> 'aac' THEN 1 ELSE 0 END) AS audio
       FROM media_file WHERE present = 1 AND container IS NOT NULL`,
    )
    .get() as { conteneur: number; video: number; audio: number };

  out.push('');
  out.push('  ce qui bloque (un fichier peut cumuler plusieurs causes) :');
  out.push(`    conteneur autre que MP4/M4V   ${String(blockers.conteneur).padStart(5)}   ${percent(blockers.conteneur, probed)}`);
  out.push(`    vidéo autre que H.264         ${String(blockers.video).padStart(5)}   ${percent(blockers.video, probed)}`);
  out.push(`    audio autre que AAC           ${String(blockers.audio).padStart(5)}   ${percent(blockers.audio, probed)}`);

  // Un fichier dont seuls le conteneur et/ou l'audio posent problème peut être
  // remuxé sans réencoder l'image : c'est mille fois moins coûteux.
  const { remuxable } = db
    .prepare(
      `SELECT COUNT(*) AS remuxable FROM media_file
       WHERE present = 1 AND container IS NOT NULL AND video_codec = 'h264' AND NOT (${DIRECT_PLAY_SQL})`,
    )
    .get() as { remuxable: number };
  out.push('');
  out.push(`  dont vidéo déjà en H.264 (remux possible, sans réencoder l’image) :`);
  out.push(`    ${String(remuxable).padStart(5)}   ${percent(remuxable, probed)}`);

  // --- Sous-titres --------------------------------------------------------
  const subtitles = db
    .prepare(
      `SELECT
         SUM(CASE WHEN texte > 0 AND image = 0 THEN 1 ELSE 0 END) AS texte_seul,
         SUM(CASE WHEN image > 0 AND texte = 0 THEN 1 ELSE 0 END) AS image_seul,
         SUM(CASE WHEN texte > 0 AND image > 0 THEN 1 ELSE 0 END) AS mixte,
         SUM(CASE WHEN texte = 0 AND image = 0 THEN 1 ELSE 0 END) AS aucun
       FROM (
         SELECT f.id,
                COALESCE(SUM(CASE WHEN s.is_image_based = 0 THEN 1 ELSE 0 END), 0) AS texte,
                COALESCE(SUM(CASE WHEN s.is_image_based = 1 THEN 1 ELSE 0 END), 0) AS image
         FROM media_file f
         LEFT JOIN embedded_subtitle s ON s.media_file_id = f.id
         WHERE f.present = 1 AND f.container IS NOT NULL
         GROUP BY f.id
       )`,
    )
    .get() as { texte_seul: number; image_seul: number; mixte: number; aucun: number };

  out.push('');
  out.push(line());
  out.push('SOUS-TITRES EMBARQUÉS');
  out.push(line());
  out.push('  Les sous-titres image (PGS, VOBSUB) sont des bitmaps : ils ne peuvent pas');
  out.push('  être convertis en WebVTT et imposeront une incrustation au transcodage.');
  out.push('');
  out.push(`  texte uniquement         ${String(subtitles.texte_seul).padStart(5)}   ${percent(subtitles.texte_seul, probed)}`);
  out.push(`  image uniquement         ${String(subtitles.image_seul).padStart(5)}   ${percent(subtitles.image_seul, probed)}`);
  out.push(`  les deux                 ${String(subtitles.mixte).padStart(5)}   ${percent(subtitles.mixte, probed)}`);
  out.push(`  aucun                    ${String(subtitles.aucun).padStart(5)}   ${percent(subtitles.aucun, probed)}`);

  const subtitleCodecs = db
    .prepare(
      `SELECT codec AS value, COUNT(*) AS n, MAX(is_image_based) AS image
       FROM embedded_subtitle GROUP BY codec ORDER BY n DESC`,
    )
    .all() as { value: string | null; n: number; image: number }[];
  if (subtitleCodecs.length > 0) {
    out.push('');
    out.push('  par codec (pistes, pas fichiers) :');
    for (const row of subtitleCodecs) {
      // Un codec non identifié n'est PAS présumé texte : ffprobe n'a rien pu en
      // dire, on l'affiche comme tel plutôt que de trancher à sa place.
      const nature = row.value === null ? 'indéterminé' : row.image === 1 ? 'IMAGE' : 'texte';
      out.push(`    ${(row.value ?? '(codec non identifié)').padEnd(24)} ${String(row.n).padStart(5)}   ${nature}`);
    }
  }

  const unidentified = db
    .prepare(
      `SELECT COUNT(*) AS tracks, COUNT(DISTINCT media_file_id) AS files
       FROM embedded_subtitle WHERE codec IS NULL`,
    )
    .get() as { tracks: number; files: number };

  if (unidentified.tracks > 0) {
    // Ces pistes comptent comme « texte » dans les paliers ci-dessus faute de
    // mieux. La nuance est signalée ici pour ne pas fausser le dimensionnement.
    out.push('');
    out.push(
      `  ${unidentified.tracks} piste(s) de codec non identifié par ffprobe, ` +
        `réparties sur ${unidentified.files} fichier(s).`,
    );
    const { safe } = db
      .prepare(
        `SELECT COUNT(*) AS safe FROM (
           SELECT media_file_id FROM embedded_subtitle
           GROUP BY media_file_id
           HAVING SUM(codec IS NULL) = COUNT(*))`,
      )
      .get() as { safe: number };
    out.push(
      safe === 0
        ? '  Aucun fichier ne dépend uniquement de ces pistes : le classement ci-dessus tient.'
        : `  ${safe} fichier(s) n'ont QUE des pistes non identifiées : leur classement est incertain.`,
    );
  }

  // --- Pistes audio -------------------------------------------------------
  const audio = db
    .prepare(
      `SELECT
         SUM(CASE WHEN n > 1 THEN 1 ELSE 0 END) AS multi,
         SUM(CASE WHEN n = 1 THEN 1 ELSE 0 END) AS mono,
         SUM(CASE WHEN n = 0 THEN 1 ELSE 0 END) AS aucune,
         MAX(n) AS maximum
       FROM (
         SELECT f.id, COUNT(a.id) AS n
         FROM media_file f
         LEFT JOIN audio_track a ON a.media_file_id = f.id
         WHERE f.present = 1 AND f.container IS NOT NULL
         GROUP BY f.id
       )`,
    )
    .get() as { multi: number; mono: number; aucune: number; maximum: number };

  out.push('');
  out.push(line());
  out.push('PISTES AUDIO');
  out.push(line());
  out.push(`  plusieurs pistes         ${String(audio.multi).padStart(5)}   ${percent(audio.multi, probed)}`);
  out.push(`  une seule piste          ${String(audio.mono).padStart(5)}   ${percent(audio.mono, probed)}`);
  out.push(`  aucune piste audio       ${String(audio.aucune).padStart(5)}   ${percent(audio.aucune, probed)}`);
  out.push(`  maximum sur un fichier   ${String(audio.maximum ?? 0).padStart(5)}`);

  const languages = db
    .prepare(
      `SELECT COALESCE(language, '(non renseignée)') AS value, COUNT(*) AS n
       FROM audio_track GROUP BY language ORDER BY n DESC LIMIT 10`,
    )
    .all() as { value: string; n: number }[];
  if (languages.length > 0) {
    out.push('');
    out.push('  langues déclarées (pistes, 10 plus fréquentes) :');
    for (const row of languages) {
      out.push(`    ${row.value.padEnd(24)} ${String(row.n).padStart(5)}`);
    }
  }

  // --- Échecs -------------------------------------------------------------
  out.push('');
  out.push(line());
  out.push(`FICHIERS EN ÉCHEC : ${input.failures.length}`);
  out.push(line());
  if (input.failures.length === 0) {
    out.push('  aucun');
  } else {
    const pathOf = db.prepare('SELECT path FROM media_file WHERE id = ?');
    for (const failure of input.failures) {
      const row = pathOf.get(failure.target_id) as { path: string } | undefined;
      out.push(`  ${row?.path ?? `media_file #${failure.target_id}`}`);
      out.push(`      ${failure.attempts} essai(s) — ${failure.last_error ?? 'erreur inconnue'}`);
    }
  }

  out.push('');
  out.push(line('═'));
  out.push(
    `File « probe » : ${input.counts.done} terminés, ${input.counts.failed} en échec, ` +
      `${input.counts.pending} en attente, ${input.counts.skipped} ignorés.`,
  );
  out.push(line('═'));

  return out.join('\n');
}
