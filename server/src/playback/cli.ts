/**
 * Commande `npm run playable` — TEMPORAIRE.
 *
 * Les fichiers directement lisibles sont éparpillés dans la bibliothèque, ce
 * qui rend les essais du lecteur pénibles : il faut savoir sur quoi cliquer.
 * Cette commande les liste avec leur titre et l'adresse à ouvrir.
 *
 * ELLE DISPARAÎTRA quand le transcodage rendra la bibliothèque entièrement
 * lisible, en même temps que le filtre `?playable=direct` et la pastille des
 * vignettes.
 *
 * Options :
 *   --limit=<n>   n'affiche que les n premières lignes (défaut : tout)
 *   --ids         n'affiche que les identifiants, un par ligne
 */
import { loadConfig, resolveDatabasePath } from '../config.js';
import { openDatabase } from '../db/index.js';
import { decidePlayback, directPlaySql, type PlayableFile } from './playability.js';

interface Row extends PlayableFile {
  title: string;
  detail: string | null;
  sizeBytes: number;
  durationSeconds: number | null;
}

function parseArguments(argv: string[]): { limit: number; idsOnly: boolean } {
  let limit = Number.POSITIVE_INFINITY;
  let idsOnly = false;

  for (const argument of argv) {
    if (argument === '--ids') idsOnly = true;
    else if (argument.startsWith('--limit=')) {
      const value = Number(argument.slice('--limit='.length));
      if (Number.isFinite(value) && value > 0) limit = Math.floor(value);
    }
  }

  return { limit, idsOnly };
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '     ';
  const minutes = Math.round(seconds / 60);
  return `${String(minutes).padStart(4)} min`;
}

function main(): void {
  const { limit, idsOnly } = parseArguments(process.argv.slice(2));
  const databasePath = resolveDatabasePath(loadConfig());
  const db = openDatabase(databasePath);

  const rows = db
    .prepare(
      `SELECT f.id, f.extension, f.container, f.video_codec AS videoCodec, f.audio_codec AS audioCodec,
              f.size_bytes AS sizeBytes, f.duration_seconds AS durationSeconds,
              COALESCE(m.title, s.title, f.file_name) AS title,
              CASE
                WHEN e.id IS NULL THEN NULL
                ELSE 'S' || substr('0' || e.season_number, -2) || ':E' || e.episode_number
              END AS detail
       FROM media_file f
       LEFT JOIN movie m ON m.id = f.movie_id
       LEFT JOIN episode e ON e.id = f.episode_id
       LEFT JOIN show s ON s.id = e.show_id
       WHERE f.present = 1 AND ${directPlaySql('f')}
       ORDER BY title, e.season_number, e.episode_number, f.file_name`,
    )
    .all() as Row[];

  if (idsOnly) {
    for (const row of rows.slice(0, limit)) console.log(row.id);
    db.close();
    return;
  }

  const { total } = db.prepare('SELECT COUNT(*) AS total FROM media_file WHERE present = 1').get() as {
    total: number;
  };

  console.log(`Base : ${databasePath}`);
  console.log('');
  console.log('FICHIERS DIRECTEMENT LISIBLES EN NAVIGATEUR');
  console.log('Règle : conteneur MP4/M4V réel + vidéo H.264 + audio AAC.');
  console.log('');

  const shown = rows.slice(0, limit);
  for (const row of shown) {
    const label = row.detail === null ? row.title : `${row.title} — ${row.detail}`;
    console.log(
      `  ${String(row.id).padStart(5)}  ${formatDuration(row.durationSeconds)}  ` +
        `${label.slice(0, 58).padEnd(58)}  /watch/${row.id}`,
    );
  }

  if (shown.length < rows.length) {
    console.log(`  … ${rows.length - shown.length} de plus (retirer --limit pour tout voir)`);
  }

  console.log('');
  console.log(`  ${rows.length} fichier(s) sur ${total} présents.`);

  /*
   * Contrôle de cohérence : la clause SQL et `decidePlayback` expriment la même
   * règle sous deux formes. Si elles divergeaient, la liste ci-dessus ne
   * correspondrait pas à ce que la route de playability répondrait.
   */
  const urls = { file: '', hls: '' };
  const disagreeing = rows.filter((row) => decidePlayback(row, urls).mode !== 'direct');
  if (disagreeing.length > 0) {
    console.log('');
    console.log(
      `  ATTENTION : ${disagreeing.length} fichier(s) classés « direct » par le SQL mais pas ` +
        'par la fonction de décision. Les deux règles ont divergé.',
    );
  }

  db.close();
}

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
