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
import { bridageArgs } from './debit.js';
import { AUDIO_SAMPLE_RATE, INIT_FILE_NAME, SEGMENT_PATTERN, primerSegments } from './segments.js';

/**
 * Quelle piste audio cette exécution produit, et avec combien de canaux.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * L'INDEX EST ABSOLU, PAS RELATIF AU TYPE.
 *
 * `audio_track.stream_index` porte l'index du flux dans le FICHIER, tel que
 * ffprobe le rend : sur le fichier #365, les pistes audio sont les flux 1 à 6,
 * la vidéo étant le flux 0. Les traduire en `0:a:N` supposerait que les flux
 * audio soient contigus et commencent à zéro — vrai la plupart du temps, faux
 * sur un fichier qui intercale un flux de données. On utilise donc `-map 0:N`.
 *
 * `channels` accompagne le choix parce que c'est LUI qui décide de la matrice
 * de downmix : elle doit suivre la piste retenue, pas la première du fichier.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type AudioChoice =
  /** Aucune piste : la sortie ne porte que la vidéo. */
  | { kind: 'none' }
  /** La première piste du fichier, quelle qu'elle soit. */
  | { kind: 'auto'; channels: number | null }
  /** Une piste désignée par son index absolu. */
  | { kind: 'stream'; streamIndex: number; channels: number | null };

/** Nombre de canaux de la piste retenue, pour choisir la matrice de downmix. */
export function channelsOf(choice: AudioChoice): number | null {
  return choice.kind === 'none' ? null : choice.channels;
}

/** Les drapeaux `-map` correspondant à un choix de piste audio. */
export function audioMapArgs(choice: AudioChoice): string[] {
  switch (choice.kind) {
    case 'none':
      return ['-an'];
    case 'auto':
      // Le « ? » rend la sélection facultative : un fichier muet ne fait pas
      // échouer l'exécution entière.
      return ['-map', '0:a:0?'];
    case 'stream':
      return ['-map', `0:${choice.streamIndex}`];
  }
}

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
  /** Piste audio produite avec la vidéo, ou aucune. */
  audio: AudioChoice;
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

/**
 * Matrice de downmix 5.1 et 7.1 vers stéréo.
 *
 * Le downmix par défaut de ffmpeg applique des coefficients qui enterrent le
 * canal central — donc les dialogues — sous les canaux musique et effets. La
 * voix remonte ici à 0,8 quand les surrounds descendent à 0,5.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IL S'APPLIQUE À TOUTES LES PISTES, PAS SEULEMENT À LA PREMIÈRE.
 *
 * Le nombre de canaux vient du choix de piste (`AudioChoice.channels`), et non
 * plus d'une propriété du fichier. Sur le fichier #365, dont les six pistes
 * sont en 5.1, chacune reçoit donc sa matrice quand elle est produite — y
 * compris celles qu'on ne découvre qu'au moment où l'utilisateur les demande.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Les coefficients sont normalisés pour éviter la saturation : leur somme par
 * canal de sortie reste sous 1 après le gain de normalisation de ffmpeg.
 */
