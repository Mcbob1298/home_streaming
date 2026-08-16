/**
 * Le PRÉLUDE : les premières secondes, encodées d'avance et gardées.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI « PRÉLUDE » ET NON « AMORCE ».
 *
 * `PRIMER_COUNT` / `PRIMER_DURATION` désignent déjà autre chose dans ce code :
 * les trois premiers segments RACCOURCIS à deux secondes, produits à la volée
 * pour que la lecture démarre plus tôt. Ils ne sont pas stockés et ne survivent
 * pas à la session.
 *
 * Le prélude est un objet différent : un préfixe temporel ENCODÉ UNE FOIS et
 * conservé sur le disque durable. Réutiliser le mot « amorce » pour les deux
 * aurait garanti qu'on finisse par les confondre dans une relecture.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CE QUI REND LA JONCTION SÛRE : LE PRÉLUDE N'EST PAS UN CAS PARTICULIER.
 *
 * Il n'est pas « joué puis remplacé ». Ses fichiers sont posés dans le
 * répertoire de session AVANT que ffmpeg ne démarre, sous les noms que la
 * session emploie. `ensureSegment` les trouve donc comme il trouverait des
 * segments qu'il vient de produire, et ffmpeg démarre naturellement au premier
 * segment absent.
 *
 * Conséquence directe : la jonction est le même mécanisme que le déplacement,
 * qui fonctionne déjà. Une reprise à 1 h 13 ne « saute » pas le prélude — elle
 * demande un segment qu'il ne contient pas, et rien de spécial ne se produit.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, symlink, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SessionInput, SessionOptions } from './session.js';
import { outputGeometry } from './encode.js';
import { countSegmentsBefore, INIT_FILE_NAME, segmentFileName } from './segments.js';

/**
 * Durée visée, en secondes.
 *
 * Le découpage tombe sur les bornes RÉELLES du plan, jamais sur cette valeur :
 * on prend tous les segments qui commencent avant. La vidéo va donc un peu plus
 * loin (26 s avec la grille 3×2 s puis 4 s) et l'audio s'arrête à 24 s, ses
 * segments faisant huit secondes. Les deux jonctions sont indépendantes, chacune
 * sur sa propre grille — c'est ce que HLS attend.
 */
export const PRELUDE_SECONDS = 24;

/**
 * Version du FORMAT du prélude.
 *
 * À incrémenter dès qu'un changement rend les préludes déjà produits
 * incompatibles — nouvelle grille de segments, autre convention de nommage.
 * Un prélude d'une version antérieure est ignoré, jamais servi.
 */
const PRELUDE_FORMAT = 1;

/** Ce qu'on écrit à côté des fichiers, pour savoir s'ils sont encore valables. */
export interface PreludeManifest {
  format: number;
  signature: string;
  videoSegments: number;
  audioSegments: number;
  streams: number[];
  builtAt: string;
  bytes: number;
}

const MANIFEST_NAME = 'prelude.json';

