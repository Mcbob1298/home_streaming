/**
 * Découpage HLS : le plan des segments et le manifeste.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE PLAN EST CONNU D'AVANCE, ET C'EST CE QUI REND LE DÉPLACEMENT POSSIBLE.
 *
 * Un manifeste qui grandit au fur et à mesure de la production interdit au
 * lecteur de viser une position pas encore produite : il ne connaît pas les
 * segments qui n'existent pas. On publie donc dès la première requête un
 * manifeste VOD COMPLET, déduit de la durée du fichier — déjà en base depuis la
 * passe ffprobe.
 *
 * Le lecteur peut alors demander n'importe quel segment. Si celui-ci n'est pas
 * encore produit, c'est au serveur de relancer ffmpeg à la position voulue.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Segments courts en tête, pour que la lecture démarre vite. */
export const PRIMER_COUNT = 3;
export const PRIMER_DURATION = 2;

/** Durée de croisière. Quatre secondes : le compromis habituel. */
export const SEGMENT_DURATION = 4;

/** Fin de l'amorce courte, en secondes. */
export const PRIMER_END = PRIMER_COUNT * PRIMER_DURATION;

export interface PlannedSegment {
  index: number;
  start: number;
  duration: number;
}

/**
 * Découpe une durée en segments : trois de deux secondes, puis quatre.
 *
 * Le dernier segment est tronqué à la durée réelle. Un fichier plus court que
 * l'amorce n'en produit que ce qu'il faut.
 */
export function planSegments(durationSeconds: number): PlannedSegment[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];

  const segments: PlannedSegment[] = [];
  let start = 0;

  while (start < durationSeconds - 0.001) {
    const target = segments.length < PRIMER_COUNT ? PRIMER_DURATION : SEGMENT_DURATION;
    const duration = Math.min(target, durationSeconds - start);
    segments.push({ index: segments.length, start: round(start), duration: round(duration) });
    start += target;
  }

  return segments;
}

/** Trois décimales : la précision d'un EXTINF, sans bruit de virgule flottante. */
function round(value: number): number {
  return Number(value.toFixed(3));
}

// ---------------------------------------------------------------------------
// Segments audio : une autre horloge que la vidéo
// ---------------------------------------------------------------------------

/**
 * Fréquence d'échantillonnage IMPOSÉE à la sortie audio.
 *
 * Forcée et non héritée : c'est elle qui rend le découpage calculable. Une
 * source en 44,1 kHz produirait des trames de durée différente, donc des bornes
 * de segment qu'on ne saurait plus prédire sans lire le fichier.
 */
export const AUDIO_SAMPLE_RATE = 48_000;

/** Une trame AAC-LC fait 1024 échantillons. Ce n'est pas un réglage. */
export const AAC_FRAME_SAMPLES = 1024;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * HUIT SECONDES, ET PAS QUATRE. LA RAISON TIENT À UNE DIVISION.
 *
 * Le muxer HLS ouvre un segment audio à la première TRAME dont l'horodatage
 * atteint « k × hls_time ». Une trame dure 1024/48000 s, soit 21,33 ms, et
 * quatre secondes n'en font pas un compte rond : 187,5. Mesuré sur ffmpeg 9,
 * un découpage à 4 s produit donc des segments qui alternent 4,010667 s et
 * 3,989333 s.
 *
 * Ce n'est pas gênant tant qu'on lit d'une traite — mais la quantification
 * n'est PAS additive : quantifier(4) + quantifier(4) = 8,021 alors que
 * quantifier(8) = 8,000. Après un déplacement, ffmpeg repart d'une horloge
 * neuve et les bornes réelles s'écartent du manifeste d'une trame par segment,
 * qui s'accumule.
 *
 * Huit secondes font exactement 375 trames. Le découpage est alors exact, et
 * surtout ADDITIF : reprendre à n'importe quelle borne redonne la même grille.
 * Vérifié sur ffmpeg 9 — 8.000000 partout, y compris après reprise à 16 s.
 *
 * Le coût est nul : un segment audio de 8 s pèse 190 ko et se produit en
 * quelques dizaines de millisecondes. Le démarrage reste tenu par la vidéo.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const AUDIO_SEGMENT_DURATION = 8;

/** En deçà, la queue est absorbée par le segment précédent plutôt que déclarée. */
const AUDIO_TAIL_MINIMUM = 1;

/**
 * Découpe audio, calquée sur ce que ffmpeg produit réellement.
 *
 * Sous-déclarer est SANS DANGER — un segment produit en trop est simplement
 * ignoré —, alors que sur-déclarer fait attendre le lecteur sur un fichier qui
 * n'arrivera jamais. D'où l'absorption de la queue : l'encodeur AAC ajoute
 * toujours quelques trames de bourrage, et déclarer un segment de 21 ms pour
 * elles n'apporterait rien.
 */