export function downmixFilter(channels: number | null): string {
  // Mono et stéréo n'ont rien à mélanger.
  if (channels === null || channels <= 2) return 'aresample=async=1:first_pts=0';

  if (channels >= 7) {
    return (
      'pan=stereo|' +
      'FL=0.5*FL+0.8*FC+0.3*LFE+0.4*BL+0.4*SL|' +
      'FR=0.5*FR+0.8*FC+0.3*LFE+0.4*BR+0.4*SR,' +
      'aresample=async=1:first_pts=0'
    );
  }

  // 5.1 : le cas le plus fréquent de la bibliothèque — 3 152 pistes sur 5 298.
  return (
    'pan=stereo|' +
    'FL=0.5*FL+0.8*FC+0.3*LFE+0.5*BL|' +
    'FR=0.5*FR+0.8*FC+0.3*LFE+0.5*BR,' +
    'aresample=async=1:first_pts=0'
  );
}

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

  /*
   * Le bridage vient JUSTE AVANT `-i` : c'est une option d'entrée.
   *
   * Sans lui, la copie de flux court à 49× le temps réel et remplit le tmpfs
   * d'un gigaoctet en quelques secondes. Voir `debit.ts` pour les chiffres.
   */
  args.push(...bridageArgs());

  args.push('-i', options.input);

  // `-t` borne l'exécution d'amorce : elle ne produit que ses trois segments
  // courts, puis rend la main à l'exécution de croisière.
  if (options.endTime !== null) {
    args.push('-t', Math.max(0, options.endTime - options.startTime).toFixed(3));
  }

  /*
   * SÉLECTION EXPLICITE DES FLUX.
   *
   * Le fichier #365 en contient 27 : une vidéo, six audio, seize sous-titres,
   * deux polices TrueType attachées et deux images de couverture. Sans cette
   * sélection, ffmpeg essaie d'en faire quelque chose — il échoue sur les
   * polices, et prend les couvertures MJPEG pour des flux vidéo.
   */
  args.push('-map', '0:v:0');
  args.push(...audioMapArgs(options.audio));
  args.push('-sn', '-dn', '-map_chapters', '-1');

  // Le cœur du remux : la vidéo n'est pas touchée.
  args.push('-c:v', 'copy');

  if (options.audio.kind !== 'none') {
    /*
     * L'audio, lui, est réencodé en AAC — c'est ce que le navigateur sait lire.
     * La fréquence est IMPOSÉE : c'est elle qui rend la découpe des segments
     * audio calculable, et donc le manifeste exact.
     */
    args.push('-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '2', '-ar', String(AUDIO_SAMPLE_RATE));
    args.push('-af', downmixFilter(channelsOf(options.audio)));
  }

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * PAS DE `-output_ts_offset` ICI, ET C'EST LA CORRECTION D'UN DÉFAUT MAJEUR.
   *
   * L'intention était juste : un segment produit par une relance à 40 minutes
   * doit se présenter à 40 minutes, pas à zéro. Mais ffmpeg n'applique PAS ce
   * décalage aux fragments. Il ramène leurs horodatages à zéro et inscrit le
   * décalage dans l'`elst` — l'edit list de l'EN-TÊTE. Mesuré sur une relance
   * au segment 600 :
   *
   *     elst du run initial        : edit vide de       41 ms
   *     elst du run relancé à 2400 : edit vide de 2 400 000 ms
   *     tfdt du segment 600 produit par la relance : 0
   *
   * Or hls.js ne recharge jamais `EXT-X-MAP` : il garde l'en-tête chargé au
   * démarrage. Le segment 600 était donc présenté à 0,041 s au lieu de 2400 s
   * — une erreur ÉGALE À LA DISTANCE DU SAUT. C'est le « saut qui atterrit
   * 1200 s ailleurs ».
   *
   * Aucun argument ne change ce comportement : `-copyts` provoque un
   * segmentation fault avec la chaîne VAAPI, et `-avoid_negative_ts disabled`,
   * `-muxdelay 0`, `-movflags +negative_cts_offsets` laissent tous le décalage
   * dans l'edit list.
   *
   * Sans l'argument, en revanche, TOUS les runs écrivent le même en-tête au bit
   * près — vérifié aux positions 0, 600, 2400, 5000 et 9000 s. Celui que le
   * lecteur détient reste donc valable pour toujours, et c'est hls.js qui place
   * chaque fragment via `timestampOffset`, déduit du manifeste. Ce qu'il sait
   * faire, et ce que la présence d'un décalage l'empêchait de faire proprement.
   * ═══════════════════════════════════════════════════════════════════════════
   */

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

// ---------------------------------------------------------------------------
// Rendu audio séparé
// ---------------------------------------------------------------------------

export interface AudioRunOptions {
  input: string;
  startTime: number;
  startNumber: number;
  endTime: number | null;
  outputDir: string;
  /** Index ABSOLU du flux à produire, et son nombre de canaux. */
  streamIndex: number;
  channels: number | null;
  /** Durée de segment. Huit secondes, pour tomber sur une trame AAC entière. */
  segmentDuration: number;
}

/**
 * Exécution d'un rendu audio seul.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UN PROCESSUS PAR PISTE ÉCOUTÉE, PAS UN PAR PISTE EXISTANTE.
 *
 * Le fichier #365 porte six pistes audio. Les produire toutes en continu
 * remplirait le tmpfs d'un gigaoctet — 172 Mo par piste pour un film de deux
 * heures — pour cinq pistes que personne n'écoute. Le rendu n'est donc lancé
 * qu'à la première demande de segment de la piste choisie, exactement comme la
 * vidéo.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * La vidéo n'est PAS produite ici : `-vn`. Les images de couverture MJPEG du
 * fichier #365 seraient sinon prises pour un flux vidéo à réencoder.
 */
/**
 * Les arguments d'UNE sortie audio, sans l'entrée.
 *
 * Extrait pour que la sortie unique et la sortie multiple partagent exactement
 * la même construction : downmix, débit, fréquence forcée, grille. Deux listes
 * écrites séparément finiraient par diverger, et la divergence ne se verrait
 * qu'à l'oreille.
 */
function sortieAudio(options: Omit<AudioRunOptions, 'input'>): string[] {
  const args: string[] = [];

  // Une seule piste, désignée par son index absolu. Rien d'autre ne sort.
  args.push('-map', `0:${options.streamIndex}`);
  args.push('-vn', '-sn', '-dn', '-map_chapters', '-1');

  args.push('-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '2', '-ar', String(AUDIO_SAMPLE_RATE));
  args.push('-af', downmixFilter(options.channels));

  // Pas de `-output_ts_offset` : voir l'explication en tête de ce fichier. Le
  // décalage atterrirait dans l'edit list de l'en-tête, que le lecteur ne relit
  // jamais, et le segment se présenterait à zéro plutôt qu'à sa position.

  args.push('-f', 'hls');
  args.push('-hls_time', String(options.segmentDuration));
  args.push('-hls_list_size', '0');
  args.push('-hls_segment_type', 'fmp4');
  args.push('-hls_fmp4_init_filename', INIT_FILE_NAME);
  args.push('-hls_segment_filename', `${options.outputDir}/${SEGMENT_PATTERN}`);
  args.push('-start_number', String(options.startNumber));
  args.push('-hls_flags', 'independent_segments+temp_file+omit_endlist');
  args.push('-y', `${options.outputDir}/internal.m3u8`);

  return args;
}

/**
 * PLUSIEURS pistes, UNE seule lecture du fichier.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SIX PISTES NE DOIVENT PAS COÛTER SIX TRAVERSÉES.
 *
 * Une exécution par piste relit le conteneur entier à chaque fois : sur Avatar,
 * 101 Go multipliés par six. Mesuré sur la bibliothèque, la pré-génération
 * passerait de 4,92 Tio à lire à 10,54 Tio — plus du double, pour exactement le
 * même résultat.
 *
 * ffmpeg accepte autant de sorties qu'on veut sur une entrée, et ne lit le
 * fichier qu'une fois. Chaque sortie garde ses propres arguments, produits par
 * la MÊME fonction que la sortie unique.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function buildMultiAudioArgs(
  input: string,
  sorties: Omit<AudioRunOptions, 'input'>[],
): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  args.push('-probesize', PROBE_SIZE, '-analyzeduration', ANALYZE_DURATION);
  args.push('-i', input);
  for (const sortie of sorties) args.push(...sortieAudio(sortie));
  return args;
}

export function buildAudioArgs(options: AudioRunOptions): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  args.push('-probesize', PROBE_SIZE, '-analyzeduration', ANALYZE_DURATION);

  if (options.startTime > 0) args.push('-ss', options.startTime.toFixed(3));
  args.push('-i', options.input);

  if (options.endTime !== null) {
    args.push('-t', Math.max(0, options.endTime - options.startTime).toFixed(3));
  }

  // Une seule piste, désignée par son index absolu. Rien d'autre ne sort.
  args.push('-map', `0:${options.streamIndex}`);
  args.push('-vn', '-sn', '-dn', '-map_chapters', '-1');

  args.push('-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '2', '-ar', String(AUDIO_SAMPLE_RATE));
  args.push('-af', downmixFilter(options.channels));

  // Pas de `-output_ts_offset` : voir l'explication en tête de ce fichier. Le
  // décalage atterrirait dans l'edit list de l'en-tête, que le lecteur ne relit
  // jamais, et le segment se présenterait à zéro plutôt qu'à sa position.

  args.push('-f', 'hls');
  args.push('-hls_time', String(options.segmentDuration));
  args.push('-hls_list_size', '0');
  args.push('-hls_segment_type', 'fmp4');
  args.push('-hls_fmp4_init_filename', INIT_FILE_NAME);
  args.push('-hls_segment_filename', `${options.outputDir}/${SEGMENT_PATTERN}`);
  args.push('-start_number', String(options.startNumber));
  args.push('-hls_flags', 'independent_segments+temp_file+omit_endlist');
  args.push('-y', `${options.outputDir}/internal.m3u8`);

  return args;
}

/**
 * LES EXÉCUTIONS D'UN DÉPART, DÉDUITES DU PLAN LUI-MÊME.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ELLE N'EN RENDAIT QU'UNE, ET C'ÉTAIT LA CICATRICE D'UN DÉFAUT RÉGLÉ AILLEURS.
 *
 * Elle enchaînait autrefois une amorce de trois segments courts puis la
 * croisière — une exécution ffmpeg ne sachant pas changer de durée de segment en
 * cours de route. La seconde partait d'une position non nulle, donc portait
 * `-output_ts_offset`, donc écrivait un en-tête fMP4 DIFFÉRENT de la première ;
 * le lecteur n'en recevant qu'un, le film perdait ses six premières secondes.
 *
 * `-output_ts_offset` a disparu depuis, pour une raison sans rapport. Les trois
 * en-têtes ont été comparés octet à octet avec le ffmpeg de production — durées
 * de segment et positions de départ mélangées, tous identiques. La divergence
 * n'est plus possible, et l'enchaînement redevient légitime. Le détail de la
 * mesure est en tête de `segments.ts`.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA DÉCOUPE EN EXÉCUTIONS SE LIT DANS LE PLAN, ELLE N'EST PAS RECALCULÉE.
 *
 * On regroupe les segments consécutifs de MÊME durée, et chaque groupe devient
 * une exécution. Aucune constante d'amorce n'apparaît donc ici : le plan porte
 * déjà sa grille, et l'audio — uniforme — obtient naturellement une exécution
 * unique sans qu'on ait à le distinguer. Une deuxième définition de l'amorce
 * dans ce fichier finirait par diverger de celle de `segments.ts` ; c'est
 * exactement ce que `passthrough.ts` et `outputGeometry` ont déjà coûté.
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
  segmentDuration: number,
): RunPlan[] {
  const premier = plan[startIndex];
  if (premier === undefined) return [];

  /*
   * `primerSegments` rend 0 dès que le plan n'a pas la forme EXACTE de l'amorce
   * — un plan issu des images clés, un fichier plus court qu'elle, ou tout
   * simplement le reste du film. Une exécution unique reste donc le cas de très
   * loin le plus fréquent : tout déplacement au-delà de la sixième seconde.
   */
  const amorce = primerSegments(plan);
  const frontiere = plan[amorce];

  // Au-delà de l'amorce — tout déplacement, donc — une seule exécution.
  if (startIndex >= amorce) {
    return [{ startTime: premier.start, startNumber: startIndex, segmentDuration, endTime: null }];
  }

  /*
   * Rien derrière l'amorce : le fichier tient tout entier dedans. Une seule
   * exécution, mais à la durée de l'AMORCE — lui donner celle de croisière
   * produirait un segment de quatre secondes là où le manifeste en annonce deux
   * de deux.
   */
  if (frontiere === undefined) {
    return [
      { startTime: premier.start, startNumber: startIndex, segmentDuration: premier.duration, endTime: null },
    ];
  }

  return [
    // L'amorce s'arrête d'elle-même — c'est `-t` qui la borne — puis rend la
    // main. Sa durée vient du plan, jamais d'une constante recopiée ici.
    {
      startTime: premier.start,
      startNumber: startIndex,
      segmentDuration: premier.duration,
      endTime: frontiere.start,
    },
    { startTime: frontiere.start, startNumber: amorce, segmentDuration, endTime: null },
  ];
}
