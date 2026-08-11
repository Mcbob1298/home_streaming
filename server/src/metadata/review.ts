/**
 * Service de l'écran de review : la file des entrées à trancher, et la
 * recherche manuelle.
 *
 * La file est construite à la volée depuis `tmdb_match`. Elle ne contient que
 * ce qui reste indécis — les entrées appliquées et les entrées volontairement
 * ignorées n'y reviennent jamais.
 */
import type { Db } from '../db/index.js';
import { matchResults, type ScoredCandidate } from './match.js';
import { getWork, type TargetType } from './store.js';
import { TmdbClient, type TmdbSearchResponse, type TmdbSearchResult } from './tmdb.js';

/**
 * Identifiant d'une entrée de review : « movie-123 », « show-45 ».
 *
 * On n'utilise pas l'identifiant de la ligne `tmdb_match` : le bouton
 * « Corriger l'association » doit fonctionner même pour une œuvre qui n'a
 * jamais été appariée, donc sans ligne.
 */
export interface ReviewKey {
  type: TargetType;
  id: number;
}

export function parseReviewKey(value: string): ReviewKey | null {
  const match = /^(movie|show)-(\d+)$/.exec(value);
  if (match === null) return null;
  return { type: match[1] as TargetType, id: Number(match[2]) };
}

export function reviewKeyOf(type: TargetType, id: number): string {
  return `${type}-${id}`;
}

export interface ReviewEntry {
  key: string;
  type: TargetType;
  targetId: number;
  status: string;
  /** Titre tel que le parser l'a extrait du nom de fichier. */
  parsedTitle: string;
  parsedYear: number | null;
  /** Chemins complets des fichiers — souvent ce qui permet de trancher. */
  filePaths: string[];
  candidates: ScoredCandidate[];
  tmdbId: number | null;
  confidence: number | null;
  reason: string | null;
  manuallyMatched: boolean;
  /** Affiche actuellement associée, s'il y en a une — utile pour juger d'une correction. */
  currentPosterPath: string | null;
}

/** Affiche déjà enregistrée pour cette œuvre. */
function currentPosterOf(db: Db, type: TargetType, id: number): string | null {
  const table = type === 'movie' ? 'movie' : 'show';
  const row = db.prepare(`SELECT poster_path FROM ${table} WHERE id = ?`).get(id) as
    | { poster_path: string | null }
    | undefined;
  return row?.poster_path ?? null;
}

/** Les fichiers d'une œuvre, chemin complet, pour affichage. */
function filePathsOf(db: Db, type: TargetType, id: number): string[] {
  const sql =
    type === 'movie'
      ? `SELECT path FROM media_file WHERE movie_id = ? AND present = 1 ORDER BY path`
      : `SELECT f.path FROM media_file f JOIN episode e ON e.id = f.episode_id
         WHERE e.show_id = ? AND f.present = 1 ORDER BY f.path LIMIT 20`;
  return (db.prepare(sql).all(id) as { path: string }[]).map((row) => row.path);
}

/** Ne garde que les œuvres qui ont encore au moins un fichier sur le disque. */
const LIVE_MATCH = `
  (m.target_type = 'movie' AND EXISTS (
     SELECT 1 FROM media_file f WHERE f.movie_id = m.target_id AND f.present = 1))
  OR
  (m.target_type = 'show' AND EXISTS (
     SELECT 1 FROM episode e JOIN media_file f ON f.episode_id = e.id AND f.present = 1
     WHERE e.show_id = m.target_id))
`;

interface MatchRow {
  target_type: TargetType;
  target_id: number;
  status: string;
  tmdb_id: number | null;
  confidence: number | null;
  reason: string | null;
  candidates_json: string | null;
  searched_title: string | null;
  searched_year: number | null;
  manually_matched: number;
}

function toEntry(db: Db, row: MatchRow): ReviewEntry {
  const work = getWork(db, row.target_type, row.target_id);
  return {
    key: reviewKeyOf(row.target_type, row.target_id),
    type: row.target_type,
    targetId: row.target_id,
    status: row.status,
    parsedTitle: row.searched_title ?? work?.title ?? '',
    parsedYear: row.searched_year ?? work?.year ?? null,
    filePaths: filePathsOf(db, row.target_type, row.target_id),
    candidates: JSON.parse(row.candidates_json ?? '[]') as ScoredCandidate[],
    tmdbId: row.tmdb_id,
    confidence: row.confidence,
    reason: row.reason,
    manuallyMatched: row.manually_matched === 1,
    currentPosterPath: currentPosterOf(db, row.target_type, row.target_id),
  };
}