/**
 * L'empreinte de TOUT ce qui façonne les octets produits.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * C'EST ELLE QUI TIENT LA PROMESSE « EXACTEMENT LES MÊMES PARAMÈTRES ».
 *
 * Un prélude encodé avant un changement de grille, de moteur de tone mapping ou
 * d'accélération produirait une jonction fausse — décrochage audio, image figée.
 * Le vérifier « à l'œil » à chaque modification du code ne tiendra pas : on
 * compare donc une empreinte, et un prélude qui ne correspond plus n'est pas
 * servi. Le pire cas devient « la lecture démarre comme avant », jamais « la
 * lecture saute ».
 *
 * Tout ce qui entre dans la construction des arguments ffmpeg doit figurer ici.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function preludeSignature(input: SessionInput, options: SessionOptions): string {
  const videoSegments = countSegmentsBefore(input.plan, PRELUDE_SECONDS);
  const audioSegments = countSegmentsBefore(input.audioPlan, PRELUDE_SECONDS);

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * LE DÉBIT ET LES DIMENSIONS FIGURENT ICI, ET ILS Y MANQUAIENT.
   *
   * L'empreinte promet de couvrir « tout ce qui entre dans la construction des
   * arguments ffmpeg ». Elle portait la grille, le mode, l'accélération et le
   * tone mapping — mais pas `-b:v`, qui décide pourtant du poids de chaque
   * octet produit. Faire passer le transport HDR de 20 à 12 Mbps changeait donc
   * la totalité des segments SANS que le garde-fou ne s'en aperçoive : la
   * lecture aurait servi vingt-six secondes à 20 Mbps puis basculé à 12.
   *
   * Une clé ajoutée invalide les préludes existants — c'est le prix, et il est
   * d'une régénération. Le taire pour les préserver reviendrait à garder un
   * garde-fou qui ne garde pas ce qu'il annonce ; c'est exactement le genre de
   * demi-vérité que ce dépôt paie ensuite au décuple.
   *
   * `outputGeometry` est la même autorité que celle de l'encodeur et du
   * manifeste : l'empreinte ne recalcule rien, elle interroge.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const sortie = outputGeometry({
    sourceWidth: input.source?.width ?? null,
    sourceHeight: input.source?.height ?? null,
    hardware: options.hardware,
    mode: input.mode,
    hdrPassthrough: input.hdrPassthrough === true,
  });

  const matiere = JSON.stringify({
    format: PRELUDE_FORMAT,
    mode: input.mode,
    ...(input.hdrPassthrough === true ? { hdrPassthrough: true } : {}),
    // Les bornes RÉELLES du préfixe, pas la durée visée : c'est la grille.
    video: input.plan.slice(0, videoSegments).map((s) => [s.start, s.duration]),
    audio: input.audioPlan.slice(0, audioSegments).map((s) => [s.start, s.duration]),
    muxedAudio: input.muxedAudio,
    renditions: input.audioRenditions.map((r) => [r.streamIndex, r.channels]),
    source: input.source ?? null,
    hardware: options.hardware,
    toneMap: options.toneMap,
    sortie: [sortie.width, sortie.height, sortie.bitrate],
  });

  return createHash('sha256').update(matiere).digest('hex').slice(0, 32);
}

/**
 * Répertoire d'un prélude.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * L'EMPREINTE DU FICHIER EST DANS LE NOM, comme pour le cache de sous-titres et
 * l'index des images clés. Un fichier réencodé sur place change de taille ou de
 * date, son prélude devient inatteignable, et aucune purge n'a à être écrite.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function preludeDirOf(root: string, mediaFileId: number, sizeBytes: number, mtimeMs: number): string {
  return path.join(root, `${mediaFileId}-${sizeBytes}-${Math.round(mtimeMs)}`);
}

export function readManifest(dir: string): PreludeManifest | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')) as PreludeManifest;
  } catch {
    return null;
  }
}

/**
 * Le prélude de ce fichier est-il utilisable POUR CETTE SESSION ?
 *
 * Rend le répertoire, ou null. Null n'est pas une erreur : c'est « démarre comme
 * avant », le comportement d'hier.
 */
export function usablePrelude(
  root: string,
  input: SessionInput,
  options: SessionOptions,
  sizeBytes: number,
  mtimeMs: number,
): string | null {
  const dir = preludeDirOf(root, input.mediaFileId, sizeBytes, mtimeMs);
  const manifest = readManifest(dir);
  if (manifest === null) return null;
  if (manifest.format !== PRELUDE_FORMAT) return null;
  if (manifest.signature !== preludeSignature(input, options)) return null;

  return dir;
}

// ---------------------------------------------------------------------------
// Poser le prélude dans une session
// ---------------------------------------------------------------------------

/**
 * Pose les fichiers d'un prélude dans un répertoire de sortie.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DES LIENS SYMBOLIQUES, PAS DES COPIES.
 *
 * Le répertoire de session vit en tmpfs — donc en MÉMOIRE, plafonné à 1 Go.
 * Y recopier vingt-quatre mégaoctets à chaque ouverture de lecture les
 * prendrait sur la mémoire du NAS pour rien. Les liens durs sont exclus : le
 * prélude est sur /volume1, la session en tmpfs, et un lien dur ne traverse pas
 * deux systèmes de fichiers.
 *
 * Effacer la session efface les LIENS, jamais leurs cibles — `rm -r` ne suit pas
 * un lien symbolique. Le prélude ne peut donc pas être détruit par la fin d'une
 * lecture.
 *
 * Repli en copie si le lien échoue : mieux vaut vingt mégaoctets de tmpfs qu'un
 * démarrage lent.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * MAIS L'EN-TÊTE EST COPIÉ, JAMAIS LIÉ. CE N'EST PAS UN DÉTAIL.
 *
 * ffmpeg écrit `init.mp4` DIRECTEMENT, sans passer par un fichier temporaire —
 * c'est écrit noir sur blanc dans `session.ts`, à propos d'un autre piège. Un
 * lien symbolique à ce nom fait donc écrire l'exécution suivante DANS LE
 * PRÉLUDE : elle y dépose l'en-tête de sa propre position.
 *
 * Constaté, et c'est ce qui cassait la jonction : après la première lecture,
 * l'en-tête du prélude annonçait 103,978 s pour des segments à 0 s. Les
 * segments, eux, étaient intacts — lus avec l'en-tête d'origine ils donnaient
 * 0, 8, 16 s. Le prélude se détruisait lui-même à la première utilisation, et
 * toutes les lectures suivantes trouvaient un en-tête qui ne correspondait à
 * rien.
 *
 * Les SEGMENTS peuvent rester des liens : ffmpeg les écrit sous un nom
 * temporaire puis les renomme (`temp_file`), et un renommage REMPLACE le lien
 * sans toucher sa cible.
 * ═════════════════════════════════════════════════════════════════════════════
 */
