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

import { DATA_DIR, loadConfig, loadEnvFile, PRELUDE_DIR, resolveDatabasePath, type AppConfig } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { findMedia, resolvePlayback } from '../playback/resolve.js';
import { detectCapabilities } from './capabilities.js';
import { supportedBackend } from './encode.js';
import {
  PRELUDE_SECONDS,
  planPrelude,
  preludeDirOf,
  preludeSignature,
  publishPrelude,
  usablePrelude,
} from './prelude.js';
import { hdrPassthroughFor } from './passthrough.js';
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

/**
 * CE QUE LES DEUX COMMANDES PARTAGENT.
 *
 * `prelude` en fabrique un, `preludes` en fabrique soixante-dix. Elles doivent
 * produire des octets IDENTIQUES : la jonction du prélude avec la suite ne tient
 * que si les paramètres coïncident au bit près. Une seconde copie de cette
 * fonction divergerait à la première modification de l'encodeur — exactement ce
 * que `passthrough.ts` et `outputGeometry` ont déjà coûté à ce dépôt.
 */
export interface OptionsFabrication {
  db: Db;
  id: number;
  config: AppConfig;
  capabilities: Awaited<ReturnType<typeof detectCapabilities>>;
  backend: ReturnType<typeof supportedBackend>;
  preludeRoot: string;
  /** Fabriquer la variante tone-mappée plutôt que celle du client capable. */
  pourClientSdr: boolean;
  /** Ne rien encoder : dire seulement ce qui serait fait. */
  simulation?: boolean;
  /** Progression, pour la commande unitaire qui l'affiche. */
  onProgress?: (message: string) => void;
}

export type ResultatPrelude =
  | { etat: 'fabrique'; nom: string; bytes: number; ms: number; signature: string; dir: string }
  | { etat: 'deja-valable'; nom: string }
  | { etat: 'simule'; nom: string };

