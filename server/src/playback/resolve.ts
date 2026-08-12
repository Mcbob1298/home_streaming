/**
 * Résolution complète d'une lecture : décision, découpe, paramètres de session.
 *
 * Partagée par la route de playability et par celle du manifeste. Les deux
 * DOIVENT aboutir au même verdict et au même plan — sinon le lecteur réclame
 * des segments que ffmpeg ne produira jamais.
 */
import type { Db } from '../db/index.js';
import { hasUsableBaseLayer, readDolbyVision, unsupportedProfileReason } from '../transcode/dovi.js';
import { ffprobeFor } from '../transcode/keyframes.js';
import { segmentPlanOf } from '../transcode/plan.js';
import {
  PRIMER_COUNT,
  PRIMER_DURATION,
  SEGMENT_DURATION,
  planSegments,
  type PlannedSegment,
} from '../transcode/segments.js';
import type { SourceInfo } from '../transcode/session.js';
import { decidePlayback, type PlaybackDecision, type PlaybackUrls } from './playability.js';

export interface MediaRow {
  id: number;
  path: string;
  rawPath: string | null;
  extension: string;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  durationSeconds: number | null;
  hdr: string | null;
  sizeBytes: number;
  mtimeMs: number;
  dvProfile: number | null;
  dvBlCompat: number | null;
}

export const MEDIA_COLUMNS = `
  id, path, raw_path AS rawPath, extension, container,
  video_codec AS videoCodec, audio_codec AS audioCodec, resolution,
  duration_seconds AS durationSeconds, hdr, size_bytes AS sizeBytes,
  mtime_ms AS mtimeMs, dv_profile AS dvProfile, dv_bl_compat AS dvBlCompat
`;

export function findMedia(db: Db, id: number): MediaRow | undefined {
  return db
    .prepare(`SELECT ${MEDIA_COLUMNS} FROM media_file WHERE id = ? AND present = 1`)
    .get(id) as MediaRow | undefined;
}

/** Dimensions tirées de « 1920x1080 ». */
export function dimensionsOf(resolution: string | null): { width: number | null; height: number | null } {
  if (resolution === null) return { width: null, height: null };
  const [w, h] = resolution.split('x').map(Number);
  return {
    width: Number.isFinite(w) && (w as number) > 0 ? (w as number) : null,
    height: Number.isFinite(h) && (h as number) > 0 ? (h as number) : null,
  };
}

/**
 * Sonde et mémorise le profil Dolby Vision, une seule fois par fichier.
 *
 * Seuls les fichiers déclarés Dolby Vision sont sondés — 94 sur 2796. La
 * lecture d'en-tête coûte quelques centaines de millisecondes, et le résultat
 * est écrit en base pour ne jamais recommencer.
 */
async function ensureDolbyVision(db: Db, ffmpegBinary: string, media: MediaRow): Promise<MediaRow> {
  if (media.hdr !== 'Dolby Vision' || media.dvProfile !== null) return media;

  const info = await readDolbyVision(ffprobeFor(ffmpegBinary), media.rawPath ?? media.path);

  /*
   * `media_file` n'a PAS de colonne `updated_at` — elle porte `first_seen_at`
   * et `last_seen_at`, qui appartiennent au scanner et n'ont rien à voir avec
   * un sondage. Les tables d'œuvres, elles, en ont une : copier leur motif ici
   * produisait un « no such column: updated_at » à la première lecture d'un
   * fichier Dolby Vision.
   */
  db.prepare('UPDATE media_file SET dv_profile = ?, dv_bl_compat = ? WHERE id = ?').run(
    info.profile,
    info.blCompat,
    media.id,
  );

  return { ...media, dvProfile: info.profile, dvBlCompat: info.blCompat };
}

/**
 * Décision seule, sans découpe.
 *
 * La route de playability répond à l'affichage d'une fiche : lui faire
 * énumérer les images clés d'un film de deux heures pour dire « remux »
 * coûterait plusieurs secondes pour une information qu'elle a déjà.
 */