const ECRITS_DIRECTEMENT = new Set([INIT_FILE_NAME, 'init-stable.mp4']);

export async function seedFromPrelude(preludeDir: string, outputDir: string): Promise<number> {
  let noms: string[];
  try {
    noms = await readdir(preludeDir);
  } catch {
    return 0;
  }

  let poses = 0;
  for (const nom of noms) {
    if (!nom.endsWith('.m4s') && !ECRITS_DIRECTEMENT.has(nom)) continue;

    const source = path.join(preludeDir, nom);
    const cible = path.join(outputDir, nom);
    if (existsSync(cible)) continue;

    try {
      if (ECRITS_DIRECTEMENT.has(nom)) await copyFile(source, cible);
      else await symlink(source, cible);
      poses += 1;
    } catch {
      try {
        await copyFile(source, cible);
        poses += 1;
      } catch {
        // Un segment non posé sera simplement produit par ffmpeg.
      }
    }
  }

  return poses;
}

// ---------------------------------------------------------------------------
// Fabriquer un prélude
// ---------------------------------------------------------------------------

export interface PreludePlan {
  videoSegments: number;
  audioSegments: number;
  streams: number[];
  videoEnd: number;
  audioEnd: number;
}

/** Ce que le prélude doit couvrir, déduit des plans réels. */
export function planPrelude(input: SessionInput): PreludePlan {
  const videoSegments = countSegmentsBefore(input.plan, PRELUDE_SECONDS);
  const audioSegments = countSegmentsBefore(input.audioPlan, PRELUDE_SECONDS);

  const dernierV = input.plan[videoSegments - 1];
  const dernierA = input.audioPlan[audioSegments - 1];

  return {
    videoSegments,
    audioSegments,
    streams: input.audioRenditions.map((r) => r.streamIndex),
    videoEnd: dernierV === undefined ? 0 : Number((dernierV.start + dernierV.duration).toFixed(3)),
    audioEnd: dernierA === undefined ? 0 : Number((dernierA.start + dernierA.duration).toFixed(3)),
  };
}

/** Taille d'un répertoire, en octets. */
export async function dirBytes(dir: string): Promise<number> {
  const { stat } = await import('node:fs/promises');
  let total = 0;
  try {
    for (const nom of await readdir(dir, { withFileTypes: true })) {
      const complet = path.join(dir, nom.name);
      total += nom.isDirectory() ? await dirBytes(complet) : (await stat(complet)).size;
    }
  } catch {
    // Répertoire absent : zéro.
  }
  return total;
}

/**
 * Écrit le manifeste et publie le prélude de façon ATOMIQUE.
 *
 * La construction se fait dans un répertoire de travail, renommé seulement une
 * fois complet : un prélude à moitié encodé — serveur arrêté en cours de route —
 * ne doit jamais être trouvé par une lecture, il produirait une jonction au
 * milieu de nulle part.
 */
export async function publishPrelude(
  staging: string,
  finalDir: string,
  manifest: Omit<PreludeManifest, 'bytes' | 'builtAt'>,
): Promise<PreludeManifest> {
  const complet: PreludeManifest = {
    ...manifest,
    bytes: await dirBytes(staging),
    builtAt: new Date().toISOString(),
  };

  await writeFile(path.join(staging, MANIFEST_NAME), JSON.stringify(complet, null, 2), 'utf8');
  await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(path.dirname(finalDir), { recursive: true });
  await rename(staging, finalDir);

  return complet;
}

/** Les segments attendus d'une sortie, pour vérifier qu'un prélude est complet. */
export function expectedFiles(count: number): string[] {
  const noms = [INIT_FILE_NAME];
  for (let i = 0; i < count; i += 1) noms.push(segmentFileName(i));
  return noms;
}