export async function fabriquerPrelude(o: OptionsFabrication): Promise<ResultatPrelude> {
  const media = findMedia(o.db, o.id);
  if (media === undefined) throw new Error(`aucun fichier présent avec l'identifiant ${o.id}`);

  const nom = path.basename(media.path);

  const resolved = await resolvePlayback(
    o.db,
    o.capabilities.binary,
    media,
    { file: `/api/stream/${media.id}`, hls: `/api/hls/${media.id}/index.m3u8` },
    { transcodeAvailable: true },
  );

  if (resolved.plan.length === 0) {
    throw new Error('découpage impossible : durée inconnue, ou aucune image clé indexée');
  }

  const mode = resolved.decision.mode === 'transcode' ? 'transcode' : 'remux';

  /*
   * La MÊME règle que la route de lecture, prise au même endroit.
   *
   * Le premier essai l'avait oubliée : la commande produisait une amorce H.264
   * tone-mappée pour une session qui attendait du HEVC. Le garde-fou d'empreinte
   * l'a refusée — correctement — mais un prélude refusé à chaque fabrication est
   * un prélude inutile.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * UNE COMMANDE N'A PAS DE CLIENT : ON CHOISIT DONC POUR QUI ON FABRIQUE.
   *
   * Depuis que la capacité se négocie, un même fichier a DEUX sorties possibles
   * — HEVC intact pour un client qui décode, H.264 tone-mappé pour les autres —
   * et donc deux préludes possibles. La commande ne peut pas le deviner.
   *
   * Par défaut elle fabrique celui du client CAPABLE : c'est le cas intéressant,
   * puisque c'est le seul où la 4K est en jeu. `--sdr` fabrique l'autre.
   *
   * Ce choix est sans danger, et c'est le garde-fou d'empreinte qui l'assure :
   * une session tone-mappée qui trouve un prélude HEVC voit une empreinte qui ne
   * correspond pas, le refuse, et démarre comme avant. Le pire cas reste « la
   * lecture démarre un peu moins vite », jamais « la lecture saute ».
   * ═══════════════════════════════════════════════════════════════════════════
   */
  const hdrPassthrough = hdrPassthroughFor({
    clientDecodesHevc: !o.pourClientSdr,
    source: resolved.source,
    mode,
  });

  const input: SessionInput = {
    mediaFileId: media.id,
    inputPath: media.rawPath ?? media.path,
    sizeBytes: media.sizeBytes,
    mtimeMs: media.mtimeMs,
    plan: resolved.plan,
    mode,
    source: resolved.source,
    // Ajouté seulement quand il est vrai : l'empreinte des autres ne bouge pas.
    ...(hdrPassthrough ? { hdrPassthrough: true } : {}),
    muxedAudio: resolved.muxedAudio,
    audioPlan: resolved.audioPlan,
    audioRenditions: resolved.audioRenditions,
  };

  const staging = path.join(o.preludeRoot, `.staging-${media.id}`);

  const options: SessionOptions = {
    ffmpegBinary: o.capabilities.binary,
    // La session bâtit `<workDir>/mf-<id>` : on vise donc le parent du staging.
    workDir: path.dirname(staging),
    hardware: o.backend.backend,
    device: o.capabilities.device ?? '/dev/dri/renderD128',
    toneMap: o.capabilities.toneMap,
    hdrMaxHeight: o.config.transcode.hdrMaxHeight,
    onLog: (message) => o.onProgress?.(message),
  };

  /*
   * REPRISE : un prélude déjà valable n'est pas refabriqué.
   *
   * C'est ce qui rend la passe sur toute une population relançable après une
   * interruption, et utilisable en rattrapage après un changement de réglage qui
   * n'invalide qu'une partie des préludes.
   */
  if (usablePrelude(o.preludeRoot, input, options, media.sizeBytes, media.mtimeMs) !== null) {
    return { etat: 'deja-valable', nom };
  }

  if (o.simulation === true) return { etat: 'simule', nom };

  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(staging, { recursive: true });

  const plan = planPrelude(input);
  o.onProgress?.(
    `vidéo ${plan.videoSegments} segments → ${plan.videoEnd} s · audio ${plan.audioSegments} × ${plan.streams.length}`,
  );

  /*
   * Le répertoire de session porte la VARIANTE, comme en lecture : fabriquer
   * les deux préludes du même fichier ne doit pas les faire écrire au même
   * endroit.
   */
  const variante = hdrPassthrough ? '-hdr' : '';
  const sessionDir = path.join(path.dirname(staging), `mf-${media.id}${variante}`);
  await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);

  const session = new TranscodeSession(input, options);
  await session.prepare();

  const debutMs = Date.now();
  try {
    if ((await session.ensureInit()) === null) throw new Error('en-tête vidéo non produit');
    for (let i = 0; i < plan.videoSegments; i += 1) {
      if ((await session.ensureSegment(i)) === null) throw new Error(`segment vidéo ${i} non produit`);
    }

    /*
     * TOUTES les pistes audio, pas seulement celle par défaut : la préférence
     * mémorisée peut désigner n'importe laquelle. Un prélude vidéo sans son
     * prélude audio correspondant démarrerait l'image instantanément puis
     * attendrait le son — pire que pas de prélude du tout.
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
    }
  } finally {
    // On tue ffmpeg SANS effacer : ces fichiers sont le produit recherché.
    session.abandon();
  }

  const ms = Date.now() - debutMs;

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * ON ÉLAGUE CE QUE FFMPEG A PRODUIT EN TROP.
   *
   * Il ne s'arrête pas au segment qu'on attendait : le temps de servir les six
   * pistes audio, la vidéo en avait produit vingt au lieu de huit. Ces segments
   * sont valables, mais ils déplacent la jonction ailleurs que là où le
   * manifeste du prélude l'annonce — et un prélude qui ment sur ses propres
   * bornes est exactement ce qu'on ne veut pas garder.
   * ─────────────────────────────────────────────────────────────────────────
   */
  await elaguer(path.join(sessionDir, 'v'), plan.videoSegments);
  for (const streamIndex of plan.streams) {
    await elaguer(path.join(sessionDir, `a-${streamIndex}`), plan.audioSegments);
  }

  const dir = preludeDirOf(o.preludeRoot, media.id, media.sizeBytes, media.mtimeMs);
  const manifest = await publishPrelude(sessionDir, dir, {
    format: 1,
    signature: preludeSignature(input, options),
    videoSegments: plan.videoSegments,
    audioSegments: plan.audioSegments,
    streams: plan.streams,
  });
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);

  return { etat: 'fabrique', nom, bytes: manifest.bytes, ms, signature: manifest.signature, dir };
}

async function main(): Promise<void> {
  loadEnvFile();
  const fileId = readFileId(process.argv.slice(2));
  if (fileId === null) {
    console.error('Usage : npm run prelude -- --file <mediaFileId> [--sdr]');
    process.exit(1);
  }

  const config = loadConfig();
  const db = openDatabase(resolveDatabasePath(config));
  const capabilities = await detectCapabilities({ dataDir: DATA_DIR });
  const backend = supportedBackend(capabilities.hardware);

  const resultat = await fabriquerPrelude({
    db,
    id: fileId,
    config,
    capabilities,
    backend,
    preludeRoot: PRELUDE_DIR,
    pourClientSdr: process.argv.includes('--sdr'),
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log('\n──────────────────────────────────────────────');
  if (resultat.etat === 'deja-valable') {
    console.log(`Déjà valable       : ${resultat.nom}`);
  } else if (resultat.etat === 'fabrique') {
    console.log(`Prélude publié     : ${resultat.dir}`);
    console.log(`Taille sur disque  : ${octets(resultat.bytes)}`);
    console.log(`Temps de génération: ${(resultat.ms / 1000).toFixed(1)} s`);
    console.log(`Empreinte          : ${resultat.signature}`);
  }

  db.close();
}
void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
