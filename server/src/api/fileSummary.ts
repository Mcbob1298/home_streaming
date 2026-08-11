/**
 * Synthèse des fichiers d'une œuvre.
 *
 * Une série n'a PAS de fichier : ce sont ses épisodes qui en ont. La fiche
 * série demandait donc ses informations techniques à une table qui ne pouvait
 * rien lui répondre, et affichait « aucun fichier » sur 89 épisodes présents.
 *
 * D'où cette synthèse, qui remonte les mêmes chiffres pour les deux types :
 * les fichiers du film pour un film, ceux de tous ses épisodes pour une série.
 * Quand plusieurs valeurs coexistent — 1080p et 720p dans une même série — on
 * les affiche toutes plutôt que d'en élire une arbitrairement.
 */
import type { Db } from '../db/index.js';

export type WorkType = 'movie' | 'show';

export interface FileSummary {
  fileCount: number;
  /** Fichiers déjà passés par ffprobe. Le reste n'a pas de codec à montrer. */
  probedCount: number;
  totalBytes: number;
  durationSeconds: number | null;
  /** Débit moyen des fichiers sondés, en bits par seconde. */
  bitrate: number | null;
  containers: string[];
  resolutions: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  hdr: string[];
  audioLanguages: string[];
  subtitles: { text: number; image: number; external: number };
  /** Chemins des fichiers pour un film, dossiers de la série pour une série. */
  locations: string[];
  addedAt: string | null;
}

/** Sépare un chemin en segments, quel que soit le style de séparateur. */
function segmentsOf(value: string): string[] {
  return value.split(/[\\/]/);
}

function separatorOf(value: string): string {
  return value.includes('\\') ? '\\' : '/';
}

/**
 * Plus long dossier commun à un ensemble de chemins de fichiers.
 *
 * Sert à désigner « le dossier de la série » sans le stocker : il se déduit des
 * fichiers eux-mêmes. Les segments sont comparés entiers, jamais caractère par
 * caractère — sinon « Saison 1 » et « Saison 10 » produiraient un « Saison 1 »
 * qui n'existe pas.
 *
 * La comparaison ignore la casse, comme le fait Windows, mais la valeur rendue
 * garde la casse du premier chemin : c'est elle qu'on affiche.
 */
export function commonDirectory(paths: string[]): string | null {
  if (paths.length === 0) return null;

  const first = paths[0] as string;
  const separator = separatorOf(first);

  // Le dernier segment est un nom de fichier : il ne fait pas partie du dossier.
  let common = segmentsOf(first).slice(0, -1);

  for (const candidate of paths.slice(1)) {
    const other = segmentsOf(candidate).slice(0, -1);
    let shared = 0;
    while (
      shared < common.length &&
      shared < other.length &&
      (common[shared] as string).toLowerCase() === (other[shared] as string).toLowerCase()
    ) {
      shared += 1;
    }
    common = common.slice(0, shared);
    if (common.length === 0) break;
  }

  if (common.length === 0) return null;
  return common.join(separator);
}

/**
 * Dossiers de saison, à remonter d'un cran.
 *
 * Une série dont une SEULE saison est sur le disque a pour dossier commun
 * « … \\One Piece\\Saison 01 ». C'est exact mais trompeur : la fiche annonce le
 * dossier de la série, pas celui d'une de ses saisons. On remonte donc quand le
 * dernier segment n'est qu'un numéro de saison.
 */
const SEASON_FOLDER_RE = /^(?:saisons?|seasons?|s)[\s._-]*\d{1,3}$/i;

/**
 * Dossier de la série : le dossier commun, remonté au-dessus d'une saison.
 *
 * Ne remonte jamais au-delà de la racine de bibliothèque, faute de quoi une
 * série rangée à plat sous « \\NAS\\Séries\\Saison 1 » ferait afficher
 * « \\NAS\\Séries » comme dossier de la série.
 */
export function showDirectory(paths: string[], rootPath: string): string | null {
  const common = commonDirectory(paths);
  if (common === null) return null;

  const segments = segmentsOf(common);
  const last = segments.at(-1);
  if (last === undefined || !SEASON_FOLDER_RE.test(last)) return common;

  const parent = segments.slice(0, -1).join(separatorOf(common));
  return parent.length > rootPath.length ? parent : common;
}

/** Trie les définitions de la plus haute à la plus basse. */
function heightOf(resolution: string): number {
  const height = Number(resolution.split('x')[1]);
  return Number.isFinite(height) ? height : 0;
}

/** Valeurs distinctes, vides écartées, ordre stable. */
function distinct(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value === null) continue;
    const trimmed = value.trim();
    if (trimmed !== '') seen.add(trimmed);
  }
  return [...seen];
}

