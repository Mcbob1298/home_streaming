/**
 * Découpe d'un fichier : obtention des images clés, mise en cache, plan.
 *
 * Le plan est le contrat entre le manifeste et ffmpeg. Il doit être IDENTIQUE
 * des deux côtés, et stable d'une requête à l'autre — d'où le cache en base,
 * invalidé par l'empreinte du fichier.
 */
import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';
import { ffprobeFor, readKeyframes } from './keyframes.js';
import {
  PRIMER_COUNT,
  PRIMER_DURATION,
  SEGMENT_DURATION,
  planFromKeyframes,
  type PlannedSegment,
} from './segments.js';

export interface MediaForPlan {
  id: number;
  inputPath: string;
  durationSeconds: number;
  sizeBytes: number;
  mtimeMs: number;
}

/** Empreinte du fichier : si elle change, la découpe est refaite. */
function fingerprintOf(media: MediaForPlan): string {
  return `${media.sizeBytes}:${Math.floor(media.mtimeMs)}`;
}

function readCache(db: Db, media: MediaForPlan): number[] | null {
  const row = db
    .prepare('SELECT fingerprint, times_json FROM keyframe_index WHERE media_file_id = ?')
    .get(media.id) as { fingerprint: string; times_json: string } | undefined;

  if (row === undefined || row.fingerprint !== fingerprintOf(media)) return null;

  try {
    const times = JSON.parse(row.times_json) as unknown;
    return Array.isArray(times) && times.every((value) => typeof value === 'number') ? times : null;
  } catch {
    return null;
  }
}

function writeCache(db: Db, media: MediaForPlan, times: number[]): void {
  db.prepare(
    `INSERT INTO keyframe_index (media_file_id, fingerprint, times_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(media_file_id) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       times_json  = excluded.times_json,
       created_at  = excluded.created_at`,
  ).run(media.id, fingerprintOf(media), JSON.stringify(times), nowIso());
}

export interface SegmentPlan {
  segments: PlannedSegment[];
  /** Vraie si les images clés viennent d'être énumérées, pas du cache. */
  probed: boolean;
  probeMs: number;
}

/**
 * Plan de découpe d'un fichier.
 *
 * Première lecture : ffprobe énumère les images clés, ~2 s pour un film de deux
 * heures. Lectures suivantes : le cache répond en une requête SQL.
 */
export async function segmentPlanOf(
  db: Db,
  ffmpegBinary: string,
  media: MediaForPlan,
): Promise<SegmentPlan> {
  const cached = readCache(db, media);
  if (cached !== null) {
    return { segments: buildPlan(cached, media.durationSeconds), probed: false, probeMs: 0 };
  }

  const startedAt = Date.now();
  const times = await readKeyframes(ffprobeFor(ffmpegBinary), media.inputPath);
  const probeMs = Date.now() - startedAt;

  if (times.length > 0) writeCache(db, media, times);

  return { segments: buildPlan(times, media.durationSeconds), probed: true, probeMs };
}

function buildPlan(times: number[], durationSeconds: number): PlannedSegment[] {
  return planFromKeyframes(times, durationSeconds, {
    target: SEGMENT_DURATION,
    primerCount: PRIMER_COUNT,
    primerTarget: PRIMER_DURATION,
  });
}
