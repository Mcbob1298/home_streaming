/**
 * Construction de la ligne de commande ffmpeg.
 *
 * Séparée de l'exécution pour être testable : on vérifie que les bons drapeaux
 * sont là, dans le bon ordre, sans lancer un seul processus.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REMUX ≠ TRANSCODAGE
 *
 * 59,3 % de la bibliothèque est déjà en H.264. Pour ces fichiers, seul le
 * conteneur et parfois l'audio posent problème : on COPIE le flux vidéo et on
 * ne réencode que le son. Quelques secondes de calcul par fichier au lieu de
 * plusieurs minutes. Ne jamais réencoder une vidéo déjà compatible.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { INIT_FILE_NAME, SEGMENT_PATTERN } from './segments.js';

export interface RemuxRunOptions {
  /** Chemin EXACT du fichier, tel que readdir l'a rendu. */
  input: string;
  /** Position de départ, en secondes. C'est le début du segment `startNumber`. */
  startTime: number;
  /** Index de playlist du premier segment produit par cette exécution. */
  startNumber: number;
  /** Durée visée des segments de cette exécution : 2 pour l'amorce, 4 ensuite. */
  segmentDuration: number;
  /** Fin de l'exécution, en secondes. Null pour aller jusqu'au bout du fichier. */
  endTime: number | null;
  /** Répertoire de travail de la session. */
  outputDir: string;
  /** Piste audio à retenir. Null pour la piste par défaut du fichier. */
  audioStreamIndex: number | null;
}

/** Débit de l'AAC produit. 192 kb/s en stéréo : transparent à l'oreille. */
export const AUDIO_BITRATE = '192k';

/**
 * Bornes d'analyse du fichier d'entrée.
 *
 * Par défaut ffmpeg lit jusqu'à cinq secondes de contenu avant de se prononcer
 * sur les flux présents. Sur un MKV de 1,3 Go servi par SMB, c'est plusieurs
 * centaines de millisecondes de lecture perdues avant la première image
 * produite : mesuré à 772 ms sans bornes, 256 ms avec.
 *
 * Cinq mégaoctets suffisent très largement à reconnaître les pistes d'un
 * fichier de bibliothèque — assez pour ne pas rater une piste audio tardive.
 */
export const PROBE_SIZE = '5M';
export const ANALYZE_DURATION = '2M';

export function buildRemuxArgs(options: RemuxRunOptions): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  args.push('-probesize', PROBE_SIZE, '-analyzeduration', ANALYZE_DURATION);

  /*
   * `-ss` AVANT `-i` est le déplacement rapide : ffmpeg saute directement dans
   * le fichier au lieu de le décoder depuis le début. Indispensable pour
   * relancer à 40 minutes sans attendre.
   *
   * Conséquence à connaître : en copie de flux, il ne peut pas couper au milieu
   * d'un groupe d'images. Il recule jusqu'à l'image clé précédente, donc la
   * production commence un peu AVANT la position demandée.
   */
  if (options.startTime > 0) args.push('-ss', options.startTime.toFixed(3));

  args.push('-i', options.input);

  // `-t` borne l'exécution d'amorce : elle ne produit que ses trois segments
  // courts, puis rend la main à l'exécution de croisière.
  if (options.endTime !== null) {
    args.push('-t', Math.max(0, options.endTime - options.startTime).toFixed(3));
  }

  args.push('-map', '0:v:0');
  args.push('-map', options.audioStreamIndex === null ? '0:a:0?' : `0:a:${options.audioStreamIndex}?`);

  // Le cœur du remux : la vidéo n'est pas touchée.
  args.push('-c:v', 'copy');

  /*
   * L'audio, lui, est réencodé en AAC — c'est ce que le navigateur sait lire.
   * Le rééchantillonnage asynchrone comble les trous d'une piste dont
   * l'horloge dérive : sans lui, un décalage s'installe sur la durée d'un film.
   */
  args.push('-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '2');
  args.push('-af', 'aresample=async=1:first_pts=0');

  /*
   * Les segments produits doivent porter leur position RÉELLE dans le film,
   * pas une position relative au début de l'exécution. Sans ce décalage, une
   * relance à 40 minutes produirait des segments horodatés à zéro et le
   * lecteur croirait être revenu au début.
   */
  if (options.startTime > 0) args.push('-output_ts_offset', options.startTime.toFixed(3));

  args.push('-f', 'hls');
  args.push('-hls_time', String(options.segmentDuration));
  args.push('-hls_list_size', '0');
  args.push('-hls_segment_type', 'fmp4');
  args.push('-hls_fmp4_init_filename', INIT_FILE_NAME);
  args.push('-hls_segment_filename', `${options.outputDir}/${SEGMENT_PATTERN}`);
  args.push('-start_number', String(options.startNumber));

  /*
   * `temp_file` fait écrire chaque segment sous un nom temporaire, renommé une
   * fois complet. C'est ce qui permet de détecter la disponibilité d'un segment
   * par la simple existence de son fichier, sans jamais en servir un tronqué.
   *
   * `omit_endlist` : le manifeste interne de ffmpeg ne nous sert pas, on
   * publie le nôtre. Autant qu'il ne prétende pas être terminé.
   */
  args.push('-hls_flags', 'independent_segments+temp_file+omit_endlist');

  // Manifeste interne, ignoré : il ne décrit que ce que CETTE exécution produit.
  args.push('-y', `${options.outputDir}/internal.m3u8`);

  return args;
}

/**
 * Découpe une exécution en deux quand elle part du début.
 *
 * Les premiers segments visent deux secondes pour que la lecture démarre vite ;
 * la suite passe à quatre. Une seule exécution ffmpeg ne sait pas changer de
 * durée de segment en cours de route, d'où l'enchaînement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE PIÈGE : le numéro de départ de la seconde exécution.
 *
 * Il ne peut PAS être deviné. Sur un fichier dont les images clés sont espacées
 * de dix secondes, une amorce « de trois segments de deux secondes » n'en
 * produit qu'un seul — et les numéros 1 et 2, jamais produits, resteraient des
 * trous que le lecteur attendrait indéfiniment. Bogue observé, trente secondes
 * d'attente puis une erreur.
 *
 * Les bornes viennent donc du PLAN, qui est calqué sur les images clés réelles :
 * la seconde exécution reprend exactement là où la première s'arrête.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface RunPlan {
  startTime: number;
  startNumber: number;
  segmentDuration: number;
  endTime: number | null;
}

export function planRuns(
  startIndex: number,
  plan: { index: number; start: number; duration: number }[],
  primerCount: number,
  segmentDuration: number,
  primerDuration: number,
): RunPlan[] {
  const first = plan[startIndex];
  if (first === undefined) return [];

  // Départ hors de l'amorce : une seule exécution, en segments de croisière.
  if (startIndex >= primerCount) {
    return [{ startTime: first.start, startNumber: startIndex, segmentDuration, endTime: null }];
  }

  const boundary = plan[primerCount];

  // Fichier plus court que l'amorce : une seule exécution, jusqu'au bout.
  if (boundary === undefined) {
    return [{ startTime: first.start, startNumber: startIndex, segmentDuration: primerDuration, endTime: null }];
  }

  return [
    {
      startTime: first.start,
      startNumber: startIndex,
      segmentDuration: primerDuration,
      endTime: boundary.start,
    },
    { startTime: boundary.start, startNumber: primerCount, segmentDuration, endTime: null },
  ];
}