interface FileRow {
  id: number;
  path: string;
  rootPath: string;
  sizeBytes: number;
  container: string | null;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  durationSeconds: number | null;
  bitrate: number | null;
  hdr: string | null;
  addedAt: string;
}

/** Portée SQL : les fichiers du film, ou ceux de tous les épisodes de la série. */
function scopeFor(type: WorkType): { join: string; where: string } {
  return type === 'movie'
    ? { join: '', where: 'f.movie_id = ?' }
    : { join: 'JOIN episode e ON e.id = f.episode_id', where: 'e.show_id = ?' };
}

export function fileSummaryOf(db: Db, type: WorkType, workId: number): FileSummary {
  const scope = scopeFor(type);

  const files = db
    .prepare(
      `SELECT f.id, f.path, r.path AS rootPath, f.size_bytes AS sizeBytes, f.container,
              f.resolution, f.video_codec AS videoCodec, f.audio_codec AS audioCodec,
              f.duration_seconds AS durationSeconds, f.bitrate, f.hdr,
              f.first_seen_at AS addedAt
       FROM media_file f
       ${scope.join}
       JOIN library_root r ON r.id = f.library_root_id
       WHERE ${scope.where} AND f.present = 1
       ORDER BY f.path`,
    )
    .all(workId) as FileRow[];

  const audioLanguages = (
    db
      .prepare(
        `SELECT DISTINCT a.language AS language
         FROM audio_track a
         JOIN media_file f ON f.id = a.media_file_id
         ${scope.join}
         WHERE ${scope.where} AND f.present = 1 AND a.language IS NOT NULL
         ORDER BY a.language`,
      )
      .all(workId) as { language: string }[]
  ).map((row) => row.language);

  const embedded = db
    .prepare(
      `SELECT
         SUM(CASE WHEN s.is_image_based = 0 THEN 1 ELSE 0 END) AS text,
         SUM(CASE WHEN s.is_image_based = 1 THEN 1 ELSE 0 END) AS image
       FROM embedded_subtitle s
       JOIN media_file f ON f.id = s.media_file_id
       ${scope.join}
       WHERE ${scope.where} AND f.present = 1`,
    )
    .get(workId) as { text: number | null; image: number | null };

  const external = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM subtitle s
       JOIN media_file f ON f.id = s.media_file_id
       ${scope.join}
       WHERE ${scope.where} AND f.present = 1 AND s.present = 1`,
    )
    .get(workId) as { total: number };

  const probed = files.filter((file) => file.videoCodec !== null || file.resolution !== null);

  /*
   * Le débit moyen ne porte que sur les fichiers sondés. Diviser par le total
   * ferait passer une série à moitié sondée pour une série à moitié compressée.
   */
  const withBitrate = files.filter((file) => file.bitrate !== null);
  const bitrate =
    withBitrate.length === 0
      ? null
      : Math.round(withBitrate.reduce((sum, file) => sum + (file.bitrate as number), 0) / withBitrate.length);

  const withDuration = files.filter((file) => file.durationSeconds !== null);
  const durationSeconds =
    withDuration.length === 0
      ? null
      : withDuration.reduce((sum, file) => sum + (file.durationSeconds as number), 0);

  /*
   * Un film montre le chemin de ses fichiers, une série le dossier qui les
   * contient. Le dossier est déduit par racine de bibliothèque : une série
   * présente sur deux partages en a deux, et un préfixe commun aux deux
   * remonterait bien trop haut pour vouloir dire quelque chose.
   */
  let locations: string[];
  if (type === 'movie') {
    locations = files.map((file) => file.path);
  } else {
    const byRoot = new Map<string, string[]>();
    for (const file of files) {
      const list = byRoot.get(file.rootPath) ?? [];
      list.push(file.path);
      byRoot.set(file.rootPath, list);
    }
    locations = [...byRoot.entries()]
      .map(([rootPath, paths]) => showDirectory(paths, rootPath))
      .filter((path): path is string => path !== null);
  }

  const addedDates = files.map((file) => file.addedAt).sort();

  return {
    fileCount: files.length,
    probedCount: probed.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    durationSeconds,
    bitrate,
    containers: distinct(files.map((file) => file.container)).sort(),
    resolutions: distinct(files.map((file) => file.resolution)).sort((a, b) => heightOf(b) - heightOf(a)),
    videoCodecs: distinct(files.map((file) => file.videoCodec)).sort(),
    audioCodecs: distinct(files.map((file) => file.audioCodec)).sort(),
    hdr: distinct(files.map((file) => file.hdr)).sort(),
    audioLanguages,
    subtitles: {
      text: embedded.text ?? 0,
      image: embedded.image ?? 0,
      external: external.total,
    },
    locations,
    addedAt: addedDates[0] ?? null,
  };
}
