/**
 * LE NOYAU DE FABRICATION D'UN PRÉLUDE — partagé, et SANS EFFET DE BORD.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EXISTE : UN IMPORT NE DOIT RIEN EXÉCUTER.
 *
 * `fabriquerPrelude` vivait dans `preludeCli.ts`, et la commande au pluriel
 * l'importait de là. Or `preludeCli.ts` se termine par un `void main()` au
 * niveau du module : l'import l'EXÉCUTAIT. `npm run preludes -- --hdr --dry`
 * imprimait donc l'usage du SINGULIER puis appelait `process.exit(1)`, avant
 * que le pluriel n'ait commencé.
 *
 * Le noyau partagé était le bon choix ; son emplacement était le défaut. Un
 * point d'entrée exécute, un module fournit — les deux ne se mélangent pas.
 * Aucune des deux commandes n'importe l'autre : toutes deux importent ceci.
 *
 * Audit fait à cette occasion : onze modules du serveur exécutent quelque chose
 * au chargement, tous des points d'entrée de commande, et un seul était importé
 * ailleurs — celui-ci. Le défaut était isolé, pas systémique.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Ce que les deux commandes partagent doit produire des octets IDENTIQUES : la
 * jonction du prélude avec la suite ne tient que si les paramètres coïncident au
 * bit près. Une seconde copie divergerait à la première modification de
 * l'encodeur — ce que `passthrough.ts` et `outputGeometry` ont déjà coûté.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { findMedia, resolvePlayback } from '../playback/resolve.js';
import type { detectCapabilities } from './capabilities.js';
import type { supportedBackend } from './encode.js';
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

/**
 * Les arguments, traduits en intentions — et testables sans lancer la commande.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE FONCTION EXISTE SÉPARÉMENT DE `main`.
 *
 * `--dry` était reconnu dans la documentation de la commande et nulle part
 * ailleurs : `main` ne le transportait pas jusqu'à `fabriquerPrelude`. La
 * commande annonçait une simulation et encodait. Sur Avatar le défaut restait
 * invisible — son prélude étant déjà valable, la fonction sortait AVANT
 * d'atteindre la question — mais sur les soixante-neuf autres fichiers HDR10,
 * `--dry` aurait produit vingt secondes d'encodage chacun.
 *
 * Un `main` n'est pas testable : il lit `process.argv`, ouvre une base et
 * termine le processus. La traduction des arguments, elle, est une fonction
 * pure — donc vérifiable, donc vérifiée.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export interface IntentionPrelude {
  fileId: number | null;
  pourClientSdr: boolean;
  simulation: boolean;
}

export function lireIntention(argv: string[]): IntentionPrelude {
  const index = argv.indexOf('--file');
  const value = index === -1 ? Number.NaN : Number(argv[index + 1]);

  return {
    fileId: Number.isSafeInteger(value) && value > 0 ? value : null,
    pourClientSdr: argv.includes('--sdr'),
    simulation: argv.includes('--dry'),
  };
}

export interface OptionsFabrication {
  db: Db;
  id: number;
  config: AppConfig;
  capabilities: Awaited<ReturnType<typeof detectCapabilities>>;
  backend: ReturnType<typeof supportedBackend>;
  preludeRoot: string;
  /** Fabriquer la variante tone-mappée plutôt que celle du client capable. */
  pourClientSdr: boolean;
  /**
   * Ne rien encoder : dire seulement ce qui serait fait.
   *
   * OBLIGATOIRE, et c'est la correction. Le champ était optionnel, et le point
   * d'entrée au singulier l'omettait : sa commande annonçait une simulation et
   * encodait. Un champ optionnel se perd en silence entre deux couches — c'est
   * la troisième fois de suite dans ce dépôt. Requis, l'oubli devient une
   * erreur de compilation, pas une découverte en production.
   */
  simulation: boolean;
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
    // La variante fabriquée EST la capacité supposée du client : un prélude
    // HEVC pour un client capable, tone-mappé pour les autres.
    { transcodeAvailable: true, capacites: { hevc: !o.pourClientSdr } },
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

  if (o.simulation) return { etat: 'simule', nom };

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

