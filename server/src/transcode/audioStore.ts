/**
 * Pistes audio PRÉ-GÉNÉRÉES, servies comme des fichiers statiques.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER LE CHEMIN FRAGILE PLUTÔT QUE LE RÉPARER.
 *
 * Un rendu audio est aujourd'hui une session vivante : un ffmpeg qu'on relance à
 * chaque déplacement, à la position visée. C'est ce chemin-là qui casse — mesuré
 * dans le navigateur, le tampon audio finit par ne plus être alimenté du tout, et
 * sur un remux il atterrit deux cents secondes ailleurs.
 *
 * Si les segments existent DÉJÀ, complets, sur le disque durable, il n'y a plus
 * rien à relancer. L'audio devient statique — servi comme les sous-titres — et le
 * déplacement n'est plus qu'une lecture de fichier. Le défaut ne peut plus se
 * produire, faute de mécanisme pour le produire.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Le prix : le volume disque, et une passe d'encodage. C'est ce qui est mesuré
 * avant d'envisager la moindre extension.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { AUDIO_SEGMENT_DURATION, INIT_FILE_NAME, segmentFileName, type PlannedSegment } from './segments.js';
import type { AudioRendition } from './session.js';

/**
 * Version du format.
 *
 * À incrémenter dès qu'un changement rend les pistes déjà produites
 * inutilisables — autre grille, autre downmix, autre débit.
 */
const FORMAT = 1;

export interface AudioManifest {
  format: number;
  signature: string;
  streams: number[];
  segments: number;
  builtAt: string;
  bytes: number;
}

export const MANIFEST_NAME = 'audio.json';

/**
 * L'empreinte de ce qui façonne les octets audio.
 *
 * Volontairement plus étroite que celle du prélude : l'audio ne dépend ni de
 * l'accélération vidéo, ni du tone mapping, ni de la définition. Y mêler ces
 * paramètres invaliderait des pistes parfaitement valables au premier changement
 * d'encodeur vidéo.
 */
export function audioSignature(plan: PlannedSegment[], renditions: AudioRendition[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        format: FORMAT,
        segmentDuration: AUDIO_SEGMENT_DURATION,
        // Les bornes réelles, pas la durée visée : c'est la grille.
        bornes: plan.map((s) => [s.start, s.duration]),
        // Le nombre de canaux décide du downmix appliqué.
        renditions: renditions.map((r) => [r.streamIndex, r.channels]),
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

/** Répertoire des pistes d'un fichier. Même convention d'empreinte que partout. */
export function audioDirOf(root: string, mediaFileId: number, sizeBytes: number, mtimeMs: number): string {
  return path.join(root, `${mediaFileId}-${sizeBytes}-${Math.round(mtimeMs)}`);
}

export function trackDirOf(root: string, mediaFileId: number, sizeBytes: number, mtimeMs: number, streamIndex: number): string {
  return path.join(audioDirOf(root, mediaFileId, sizeBytes, mtimeMs), `a-${streamIndex}`);
}

export function readAudioManifest(dir: string): AudioManifest | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')) as AudioManifest;
  } catch {
    return null;
  }
}

/**
 * Les pistes pré-générées de ce fichier sont-elles utilisables ?
 *
 * Rend le répertoire, ou null. Null n'est pas une erreur : c'est « produis-les à
 * la demande », le comportement d'avant.
 */
export function usableAudio(
  root: string,
  mediaFileId: number,
  sizeBytes: number,
  mtimeMs: number,
  plan: PlannedSegment[],
  renditions: AudioRendition[],
): string | null {
  if (renditions.length === 0) return null;

  const dir = audioDirOf(root, mediaFileId, sizeBytes, mtimeMs);
  const manifest = readAudioManifest(dir);
  if (manifest === null) return null;
  if (manifest.format !== FORMAT) return null;
  if (manifest.signature !== audioSignature(plan, renditions)) return null;

  // Toutes les pistes annoncées doivent être là : servir la moitié d'un jeu
  // ferait retomber l'autre moitié sur la session, donc sur le chemin fragile.
  for (const rendition of renditions) {
    if (!manifest.streams.includes(rendition.streamIndex)) return null;
  }

  return dir;
}

/** Fichier statique d'un segment, ou null s'il n'existe pas. */
export function staticSegment(dir: string, streamIndex: number, index: number): string | null {
  const file = path.join(dir, `a-${streamIndex}`, segmentFileName(index));
  return existsSync(file) ? file : null;
}

/** En-tête statique d'une piste, ou null. */
export function staticInit(dir: string, streamIndex: number): string | null {
  const file = path.join(dir, `a-${streamIndex}`, INIT_FILE_NAME);
  return existsSync(file) ? file : null;
}
