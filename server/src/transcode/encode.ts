/**
 * Arguments de transcodage vidéo, en accélération matérielle.
 *
 * Module pur : la ligne de commande se vérifie sans lancer un seul processus.
 * C'est indispensable ici — une chaîne de filtres VAAPI mal ordonnée ne se voit
 * qu'à l'image produite, et l'image produite ne se teste pas automatiquement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TROIS PIÈGES CORRIGÉS, TOUS CONSTATÉS SUR DE VRAIES MESURES
 *
 * 1. SANS TONE MAPPING, les métadonnées HDR sont recopiées telles quelles dans
 *    un flux H.264 destiné à un écran SDR : l'image sort délavée et désaturée.
 *    164 fichiers concernés. Le tone mapping se fait SUR LE GPU — redescendre
 *    les images en mémoire centrale annulerait tout le gain.
 *
 * 2. LE REPLI LOGICIEL PRODUISAIT DU H.264 10 BITS sur une source 10 bits —
 *    « profile High 10, yuv420p10le » — qu'aucun navigateur ne décode. Le
 *    format de pixels est donc imposé, jamais hérité.
 *
 * 3. LE DOWNMIX AUDIO PAR DÉFAUT de ffmpeg noie les dialogues sous la musique
 *    en réduisant du 5.1 en stéréo. Une matrice explicite les remonte.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ANALYZE_DURATION, PROBE_SIZE, audioMapArgs, channelsOf, downmixFilter, type AudioChoice } from './args.js';
import {
  LIBPLACEBO_FILTER,
  TONE_MAP_OPENCL_FILTER,
  TONE_MAP_VAAPI_FILTER,
  type ToneMapBackend,
} from './capabilities.js';
import { AUDIO_SAMPLE_RATE, INIT_FILE_NAME, SEGMENT_PATTERN } from './segments.js';

/*
 * Le downmix vit dans `args.ts` : il s'applique aux DEUX chemins, remux et
 * transcodage, et n'appartient donc à aucun des deux. La réexportation garde
 * un point d'accès unique côté encodage.
 */
export { downmixFilter };

export type HdrKind = 'HDR10' | 'HDR10+' | 'HLG' | 'Dolby Vision' | null;

/**
 * Les accélérations que CE MODULE sait réellement piloter.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE TYPE EST LA GARANTIE, PAS LE COMMENTAIRE.
 *
 * Le type valait `'vaapi' | null`, et `index.ts` y ramenait tout le reste par
 * un `=== 'vaapi' ? 'vaapi' : null`. Le jour où ffmpeg 7 a fait marcher QSV, la
 * détection l'a retenu, ce ternaire l'a converti en `null`, et le serveur s'est
 * mis à transcoder en LOGICIEL — à x0,47, sous le temps réel — sans rien dire.
 *
 * `supportedBackend()` remplace ce ternaire : elle rend le moteur quand il est
 * pris en charge, et null accompagné d'une RAISON sinon. Ajouter un moteur à la
 * détection sans l'implémenter ici produit désormais un message explicite au
 * démarrage, jamais un repli muet.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type HardwareBackend = 'vaapi' | 'qsv' | null;

/** Ce que la détection peut rendre, y compris ce qu'on ne sait pas piloter. */
export type DetectedAcceleration = 'qsv' | 'vaapi' | 'nvenc' | 'amf' | 'videotoolbox' | null;

export interface BackendChoice {
  backend: HardwareBackend;
  /** Renseignée quand un moteur a été détecté mais n'est pas pris en charge. */
  unsupported: string | null;
}

export function supportedBackend(detected: DetectedAcceleration): BackendChoice {
  switch (detected) {
    case 'vaapi':
    case 'qsv':
      return { backend: detected, unsupported: null };
    case null:
      return { backend: null, unsupported: null };
    case 'nvenc':
    case 'amf':
    case 'videotoolbox':
      return {
        backend: null,
        unsupported:
          `L'accélération « ${detected} » a passé l'essai mais n'est pas implémentée dans ` +
          'encode.ts : le transcodage se fera en LOGICIEL, beaucoup plus lentement. ' +
          'Ajouter sa chaîne de filtres, ou la retirer des candidats de capabilities.ts.',
      };
    default: {
      // Exhaustivité vérifiée à la compilation : un moteur ajouté au type sans
      // être traité ici fait échouer le build, pas la production.
      const jamais: never = detected;
      return { backend: null, unsupported: `Accélération inconnue : ${String(jamais)}` };
    }
  }
}

