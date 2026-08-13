/**
 * `npm run subtitles` — passe de préchauffage des sous-titres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRÉPARER À L'AVANCE CE QU'ON CALCULERAIT À LA DEMANDE.
 *
 * Une extraction traverse le fichier entier : plus de cinq minutes sur un remux
 * 4K servi par SMB. Faite pendant que personne ne regarde, elle ne coûte rien à
 * personne ; faite au moment où quelqu'un lance la lecture, elle est un défaut.
 *
 * Cette passe la fait pour toute la bibliothèque, une fois. Ensuite, ouvrir
 * n'importe quel fichier trouve ses sous-titres déjà prêts.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   npm run subtitles              reprend là où la passe précédente s'est arrêtée
 *   npm run subtitles -- --full    tout refaire, cache compris
 *   npm run subtitles -- --retry-failed
 *   npm run subtitles -- --limit 50
 */
import path from 'node:path';

import { DATA_DIR, loadConfig, loadEnvFile, resolveDatabasePath } from '../config.js';
import { openDatabase } from '../db/index.js';
import { detectCapabilities } from './capabilities.js';
import { extractSubtitles, readyStreams, type SubtitleSource } from './subtitles.js';
import { filesWithTextSubtitles, subtitleQueue, subtitleSourceOf } from './subtitleQueue.js';

interface Options {
  full: boolean;
  retryFailed: boolean;
  limit: number | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { full: false, retryFailed: false, limit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--full') options.full = true;
    else if (arg === '--retry-failed') options.retryFailed = true;
    else if (arg === '--limit') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) options.limit = value;
      index += 1;
    }
  }
  return options;
}

/** « 3 h 12 min 04 s », pour une passe qui dure des heures. */
function duree(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min ${String(s).padStart(2, '0')} s`;
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

function octets(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${Math.round(bytes / 1024)} Ko`;
}

/** Taille du cache produit, parcourue une fois à la fin. */
async function tailleDuCache(dir: string): Promise<number> {
  const { readdir, stat } = await import('node:fs/promises');
  let total = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await tailleDuCache(full);
      else total += (await stat(full)).size;
    }
  } catch {
    // Cache absent : zéro.
  }
  return total;
}

async function main(): Promise<void> {
  loadEnvFile();
  const options = parseOptions(process.argv.slice(2));

  const config = loadConfig();
  const db = openDatabase(resolveDatabasePath(config));
  const cacheDir = path.join(DATA_DIR, 'subtitles');

  const capabilities = await detectCapabilities({ dataDir: DATA_DIR });
  console.log(`ffmpeg : ${capabilities.version}`);
  console.log(`Cache  : ${cacheDir}\n`);

  const cibles = filesWithTextSubtitles(db);
  console.log(`${cibles.length} fichiers portent des sous-titres texte embarqués.`);

  const queue = subtitleQueue(db);
  if (options.full) console.log(`  ${queue.requeueAll()} travaux remis en attente (--full)`);
  if (options.retryFailed) console.log(`  ${queue.requeueFailed()} travaux en échec relancés`);
  queue.requeueStale();

  const inscrits = queue.enqueue(
    cibles.map(({ source, fingerprint }) => ({
      targetType: 'media_file' as const,
      targetId: source.id,
      fingerprint,
    })),
  );
  console.log(
    `  ${inscrits.added} nouveaux, ${inscrits.reactivated} modifiés depuis la dernière passe, ` +
      `${inscrits.unchanged} déjà à jour\n`,
  );

  const debut = Date.now();
  let traites = 0;
  let pistes = 0;
  let echecs = 0;
  let ignores = 0;

  for (;;) {
    if (options.limit !== null && traites >= options.limit) break;

    const [job] = queue.claim(1);
    if (job === undefined) break;

    const source: SubtitleSource | undefined = subtitleSourceOf(db, job.target_id);
    if (source === undefined) {
      queue.skip(job.id, 'fichier absent de l’index ou disparu du disque');
      ignores += 1;
      continue;
    }

    const avant = readyStreams(cacheDir, source).size;
    const t0 = Date.now();

    try {
      const total = await extractSubtitles(db, capabilities.binary, cacheDir, source);
      queue.complete(job.id);
      traites += 1;
      pistes += total - avant;

      const restants = queue.counts().pending;
      console.log(
        `  [${traites}] #${source.id} — ${total} piste(s) en ${duree(Date.now() - t0)}` +
          ` · ${restants} en attente`,
      );
    } catch (error) {
      queue.fail(job.id, (error as Error).message);
      echecs += 1;
      console.log(`  [${traites}] #${source.id} — ÉCHEC : ${(error as Error).message}`);
    }
  }

  const total = Date.now() - debut;
  const taille = await tailleDuCache(cacheDir);
  const counts = queue.counts();

  console.log('\n──────────────────────────────────────────────');
  console.log(`Fichiers traités   : ${traites}`);
  console.log(`Pistes produites   : ${pistes}`);
  console.log(`Échecs             : ${echecs}`);
  console.log(`Ignorés            : ${ignores}`);
  console.log(`Durée totale       : ${duree(total)}`);
  if (traites > 0) console.log(`Moyenne par fichier: ${duree(total / traites)}`);
  console.log(`Volume du cache    : ${octets(taille)}`);
  console.log(`Reste en attente   : ${counts.pending}`);
  if (counts.failed > 0) {
    console.log(`\n${counts.failed} en échec — « npm run subtitles -- --retry-failed » pour réessayer.`);
  }

  db.close();
}

void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
