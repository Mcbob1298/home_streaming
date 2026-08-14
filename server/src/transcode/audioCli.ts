/**
 * `npm run audio -- --file 365` — pré-génère les pistes audio d'un fichier.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * MÊME CONSTRUCTION D'ARGUMENTS QUE LA LECTURE, ET UNE SEULE LECTURE DU FICHIER.
 *
 * Les arguments viennent du même constructeur que la lecture à la demande :
 * le downmix — matrice à centre 0,8 pour le 5.1 —, le débit, la fréquence forcée
 * à 48 kHz et la grille de huit secondes en découlent, sans qu'une seule valeur
 * soit recopiée ici.
 *
 * Une exécution unique, du début à la fin du film, avec une sortie par piste :
 * c'est ce qui rend la grille exacte de bout en bout — 375 trames par segment,
 * vérifié — sans relire le conteneur une fois par piste.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AUDIO_DIR, DATA_DIR, loadConfig, loadEnvFile, resolveDatabasePath } from '../config.js';
import { openDatabase } from '../db/index.js';
import { findMedia, resolvePlayback } from '../playback/resolve.js';
import { buildMultiAudioArgs } from './args.js';
import { audioDirOf, audioSignature, MANIFEST_NAME, type AudioManifest } from './audioStore.js';
import { detectCapabilities } from './capabilities.js';
import { AUDIO_SEGMENT_DURATION } from './segments.js';

function readFileId(argv: string[]): number | null {
  const index = argv.indexOf('--file');
  if (index === -1) return null;
  const value = Number(argv[index + 1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function octets(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} Go`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
  return `${Math.round(n / 1024)} Ko`;
}

async function tailleDe(dir: string): Promise<number> {
  let total = 0;
  for (const entree of await readdir(dir, { withFileTypes: true })) {
    const complet = path.join(dir, entree.name);
    total += entree.isDirectory() ? await tailleDe(complet) : (await stat(complet)).size;
  }
  return total;
}

function lancer(binaire: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const enfant = spawn(binaire, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    enfant.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    enfant.on('error', (error) => reject(error));
    enfant.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').at(-1) ?? `ffmpeg a quitté avec le code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  loadEnvFile();
  const fileId = readFileId(process.argv.slice(2));
  if (fileId === null) {
    console.error('Usage : npm run audio -- --file <mediaFileId>');
    process.exit(1);
  }

  const config = loadConfig();
  const db = openDatabase(resolveDatabasePath(config));
  const media = findMedia(db, fileId);
  if (media === undefined) {
    console.error(`Aucun fichier présent avec l’identifiant ${fileId}.`);
    process.exit(1);
  }

  const capabilities = await detectCapabilities({ dataDir: DATA_DIR });
  const resolved = await resolvePlayback(
    db,
    capabilities.binary,
    media,
    { file: `/api/stream/${media.id}`, hls: `/api/hls/${media.id}/index.m3u8` },
    { transcodeAvailable: true },
  );

  if (resolved.audioRenditions.length === 0) {
    console.error(
      'Ce fichier n’a pas de pistes audio séparées — une seule piste, ou audio muxé.\n' +
        'La pré-génération n’a rien à produire, et le fichier est déjà immunisé contre le défaut.',
    );
    process.exit(1);
  }

  const staging = path.join(AUDIO_DIR, `.staging-${media.id}`);
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(staging, { recursive: true });

  console.log(`Fichier #${media.id} — ${path.basename(media.path)}`);
  console.log(`  ${resolved.audioRenditions.length} piste(s), ${resolved.audioPlan.length} segments de ${AUDIO_SEGMENT_DURATION} s`);
  console.log(`  durée ${Math.round((media.durationSeconds ?? 0) / 60)} min\n`);

  const debutTotal = Date.now();

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * TOUTES LES PISTES EN UNE SEULE LECTURE DU FICHIER.
   *
   * Une exécution par piste relit le conteneur à chaque fois. Sur Avatar, six
   * pistes voulaient dire six traversées de 101 Go — mesuré à plus de douze
   * minutes rien que pour la première. Sur la bibliothèque entière, l'écart est
   * de 4,92 Tio à lire contre 10,54.
   *
   * ffmpeg accepte plusieurs sorties sur une entrée et ne lit le fichier
   * qu'une fois. Chaque sortie garde ses propres arguments, construits par la
   * même fonction que la lecture à la demande.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const sorties = resolved.audioRenditions.map((rendition) => ({
    startTime: 0,
    startNumber: 0,
    // Jusqu'au bout : une seule exécution, donc une grille continue.
    endTime: null,
    outputDir: path.join(staging, `a-${rendition.streamIndex}`),
    streamIndex: rendition.streamIndex,
    channels: rendition.channels,
    segmentDuration: AUDIO_SEGMENT_DURATION,
  }));
  for (const sortie of sorties) await mkdir(sortie.outputDir, { recursive: true });

  console.log(`  une seule lecture, ${sorties.length} sortie(s) simultanée(s)…`);
  await lancer(capabilities.binary, buildMultiAudioArgs(media.rawPath ?? media.path, sorties));
  const secondesTotal = (Date.now() - debutTotal) / 1000;

  const parPiste: { streamIndex: number; secondes: number; octets: number; segments: number }[] = [];
  for (const sortie of sorties) {
    // La playlist interne de ffmpeg ne sert qu'à lui.
    await rm(path.join(sortie.outputDir, 'internal.m3u8'), { force: true }).catch(() => undefined);
    const noms = await readdir(sortie.outputDir);
    const segments = noms.filter((n) => n.endsWith('.m4s')).length;
    const taille = await tailleDe(sortie.outputDir);
    parPiste.push({ streamIndex: sortie.streamIndex, secondes: secondesTotal / sorties.length, octets: taille, segments });
    console.log(`  piste ${sortie.streamIndex} (${sortie.channels ?? '?'} canaux) : ${segments} segments, ${octets(taille)}`);
  }

  const total = await tailleDe(staging);
  const manifest: AudioManifest = {
    format: 1,
    signature: audioSignature(resolved.audioPlan, resolved.audioRenditions),
    streams: resolved.audioRenditions.map((r) => r.streamIndex),
    segments: resolved.audioPlan.length,
    builtAt: new Date().toISOString(),
    bytes: total,
  };
  await writeFile(path.join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');

  const final = audioDirOf(AUDIO_DIR, media.id, media.sizeBytes, media.mtimeMs);
  await rm(final, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(path.dirname(final), { recursive: true });
  await rename(staging, final);

  console.log('\n──────────────────────────────────────────────');
  console.log(`Publié            : ${final}`);
  console.log(`Volume total      : ${octets(total)}`);
  console.log(`Temps total       : ${((Date.now() - debutTotal) / 1000).toFixed(1)} s`);
  console.log(`Moyenne par piste : ${(parPiste.reduce((s, p) => s + p.secondes, 0) / parPiste.length).toFixed(1)} s, ${octets(total / parPiste.length)}`);
  console.log(`Empreinte         : ${manifest.signature}`);

  db.close();
}

void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