export interface TranscodeRunOptions {
  input: string;
  startTime: number;
  startNumber: number;
  segmentDuration: number;
  endTime: number | null;
  outputDir: string;
  /** Piste audio produite avec la vidéo, ou aucune quand elle est rendue à part. */
  audio: AudioChoice;

  /** Dimensions de la source, pour ne jamais agrandir et calculer la sortie. */
  sourceWidth: number | null;
  sourceHeight: number | null;
  /** Images par seconde de la source, pour placer les images clés. */
  frameRate: number | null;
  hdr: HdrKind;
  /** Accélération retenue au démarrage, après essai réel. */
  hardware: HardwareBackend;
  device: string;
  /** Moteur de tone mapping retenu au démarrage, après essai réel. */
  toneMap: ToneMapBackend | null;
  /**
   * Transporter le HDR INTACT plutôt que le convertir.
   *
   * Décidé en amont (liste de périmètre aujourd'hui, capacité du client demain).
   * Voir `hdrPassthroughArgs` pour ce que cela change et pourquoi.
   */
  hdrPassthrough?: boolean;
}

/** Hauteur maximale produite. Au-delà, le NAS travaille pour rien. */
export const TARGET_HEIGHT = 1080;

/**
 * Débit vidéo par palier de hauteur, en bits par seconde.
 *
 * Choisi d'après la résolution de SORTIE, jamais recopié de la source : un 4K
 * à 60 Mb/s réduit en 1080p n'a aucun besoin de 60 Mb/s, et les produire
 * saturerait le réseau pour une image identique.
 */
export function bitrateFor(height: number): number {
  if (height > 1080) return 12_000_000;
  if (height > 720) return 6_000_000;
  if (height > 576) return 3_000_000;
  return 1_500_000;
}

