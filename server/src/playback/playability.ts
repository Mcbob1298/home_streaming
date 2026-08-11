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
}

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
  options: { remuxAvailable?: boolean } = {},
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
  const videoIsCompatible = includes(DIRECT_VIDEO_CODECS, file.videoCodec);

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

  return {
    ...common,
    mode: 'unsupported',
    source: null,
    reason: `${capitalize(joinFrench(blockers))} : ce fichier n’est pas lisible tel quel dans un navigateur.`,
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
