/**
 * `npm run prelude -- --file 365` — fabrique le prélude d'un fichier.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IL PASSE PAR LA MÊME MACHINE QUE LA LECTURE. C'EST TOUT L'ENJEU.
 *
 * Le prélude et la suite doivent avoir exactement les mêmes paramètres
 * d'encodage — résolution, profil, débit, images par seconde, tone mapping,
 * réglages audio, grille de segments. Une liste d'arguments recopiée ici
 * divergerait à la première modification de l'encodeur, et la jonction
 * décrocherait sans que rien ne le signale.
 *
 * On construit donc le MÊME `SessionInput` que la route de lecture, via
 * `resolvePlayback`, on le donne à une vraie `TranscodeSession`, et on lui
 * réclame ses premiers segments. Les arguments ffmpeg ne sont écrits nulle part
 * ici : ils viennent de `videoArgs()` et `buildAudioArgs()`, les mêmes qui
 * serviront la suite.
 *
 * La seule différence avec une lecture : le répertoire de sortie est durable, et
 * on s'arrête à la fin du préfixe.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR, loadConfig, loadEnvFile, PRELUDE_DIR, resolveDatabasePath } from '../config.js';
import { openDatabase } from '../db/index.js';
import { findMedia, resolvePlayback } from '../playback/resolve.js';
import { detectCapabilities } from './capabilities.js';
import { supportedBackend } from './encode.js';
import {
  PRELUDE_SECONDS,
  planPrelude,
  preludeDirOf,
  preludeSignature,
  publishPrelude,
} from './prelude.js';
import { TranscodeSession, type SessionInput, type SessionOptions } from './session.js';

function readFileId(argv: string[]): number | null {
  const index = argv.indexOf('--file');
  if (index === -1) return null;
  const value = Number(argv[index + 1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Supprime les segments au-delà du compte déclaré, et le reste du bruit. */
async function elaguer(dir: string, garder: number): Promise<void> {
  const { readdir, rm } = await import('node:fs/promises');
  let noms: string[];
  try {
    noms = await readdir(dir);
  } catch {
    return;
  }

  for (const nom of noms) {
    // La playlist interne de ffmpeg ne sert qu'à lui : elle n'est pas servie.
    if (nom === 'internal.m3u8') {
      await rm(path.join(dir, nom), { force: true });
      continue;
    }
    const m = /^seg-(\d+)\.m4s$/.exec(nom);
    if (m !== null && Number(m[1]) >= garder) await rm(path.join(dir, nom), { force: true });
  }
}