/** Hauteur de sortie : celle de la cible, ou celle de la source si plus petite. */
export function outputHeight(sourceHeight: number | null): number {
  if (sourceHeight === null || sourceHeight <= 0) return TARGET_HEIGHT;
  return Math.min(TARGET_HEIGHT, sourceHeight);
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * TRANSPORTER LE HDR INTACT PLUTÔT QUE DE LE CONVERTIR.
 *
 * On a passé plusieurs sessions à chercher QUEL tone mapping appliquer. La
 * bonne question était s'il fallait en appliquer un.
 *
 * `tonemap_vaapi` détruit l'information AVANT l'encodage : mesuré sur une scène
 * sombre d'Avatar, le décile bas de luminance tombe à 0 — un dixième des pixels
 * ramenés au noir absolu — là où un tone mapping logiciel le garde à 4 ou 5.
 * Aucun débit ne récupère cela : 12, 16 et 21 Mbps donnent tous 0.
 *
 * La voie retenue est celle que Plex emploie sur ce même NAS, relevée dans sa
 * ligne de commande : AUCUN tone mapping, sortie HEVC 10 bits, courbe PQ
 * conservée jusqu'au client. Rien n'est détruit en amont, et c'est le lecteur —
 * qui connaît l'écran, ce que le serveur ignore — qui décide du rendu.
 *
 * Trois conditions, toutes vérifiées par la mesure :
 *   • le H.264 ne peut PAS porter ce flux : pas de profil 10 bits en VAAPI sur
 *     cette puce, ffmpeg répond « Invalid argument ». D'où HEVC.
 *   • le navigateur doit savoir le décoder — `MediaSource.isTypeSupported` sur
 *     `hvc1.2.4.L153.B0`, et surtout pas `canPlayType`, qui a déjà menti ici.
 *   • le coût : 1,38× le temps réel en 4K contre 4,96× pour la chaîne SDR, soit
 *     une session au lieu de deux. Accepté : 164 fichiers sur 2796 sont HDR.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON REDIMENSIONNE, ET C'EST UN REVIREMENT MESURÉ.
 *
 * Ce paragraphe disait l'inverse : « réduire un HDR n'aurait aucun sens quand
 * l'intention est de ne rien perdre ». L'argument était esthétique, la mesure a
 * tranché autrement — et pas sur le débit, sur la VITESSE D'ENCODAGE.
 *
 * En 4K le transcodeur tient ~1,7× le temps réel. La marge de tampon après un
 * déplacement croît donc lentement : moins de 5 s dix secondes après le saut,
 * contre +57 à +87 s sur le chemin 1080p qui encode à ~5×. Mesuré aux attentes
 * de 10, 20 et 35 s pour vérifier que c'était bien une croissance et non un
 * plafond.
 *
 * Réduire coûte des pixels — sur un écran qui en fait 1920×1080. Cela garde ce
 * qui était le but : HEVC 10 bits, courbe PQ, primaires BT.2020. Le HDR voyage
 * intact, simplement à la définition de l'écran.
 * ─────────────────────────────────────────────────────────────────────────────
 * ═════════════════════════════════════════════════════════════════════════════
 */
/** Débit du transport HDR. Celui de Plex, le temps que la règle le remplace. */
export const HDR_PASSTHROUGH_BITRATE = 12_000_000;

export function hdrPassthroughArgs(width: number | null, height: number | null): string[] {
  /*
   * Les dimensions de SORTIE, pas celles de la source : c'est `outputGeometry`
   * qui les décide, et elle est aussi ce que le manifeste annonce.
   */
  const dimensions =
    width !== null && height !== null && width > 0 && height > 0 ? `w=${width}:h=${height}:` : '';

  return [
    // `p010` : le format 10 bits de VAAPI. C'est lui qui porte le HDR.
    '-vf',
    `scale_vaapi=${dimensions}format=p010`,
    '-c:v',
    'hevc_vaapi',
    /*
     * Pas de `-profile:v` : « main » désignerait le profil 8 bits et ferait
     * échouer l'encodeur. Laissé à ffmpeg, qui déduit Main 10 du format p010 —
     * c'est aussi ce que fait Plex, dont la commande n'en pose aucun.
     */
  ];
}

/**
 * CE QUI SORT VRAIMENT : dimensions et débit, calculés UNE SEULE FOIS.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LA MÊME LEÇON QUE `passthrough.ts`, SUR UN AUTRE COUPLE D'APPELANTS.
 *
 * `buildTranscodeArgs` décidait de la hauteur et du débit dans son corps ; le
 * manifeste maître, lui, appelait `bitrateFor(outputHeight(...))` de son côté.
 * Les deux calculs ont divergé dès que le transport HDR est apparu, et le
 * manifeste d'Avatar annonçait :
 *
 *     BANDWIDTH=6192000   RESOLUTION=3840x2160
 *
 * soit 6,2 Mbps pour un flux qui en porte 20, et une résolution prise sur la
 * SOURCE — donc fausse aussi sur le chemin tone-mappé, qui produit du 1080p en
 * annonçant les dimensions d'origine.
 *
 * Rien ne cassait aujourd'hui : un manifeste à un seul rendu ne fait pas de
 * bascule de débit. Mais c'est précisément la forme de défaut que ce dépôt a
 * décidé de traiter comme un défaut — une règle écrite deux fois finit toujours
 * par être vraie à un seul endroit.
 *
 * Une fonction, deux appelants, et l'encodeur reste l'autorité.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export interface OutputGeometry {
  /** Le HDR est-il transporté intact, sans conversion ni redimensionnement ? */
  passthrough: boolean;
  width: number | null;
  height: number;
  /** Débit vidéo visé, en bits par seconde. */
  bitrate: number;
}

