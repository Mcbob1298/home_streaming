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
import type { ToneMapBackend } from './capabilities.js';
import { INIT_FILE_NAME, SEGMENT_PATTERN } from './segments.js';

export type HdrKind = 'HDR10' | 'HDR10+' | 'HLG' | 'Dolby Vision' | null;

export interface TranscodeRunOptions {
  input: string;
  startTime: number;
  startNumber: number;
  segmentDuration: number;
  endTime: number | null;
  outputDir: string;
  /** Piste audio à retenir. Null pour la première. */
  audioStreamIndex: number | null;

  /** Dimensions de la source, pour ne jamais agrandir et calculer la sortie. */
  sourceWidth: number | null;
  sourceHeight: number | null;
  /** Images par seconde de la source, pour placer les images clés. */
  frameRate: number | null;
  hdr: HdrKind;
  /** Accélération retenue au démarrage, après essai réel. */
  hardware: 'vaapi' | null;
  device: string;
  /** Moteur de tone mapping retenu au démarrage, après essai réel. */
  toneMap: ToneMapBackend | null;
  /** Nombre de canaux de la source, pour choisir la matrice de downmix. */
  audioChannels: number | null;
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
      filters.push(
        'libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=nv12',
      );
      filters.push('hwmap=derive_device=vaapi:reverse=1');
      return filters.join(',');
    }

    filters.push('tonemap_vaapi=format=nv12:matrix=bt709:primaries=bt709:transfer=bt709');
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
 * Matrice de downmix 5.1 et 7.1 vers stéréo.
 *
 * PIÈGE 3 : le downmix par défaut de ffmpeg applique des coefficients qui
 * enterrent le canal central — donc les dialogues — sous les canaux musique et
 * effets. La voix remonte ici à 0,8 quand les surrounds descendent à 0,5.
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

  // 5.1 : le cas le plus fréquent de la bibliothèque.
  return (
    'pan=stereo|' +
    'FL=0.5*FL+0.8*FC+0.3*LFE+0.5*BL|' +
    'FR=0.5*FR+0.8*FC+0.3*LFE+0.5*BR,' +
    'aresample=async=1:first_pts=0'
  );
}

/**
 * Intervalle entre images clés forcées.
 *
 * La vidéo étant réencodée, on place les images clés OÙ L'ON VEUT — ce que la
 * copie de flux du palier 1 ne permettait pas. Les segments tombent donc
 * exactement sur les durées annoncées par le manifeste, sans avoir à énumérer
 * les images clés de la source au préalable.
 */
export function keyframeArgs(segmentDuration: number, frameRate: number | null): string[] {
  const args = ['-force_key_frames', `expr:gte(t,n_forced*${segmentDuration})`];

  /*
   * Un intervalle maximal double sécurise le cas où l'expression ne tombe pas
   * juste — sur une source à cadence variable, notamment.
   */
  if (frameRate !== null && frameRate > 0) {
    args.push('-g', String(Math.round(frameRate * segmentDuration)));
  }

  return args;
}

export function buildTranscodeArgs(options: TranscodeRunOptions): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  args.push('-probesize', '5M', '-analyzeduration', '2M');

  /*
   * Décodage MATÉRIEL, pas seulement l'encodage. `-hwaccel_output_format vaapi`
   * est le drapeau qui compte : sans lui les images décodées redescendent en
   * mémoire centrale, et le décodage HEVC logiciel mange à lui seul le gain.
   */
  const hardware = options.hardware === 'vaapi';
  if (hardware) {
    args.push('-hwaccel', 'vaapi', '-hwaccel_device', options.device, '-hwaccel_output_format', 'vaapi');
  }

  if (options.startTime > 0) args.push('-ss', options.startTime.toFixed(3));
  args.push('-i', options.input);
  if (options.endTime !== null) {
    args.push('-t', Math.max(0, options.endTime - options.startTime).toFixed(3));
  }

  /*
   * SÉLECTION EXPLICITE DES FLUX.
   *
   * Avatar contient 27 flux : 1 vidéo, 6 audio, 16 sous-titres, 2 polices
   * TrueType attachées et 2 images de couverture. Sans cette sélection, ffmpeg
   * essaie d'en faire quelque chose — et échoue sur les polices.
   */
  args.push('-map', '0:v:0');
  args.push('-map', options.audioStreamIndex === null ? '0:a:0?' : `0:a:${options.audioStreamIndex}?`);
  // Rien d'autre. Les pistes multiples et les sous-titres viennent au palier 3.
  args.push('-sn', '-dn', '-map_chapters', '-1');

  const height = outputHeight(options.sourceHeight);

  if (hardware) {
    args.push(
      '-vf',
      vaapiFilterChain({
        targetHeight: height,
        hdr: options.hdr,
        sourceWidth: options.sourceWidth,
        sourceHeight: options.sourceHeight,
        toneMap: options.toneMap,
      }),
    );
    args.push('-c:v', 'h264_vaapi');
    // Profil « main » : universellement décodé, et suffisant en 8 bits.
    args.push('-profile:v', 'main');
  } else {
    args.push(
      '-vf',
      softwareFilterChain({
        targetHeight: height,
        hdr: options.hdr,
        sourceWidth: options.sourceWidth,
        sourceHeight: options.sourceHeight,
      }),
    );
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high');
    // Ceinture et bretelles : le filtre l'impose déjà, mais un profil High 10
    // produit par héritage serait invisible jusqu'à l'échec du navigateur.
    args.push('-pix_fmt', 'yuv420p');
  }

  const bitrate = bitrateFor(height);
  args.push('-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2));

  args.push(...keyframeArgs(options.segmentDuration, options.frameRate));

  /*
   * Les métadonnées de couleur HDR ne doivent PAS survivre au tone mapping :
   * un flux BT.709 étiqueté smpte2084 serait réinterprété par le navigateur et
   * l'image ressortirait délavée malgré la conversion.
   */
  if (needsToneMapping(options.hdr)) {
    args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  }

  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push('-af', downmixFilter(options.audioChannels));

  if (options.startTime > 0) args.push('-output_ts_offset', options.startTime.toFixed(3));

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
