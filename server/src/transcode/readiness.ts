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
 * Instant à partir duquel le verrou s'applique.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * « NE PAS CACHER » ET « LES SOUS-TITRES SONT EXTRAITS » SONT DEUX CHOSES.
 *
 * Les confondre a produit un vrai défaut : la reprise de données marquait les
 * 2 796 fichiers existants comme PRÊTS, donc 2 306 d'entre eux annonçaient des
 * pistes de sous-titres qui n'existaient sur aucun disque. Ouvrir l'un d'eux
 * listait des pistes dont le `.vtt` répondait 409.
 *
 * `subtitles_fingerprint` ne dit plus qu'UNE chose, et elle est vraie : les
 * WebVTT de cette version du fichier sont écrits. La préservation de la
 * bibliothèque existante est devenue ce qu'elle aurait dû être dès le début —
 * une règle de VISIBILITÉ, pas un mensonge sur l'état.
 *
 * Un fichier vu pour la première fois AVANT cet instant reste visible même s'il
 * n'est pas préparé : il l'a toujours été, et la passe l'enrichit sans le
 * cacher. Un fichier vu APRÈS n'apparaît que complet.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export const GATE_KEY = 'subtitles_gate_since';

/** L'instant du verrou, ou null quand il n'a jamais été posé. */
export function gateSince(db: Db): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(GATE_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Condition SQL « cette œuvre est visible » pour un alias de `media_file`.
 *
 * Prête, OU antérieure au verrou. La sous-requête sur `meta` est évaluée par
 * SQLite une fois par requête, pas une fois par ligne.
 */
function visibleSql(alias: string): string {
  return `(${readySql(alias)} OR ${alias}.first_seen_at < COALESCE(
     (SELECT value FROM meta WHERE key = '${GATE_KEY}'), '9999'))`;
}

/**
 * Un film est disponible quand il a AU MOINS un fichier présent et prêt.
 *
 * « Au moins un » et non « tous » : un film en version longue et version cinéma
 * dont une seule est préparée reste regardable, c'est celle-là qu'on ouvrira.
 */
export const MOVIE_AVAILABLE = `EXISTS (
  SELECT 1 FROM media_file f
  WHERE f.movie_id = movie.id AND f.present = 1 AND ${visibleSql('f')}
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
  WHERE e.show_id = show.id AND ${visibleSql('f')}
)`;

/** Un épisode est disponible aux mêmes conditions qu'un film. */
export const EPISODE_AVAILABLE = `EXISTS (
  SELECT 1 FROM media_file f
  WHERE f.episode_id = episode.id AND f.present = 1 AND ${visibleSql('f')}
)`;
