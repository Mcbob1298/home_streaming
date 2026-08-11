/**
 * Commande `npm run keyframes` — indexation des images clés.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE PASSE EXISTE
 *
 * Le manifeste HLS doit décrire la découpe RÉELLE du fichier, donc connaître
 * ses images clés. Les énumérer coûte ~2 s sur un fichier déjà lu par le
 * système, mais la première lecture d'un film de 1,8 Go sur le partage SMB
 * demande de le parcourir en entier : 139 s mesurées.
 *
 * Deux minutes d'attente avant la première image seraient inacceptables. Cette
 * passe fait donc le travail à l'avance, hors ligne, comme le sondage et les
 * métadonnées — et jamais depuis une requête HTTP.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Options :
 *   --full          réindexe tout, même ce qui est déjà en cache
 *   --limit=<n>     s'arrête après n fichiers
 *   --concurrency=<n>  fichiers en parallèle (défaut : 2 — le NAS n'aime pas la foule)
 */
import { loadConfig, loadEnvFile, resolveDatabasePath } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { remuxSql } from '../playback/playability.js';
import { detectCapabilities, FfmpegMissingError } from './capabilities.js';
import { ffprobeFor, readKeyframes } from './keyframes.js';
import { nowIso } from '../db/index.js';

interface Row {
  id: number;
  path: string;
  rawPath: string | null;
  sizeBytes: number;
  mtimeMs: number;
  fileName: string;
}

interface Options {
  full: boolean;
  limit: number;
  concurrency: number;
}

function parseArguments(argv: string[]): Options {
  const options: Options = { full: false, limit: Number.POSITIVE_INFINITY, concurrency: 2 };

  for (const argument of argv) {
    if (argument === '--full') options.full = true;
    else if (argument.startsWith('--limit=')) {
      const value = Number(argument.slice('--limit='.length));
      if (Number.isFinite(value) && value > 0) options.limit = Math.floor(value);
    } else if (argument.startsWith('--concurrency=')) {
      const value = Number(argument.slice('--concurrency='.length));
      if (Number.isFinite(value) && value > 0) options.concurrency = Math.floor(value);
    }
  }

  return options;
}

/**
 * Fichiers à indexer : ceux qui passeront par un remux.
 *
 * Les 143 fichiers déjà lisibles n'en ont pas besoin — ils sont servis tels
 * quels. Ceux qui demandent un transcodage vidéo non plus : le palier suivant
 * réencodera leur image et pourra donc placer les images clés où il veut.
 */
function listPending(db: Db, full: boolean): Row[] {
  const cached = full
    ? ''
    : `AND NOT EXISTS (
         SELECT 1 FROM keyframe_index k
         WHERE k.media_file_id = f.id
           AND k.fingerprint = f.size_bytes || ':' || CAST(f.mtime_ms AS INTEGER))`;

  return db
    .prepare(
      `SELECT f.id, f.path, f.raw_path AS rawPath, f.size_bytes AS sizeBytes,
              f.mtime_ms AS mtimeMs, f.file_name AS fileName
       FROM media_file f
       WHERE f.present = 1 AND ${remuxSql('f')} ${cached}
       ORDER BY f.size_bytes`,
    )
    .all() as Row[];
}

function formatBytes(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  return gigabytes >= 1 ? `${gigabytes.toFixed(1)} Go` : `${Math.round(bytes / 1024 ** 2)} Mo`;
}

async function main(): Promise<void> {
  loadEnvFile();
  const options = parseArguments(process.argv.slice(2));

  const capabilities = await detectCapabilities();
  const ffprobe = ffprobeFor(capabilities.binary);

  const databasePath = resolveDatabasePath(loadConfig());
  const db = openDatabase(databasePath);

  const pending = listPending(db, options.full).slice(0, options.limit);
  const totalBytes = pending.reduce((sum, row) => sum + row.sizeBytes, 0);

  console.log(`Base     : ${databasePath}`);
  console.log(`ffprobe  : ${ffprobe}`);
  console.log('');
  console.log(`À indexer : ${pending.length} fichier(s), ${formatBytes(totalBytes)} à parcourir.`);
  if (pending.length === 0) {
    console.log('Rien à faire. Utilisez --full pour tout refaire.');
    db.close();
    return;
  }
  console.log(`${options.concurrency} en parallèle. Chaque fichier est lu en entier une fois.\n`);

  const save = db.prepare(
    `INSERT INTO keyframe_index (media_file_id, fingerprint, times_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(media_file_id) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       times_json  = excluded.times_json,
       created_at  = excluded.created_at`,
  );

  const startedAt = Date.now();
  let done = 0;
  let failed = 0;
  let keyframeTotal = 0;
  let bytesDone = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const row = pending[cursor] as Row;
      cursor += 1;

      try {
        const times = await readKeyframes(ffprobe, row.rawPath ?? row.path);
        if (times.length === 0) throw new Error('aucune image clé trouvée');

        save.run(row.id, `${row.sizeBytes}:${Math.floor(row.mtimeMs)}`, JSON.stringify(times), nowIso());
        keyframeTotal += times.length;
        done += 1;
      } catch (error) {
        failed += 1;
        console.log(`\n  échec : ${row.fileName}\n          ${(error as Error).message.split('\n')[0]}`);
      }

      bytesDone += row.sizeBytes;
      const elapsed = (Date.now() - startedAt) / 1000;
      const share = bytesDone / Math.max(1, totalBytes);
      const remaining = share > 0 ? Math.round(elapsed / share - elapsed) : 0;
      const message =
        `  ${done + failed}/${pending.length} (${Math.round(share * 100)} %)  ·  ` +
        `${failed} échec(s)  ·  reste ~${Math.round(remaining / 60)} min`;

      if (process.stdout.isTTY === true) process.stdout.write(`\r${message.padEnd(78)}`);
      else process.stdout.write(`${message}\n`);
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, worker));
  if (process.stdout.isTTY === true) process.stdout.write('\n');

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const { indexed } = db.prepare('SELECT COUNT(*) AS indexed FROM keyframe_index').get() as { indexed: number };
  const { stored } = db
    .prepare('SELECT COALESCE(SUM(LENGTH(times_json)), 0) AS stored FROM keyframe_index')
    .get() as { stored: number };

  console.log('');
  console.log(`  indexés dans cette passe  ${done}`);
  console.log(`  en échec                  ${failed}`);
  console.log(`  images clés relevées      ${keyframeTotal.toLocaleString('fr-FR')}`);
  console.log(`  durée                     ${Math.floor(seconds / 60)} min ${seconds % 60} s`);
  console.log(`  débit de lecture          ${(totalBytes / 1024 ** 2 / Math.max(1, seconds)).toFixed(0)} Mo/s`);
  console.log('');
  console.log(`  fichiers en cache         ${indexed}`);
  console.log(`  taille de l'index         ${formatBytes(stored)}`);

  db.close();
}

main().catch((error: unknown) => {
  if (error instanceof FfmpegMissingError) console.error(`\n${error.message}`);
  else console.error(`\n${(error as Error).message}`);
  process.exitCode = 1;
});