export function outputGeometry(options: {
  sourceWidth: number | null;
  sourceHeight: number | null;
  hardware: HardwareBackend | null;
  hdrPassthrough?: boolean;
  /**
   * Le mode de la session. Absent = transcodage, seul cas où `buildTranscodeArgs`
   * appelle cette fonction.
   *
   * En REMUX le flux vidéo est COPIÉ : ni redimensionnement, ni réencodage. Ses
   * dimensions et son débit sont donc ceux de la source, et les faire passer par
   * la règle de réduction annoncerait du 1080p là où transitent 4K intactes.
   */
  mode?: 'remux' | 'transcode';
  /** Débit de la source, pour le remux. Celui du fichier, faute de mieux. */
  sourceBitrate?: number | null;
}): OutputGeometry {
  if (options.mode === 'remux') {
    return {
      passthrough: false,
      width: options.sourceWidth,
      height: options.sourceHeight ?? outputHeight(options.sourceHeight),
      bitrate:
        options.sourceBitrate !== null && options.sourceBitrate !== undefined && options.sourceBitrate > 0
          ? options.sourceBitrate
          : bitrateFor(outputHeight(options.sourceHeight)),
    };
  }

  /*
   * Le transport intact n'existe que sur VAAPI : c'est `hevc_vaapi` qui porte le
   * 10 bits. Sans lui, on retombe sur le chemin ordinaire — et le manifeste doit
   * retomber avec, sinon il annoncerait 20 Mbps de HEVC là où passe du H.264.
   */
  const passthrough = options.hdrPassthrough === true && options.hardware === 'vaapi';

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * LE TRANSPORT HDR PASSE PAR `outputHeight` COMME LE RESTE.
   *
   * Il ne redimensionnait pas : « réduire un HDR n'aurait aucun sens quand
   * l'intention est de ne rien perdre ». L'intention était juste, la mesure l'a
   * corrigée — et ce n'est PAS le débit qui a tranché, c'est la vitesse
   * d'encodage.
   *
   * En 4K le transcodeur tourne à ~1,7× le temps réel. La marge de tampon après
   * un déplacement croît donc de ~0,7 s par seconde de lecture, et vaut encore
   * moins de 5 s dix secondes après le saut — contre +57 à +87 s sur le chemin
   * 1080p, qui encode à ~5×. Mesuré aux trois attentes 10, 20 et 35 s.
   *
   * Ce qui est perdu en réduisant : des pixels. Ce qui est gardé, et qui était
   * le but : le HEVC 10 bits, la courbe PQ et les primaires BT.2020 — vérifiés
   * dans l'en-tête produit. Le HDR voyage intact, simplement en 1920×1080, sur
   * un écran qui en fait 1920×1080.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const height = outputHeight(options.sourceHeight);
  const size = outputSize(options.sourceWidth, options.sourceHeight, height);

  return {
    passthrough,
    width: size?.width ?? null,
    height: size?.height ?? height,
    bitrate: passthrough ? HDR_PASSTHROUGH_BITRATE : bitrateFor(height),
  };
}

/**
 * Le fichier demande-t-il un tone mapping ?
 *
 * Le Dolby Vision profil 5 est écarté en amont, à la décision de lecture : il
 * n'a pas de couche de repli, et le traiter comme du HDR10 produit une image
 * verdâtre. Sur cette bibliothèque, 93 des 94 fichiers Dolby Vision sont en
 * profil 8 compatibilité 1, dont la couche de base EST du HDR10 — ils passent
 * donc par exactement le même chemin que le HDR10.
 */
export function needsToneMapping(hdr: HdrKind): boolean {
  return hdr === 'HDR10' || hdr === 'HDR10+' || hdr === 'HLG' || hdr === 'Dolby Vision';
}

/**
 * Dimensions de sortie, calculées explicitement.
 *
 * Plutôt que de déléguer à `-2`, dont la prise en charge par `scale_vaapi`
 * n'est pas documentée dans cette version : on connaît la résolution source,
 * autant faire le calcul et n'envoyer que des entiers.
 *
 * La largeur est arrondie au multiple de 2 le plus proche — H.264 en 4:2:0
 * n'accepte pas de dimension impaire.
 */
/**
 * Marge au-delà de laquelle un redimensionnement vaut la peine.
 *
 * Beaucoup de fichiers « 1080p » sont encodés en 1920×1088 : le H.264 travaille
 * par macroblocs de 16 pixels, et 1080 n'en est pas un multiple. Les réduire à
 * 1906×1080 ferait travailler le moteur et dégraderait l'image pour 0,7 % de
 * pixels en moins. Cinq pour cent de tolérance couvrent tous ces cas de
 * bourrage sans laisser passer un vrai 1440p.
 */
const RESIZE_TOLERANCE = 1.05;

