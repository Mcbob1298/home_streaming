/**
 * Appel de ffprobe et interprétation de sa sortie.
 *
 * L'analyse de la sortie JSON est séparée de l'exécution du binaire : la
 * première est pure et testable, la seconde touche au disque.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Ce qui nous intéresse dans la sortie de ffprobe. */
export interface ProbeResult {
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  bitrate: number | null;
  /** Type de HDR détecté, ou null si le fichier est en SDR. */
  hdr: HdrType | null;
  audioTracks: AudioTrack[];
  subtitles: EmbeddedSubtitle[];
}

export type HdrType = 'HDR10' | 'HDR10+' | 'Dolby Vision' | 'HLG';

export interface AudioTrack {
  streamIndex: number;
  codec: string | null;
  channels: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
}

export interface EmbeddedSubtitle {
  streamIndex: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  isForced: boolean;
  isDefault: boolean;
  /** Sous-titre bitmap : ne pourra pas devenir du WebVTT. */
  isImageBased: boolean;
}

/**
 * Codecs de sous-titres qui sont des IMAGES, pas du texte.
 *
 * C'est la distinction dimensionnante pour la suite : un sous-titre texte se
 * convertit en WebVTT et s'affiche nativement dans le navigateur ; un
 * sous-titre image doit être incrusté dans la vidéo au transcodage, ou rendu
 * par un lecteur spécialisé.
 */
const IMAGE_BASED_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'pgssub',
  'dvd_subtitle',
  'dvdsub',
  'dvb_subtitle',
  'dvbsub',
  'xsub',
]);

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  bit_rate?: string;
  duration?: string;
  color_transfer?: string;
  color_primaries?: string;
  side_data_list?: { side_data_type?: string }[];
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
  streams?: FfprobeStream[];
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ffprobe renvoie « matroska,webm » : on garde le premier nom. */
function firstFormatName(formatName: string | undefined): string | null {
  if (formatName === undefined || formatName === '') return null;
  return formatName.split(',')[0] ?? null;
}

function tag(stream: FfprobeStream, name: string): string | null {
  const tags = stream.tags;
  if (tags === undefined) return null;
  // Les clés de tags ne sont pas normalisées en casse d'un conteneur à l'autre.
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === name && value !== '') return value;
  }
  return null;
}

function hasDisposition(stream: FfprobeStream, name: string): boolean {
  return stream.disposition?.[name] === 1;
}

/**
 * Détecte le type de HDR.
 *
 * - Dolby Vision : une « side data » dédiée, ou un profil DOVI ;
 * - HDR10+       : métadonnées dynamiques HDR (SMPTE 2094) ;
 * - HDR10        : courbe de transfert PQ (SMPTE 2084) ;
 * - HLG          : courbe de transfert ARIB STD-B67.
 *
 * L'ordre compte : un fichier Dolby Vision est souvent aussi marqué PQ, et
 * c'est l'information la plus spécifique qu'on veut garder.
 */
export function detectHdr(stream: FfprobeStream): HdrType | null {
  const sideData = stream.side_data_list ?? [];
  const sideDataTypes = sideData.map((entry) => (entry.side_data_type ?? '').toLowerCase());

  if (sideDataTypes.some((type) => type.includes('dovi') || type.includes('dolby vision'))) {
    return 'Dolby Vision';
  }
  if (sideDataTypes.some((type) => type.includes('hdr dynamic metadata') || type.includes('2094'))) {
    return 'HDR10+';
  }

  const transfer = (stream.color_transfer ?? '').toLowerCase();
  if (transfer === 'smpte2084') return 'HDR10';
  if (transfer === 'arib-std-b67') return 'HLG';

  return null;
}

/**
 * Transforme la sortie JSON de ffprobe en objet exploitable.
 * Pure : aucune I/O, testable sans fichier vidéo.
 */