export async function resolveDecision(
  db: Db,
  ffmpegBinary: string,
  media: MediaRow,
  urls: PlaybackUrls,
  options: { transcodeAvailable: boolean },
): Promise<{ decision: PlaybackDecision; source: SourceInfo }> {
  const enriched = await ensureDolbyVision(db, ffmpegBinary, media);

  const size = dimensionsOf(enriched.resolution);
  const source: SourceInfo = {
    width: size.width,
    height: size.height,
    frameRate: null,
    hdr: (enriched.hdr as SourceInfo['hdr']) ?? null,
    audioChannels: audioChannelsOf(db, enriched.id),
  };

  const decision = decidePlayback(
    {
      id: enriched.id,
      extension: enriched.extension,
      container: enriched.container,
      videoCodec: enriched.videoCodec,
      audioCodec: enriched.audioCodec,
      hdr: enriched.hdr,
    },
    urls,
    { remuxAvailable: options.transcodeAvailable },
  );

  if (enriched.hdr === 'Dolby Vision' && enriched.dvProfile !== null) {
    const info = { profile: enriched.dvProfile, blCompat: enriched.dvBlCompat ?? 0 };
    if (!hasUsableBaseLayer(info)) {
      return {
        decision: { ...decision, mode: 'unsupported', source: null, reason: unsupportedProfileReason(info) },
        source,
      };
    }
  }

  return { decision, source };
}

export interface ResolvedPlayback {
  decision: PlaybackDecision;
  /** Découpe en segments. Vide quand le fichier n'est pas lisible. */
  plan: PlannedSegment[];
  source: SourceInfo;
  /** Renseigné quand la découpe a demandé une énumération des images clés. */
  keyframeProbeMs: number;
}

/**
 * Décide, sonde et découpe.
 *
 * L'ordre compte : le profil Dolby Vision doit être connu AVANT la décision,
 * puisqu'un profil 5 rend le fichier non lisible quel que soit son codec.
 */
export async function resolvePlayback(
  db: Db,
  ffmpegBinary: string,
  media: MediaRow,
  urls: PlaybackUrls,
  options: { transcodeAvailable: boolean },
): Promise<ResolvedPlayback> {
  const { decision, source } = await resolveDecision(db, ffmpegBinary, media, urls, options);
  const enriched = media;

  if (decision.mode === 'direct' || decision.mode === 'unsupported') {
    return { decision, plan: [], source, keyframeProbeMs: 0 };
  }

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * DEUX DÉCOUPES, POUR DEUX RAISONS OPPOSÉES.
   *
   * En REMUX la vidéo est copiée : ffmpeg ne peut couper qu'aux images clés
   * existantes, qu'il faut donc énumérer pour que le manifeste dise la vérité.
   *
   * En TRANSCODAGE la vidéo est réencodée : on place les images clés où l'on
   * veut. La découpe suit exactement le plan annoncé — trois segments de deux
   * secondes puis quatre — sans aucune énumération préalable. C'est ce que le
   * palier 1 ne pouvait pas garantir, et qui devient exact ici.
   * ─────────────────────────────────────────────────────────────────────────
   */
  if (decision.mode === 'transcode') {
    return {
      decision,
      plan: planSegments(enriched.durationSeconds ?? 0),
      source,
      keyframeProbeMs: 0,
    };
  }

  const { segments, probeMs } = await segmentPlanOf(db, ffmpegBinary, {
    id: enriched.id,
    inputPath: enriched.rawPath ?? enriched.path,
    durationSeconds: enriched.durationSeconds ?? 0,
    sizeBytes: enriched.sizeBytes,
    mtimeMs: enriched.mtimeMs,
  });

  return { decision, plan: segments, source, keyframeProbeMs: probeMs };
}

/** Nombre de canaux de la piste audio par défaut, pour choisir le downmix. */
function audioChannelsOf(db: Db, mediaFileId: number): number | null {
  const row = db
    .prepare(
      `SELECT channels FROM audio_track WHERE media_file_id = ?
       ORDER BY is_default DESC, stream_index LIMIT 1`,
    )
    .get(mediaFileId) as { channels: number | null } | undefined;
  return row?.channels ?? null;
}

export { PRIMER_COUNT, PRIMER_DURATION, SEGMENT_DURATION };