export function shouldResize(sourceHeight: number | null, targetHeight: number): boolean {
  return sourceHeight !== null && sourceHeight > targetHeight * RESIZE_TOLERANCE;
}

export function outputSize(
  sourceWidth: number | null,
  sourceHeight: number | null,
  targetHeight: number,
): { width: number; height: number } | null {
  if (sourceWidth === null || sourceHeight === null || sourceWidth <= 0 || sourceHeight <= 0) return null;

  // Ne jamais agrandir, et ne pas s'agiter pour un bourrage de macroblocs.
  if (!shouldResize(sourceHeight, targetHeight)) return { width: even(sourceWidth), height: even(sourceHeight) };

  const width = Math.round((sourceWidth * targetHeight) / sourceHeight);
  return { width: even(width), height: even(targetHeight) };
}

function even(value: number): number {
  return value % 2 === 0 ? value : value + 1;
}

/**
 * Chaîne de filtres VAAPI.
 *
 * L'ORDRE ET LE LIEU comptent autant que le contenu. Les images arrivent déjà
 * sur le GPU grâce à `-hwaccel_output_format vaapi` ; tout ce qui suit doit y
 * rester. Un seul filtre logiciel au milieu — un `format=` mal placé, un
 * `scale=` au lieu de `scale_vaapi=` — force un aller-retour vers la mémoire
 * centrale et fait chuter le débit d'un facteur cinq.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEUX FILTRES, PAS UN.
 *
 * `tonemap_vaapi` ne fait QUE la conversion de plage dynamique. Ses seules
 * options, relevées par `ffmpeg -h filter=tonemap_vaapi` sur la machine cible,
 * sont `format`, `matrix`, `primaries` et `transfer` — aucune dimension. Lui
 * passer `w` et `h` fait échouer l'initialisation du filtre.
 *
 * Le redimensionnement revient donc à `scale_vaapi`, placé AVANT : tone-mapper
 * 4K puis réduire ferait travailler le moteur sur quatre fois plus de pixels.
 * Les deux filtres restent sur le GPU, donc aucune copie vers la mémoire
 * centrale ne s'intercale.
 *
 * Le `scale_vaapi` qui précède un tone mapping n'impose PAS son format : la
 * source doit rester en 10 bits jusqu'à la conversion, sinon on écrête les
 * hautes lumières avant de les compresser, ce qui est exactement ce que le
 * tone mapping doit éviter.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function vaapiFilterChain(options: {
  targetHeight: number;
  hdr: HdrKind;
  sourceWidth: number | null;
  sourceHeight: number | null;
  /** Moteur retenu au démarrage, après essai réel. */
  toneMap?: ToneMapBackend | null;
}): string {
  const size = outputSize(options.sourceWidth, options.sourceHeight, options.targetHeight);
  const resizing = size !== null && shouldResize(options.sourceHeight, options.targetHeight);

  const filters: string[] = [];

  if (needsToneMapping(options.hdr)) {
    // Réduire d'abord, en gardant la précision de la source.
    if (resizing && size !== null) filters.push(`scale_vaapi=w=${size.width}:h=${size.height}`);

    /*
     * ───────────────────────────────────────────────────────────────────────
     * LIBPLACEBO PASSE PAR VULKAN, PAS PAR VAAPI.
     *
     * Les images arrivent sur des surfaces VAAPI. `hwmap=derive_device=vulkan`
     * les EXPOSE à Vulkan sans les copier — les deux interfaces partagent le
     * même tampon via DRM. Le retour se fait pareillement.
     *
     * Ce n'est donc PAS un aller-retour vers la mémoire centrale : il n'y a ni
     * `hwdownload` ni `hwupload` dans la chaîne, et c'est exactement ce que le
     * test vérifie.
     * ───────────────────────────────────────────────────────────────────────
     */
    if (options.toneMap === 'libplacebo') {
      filters.push('hwmap=derive_device=vulkan');
      filters.push(LIBPLACEBO_FILTER);
      filters.push('hwmap=derive_device=vaapi:reverse=1');
      return filters.join(',');
    }

    filters.push(TONE_MAP_VAAPI_FILTER);
    return filters.join(',');
  }

  /*
   * En SDR, `scale_vaapi` fait tout : dimension et format. Le format est
   * imposé même sans redimensionner — une source 10 bits produirait sinon du
   * H.264 High 10, que les navigateurs ne décodent pas.
   */
  if (resizing && size !== null) {
    filters.push(`scale_vaapi=w=${size.width}:h=${size.height}:format=nv12`);
  } else {
    filters.push('scale_vaapi=format=nv12');
  }

  return filters.join(',');
}

