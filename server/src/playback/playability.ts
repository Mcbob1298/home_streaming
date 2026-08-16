/**
 * Décision de lecture : ce fichier part-il tel quel dans un navigateur ?
 *
 * Module pur — une ligne de `media_file` entre, une décision sort. Aucun accès
 * au disque, aucune requête : c'est ce qui le rend testable et c'est aussi ce
 * qui garantit que la route HTTP et la commande de listing donnent exactement
 * la même réponse.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNE SOURCE N'EST PAS UN FICHIER
 *
 * `source` porte toujours son `type` explicite. Aujourd'hui il ne vaut que
 * `file`, mais l'appelant ne doit JAMAIS déduire la nature d'une source de son
 * extension : le jour où la lecture démarrera sur une amorce pré-transcodée
 * suivie d'un flux continu, la même route renverra un manifeste HLS et rien
 * d'autre ne changera côté client que le branchement de la source.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Comment lire ce fichier.
 *
 * `direct`   — il part tel quel, aucun calcul.
 * `remux`    — la vidéo est déjà en H.264 : on la COPIE et on ne réencode que
 *              l'audio. Quelques secondes de calcul par fichier.
 * `transcode`— la vidéo doit être réencodée. Palier suivant.
 */
export type PlaybackMode = 'direct' | 'remux' | 'transcode' | 'unsupported';

/** `hls` n'est pas encore produit, mais le type l'attend déjà. */
export type SourceType = 'file' | 'hls';

export interface PlaybackSource {
  url: string;
  type: SourceType;
}

export interface PlayableFile {
  id: number;
  extension: string;
  /** Conteneur RÉEL vu par ffprobe, qui ne suit pas toujours l'extension. */
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Type de HDR détecté, ou null en SDR. Décide du tone mapping. */
  hdr?: string | null;
}

/**
 * Codecs vidéo qu'on sait réencoder.
 *
 * La liste est FERMÉE : un codec inconnu part en « unsupported » avec son nom,
 * plutôt que d'être lancé dans un transcodage qui échouera après trente
 * secondes d'attente. Elle couvre 993 des 993 fichiers non-H.264 de la
 * bibliothèque — 956 HEVC, 35 MPEG-4, 2 AV1.
 */
export const TRANSCODABLE_VIDEO_CODECS = [
  'hevc',
  'h265',
  'mpeg4',
  'av1',
  'vp9',
  'vp8',
  'mpeg2video',
  'vc1',
  'msmpeg4v3',
  'wmv3',
] as const;

