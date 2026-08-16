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

/**
 * Durée d'un segment vidéo. Quatre secondes : le compromis habituel.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * L'AMORCE COURTE EST DE RETOUR, PARCE QUE SA CAUSE D'ÉCHEC A DISPARU.
 *
 * Trois segments de deux secondes ouvrent la lecture, puis on passe à quatre.
 * Une seule exécution ffmpeg ne sachant pas changer de durée en cours de route,
 * il en faut DEUX — et c'est là que tout se jouait autrefois : la seconde
 * portait `-output_ts_offset`, donc écrivait un en-tête fMP4 différent de la
 * première. Mesuré à l'époque sur les deux `init.mp4` : deux octets d'écart,
 * 6000 contre 41, soit exactement la longueur de l'amorce en millisecondes. Le
 * lecteur ne recevant qu'UN en-tête, les segments de la seconde exécution
 * étaient lus avec le mauvais — six segments donnaient 432 images, dix-huit
 * secondes de contenu sur une ligne de temps de douze.
 *
 * L'amorce avait donc été retirée. Mais elle n'était pas la cause : elle en
 * était le RÉVÉLATEUR. `-output_ts_offset` l'a été, et il a été supprimé depuis
 * pour une raison sans rapport — il cassait aussi les déplacements.
 *
 * Vérifié avant de la remettre, avec le ffmpeg de production sur Avatar, trois
 * exécutions comparées octet à octet :
 *
 *     -hls_time 2 depuis 0 s   86741ce4d59f9cdf443281c02268bc19   1151 o
 *     -hls_time 4 depuis 6 s   86741ce4d59f9cdf443281c02268bc19   1151 o
 *     -hls_time 4 depuis 0 s   86741ce4d59f9cdf443281c02268bc19   1151 o
 *
 * Ni la durée de segment ni la position de départ n'entrent dans l'en-tête. La
 * divergence est structurellement impossible aujourd'hui, et `init-stable.mp4`
 * fige de toute façon le premier produit.
 *
 * CE QU'ELLE APPORTE, ET POURQUOI LE PRÉLUDE NE SUFFISAIT PAS. Le prélude sert
 * de vrais fichiers déjà encodés, donc rien à produire — mais il faut encore les
 * TRANSPORTER. Sur la liaison de référence (~70 Mb/s), un premier segment 4K de
 * quatre secondes pèse 7 Mo et coûte 870 ms avant la première image. La moitié
 * de la durée, c'est la moitié des octets.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export const SEGMENT_DURATION = 4;

/**
 * L'AMORCE : combien de segments courts, et de quelle durée.
 *
 * Trois fois deux secondes. Le compte n'est pas arbitraire : il faut couvrir le
 * temps que met la croisière à produire son premier segment, sans quoi la
 * lecture rattrape l'amorce et attend quand même.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA FRONTIÈRE N'A PAS À TOMBER SUR LA GRILLE DE CROISIÈRE, ET C'EST VOULU.
 *
 * Six secondes n'est pas un multiple de quatre. La croisière ne reprend donc pas
 * une grille 0-4-8 : elle démarre À la frontière et compte à partir de là —
 * 6-10, 10-14, 14-18. Il n'y a pas deux grilles à faire coïncider, il y en a
 * UNE, celle que `planSegments` écrit et que le manifeste publie ; les bornes
 * réelles sont donc justes par construction.
 *
 * Ce qui compte vraiment, et que le test vérifie : l'amorce se divise en
 * segments entiers (6 = 3 × 2), et la frontière est une borne du plan.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const PRIMER_COUNT = 3;
export const PRIMER_DURATION = 2;

/** Fin de l'amorce, en secondes. La frontière entre l'amorce et la croisière. */
export const PRIMER_END = PRIMER_COUNT * PRIMER_DURATION;

export interface PlannedSegment {
  index: number;
  start: number;
  duration: number;
}

/**
 * Découpe une durée : l'amorce courte, puis la croisière.
 *
 * Le dernier segment est tronqué à la durée réelle. Un fichier plus court que
 * l'amorce n'obtient que des segments courts, ce qui est le comportement voulu :
 * il n'y a alors rien à quoi rendre la main.
 */
