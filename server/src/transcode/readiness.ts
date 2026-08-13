/**
 * Disponibilité d'une œuvre : ses sous-titres sont-ils préparés ?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LE MODÈLE NETFLIX : L'ASSET EXISTE AVANT LE TITRE.
 *
 * Les sous-titres ne sont plus extraits pendant la lecture. Ils sont préparés en
 * amont, une fois, et servis comme des fichiers statiques. En contrepartie, un
 * titre dont la préparation n'est pas finie n'est pas proposé : mieux vaut ne
 * rien montrer que de montrer quelque chose d'incomplet.
 *
 * L'état tient dans UNE colonne, `media_file.subtitles_fingerprint`, qui porte
 * l'empreinte du fichier au moment où ses sous-titres ont été produits. Prêt
 * signifie « cette empreinte égale l'empreinte courante ». Un fichier réencodé
 * repasse donc en préparation sans qu'aucun code ne le décide.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import type { Db } from '../db/index.js';

/** L'empreinte d'un fichier : la même que celle du cache des images clés. */
export function fingerprintOf(sizeBytes: number, mtimeMs: number): string {
  return `${sizeBytes}-${Math.round(mtimeMs)}`;
}

/**
 * Condition SQL « ce fichier est prêt », pour un alias de `media_file`.
 *
 * Écrite ici et importée partout : une règle de disponibilité recopiée dans
 * cinq requêtes finit par diverger dans l'une des cinq.
 */
export function readySql(alias: string): string {
  return `${alias}.subtitles_fingerprint = ${alias}.size_bytes || '-' || CAST(${alias}.mtime_ms AS INTEGER)`;
}

/** Marque les sous-titres d'un fichier comme prêts, dans sa version courante. */
export function markReady(db: Db, mediaFileId: number): void {
  db.prepare(
    `UPDATE media_file
     SET subtitles_fingerprint = size_bytes || '-' || CAST(mtime_ms AS INTEGER)
     WHERE id = ?`,
  ).run(mediaFileId);
}

/** Remet un fichier en préparation. Utilisé quand une extraction est invalidée. */
export function markPending(db: Db, mediaFileId: number): void {
  db.prepare('UPDATE media_file SET subtitles_fingerprint = NULL WHERE id = ?').run(mediaFileId);
}

export function isReady(db: Db, mediaFileId: number): boolean {
  const row = db
    .prepare(`SELECT ${readySql('f')} AS ready FROM media_file f WHERE f.id = ?`)
    .get(mediaFileId) as { ready: number } | undefined;
  return row?.ready === 1;
}

// ---------------------------------------------------------------------------
// Ce que voient les routes de liste
// ---------------------------------------------------------------------------

/**
 * Un film est disponible quand il a AU MOINS un fichier présent et prêt.
 *
 * « Au moins un » et non « tous » : un film en version longue et version cinéma
 * dont une seule est préparée reste regardable, c'est celle-là qu'on ouvrira.
 */
export const MOVIE_AVAILABLE = `EXISTS (
  SELECT 1 FROM media_file f
  WHERE f.movie_id = movie.id AND f.present = 1 AND ${readySql('f')}
)`;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UNE SÉRIE N'EST JAMAIS MASQUÉE POUR UN ÉPISODE.
 *
 * Elle apparaît dès qu'UN épisode est prêt. Attendre que les vingt-quatre le
 * soient ferait disparaître One Piece pendant des heures parce qu'un seul
 * épisode est en cours de préparation — et c'est l'épisode, pas la série, que
 * l'utilisateur ne peut pas regarder. La grille le marque à sa place.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const SHOW_AVAILABLE = `EXISTS (
  SELECT 1 FROM episode e
  JOIN media_file f ON f.episode_id = e.id AND f.present = 1
  WHERE e.show_id = show.id AND ${readySql('f')}
)`;

/** Un épisode est disponible aux mêmes conditions qu'un film. */
export const EPISODE_AVAILABLE = `EXISTS (
  SELECT 1 FROM media_file f
  WHERE f.episode_id = episode.id AND f.present = 1 AND ${readySql('f')}
)`;
