/** Écriture d'un résultat ffprobe en base. */
import type { Db } from '../db/index.js';
import type { ProbeResult } from './ffprobe.js';

export interface ProbeTargetRow {
  id: number;
  /** Chemin exact du disque. Peut être null sur une base créée avant la phase 2. */
  raw_path: string | null;
  /** Forme NFC, utilisée en repli et pour les messages. */
  path: string;
  size_bytes: number;
  mtime_ms: number;
}

/** Fichiers présents à sonder, avec de quoi calculer leur empreinte. */
export function listProbeTargets(db: Db): ProbeTargetRow[] {
  return db
    .prepare(
      `SELECT id, raw_path, path, size_bytes, mtime_ms
       FROM media_file WHERE present = 1 ORDER BY id`,
    )
    .all() as ProbeTargetRow[];
}

/** Empreinte d'un fichier : si elle change, il faudra le re-sonder. */
export function fingerprintOf(row: { size_bytes: number; mtime_ms: number }): string {
  return `${row.size_bytes}:${row.mtime_ms}`;
}

export function getProbeTarget(db: Db, mediaFileId: number): ProbeTargetRow | undefined {
  return db
    .prepare('SELECT id, raw_path, path, size_bytes, mtime_ms FROM media_file WHERE id = ?')
    .get(mediaFileId) as ProbeTargetRow | undefined;
}

/**
 * Enregistre le résultat : colonnes techniques du fichier, pistes audio et
 * sous-titres embarqués.
 *
 * Les pistes sont remplacées et non complétées : ffprobe vient de dire ce que
 * contient le fichier, c'est la vérité du moment.
 */
export function saveProbeResult(db: Db, mediaFileId: number, result: ProbeResult): void {
  const updateFile = db.prepare(`
    UPDATE media_file SET
      container        = @container,
      video_codec      = @video_codec,
      audio_codec      = @audio_codec,
      resolution       = @resolution,
      duration_seconds = @duration_seconds,
      bitrate          = @bitrate,
      hdr              = @hdr
    WHERE id = @id
  `);

  const clearAudio = db.prepare('DELETE FROM audio_track WHERE media_file_id = ?');
  const clearSubtitles = db.prepare('DELETE FROM embedded_subtitle WHERE media_file_id = ?');

  const insertAudio = db.prepare(`
    INSERT INTO audio_track (media_file_id, stream_index, codec, channels, language, title, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSubtitle = db.prepare(`
    INSERT INTO embedded_subtitle
      (media_file_id, stream_index, codec, language, title, is_forced, is_default, is_image_based)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    updateFile.run({
      id: mediaFileId,
      container: result.container,
      video_codec: result.videoCodec,
      audio_codec: result.audioCodec,
      // « largeur x hauteur », ou null si la vidéo n'a pas de dimensions.
      resolution:
        result.width !== null && result.height !== null ? `${result.width}x${result.height}` : null,
      duration_seconds: result.durationSeconds,
      bitrate: result.bitrate,
      hdr: result.hdr,
    });

    clearAudio.run(mediaFileId);
    for (const track of result.audioTracks) {
      insertAudio.run(
        mediaFileId,
        track.streamIndex,
        track.codec,
        track.channels,
        track.language,
        track.title,
        track.isDefault ? 1 : 0,
      );
    }

    clearSubtitles.run(mediaFileId);
    for (const subtitle of result.subtitles) {
      insertSubtitle.run(
        mediaFileId,
        subtitle.streamIndex,
        subtitle.codec,
        subtitle.language,
        subtitle.title,
        subtitle.isForced ? 1 : 0,
        subtitle.isDefault ? 1 : 0,
        subtitle.isImageBased ? 1 : 0,
      );
    }
  });

  run();
}