function octets(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} Go`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
  return `${Math.round(n / 1024)} Ko`;
}

async function main(): Promise<void> {
  loadEnvFile();
  const fileId = readFileId(process.argv.slice(2));
  if (fileId === null) {
    console.error('Usage : npm run prelude -- --file <mediaFileId>');
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
  const backend = supportedBackend(capabilities.hardware);

  const resolved = await resolvePlayback(
    db,
    capabilities.binary,
    media,
    { file: `/api/stream/${media.id}`, hls: `/api/hls/${media.id}/index.m3u8` },
    { transcodeAvailable: true },
  );

  if (resolved.plan.length === 0) {
    console.error('Découpage impossible : durée inconnue, ou aucune image clé indexée.');
    process.exit(1);
  }

  const input: SessionInput = {
    mediaFileId: media.id,
    inputPath: media.rawPath ?? media.path,
    sizeBytes: media.sizeBytes,
    mtimeMs: media.mtimeMs,
    plan: resolved.plan,
    mode: resolved.decision.mode === 'transcode' ? 'transcode' : 'remux',
    source: resolved.source,
    muxedAudio: resolved.muxedAudio,
    audioPlan: resolved.audioPlan,
    audioRenditions: resolved.audioRenditions,
  };

  /*
   * Le répertoire de travail est un STAGING : le prélude n'est publié qu'une
   * fois complet. Un encodage interrompu ne doit jamais être trouvé par une
   * lecture — il produirait une jonction au milieu de nulle part.
   */
  const staging = path.join(PRELUDE_DIR, `.staging-${media.id}`);
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(staging, { recursive: true });

  const options: SessionOptions = {
    ffmpegBinary: capabilities.binary,
    // La session bâtit `<workDir>/mf-<id>` : on vise donc le parent du staging.
    workDir: path.dirname(staging),
    hardware: backend.backend,
    device: capabilities.device ?? '/dev/dri/renderD128',
    toneMap: capabilities.toneMap,
    onLog: (message, details) => console.log(`  ${message}`, details ?? ''),
  };

  const plan = planPrelude(input);
  console.log(`Fichier #${media.id} — ${path.basename(media.path)}`);
  console.log(`  mode        : ${input.mode}`);
  console.log(`  accélération: ${backend.backend ?? 'logiciel'} · tone mapping ${capabilities.toneMap ?? 'aucun'}`);
  console.log(`  vidéo       : ${plan.videoSegments} segments → ${plan.videoEnd} s`);
  console.log(`  audio       : ${plan.audioSegments} segments × ${plan.streams.length} piste(s) → ${plan.audioEnd} s`);
  console.log(`  visé        : ${PRELUDE_SECONDS} s\n`);

  // Le nom du répertoire de session est imposé par TranscodeSession.
  const sessionDir = path.join(path.dirname(staging), `mf-${media.id}`);
  await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);

  const session = new TranscodeSession(input, options);
  await session.prepare();

  const debut = Date.now();
  try {
    // --- vidéo ---------------------------------------------------------------
    if ((await session.ensureInit()) === null) throw new Error('en-tête vidéo non produit');
    for (let i = 0; i < plan.videoSegments; i += 1) {
      if ((await session.ensureSegment(i)) === null) throw new Error(`segment vidéo ${i} non produit`);
      process.stdout.write(`\r  vidéo ${i + 1}/${plan.videoSegments}`);
    }
    console.log('');

    // --- audio, TOUTES les pistes -------------------------------------------
    /*
     * Toutes, et pas seulement la piste par défaut : la préférence mémorisée
     * peut désigner n'importe laquelle. Un prélude vidéo sans son prélude audio
     * correspondant démarrerait l'image instantanément puis attendrait le son —
     * pire que pas de prélude du tout.
     */
    for (const streamIndex of plan.streams) {
      if ((await session.ensureAudioInit(streamIndex)) === null) {
        throw new Error(`en-tête audio ${streamIndex} non produit`);
      }
      for (let i = 0; i < plan.audioSegments; i += 1) {
        if ((await session.ensureAudioSegment(streamIndex, i)) === null) {
          throw new Error(`segment audio ${streamIndex}/${i} non produit`);
        }
      }
      process.stdout.write(`\r  audio ${plan.streams.indexOf(streamIndex) + 1}/${plan.streams.length}`);
    }
    console.log('');
  } finally {
    // On tue ffmpeg SANS effacer : ces fichiers sont le produit recherché.
    session.abandon();
  }

  const secondes = (Date.now() - debut) / 1000;

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * ON ÉLAGUE CE QUE FFMPEG A PRODUIT EN TROP.
   *
   * Il ne s'arrête pas au segment qu'on attendait : le temps de servir les six
   * pistes audio, la vidéo en avait produit vingt au lieu de huit. Ces segments
   * sont valables, mais ils déplacent la jonction ailleurs que là où le
   * manifeste du prélude l'annonce — et un prélude qui ment sur ses propres
   * bornes est exactement ce qu'on ne veut pas garder.
   *
   * Mesuré : 56,5 Mo avec les surplus, contre ce qui est réellement déclaré.
   * ─────────────────────────────────────────────────────────────────────────
   */
  await elaguer(path.join(sessionDir, 'v'), plan.videoSegments);
  for (const streamIndex of plan.streams) {
    await elaguer(path.join(sessionDir, `a-${streamIndex}`), plan.audioSegments);
  }

  const manifest = await publishPrelude(
    sessionDir,
    preludeDirOf(PRELUDE_DIR, media.id, media.sizeBytes, media.mtimeMs),
    {
      format: 1,
      signature: preludeSignature(input, options),
      videoSegments: plan.videoSegments,
      audioSegments: plan.audioSegments,
      streams: plan.streams,
    },
  );
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`Prélude publié     : ${preludeDirOf(PRELUDE_DIR, media.id, media.sizeBytes, media.mtimeMs)}`);
  console.log(`Taille sur disque  : ${octets(manifest.bytes)}`);
  console.log(`Temps de génération: ${secondes.toFixed(1)} s`);
  console.log(`Empreinte          : ${manifest.signature}`);

  db.close();
}

void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
