/**
 * Commande `npm run images` — rapatrie les images manquantes.
 *
 * Séparée de `npm run metadata` à dessein : quand on ajoute une taille au jeu
 * (parce qu'une image se révélait floue sur grand écran), il faut retélécharger
 * SANS refaire les 481 appariements TMDB, qui sont déjà justes.
 *
 * Aucun appel à l'API TMDB : tous les chemins d'images sont déjà en base, seule
 * la CDN d'images est sollicitée. Les tailles déjà présentes sont ignorées.
 *
 * Options :
 *   --concurrency=<n>   téléchargements simultanés (défaut : 6)
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig, resolveDatabasePath, resolveImagesPath } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { mapLimit } from '../util/concurrency.js';
import { ImageDownloader, IMAGE_SIZES, type ImageKind } from '../metadata/images.js';

const DEFAULT_CONCURRENCY = 6;

interface Wanted {
  tmdbPath: string;
  kind: ImageKind;
}

/** Toutes les images référencées en base, dédoublonnées. */
function collectImages(db: Db): Wanted[] {
  const sources: { sql: string; kind: ImageKind }[] = [
    { sql: 'SELECT poster_path AS p FROM movie WHERE poster_path IS NOT NULL', kind: 'poster' },
    { sql: 'SELECT backdrop_path AS p FROM movie WHERE backdrop_path IS NOT NULL', kind: 'backdrop' },
    { sql: 'SELECT logo_path AS p FROM movie WHERE logo_path IS NOT NULL', kind: 'logo' },
    { sql: 'SELECT poster_path AS p FROM show WHERE poster_path IS NOT NULL', kind: 'poster' },
    { sql: 'SELECT backdrop_path AS p FROM show WHERE backdrop_path IS NOT NULL', kind: 'backdrop' },
    { sql: 'SELECT logo_path AS p FROM show WHERE logo_path IS NOT NULL', kind: 'logo' },
    { sql: 'SELECT poster_path AS p FROM season WHERE poster_path IS NOT NULL', kind: 'poster' },
    { sql: 'SELECT still_path AS p FROM episode WHERE still_path IS NOT NULL', kind: 'still' },
  ];

  const seen = new Set<string>();
  const wanted: Wanted[] = [];
  for (const source of sources) {
    for (const row of db.prepare(source.sql).all() as { p: string }[]) {
      const key = `${source.kind}:${row.p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push({ tmdbPath: row.p, kind: source.kind });
    }
  }
  return wanted;
}

/** Volume total du dossier d'images, pour le avant / après. */
async function directorySize(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(full)).size;
      }
    }
  }

  await walk(root);
  return { bytes, files };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
  return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const concurrencyArgument = argv.find((argument) => argument.startsWith('--concurrency='));
  const concurrency = concurrencyArgument === undefined
    ? DEFAULT_CONCURRENCY
    : Math.max(1, Math.floor(Number(concurrencyArgument.slice('--concurrency='.length))) || DEFAULT_CONCURRENCY);

  const config = loadConfig();
  const imagesRoot = resolveImagesPath(config);
  const db = openDatabase(resolveDatabasePath(config), { readonly: true });

  console.log(`Images : ${imagesRoot}`);
  console.log('Tailles par type :');
  for (const [kind, sizes] of Object.entries(IMAGE_SIZES)) {
    console.log(`  ${kind.padEnd(9)} ${sizes.join(', ')}`);
  }

  const before = await directorySize(imagesRoot);
  console.log(`\nAvant : ${before.files} fichiers, ${formatBytes(before.bytes)}`);

  const wanted = collectImages(db);
  const total = wanted.reduce((sum, item) => sum + IMAGE_SIZES[item.kind].length, 0);
  console.log(`À vérifier : ${wanted.length} images, ${total} fichiers attendus, ${concurrency} en parallèle.\n`);

  const downloader = new ImageDownloader(imagesRoot);
  const isTty = process.stdout.isTTY === true;
  let done = 0;
  let lastPrint = 0;

  await mapLimit(wanted, concurrency, async (item) => {
    await downloader.fetchAll(item.tmdbPath, item.kind);
    done += 1;

    const now = Date.now();
    if (now - lastPrint < 250 && done < wanted.length) return;
    lastPrint = now;
    const message =
      `  ${done}/${wanted.length}  ·  ${downloader.stats.downloaded} téléchargées` +
      `  ·  ${downloader.stats.skipped} déjà là  ·  ${downloader.stats.failed} échec(s)`;
    if (isTty) process.stdout.write(`\r${message.padEnd(78)}`);
    else process.stdout.write(`${message}\n`);
  });

  if (isTty) process.stdout.write('\n');

  const after = await directorySize(imagesRoot);

  console.log('\n─────────────────────────────────────────────');
  console.log(`Téléchargées   ${downloader.stats.downloaded}`);
  console.log(`Déjà présentes ${downloader.stats.skipped}`);
  console.log(`En échec       ${downloader.stats.failed}`);
  console.log('─────────────────────────────────────────────');
  console.log(`Avant  ${String(before.files).padStart(5)} fichiers  ${formatBytes(before.bytes).padStart(9)}`);
  console.log(`Après  ${String(after.files).padStart(5)} fichiers  ${formatBytes(after.bytes).padStart(9)}`);
  console.log(`Ajout  ${String(after.files - before.files).padStart(5)} fichiers  ${formatBytes(after.bytes - before.bytes).padStart(9)}`);
  console.log('─────────────────────────────────────────────');

  db.close();
}

main().catch((error: unknown) => {
  console.error(`\n${(error as Error).message}`);
  process.exitCode = 1;
});
