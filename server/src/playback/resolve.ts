/**
 * Résolution complète d'une lecture : décision, découpe, paramètres de session.
 *
 * Partagée par la route de playability et par celle du manifeste. Les deux
 * DOIVENT aboutir au même verdict et au même plan — sinon le lecteur réclame
 * des segments que ffmpeg ne produira jamais.
 */
import type { Db } from '../db/index.js';
import type { AudioChoice } from '../transcode/args.js';
import { hasUsableBaseLayer, readDolbyVision, unsupportedProfileReason } from '../transcode/dovi.js';
import { ffprobeFor } from '../transcode/keyframes.js';
import { needsSeparateAudio } from '../transcode/manifest.js';
import { segmentPlanOf } from '../transcode/plan.js';
import {
  SEGMENT_DURATION,
  planAudioSegments,
  planSegments,
  type PlannedSegment,
} from '../transcode/segments.js';
import type { AudioRendition, SourceInfo } from '../transcode/session.js';
import { decidePlayback, type PlaybackDecision, type PlaybackUrls } from './playability.js';
import {
  labelAudioTracks,
  pickDefaultAudio,
  selectSubtitleTracks,
  type AudioTrackRow,
  type LabelledAudioTrack,
  type LabelledSubtitleTrack,
  type SubtitleTrackRow,
} from './tracks.js';

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
): Promise<{ decision: PlaybackDecision; source: SourceInfo; tracks: TrackSelection }> {
  const enriched = await ensureDolbyVision(db, ffmpegBinary, media);
  const tracks = tracksOf(db, media.id);

  const size = dimensionsOf(enriched.resolution);
  const source: SourceInfo = {
    width: size.width,
    height: size.height,
    frameRate: null,
    hdr: (enriched.hdr as SourceInfo['hdr']) ?? null,
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
        tracks,
      };
    }
  }

  return { decision, source, tracks };
}

export interface ResolvedPlayback {
  decision: PlaybackDecision;
  /** Découpe de la vidéo. Vide quand le fichier n'est pas lisible. */
  plan: PlannedSegment[];
  source: SourceInfo;
  /** Renseigné quand la découpe a demandé une énumération des images clés. */
  keyframeProbeMs: number;
  tracks: TrackSelection;
  /** Piste audio muxée dans la vidéo, ou `none` quand l'audio est rendu à part. */
  muxedAudio: AudioChoice;
  /** Pistes exposées comme rendus séparés. Vide quand l'audio reste muxé. */
  audioRenditions: AudioRendition[];
  /** Découpe des rendus audio. Vide quand l'audio reste muxé. */
  audioPlan: PlannedSegment[];
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
  const { decision, source, tracks } = await resolveDecision(db, ffmpegBinary, media, urls, options);
  const enriched = media;
  const layout = audioLayoutOf(tracks, enriched.durationSeconds ?? 0);

  if (decision.mode === 'direct' || decision.mode === 'unsupported') {
    return { decision, plan: [], source, keyframeProbeMs: 0, tracks, ...layout };
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
      tracks,
      ...layout,
    };
  }

  const { segments, probeMs } = await segmentPlanOf(db, ffmpegBinary, {
    id: enriched.id,
    inputPath: enriched.rawPath ?? enriched.path,
    durationSeconds: enriched.durationSeconds ?? 0,
    sizeBytes: enriched.sizeBytes,
    mtimeMs: enriched.mtimeMs,
  });

  return { decision, plan: segments, source, keyframeProbeMs: probeMs, tracks, ...layout };
}

// ---------------------------------------------------------------------------
// Pistes audio et sous-titres
// ---------------------------------------------------------------------------

/**
 * Ce que le lecteur doit savoir des pistes d'un fichier.
 *
 * Calculé À PARTIR DE LA BASE, jamais en re-sondant : les tables `audio_track`
 * et `embedded_subtitle` sont remplies par la passe ffprobe, et relancer
 * ffprobe sur un MKV de 30 Go pour afficher un menu coûterait des secondes.
 */
export interface TrackSelection {
  audio: LabelledAudioTrack[];
  /**
   * Les lignes brutes, telles qu'elles sont en base.
   *
   * Portées ici pour que la résolution d'une préférence — qui a besoin du titre
   * pour écarter l'audiodescription — n'ait pas à refaire la requête.
   */
  audioRows: AudioTrackRow[];
  /** Index de flux de la piste retenue à l'ouverture, sans préférence. */
  defaultAudio: number | null;
  subtitles: LabelledSubtitleTrack[];
  /** Le fichier n'a QUE des sous-titres image : le sélecteur doit le dire. */
  imageOnlySubtitles: boolean;
}

export function tracksOf(db: Db, mediaFileId: number): TrackSelection {
  const audioRows = (
    db
      .prepare(
        `SELECT stream_index AS streamIndex, codec, channels, language, title, is_default AS isDefault
         FROM audio_track WHERE media_file_id = ? ORDER BY stream_index`,
      )
      .all(mediaFileId) as (Omit<AudioTrackRow, 'isDefault'> & { isDefault: number })[]
  ).map((row) => ({ ...row, isDefault: row.isDefault === 1 }));

  const subtitleRows = (
    db
      .prepare(
        `SELECT stream_index AS streamIndex, codec, language, title,
                is_forced AS isForced, is_default AS isDefault, is_image_based AS isImageBased
         FROM embedded_subtitle WHERE media_file_id = ? ORDER BY stream_index`,
      )
      .all(mediaFileId) as (Omit<SubtitleTrackRow, 'isForced' | 'isDefault' | 'isImageBased'> & {
      isForced: number;
      isDefault: number;
      isImageBased: number;
    })[]
  ).map((row) => ({
    ...row,
    isForced: row.isForced === 1,
    isDefault: row.isDefault === 1,
    isImageBased: row.isImageBased === 1,
  }));

  const selection = selectSubtitleTracks(subtitleRows);

  return {
    audio: labelAudioTracks(audioRows),
    audioRows,
    defaultAudio: pickDefaultAudio(audioRows),
    subtitles: selection.tracks,
    imageOnlySubtitles: selection.imageOnly,
  };
}

/**
 * Comment l'audio est produit : muxé dans la vidéo, ou à part.
 *
 * La décision est DÉTERMINISTE, tirée du seul nombre de pistes. C'est
 * indispensable : la session est créée à la première requête et réutilisée
 * ensuite, donc deux requêtes qui aboutiraient à des choix différents
 * produiraient un manifeste que la session ne sait pas honorer.
 */
export function audioLayoutOf(
  tracks: TrackSelection,
  durationSeconds: number,
): { muxedAudio: AudioChoice; audioRenditions: AudioRendition[]; audioPlan: PlannedSegment[] } {
  if (!needsSeparateAudio(tracks.audio.length)) {
    const only = tracks.audio[0];
    return {
      muxedAudio:
        only === undefined
          ? { kind: 'auto', channels: null }
          : { kind: 'stream', streamIndex: only.streamIndex, channels: only.channels },
      audioRenditions: [],
      audioPlan: [],
    };
  }

  return {
    // La vidéo ne porte alors AUCUN son : c'est ce que le manifeste annonce.
    muxedAudio: { kind: 'none' },
    audioRenditions: tracks.audio.map((track) => ({
      streamIndex: track.streamIndex,
      channels: track.channels,
    })),
    audioPlan: planAudioSegments(durationSeconds),
  };
}

export { SEGMENT_DURATION };