export function planSegments(durationSeconds: number): PlannedSegment[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];

  const segments: PlannedSegment[] = [];
  let start = 0;

  while (start < durationSeconds - 0.001) {
    const pas = segments.length < PRIMER_COUNT ? PRIMER_DURATION : SEGMENT_DURATION;
    const duration = Math.min(pas, durationSeconds - start);
    segments.push({ index: segments.length, start: round(start), duration: round(duration) });
    start += pas;
  }

  return segments;
}

/**
 * Combien de segments de tête forment l'AMORCE dans ce plan — 0 s'il n'y en a pas.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI UN TEST EXACT, ET SURTOUT PAS « LE PREMIER EST PLUS COURT ».
 *
 * `planRuns` a d'abord déduit ses exécutions en regroupant les segments de même
 * durée. Élégant, et faux : le REMUX ne passe pas par `planSegments` mais par
 * l'énumération des images clés, dont les durées sont IRRÉGULIÈRES. Un fichier
 * dont le premier segment tombe à 3,8 s aurait alors été découpé en deux
 * exécutions, la première avec `-hls_time 3.8` — un découpage que personne n'a
 * demandé, sur le chemin où la vidéo est copiée et où ffmpeg ne peut couper
 * qu'aux images clés existantes.
 *
 * Le fichier qui a servi de témoin ne l'a pas montré : ses images clés tombent
 * exactement toutes les quatre secondes, donc rien ne se déclenchait. Le défaut
 * n'attendait qu'un encodage à GOP variable.
 *
 * On compte donc les segments de tête dont la durée vaut EXACTEMENT
 * `PRIMER_DURATION`, au plus `PRIMER_COUNT`. Un plan irrégulier rend zéro dès
 * son premier segment et garde son exécution unique.
 *
 * Le compte peut être inférieur à `PRIMER_COUNT` — un fichier de cinq secondes
 * donne 0-2, 2-4, 4-5, donc deux segments d'amorce et une queue tronquée. C'est
 * `planRuns` qui en tire les exécutions ; ici on ne fait que lire la grille.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function primerSegments(plan: PlannedSegment[]): number {
  let n = 0;
  while (n < PRIMER_COUNT && plan[n]?.duration === PRIMER_DURATION) n += 1;
  return n;
}

/**
 * Le premier segment que le répertoire NE porte PAS, en partant de zéro.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * C'EST LE DISQUE QUI DÉCIDE, PAS UNE CONSTANTE NI LE PLAN ATTENDU.
 *
 * Sert à démarrer la croisière là où le prélude s'arrête, au lieu de réencoder
 * ce qu'il vient de poser — seize secondes de moteur par démarrage sur Avatar.
 *
 * Le prélude annonce huit segments dans son manifeste, et le plan en attend huit
 * avant vingt-six secondes. Se fier à l'un des deux serait un pari : un prélude
 * partiellement effacé, une grille changée sans régénération, une publication
 * interrompue, et la croisière démarrerait APRÈS un segment absent — un trou que
 * rien ne comblerait, puisque personne ne le réclamerait avant la lecture.
 *
 * On s'arrête donc au premier manquant. Le pire cas devient « quelques segments
 * déjà présents sont réencodés », c'est-à-dire le comportement d'avant. Jamais
 * « il manque un segment au milieu ».
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function premierSegmentAbsent(
  dir: string,
  total: number,
  existe: (chemin: string) => boolean,
): number {
  for (let index = 0; index < total; index += 1) {
    if (!existe(`${dir}/${segmentFileName(index)}`)) return index;
  }
  return total;
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
 * `target` est un MINIMUM : sur un fichier dont les images clés sont espacées de
 * dix secondes, un segment « de quatre secondes » en fera dix. C'est la source
 * qui décide, et le manifeste doit dire la vérité.
 */
export function planFromKeyframes(
  keyframes: number[],
  durationSeconds: number,
  options: { target?: number } = {},
): PlannedSegment[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  if (keyframes.length === 0) return [];

  const target = options.target ?? SEGMENT_DURATION;

  const starts: number[] = [keyframes[0] as number];

  for (const time of keyframes) {
    const currentStart = starts.at(-1) as number;
    if (time - currentStart >= target) starts.push(time);
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