/**
 * Chaîne de filtres QuickSync.
 *
 * `vpp_qsv` fait tout d'un coup — dimension, format, et tone mapping par
 * `tonemap=1` — là où VAAPI demande deux filtres. Il n'y a donc rien à ordonner
 * ni aucun périphérique à dériver : QSV n'a pas l'équivalent du détour par
 * Vulkan qui met libplacebo en échec.
 *
 * Mesuré 40 à 50 % plus lent que VAAPI sur le HDR de cette machine, d'où sa
 * seconde place. Il reste le bon choix là où VAAPI ne s'initialise pas.
 */
export function qsvFilterChain(options: {
  targetHeight: number;
  hdr: HdrKind;
  sourceWidth: number | null;
  sourceHeight: number | null;
}): string {
  const size = outputSize(options.sourceWidth, options.sourceHeight, options.targetHeight);
  const resizing = size !== null && shouldResize(options.sourceHeight, options.targetHeight);

  const parts: string[] = [];
  if (resizing && size !== null) parts.push(`w=${size.width}`, `h=${size.height}`);
  if (needsToneMapping(options.hdr)) parts.push('tonemap=1');
  parts.push('format=nv12');

  return `vpp_qsv=${parts.join(':')}`;
}

/**
 * Chaîne de filtres logicielle, pour le repli sans accélération.
 *
 * `zscale` fait la conversion de plage dynamique, `tonemap` la compression des
 * hautes lumières. Coûteux — c'est un repli, pas un mode de fonctionnement.
 */
export function softwareFilterChain(options: {
  targetHeight: number;
  hdr: HdrKind;
  sourceWidth: number | null;
  sourceHeight: number | null;
}): string {
  const filters: string[] = [];

  if (needsToneMapping(options.hdr)) {
    filters.push(
      'zscale=transfer=linear:npl=100',
      'tonemap=hable:desat=0',
      'zscale=primaries=bt709:transfer=bt709:matrix=bt709',
    );
  }

  const size = outputSize(options.sourceWidth, options.sourceHeight, options.targetHeight);
  const resizing = size !== null && shouldResize(options.sourceHeight, options.targetHeight);
  if (resizing && size !== null) filters.push(`scale=${size.width}:${size.height}`);

  /*
   * PIÈGE 2 : sans cette ligne, libx264 hérite du format de la source et
   * produit « High 10 / yuv420p10le » sur une source 10 bits. Aucun navigateur
   * ne décode ce profil.
   */
  filters.push('format=yuv420p');

  return filters.join(',');
}