export interface PlaybackDecision {
  mediaFileId: number;
  mode: PlaybackMode;
  /** Null quand il n'y a rien à lire — c'est le cas de `unsupported`. */
  source: PlaybackSource | null;
  reason: string;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

/**
 * Extensions acceptées en lecture directe.
 *
 * Le navigateur se fie d'abord au type MIME que nous annonçons, mais garder la
 * contrainte d'extension aligne la décision sur celle du rapport ffprobe.
 */
export const DIRECT_EXTENSIONS = ['.mp4', '.m4v'] as const;

/**
 * Conteneurs acceptés, tels que ffprobe les nomme.
 *
 * ffprobe rend « mov,mp4,m4a,3gp,3g2,mj2 » pour toute la famille MP4 ; la passe
 * de sondage n'en garde que le premier nom, d'où « mov ».
 *
 * Ce contrôle est ce qui distingue notre règle de celle du rapport ffprobe, qui
 * ne regardait que l'extension. Un fichier peut porter l'extension .mp4 et
 * contenir tout autre chose — la bibliothèque en compte un, un flux de
 * transport MPEG renommé, qu'aucun navigateur ne sait lire.
 */
export const DIRECT_CONTAINERS = ['mov', 'mp4'] as const;

export const DIRECT_VIDEO_CODECS = ['h264'] as const;

/**
 * Codecs qu'il suffit de REMUXER, sans réencoder.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LE HEVC EN A ÉTÉ RETIRÉ, APRÈS Y AVOIR ÉTÉ MIS.
 *
 * Chrome décode bel et bien le HEVC Main 10 — `MediaSource.isTypeSupported` sur
 * `hvc1.2.4.L153.B0` répond vrai, et le remux d'Avatar tourne à 49,2× le temps
 * réel contre 1,18× en réencodage, sans aucune perte puisque rien n'est encodé.
 * Tout cela reste exact.
 *
 * Mais il ne le LIT pas pour autant à n'importe quel débit : à 75,7 Mbps en 4K,
 * la lecture perd 15 % de ses images et se fige après trois minutes — mesuré
 * dans l'instrument, puis confirmé dans un vrai navigateur avec carte
 * graphique. Le tampon affichait +9,37 s au moment du blocage : ce n'est pas le
 * transfert qui manquait, c'est le décodeur qui n'a pas tenu.
 *
 * On aurait pu poser un seuil de débit et garder les deux chemins. C'est
 * précisément ce qu'on ne fait pas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA LEÇON DE CE PROJET : SUPPRIMER LE CAS PARTICULIER PLUTÔT QUE LE RÉPARER.
 *
 * L'amorce courte à côté du run normal — six secondes de film perdues. Le
 * magasin audio statique à côté des sessions vivantes — un audio placé au
 * double de sa position. Le remux et le transcodage avec leurs grilles
 * différentes — des segments de 78 Mo qui dépassaient le tampon du lecteur.
 * Trois fois, la panne est née de la COEXISTENCE, et trois fois la suppression
 * du cas particulier a mieux marché que sa réparation.
 *
 * Un seul chemin qui fonctionne partout vaut mieux que deux dont l'un est plus
 * rapide et casse sur certains fichiers. Le HEVC repart donc au réencodage,
 * avec le HDR transporté intact — ce qui reste l'acquis majeur, et qui ne
 * dépend pas du remux.
 *
 * Effet de bord bienvenu : le réencodage place ses images clés où il veut, donc
 * il ne dépend d'aucun index. Les fichiers qui ne démarraient pas faute
 * d'indexation redémarrent, et la passe globale n'a plus à être décidée.
 * ─────────────────────────────────────────────────────────────────────────────
 * ═════════════════════════════════════════════════════════════════════════════
 */
export const REMUXABLE_VIDEO_CODECS = ['h264'] as const;
export const DIRECT_AUDIO_CODECS = ['aac'] as const;

/** Noms lisibles des codecs, pour que le message dise quelque chose à un humain. */
const CODEC_LABELS: Record<string, string> = {
  hevc: 'HEVC (H.265)',
  h264: 'H.264',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg4: 'MPEG-4 Part 2',
  mpeg2video: 'MPEG-2',
  vc1: 'VC-1',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
  truehd: 'TrueHD',
  flac: 'FLAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  mp3: 'MP3',
  aac: 'AAC',
  pcm_s16le: 'PCM',
};

const CONTAINER_LABELS: Record<string, string> = {
  matroska: 'Matroska (MKV)',
  webm: 'WebM',
  avi: 'AVI',
  mpegts: 'flux de transport MPEG',
  mpeg: 'MPEG-PS',
  asf: 'ASF (WMV)',
  ogg: 'Ogg',
  flv: 'FLV',
  mov: 'MP4',
};

function label(value: string | null, labels: Record<string, string>): string {
  if (value === null) return 'inconnu';
  return labels[value] ?? value;
}

/** Type MIME annoncé au navigateur, déduit de l'extension. */
export function mimeTypeFor(extension: string): string {
  switch (extension.toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    case '.avi':
      return 'video/x-msvideo';
    case '.mov':
      return 'video/quicktime';
    case '.ts':
      return 'video/mp2t';
    default:
      return 'application/octet-stream';
  }
}

function includes(list: readonly string[], value: string | null): boolean {
  return value !== null && list.includes(value.toLowerCase());
}

/**
 * Ce qui empêche la lecture directe, en clair.
 *
 * La liste est ordonnée du plus dimensionnant au moins : un fichier HEVC dans
 * un MKV devra être réencodé, alors qu'un H.264 dans un MKV ne demandera qu'un
 * remux. C'est cette nuance que la phrase doit porter.
 */
function blockersOf(file: PlayableFile): string[] {
  const blockers: string[] = [];

  if (!includes(DIRECT_VIDEO_CODECS, file.videoCodec)) {
    blockers.push(`la vidéo est en ${label(file.videoCodec, CODEC_LABELS)}`);
  }
  if (!includes(DIRECT_AUDIO_CODECS, file.audioCodec)) {
    blockers.push(`l’audio est en ${label(file.audioCodec, CODEC_LABELS)}`);
  }
  if (!includes(DIRECT_EXTENSIONS, file.extension) || !includes(DIRECT_CONTAINERS, file.container)) {
    blockers.push(`le conteneur est du ${label(file.container, CONTAINER_LABELS)}`);
  }

  return blockers;
}

export interface PlaybackUrls {
  /** Fichier servi tel quel, pour la lecture directe. */
  file: string;
  /** Manifeste HLS produit à la demande, pour le remux et le transcodage. */
  hls: string;
}

/**
 * Décide comment lire un fichier.
 *
 * Un fichier non sondé — codecs à NULL — n'est PAS présumé lisible : on ne
 * devine pas, exactement comme la passe TMDB ne devine pas un appariement.
 *
 * `remuxAvailable` dit si ffmpeg a été trouvé au démarrage. Sans lui, la
 * décision retombe honnêtement sur « non lisible » plutôt que de proposer une
 * source que rien ne saurait produire.
 */
export function decidePlayback(
  file: PlayableFile,
  urls: PlaybackUrls,
  options: { remuxAvailable?: boolean; clientDecodesHevc?: boolean } = {},
): PlaybackDecision {
  const common = {
    mediaFileId: file.id,
    container: file.container,
    videoCodec: file.videoCodec,
    audioCodec: file.audioCodec,
  };

  if (file.container === null && file.videoCodec === null) {
    return {
      ...common,
      mode: 'unsupported',
      source: null,
      reason:
        'Ce fichier n’a pas encore été analysé. Lancer « npm run probe » pour ' +
        'connaître ses codecs, puis rouvrir cette page.',
    };
  }

  const blockers = blockersOf(file);

  if (blockers.length === 0) {
    return { ...common, mode: 'direct', source: { url: urls.file, type: 'file' }, reason: 'Lecture directe' };
  }

  /*
   * La vidéo est déjà en H.264 : elle est COPIÉE, seul l'audio est réencodé.
   * C'est la population la plus nombreuse — 59,3 % de la bibliothèque — et la
   * moins coûteuse. Ne jamais la faire passer par un réencodage vidéo.
   */
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * « COMPATIBLE » DÉPEND DU CLIENT, PAS DU SEUL CODEC.
   *
   * `DIRECT_VIDEO_CODECS` ne contient que H.264 parce que c'est le seul codec
   * que TOUT navigateur décode. Mais Chrome décode le HEVC Main 10 — vérifié par
   * `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"')`, et
   * surtout pas par `canPlayType`, qui a déjà menti sur ce projet.
   *
   * Quand c'est le cas, un fichier HEVC n'a plus besoin d'être réencodé : il
   * suffit de changer de conteneur. Mesuré sur Avatar : 49,2× le temps réel
   * contre 1,18× en réencodage, et la qualité est celle du fichier — c'est une
   * copie, pas un encodage. Tout le chantier du tone mapping disparaît avec.
   *
   * Le prix est le débit : 74,3 Mbps, soit le fichier lui-même. C'est ce que la
   * négociation devra arbitrer, sur une mesure de débit réel et non sur une
   * règle d'adresse IP.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  const videoIsCompatible = includes(REMUXABLE_VIDEO_CODECS, file.videoCodec);

  if (videoIsCompatible) {
    if (options.remuxAvailable !== true) {
      return {
        ...common,
        mode: 'unsupported',
        source: null,
        reason:
          'Ce fichier demande un remux, mais ffmpeg est introuvable sur le serveur. ' +
          'Renseigner FFMPEG_PATH dans .env, puis relancer le serveur.',
      };
    }

    return {
      ...common,
      mode: 'remux',
      source: { url: urls.hls, type: 'hls' },
      reason: `${capitalize(joinFrench(blockers))} : la vidéo est copiée telle quelle, seul l’audio est réencodé.`,
    };
  }

  /*
   * La vidéo doit être réencodée. C'est le mode le plus coûteux — mesuré à ×5
   * en 4K sur le NAS — mais il couvre les 993 fichiers restants.
   */
  if (includes(TRANSCODABLE_VIDEO_CODECS, file.videoCodec)) {
    if (options.remuxAvailable !== true) {
      return {
        ...common,
        mode: 'unsupported',
        source: null,
        reason:
          'Ce fichier demande un transcodage, mais ffmpeg est introuvable sur le serveur. ' +
          'Renseigner FFMPEG_PATH dans .env, puis relancer le serveur.',
      };
    }

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * LE TEXTE DOIT DIRE CE QU'ON SERT, PAS CE QU'ON SERVAIT AVANT.
     *
     * Il annonçait « la vidéo est réencodée en H.264 » pour TOUS les
     * transcodages, y compris ceux qui partent en HEVC 10 bits avec leur HDR
     * intact. Un fichier mentait ainsi depuis l'arrivée du transport HDR, et
     * soixante-dix l'auraient fait après l'ouverture à la bibliothèque.
     *
     * Ce genre d'écart ne se paie pas le jour même : il se paie trois mois plus
     * tard, quand on cherche pourquoi un flux annoncé H.264 arrive en HEVC.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const hdrIntact = options.clientDecodesHevc === true && file.hdr === 'HDR10';

    return {
      ...common,
      mode: 'transcode',
      source: { url: urls.hls, type: 'hls' },
      reason: hdrIntact
        ? `${capitalize(joinFrench(blockers))} : la vidéo est réencodée en HEVC 10 bits, ` +
          'son HDR transporté intact jusqu’à votre écran.'
        : `${capitalize(joinFrench(blockers))} : la vidéo est réencodée en H.264.`,
    };
  }

  return {
    ...common,
    mode: 'unsupported',
    source: null,
    reason: `${capitalize(joinFrench(blockers))} : ce codec vidéo n’est pas pris en charge.`,
  };
}

/** « a », « a et b », « a, b et c ». */
function joinFrench(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} et ${parts.at(-1) as string}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Un fichier peut-il être remuxé — vidéo copiée, audio seul réencodé ?
 *
 * Exposé à part pour les comptages : c'est la population qui fait passer la
 * bibliothèque de 5 % à 65 % de lisibilité pour un coût de calcul quasi nul.
 */
export function isRemuxable(file: PlayableFile): boolean {
  return includes(DIRECT_VIDEO_CODECS, file.videoCodec) && blockersOf(file).length > 0;
}

/** Même règle, en SQL. */
export function remuxSql(alias = 'media_file'): string {
  const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');
  return `(
    lower(${alias}.video_codec) IN (${list(DIRECT_VIDEO_CODECS)})
    AND NOT ${directPlaySql(alias)}
  )`;
}

/** Fichiers dont la vidéo doit être réencodée. */
export function transcodeSql(alias = 'media_file'): string {
  const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');
  return `(lower(${alias}.video_codec) IN (${list(TRANSCODABLE_VIDEO_CODECS)}))`;
}

/**
 * Même règle, en SQL, pour les listes et les comptages.
 *
 * Deux expressions d'une seule règle, c'est deux occasions de diverger. Elles
 * sont donc dérivées des mêmes constantes, et un test vérifie que le SQL et
 * `decidePlayback` classent la même chose de la même façon.
 *
 * `alias` est le nom de la table `media_file` dans la requête appelante.
 */
export function directPlaySql(alias = 'media_file'): string {
  const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');
  // `lower()` reproduit la comparaison insensible à la casse du code : sans
  // lui, un « .MP4 » serait accepté par la fonction et refusé par le SQL.
  return `(
    lower(${alias}.extension) IN (${list(DIRECT_EXTENSIONS)})
    AND lower(${alias}.container) IN (${list(DIRECT_CONTAINERS)})
    AND lower(${alias}.video_codec) IN (${list(DIRECT_VIDEO_CODECS)})
    AND lower(${alias}.audio_codec) IN (${list(DIRECT_AUDIO_CODECS)})
  )`;
}