const QUEUE_SQL = `
  SELECT target_type, target_id, status, tmdb_id, confidence, reason, candidates_json,
         searched_title, searched_year, manually_matched
  FROM tmdb_match m
  WHERE m.status IN ('needs_review', 'not_found') AND (${LIVE_MATCH})
  ORDER BY m.target_type, m.searched_title COLLATE NOCASE
`;

/** Les clés de la file, dans l'ordre d'affichage. Sert au compteur « 12 / 62 ». */
export function reviewQueueKeys(db: Db): string[] {
  return (db.prepare(QUEUE_SQL).all() as MatchRow[]).map((row) => reviewKeyOf(row.target_type, row.target_id));
}

export function reviewQueue(db: Db): ReviewEntry[] {
  return (db.prepare(QUEUE_SQL).all() as MatchRow[]).map((row) => toEntry(db, row));
}

/**
 * Une entrée précise, qu'elle soit dans la file ou non.
 *
 * Une œuvre déjà appariée n'a pas d'entrée en attente : on en fabrique une à la
 * volée, sans rien écrire en base, pour que « Corriger l'association » ouvre le
 * même écran.
 */
export function reviewEntry(db: Db, key: ReviewKey): ReviewEntry | null {
  const row = db
    .prepare(
      `SELECT target_type, target_id, status, tmdb_id, confidence, reason, candidates_json,
              searched_title, searched_year, manually_matched
       FROM tmdb_match WHERE target_type = ? AND target_id = ?`,
    )
    .get(key.type, key.id) as MatchRow | undefined;

  if (row !== undefined) return toEntry(db, row);

  const work = getWork(db, key.type, key.id);
  if (work === undefined) return null;

  return {
    key: reviewKeyOf(key.type, key.id),
    type: key.type,
    targetId: key.id,
    status: 'needs_review',
    parsedTitle: work.title,
    parsedYear: work.year,
    filePaths: filePathsOf(db, key.type, key.id),
    candidates: [],
    tmdbId: null,
    confidence: null,
    reason: null,
    manuallyMatched: false,
    currentPosterPath: currentPosterOf(db, key.type, key.id),
  };
}

/** Entrée suivante dans la file, une fois `key` traitée. */
export function nextInQueue(db: Db, key: ReviewKey): ReviewEntry | null {
  const queue = reviewQueue(db);
  const current = reviewKeyOf(key.type, key.id);
  // L'entrée courante vient de sortir de la file : la suivante a pris sa place.
  const index = queue.findIndex((entry) => entry.key === current);
  if (index >= 0) return queue[index] ?? null;
  return queue[0] ?? null;
}

/**
 * Recherche manuelle, en français ET en anglais.
 *
 * Les deux langues systématiquement, sans sélecteur : un film japonais est
 * rangé tantôt sous son titre français, tantôt sous son titre anglais, et
 * demander à l'utilisateur de deviner lequel interroger n'a pas de sens. Les
 * deux jeux de résultats sont fusionnés et dédoublonnés sur l'identifiant TMDB.
 */
export async function searchTmdb(
  client: TmdbClient,
  type: TargetType,
  title: string,
  year: number | null,
): Promise<ScoredCandidate[]> {
  const endpoint = type === 'movie' ? '/search/movie' : '/search/tv';

  const query = (language: string): Record<string, string | number | undefined> => {
    const params: Record<string, string | number | undefined> = {
      query: title,
      language,
      include_adult: 'false',
    };
    if (year !== null) {
      if (type === 'movie') params.year = year;
      else params.first_air_date_year = year;
    }
    return params;
  };

  const [french, english] = await Promise.all([
    client.get<TmdbSearchResponse>(endpoint, query('fr-FR')),
    client.get<TmdbSearchResponse>(endpoint, query('en-US')),
  ]);

  const byId = new Map<number, TmdbSearchResult>();
  // Le résultat français passe en premier : à contenu égal, c'est son libellé
  // qu'on veut afficher.
  for (const result of [...(french.results ?? []), ...(english.results ?? [])]) {
    if (!byId.has(result.id)) byId.set(result.id, result);
  }

  return matchResults({ title, year }, [...byId.values()]).candidates;
}

/** Récupère une œuvre TMDB par son identifiant, pour l'affichage avant validation. */
export async function fetchById(
  client: TmdbClient,
  type: TargetType,
  tmdbId: number,
): Promise<ScoredCandidate | null> {
  const endpoint = type === 'movie' ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  try {
    const details = await client.get<TmdbSearchResult>(endpoint, { language: 'fr-FR' });
    const [candidate] = matchResults({ title: '', year: null }, [details]).candidates;
    return candidate ?? null;
  } catch {
    return null;
  }
}