/**
 * Intervalle entre images clés forcées.
 *
 * La vidéo étant réencodée, on place les images clés OÙ L'ON VEUT — ce que la
 * copie de flux du palier 1 ne permettait pas, et c'est ce qui dispense
 * d'énumérer les images clés de la source au préalable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * « EXACTEMENT » EST FAUX, ET L'ÉCART EST BORNÉ PAR UNE DURÉE D'IMAGE.
 *
 * L'expression pose une image clé sur la PREMIÈRE image dont l'horodatage
 * atteint `n × segmentDuration`, soit l'image `ceil(n × segmentDuration × fps)`.
 * Sur une source à 24000/1001, mesuré sur vingt-cinq segments consécutifs :
 *
 *     4,004  8,008  …  40,040   puis 44,002292 — l'écart RETOMBE
 *
 * C'est une dent de scie de période onze segments, bornée à 41,7 ms. Elle ne
 * s'accumule pas, et elle est sans conséquence : `EXTINF` sert à CHOISIR un
 * segment, pas à dater les images — celles-ci sont jouées à leur PTS. Un écart
 * de 41,7 ms dans un segment de quatre secondes ne peut jamais désigner le
 * mauvais segment.
 *
 * Ne pas « corriger » cet écart en déclarant `frames/fps` dans le manifeste sans
 * changer aussi l'encodeur : le manifeste dériverait alors linéairement contre
 * une production qui, elle, reste bornée.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function keyframeArgs(segmentDuration: number, frameRate: number | null): string[] {
  const args = ['-force_key_frames', `expr:gte(t,n_forced*${segmentDuration})`];

  /*
   * ATTENTION : cette branche est MORTE en l'état.
   *
   * `frameRate` vaut toujours `null` — `resolve.ts` l'écrit en dur, et
   * `media_file` ne porte aucune colonne de cadence. `-g` n'est donc jamais
   * émis, et le garde-fou décrit ci-dessous n'a jamais protégé quoi que ce soit.
   *
   * Ce qu'il ferait s'il était alimenté : borner l'intervalle entre images clés
   * pour le cas où l'expression ne tombe pas juste, typiquement sur une source à
   * cadence variable. Le faire vivre suppose de stocker la cadence — chantier
   * séparé, à ne pas mêler à une enquête en cours.
   */
  if (frameRate !== null && frameRate > 0) {
    args.push('-g', String(Math.round(frameRate * segmentDuration)));
  }

  return args;
}

