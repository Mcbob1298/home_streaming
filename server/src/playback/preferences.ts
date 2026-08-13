/**
 * Mémorisation des choix de piste, par utilisateur.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEUX PORTÉES, ET UN REPLI DE L'UNE SUR L'AUTRE.
 *
 * Le choix est retenu sur l'ŒUVRE — le film, ou la série entière — pour qu'un
 * anime commencé en japonais sous-titré français continue ainsi d'un épisode
 * au suivant, sans avoir à rouvrir le menu vingt-quatre fois.
 *
 * Il est AUSSI retenu globalement, comme dernier choix fait n'importe où. C'est
 * ce qui rend la première ouverture d'une NOUVELLE série correcte : quelqu'un
 * qui regarde tout en version originale sous-titrée n'a pas à le redire à
 * chaque série qu'il commence.
 *
 * L'ordre est donc : préférence de l'œuvre, puis préférence globale, puis la
 * règle automatique — français d'abord, et jamais l'audiodescription.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Comme la progression, l'identifiant d'utilisateur ne vient jamais de la
 * requête : il vient de `currentUserId()`.
 */
import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';
import type { SubtitleKind, TrackPreference } from './tracks.js';

/** Sur quoi porte une préférence. `global` est le dernier choix, où qu'il ait été fait. */
export type PreferenceScope = 'global' | 'movie' | 'show';

/** L'identifiant de la portée globale. Zéro : aucune œuvre ne porte cet identifiant. */
const GLOBAL_ID = 0;

interface PreferenceRow {
  audioLanguage: string | null;
  subtitlesEnabled: number;
  subtitleLanguage: string | null;
  subtitleKind: string | null;
}

function toPreference(row: PreferenceRow | undefined): TrackPreference | null {
  if (row === undefined) return null;
  return {
    audioLanguage: row.audioLanguage,
    subtitlesEnabled: row.subtitlesEnabled === 1,
    subtitleLanguage: row.subtitleLanguage,
    subtitleKind: (row.subtitleKind as SubtitleKind | null) ?? null,
  };
}

function readOne(db: Db, userId: number, scope: PreferenceScope, scopeId: number): TrackPreference | null {
  const row = db
    .prepare(
      `SELECT audio_language AS audioLanguage, subtitles_enabled AS subtitlesEnabled,
              subtitle_language AS subtitleLanguage, subtitle_kind AS subtitleKind
       FROM playback_preference
       WHERE user_id = ? AND scope_type = ? AND scope_id = ?`,
    )
    .get(userId, scope, scopeId) as PreferenceRow | undefined;

  return toPreference(row);
}

/**
 * La préférence qui s'applique à une œuvre.
 *
 * `workScope` et `workId` désignent le film ou la SÉRIE — jamais l'épisode :
 * c'est ce qui fait porter le choix sur toute la série.
 */
export function preferenceFor(
  db: Db,
  userId: number,
  workScope: 'movie' | 'show' | null,
  workId: number | null,
): TrackPreference | null {
  if (workScope !== null && workId !== null) {
    const own = readOne(db, userId, workScope, workId);
    if (own !== null) return own;
  }
  return readOne(db, userId, 'global', GLOBAL_ID);
}

/**
 * Enregistre un choix, sur l'œuvre ET globalement.
 *
 * Les deux écritures vont ensemble : un choix fait sur une série est aussi le
 * dernier choix fait tout court, et c'est lui qui servira de point de départ à
 * la série suivante.
 */
export function savePreference(
  db: Db,
  userId: number,
  workScope: 'movie' | 'show' | null,
  workId: number | null,
  preference: TrackPreference,
): void {
  const write = db.prepare(
    `INSERT INTO playback_preference
       (user_id, scope_type, scope_id, audio_language, subtitles_enabled,
        subtitle_language, subtitle_kind, updated_at)
     VALUES (@userId, @scope, @scopeId, @audioLanguage, @subtitlesEnabled,
             @subtitleLanguage, @subtitleKind, @updatedAt)
     ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET
       audio_language    = excluded.audio_language,
       subtitles_enabled = excluded.subtitles_enabled,
       subtitle_language = excluded.subtitle_language,
       subtitle_kind     = excluded.subtitle_kind,
       updated_at        = excluded.updated_at`,
  );

  const common = {
    userId,
    audioLanguage: preference.audioLanguage,
    subtitlesEnabled: preference.subtitlesEnabled ? 1 : 0,
    subtitleLanguage: preference.subtitleLanguage,
    subtitleKind: preference.subtitleKind,
    updatedAt: nowIso(),
  };

  const both = db.transaction(() => {
    if (workScope !== null && workId !== null) {
      write.run({ ...common, scope: workScope, scopeId: workId });
    }
    write.run({ ...common, scope: 'global', scopeId: GLOBAL_ID });
  });

  both();
}

/** Oublie la préférence d'une œuvre. La globale reste. */
export function forgetPreference(db: Db, userId: number, workScope: 'movie' | 'show', workId: number): void {
  db.prepare('DELETE FROM playback_preference WHERE user_id = ? AND scope_type = ? AND scope_id = ?').run(
    userId,
    workScope,
    workId,
  );
}