export function parseFfprobeOutput(raw: string): ProbeResult {
  const data = JSON.parse(raw) as FfprobeOutput;
  const streams = data.streams ?? [];

  // La piste vidéo « principale » : la première qui ne soit pas une vignette.
  const videoStream = streams.find(
    (stream) =>
      stream.codec_type === 'video' &&
      !hasDisposition(stream, 'attached_pic') &&
      stream.codec_name !== 'mjpeg' &&
      stream.codec_name !== 'png',
  );

  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  const subtitleStreams = streams.filter((stream) => stream.codec_type === 'subtitle');

  const audioTracks: AudioTrack[] = audioStreams.map((stream, position) => ({
    streamIndex: stream.index ?? position,
    codec: stream.codec_name ?? null,
    channels: toNumber(stream.channels),
    language: tag(stream, 'language'),
    title: tag(stream, 'title'),
    isDefault: hasDisposition(stream, 'default'),
  }));

  const subtitles: EmbeddedSubtitle[] = subtitleStreams.map((stream, position) => {
    const codec = stream.codec_name ?? null;
    return {
      streamIndex: stream.index ?? position,
      codec,
      language: tag(stream, 'language'),
      title: tag(stream, 'title'),
      isForced: hasDisposition(stream, 'forced'),
      isDefault: hasDisposition(stream, 'default'),
      isImageBased: codec !== null && IMAGE_BASED_SUBTITLE_CODECS.has(codec.toLowerCase()),
    };
  });

  // La durée du conteneur est plus fiable que celle d'une piste isolée.
  const durationSeconds = toNumber(data.format?.duration) ?? toNumber(videoStream?.duration);

  return {
    container: firstFormatName(data.format?.format_name),
    videoCodec: videoStream?.codec_name ?? null,
    // La piste audio par défaut décide du codec « principal » affiché.
    audioCodec: (audioStreams.find((stream) => hasDisposition(stream, 'default')) ?? audioStreams[0])?.codec_name ?? null,
    width: toNumber(videoStream?.width),
    height: toNumber(videoStream?.height),
    durationSeconds,
    bitrate: toNumber(data.format?.bit_rate) ?? toNumber(videoStream?.bit_rate),
    hdr: videoStream === undefined ? null : detectHdr(videoStream),
    audioTracks,
    subtitles,
  };
}

export class FfprobeMissingError extends Error {}

/** Vérifie que ffprobe répond, et renvoie sa version. */
export async function checkFfprobe(binary: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 15_000 });
    return (stdout.split('\n')[0] ?? '').trim();
  } catch {
    throw new FfprobeMissingError(
      [
        `ffprobe est introuvable (commande essayée : « ${binary} »).`,
        '',
        'ffprobe fait partie de FFmpeg. Pour l’installer sous Windows :',
        '    winget install Gyan.FFmpeg',
        '',
        'Puis ouvrez un NOUVEAU terminal (le PATH n’est pas rafraîchi dans les',
        'terminaux déjà ouverts) et relancez « npm run probe ».',
        '',
        'Si FFmpeg est installé ailleurs, indiquez le chemin complet du binaire',
        'dans la variable d’environnement FFPROBE_PATH.',
      ].join('\n'),
    );
  }
}

/**
 * Sonde un fichier.
 *
 * `filePath` DOIT être le chemin exact issu de readdir (colonne `raw_path`),
 * jamais une forme NFC recomposée : NTFS et SMB comparent les noms octet à
 * octet, et un chemin recomposé peut ne pas exister sur le disque.
 */
export async function probeFile(
  binary: string,
  filePath: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    binary,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    {
      timeout: timeoutMs,
      // Une sortie ffprobe peut dépasser le tampon par défaut sur les fichiers
      // à nombreuses pistes.
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );

  if (stdout.trim() === '') throw new Error('ffprobe n’a rien renvoyé (fichier illisible ou tronqué)');
  return parseFfprobeOutput(stdout);
}