export function buildTranscodeArgs(options: TranscodeRunOptions): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  /*
   * Les MÊMES bornes que le remux et l'audio, prises à la même source.
   *
   * Elles étaient recopiées en dur ici — deux valeurs identiques par accident,
   * qui auraient divergé au premier réglage. C'est le troisième exemplaire du
   * même défaut dans cette séance, après la géométrie de sortie et le débit de
   * l'empreinte de prélude.
   *
   * Sur leur valeur : Plex sonde 20 Mo et 20 s là où nous sondons 5 Mo et 2 s.
   * Mesuré sur le fichier #365 et ses 27 flux, cache chaud, huit exécutions —
   * les deux réglages voient EXACTEMENT les mêmes flux (3 vidéo, 6 audio, 16
   * sous-titres) et coûtent le même temps, 2,29 à 2,34 s. La grande sonde
   * n'achète rien ici. Attention au piège qui a failli conclure l'inverse : la
   * première exécution paie la lecture à froid, 4 à 5 s, quel que soit le
   * réglage — comparer sans alterner l'ordre mesure le cache, pas la sonde.
   */
  args.push('-probesize', PROBE_SIZE, '-analyzeduration', ANALYZE_DURATION);

  /*
   * Décodage MATÉRIEL, pas seulement l'encodage. `-hwaccel_output_format vaapi`
   * est le drapeau qui compte : sans lui les images décodées redescendent en
   * mémoire centrale, et le décodage HEVC logiciel mange à lui seul le gain.
   */
  if (options.hardware === 'vaapi') {
    args.push('-hwaccel', 'vaapi', '-hwaccel_device', options.device, '-hwaccel_output_format', 'vaapi');
  } else if (options.hardware === 'qsv') {
    // QSV veut un périphérique nommé, que la chaîne de filtres réutilise.
    args.push('-init_hw_device', `qsv=hw:${options.device}`, '-filter_hw_device', 'hw');
    args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
  }

  if (options.startTime > 0) args.push('-ss', options.startTime.toFixed(3));
  args.push('-i', options.input);
  if (options.endTime !== null) {
    args.push('-t', Math.max(0, options.endTime - options.startTime).toFixed(3));
  }

  /*
   * SÉLECTION EXPLICITE DES FLUX.
   *
   * Le fichier #365 contient 27 flux : 1 vidéo, 6 audio, 16 sous-titres,
   * 2 polices TrueType attachées et 2 images de couverture. Sans cette
   * sélection, ffmpeg essaie d'en faire quelque chose — et échoue sur les
   * polices, tout en prenant les couvertures MJPEG pour des flux vidéo.
   *
   * `0:v:0` et non `0:v` : le premier flux vidéo NON-vignette, que ffmpeg
   * choisit correctement, plutôt que tous les flux vidéo du fichier.
   */
  args.push('-map', '0:v:0');
  args.push(...audioMapArgs(options.audio));
  args.push('-sn', '-dn', '-map_chapters', '-1');

  const sortie = outputGeometry({
    sourceWidth: options.sourceWidth,
    sourceHeight: options.sourceHeight,
    hardware: options.hardware,
    hdrPassthrough: options.hdrPassthrough,
  });
  const passthrough = sortie.passthrough;
  const height = sortie.height;

  const geometry = {
    targetHeight: height,
    hdr: options.hdr,
    sourceWidth: options.sourceWidth,
    sourceHeight: options.sourceHeight,
  };

  if (passthrough) {
    args.push(...hdrPassthroughArgs(sortie.width, sortie.height));
  } else if (options.hardware === 'vaapi') {
    args.push('-vf', vaapiFilterChain({ ...geometry, toneMap: options.toneMap }));
    args.push('-c:v', 'h264_vaapi');
    // Profil « main » : universellement décodé, et suffisant en 8 bits.
    args.push('-profile:v', 'main');
  } else if (options.hardware === 'qsv') {
    args.push('-vf', qsvFilterChain(geometry));
    args.push('-c:v', 'h264_qsv', '-profile:v', 'main');
  } else {
    args.push('-vf', softwareFilterChain(geometry));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high');
    // Ceinture et bretelles : le filtre l'impose déjà, mais un profil High 10
    // produit par héritage serait invisible jusqu'à l'échec du navigateur.
    args.push('-pix_fmt', 'yuv420p');
  }

  /*
   * Le débit du transport HDR est aligné sur celui de Plex — 20 Mbps, relevé
   * dans sa ligne de commande — parce que c'est la référence à laquelle la
   * comparaison à l'œil a été faite. À remplacer par la règle déduite du débit
   * source, qui est le chantier suivant : une constante ici est provisoire.
   */
  const bitrate = sortie.bitrate;
  args.push('-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2));

  args.push(...keyframeArgs(options.segmentDuration, options.frameRate));

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * LES MÉTADONNÉES DE COULEUR VIENNENT DU FILTRE, PAS DE LA LIGNE DE COMMANDE.
   *
   * Un flux BT.709 étiqueté smpte2084 serait réinterprété par le navigateur et
   * ressortirait délavé malgré la conversion : il faut donc que la sortie soit
   * correctement étiquetée. Elle l'est — par le filtre de tone mapping, qui
   * pose `matrix`, `primaries` et `transfer` sur les images qu'il produit.
   *
   * Les redire en options de sortie était une ceinture et bretelles que
   * ffmpeg 5.1 tolérait. ffmpeg 7 ne la tolère plus : ne trouvant pas la
   * conversion demandée, il insère un `auto_scale` entre le filtre et
   * l'encodeur, et ce filtre logiciel ne sait pas traiter une surface VAAPI —
   *
   *   Impossible to convert between the formats supported by the filter
   *   'Parsed_tonemap_vaapi_1' and the filter 'auto_scale_0'
   *
   * Résultat : aucun paquet écrit, et les 164 fichiers HDR en échec. Vérifié
   * après retrait : `color_space=bt709, color_transfer=bt709,
   * color_primaries=bt709, pix_fmt=yuv420p, profile=Main`.
   *
   * Le repli logiciel les garde : `zscale` les pose aussi, mais là un
   * `auto_scale` inséré sait faire son travail, et la redondance ne coûte rien.
   * ───────────────────────────────────────────────────────────────────────────
   */
  if (needsToneMapping(options.hdr) && options.hardware === null) {
    args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  }

  if (options.audio.kind !== 'none') {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', String(AUDIO_SAMPLE_RATE));
    // La matrice suit la piste RETENUE, pas la première du fichier.
    args.push('-af', downmixFilter(channelsOf(options.audio)));
  }

  /*
   * Pas de `-output_ts_offset`, et c'est délibéré.
   *
   * ffmpeg ne l'applique pas aux fragments : il ramène leurs horodatages à zéro
   * et inscrit le décalage dans l'edit list de l'en-tête. Comme hls.js ne
   * recharge jamais `EXT-X-MAP`, les segments d'une relance étaient présentés
   * avec l'en-tête du premier run — donc à une position fausse d'exactement la
   * distance du saut. Le détail de la mesure est en tête de `args.ts`.
   */

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