export function planAudioSegments(durationSeconds: number): PlannedSegment[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];

  const segments: PlannedSegment[] = [];
  for (let start = 0; start < durationSeconds - 0.001; start += AUDIO_SEGMENT_DURATION) {
    const duration = Math.min(AUDIO_SEGMENT_DURATION, durationSeconds - start);
    segments.push({ index: segments.length, start: round(start), duration: round(duration) });
  }

  const last = segments.at(-1);
  if (segments.length > 1 && last !== undefined && last.duration < AUDIO_TAIL_MINIMUM) {
    segments.pop();
    const previous = segments.at(-1) as PlannedSegment;
    previous.duration = round(previous.duration + last.duration);
  }

  return segments;
}

/** Segment contenant une position donnée. Borné aux extrémités du plan. */
export function segmentIndexAt(plan: PlannedSegment[], time: number): number {
  if (plan.length === 0) return 0;
  if (time <= 0) return 0;

  // Recherche dichotomique : un film de trois heures fait 2700 segments, et
  // cette fonction est appelée à chaque requête de segment.
  let low = 0;
  let high = plan.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if ((plan[middle] as PlannedSegment).start <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

export interface PlaylistUrls {
  /** URL du segment d'initialisation fMP4, commun à tous les segments. */
  init: string;
  segment: (index: number) => string;
}

/**
 * Manifeste de média, en VOD complet.
 *
 * Version 7 : c'est le minimum pour `EXT-X-MAP`, donc pour les segments fMP4.
 * `EXT-X-INDEPENDENT-SEGMENTS` dit au lecteur que chaque segment commence par
 * une image clé et peut donc être décodé seul — ce qui est vrai puisque le
 * découpage suit les images clés de la source.
 */
export function buildPlaylist(plan: PlannedSegment[], urls: PlaylistUrls): string {
  const target = Math.ceil(plan.reduce((maximum, segment) => Math.max(maximum, segment.duration), 0));

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.max(1, target)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${urls.init}"`,
  ];

  for (const segment of plan) {
    lines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
    lines.push(urls.segment(segment.index));
  }

  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/**
 * Découpe calquée sur les images clés RÉELLES du fichier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CETTE FONCTION REPRODUIT EXACTEMENT LA RÈGLE DE FFMPEG.
 *
 * Le muxer HLS ouvre un nouveau segment à la première image clé dont
 * l'horodatage atteint « début du segment courant + hls_time ». Si notre plan
 * suivait une autre règle, le manifeste décrirait une découpe que ffmpeg ne
 * produirait pas : segments manquants, ou contenu décalé.
 *
 * Toute modification ici doit être vérifiée contre la sortie réelle de ffmpeg.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `primerCount` premiers segments visent `primerTarget`, les suivants `target`.
 * Ce sont des MINIMUMS : sur un fichier dont les images clés sont espacées de
 * dix secondes, un segment « de deux secondes » en fera dix. C'est la source
 * qui décide, et le manifeste doit dire la vérité.
 */
export function planFromKeyframes(
  keyframes: number[],
  durationSeconds: number,
  options: { target?: number; primerCount?: number; primerTarget?: number } = {},
): PlannedSegment[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  if (keyframes.length === 0) return [];

  const target = options.target ?? SEGMENT_DURATION;
  const primerCount = options.primerCount ?? 0;
  const primerTarget = options.primerTarget ?? PRIMER_DURATION;

  const starts: number[] = [keyframes[0] as number];

  for (const time of keyframes) {
    const currentStart = starts.at(-1) as number;
    const minimum = starts.length <= primerCount ? primerTarget : target;
    if (time - currentStart >= minimum) starts.push(time);
  }

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? durationSeconds;
    return { index, start: round(start), duration: round(Math.max(0, end - start)) };
  });
}

/**
 * Nombre de segments produits par une exécution bornée dans le temps.
 *
 * Sert à enchaîner l'amorce et la croisière avec le bon `-start_number` : le
 * numéro du premier segment de la seconde exécution est le nombre de segments
 * que la première aura réellement produits, pas une constante devinée.
 */
export function countSegmentsBefore(plan: PlannedSegment[], endTime: number): number {
  return plan.filter((segment) => segment.start < endTime - 0.001).length;
}

/** Nom de fichier d'un segment. Le zéro initial garde l'ordre alphabétique. */
export function segmentFileName(index: number): string {
  return `seg-${String(index).padStart(5, '0')}.m4s`;
}

/** Motif que ffmpeg remplit lui-même, avec la même convention de nommage. */
export const SEGMENT_PATTERN = 'seg-%05d.m4s';
export const INIT_FILE_NAME = 'init.mp4';

/**
 * Manifeste de sous-titres : UN seul segment couvrant tout le film.
 *
 * Un WebVTT complet pèse quelques dizaines de kilo-octets — le découper en
 * tranches de huit secondes produirait neuf cents fichiers pour rien, et
 * obligerait à recalculer les horodatages de chaque tranche. Un segment unique
 * est parfaitement légal en HLS, et c'est ce que font les diffuseurs.
 *
 * Pas d'`EXT-X-MAP` ici : le WebVTT n'est pas du fMP4, il n'a pas d'en-tête
 * séparé.
 */
export function buildSubtitlePlaylist(durationSeconds: number, url: string): string {
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;

  return (
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(duration))}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXTINF:${duration.toFixed(6)},`,
      url,
      '#EXT-X-ENDLIST',
    ].join('\n') + '\n'
  );
}
