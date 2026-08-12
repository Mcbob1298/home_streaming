/**
 * Règles de la reprise de lecture.
 *
 * Module PUR : ni base, ni lecteur, ni horloge implicite — l'instant courant est
 * toujours passé en paramètre. C'est ce qui rend testables les cas tordus, et
 * ils sont nombreux : un épisode terminé en fin de saison, une entrée vieille de
 * six mois, un fichier dont la durée est inconnue.
 */

/**
 * Au-delà de ce seuil, l'œuvre est considérée VUE.
 *
 * 90 % et non 100 % : personne ne regarde le générique de fin, et une œuvre
 * qu'on laisserait à 97 % resterait éternellement dans la liste.
 */
export const WATCHED_RATIO = 0.9;

/**
 * En deçà, l'œuvre n'apparaît pas.
 *
 * Ouvrir un film deux minutes puis changer d'avis ne doit pas polluer la
 * rangée. Cinq pour cent d'un film de deux heures font six minutes.
 */
export const STARTED_RATIO = 0.05;

/** Une entrée sans activité depuis six mois disparaît. */
export const EXPIRY_DAYS = 182;

export type MediaType = 'movie' | 'episode';

export interface ProgressEntry {
  mediaId: number;
  mediaType: MediaType;
  positionSeconds: number;
  /** Durée totale connue au moment de l'enregistrement. Null si inconnue. */
  durationSeconds: number | null;
  updatedAt: string;
  watched: boolean;
}

/** Avancement entre 0 et 1. Zéro quand la durée est inconnue. */
export function ratioOf(positionSeconds: number, durationSeconds: number | null): number {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return 0;
  return Math.min(1, positionSeconds / durationSeconds);
}

/**
 * L'œuvre est-elle terminée ?
 *
 * Sert à l'enregistrement : c'est le serveur qui décide, pas le lecteur. Une
 * durée inconnue ne permet pas de conclure — on ne marque alors rien.
 */
export function isFinished(positionSeconds: number, durationSeconds: number | null): boolean {
  if (durationSeconds === null || durationSeconds <= 0) return false;
  return ratioOf(positionSeconds, durationSeconds) >= WATCHED_RATIO;
}

/** L'entrée est-elle trop ancienne pour rester dans la rangée ? */
export function isExpired(updatedAt: string, now: Date): boolean {
  const updated = new Date(updatedAt).getTime();
  // Une date illisible ne doit pas faire disparaître une entrée par surprise.
  if (Number.isNaN(updated)) return false;
  return now.getTime() - updated > EXPIRY_DAYS * 24 * 3600 * 1000;
}

/**
 * Cette entrée mérite-t-elle sa place dans « Continuer à regarder » ?
 *
 * Quatre conditions, toutes nécessaires : commencée pour de bon, pas terminée,
 * pas marquée vue à la main, pas oubliée depuis six mois.
 */
export function belongsInContinue(entry: ProgressEntry, now: Date): boolean {
  if (entry.watched) return false;
  if (isExpired(entry.updatedAt, now)) return false;

  const ratio = ratioOf(entry.positionSeconds, entry.durationSeconds);
  return ratio >= STARTED_RATIO && ratio < WATCHED_RATIO;
}

/** « Il reste 36 min », « Il reste 1 h 12 ». */
export function remainingLabel(positionSeconds: number, durationSeconds: number | null): string | null {
  if (durationSeconds === null || durationSeconds <= 0) return null;

  const remaining = Math.max(0, durationSeconds - positionSeconds);
  const minutes = Math.round(remaining / 60);
  if (minutes <= 0) return null;
  if (minutes < 60) return `Il reste ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `Il reste ${hours} h` : `Il reste ${hours} h ${String(rest).padStart(2, '0')}`;
}

/**
 * « S11:E8 Le goût du risque », comme sur Disney+.
 *
 * Le lecteur, la rangée de reprise et le bouton des fiches désignent tous le
 * même épisode : ils doivent l'écrire de la même façon.
 */
export function episodeLabel(
  seasonNumber: number,
  episodeNumber: number,
  title: string | null,
): string {
  const numbering = `S${String(seasonNumber).padStart(2, '0')}:E${episodeNumber}`;
  return title === null || title.trim() === '' ? numbering : `${numbering} ${title}`;
}

// ---------------------------------------------------------------------------
// Séries : UNE seule entrée par série
// ---------------------------------------------------------------------------

export interface EpisodeState {
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  /** Fichier à ouvrir. Null quand l'épisode n'est plus sur le disque. */
  mediaFileId: number | null;
  positionSeconds: number;
  durationSeconds: number | null;
  updatedAt: string | null;
  watched: boolean;
}

export interface ShowEntry {
  episode: EpisodeState;
  /** `resume` reprend l'épisode en cours, `next` propose le suivant. */
  kind: 'resume' | 'next';
}

/** Ordre de diffusion : saison puis numéro d'épisode. */
function byAiring(a: EpisodeState, b: EpisodeState): number {
  return a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber;
}

/**
 * L'entrée unique d'une série dans « Continuer à regarder ».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNE SÉRIE = UNE VIGNETTE.
 *
 * Ni la série entière, ni un épisode par saison : l'épisode EN COURS, ou le
 * SUIVANT quand le dernier regardé est terminé. C'est ce qu'on veut voir en
 * arrivant, et c'est aussi ce qui évite qu'une série de onze saisons occupe
 * toute la rangée.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * L'épisode de référence est le dernier TOUCHÉ, pas le plus avancé dans la
 * série : quelqu'un qui revient en arrière pour revoir un épisode reprend là,
 * pas à l'endroit où il s'était arrêté la semaine d'avant.
 */
export function pickShowEntry(episodes: EpisodeState[], now: Date): ShowEntry | null {
  /*
   * À date égale, c'est l'épisode le PLUS AVANCÉ dans la série qui l'emporte.
   *
   * Les dates sont à la milliseconde : deux enregistrements peuvent tomber sur
   * la même. Sans départage, l'ordre dépendrait de celui que SQLite a rendu, et
   * la reprise désignerait un épisode ou l'autre selon les jours.
   */
  const touched = episodes
    .filter((episode) => episode.updatedAt !== null)
    .sort(
      (a, b) =>
        Date.parse(b.updatedAt as string) - Date.parse(a.updatedAt as string) || byAiring(b, a),
    );

  const latest = touched[0];
  if (latest === undefined) return null;
  if (isExpired(latest.updatedAt as string, now)) return null;

  const ratio = ratioOf(latest.positionSeconds, latest.durationSeconds);

  // En cours : on le reprend, à condition d'avoir dépassé le seuil de départ.
  if (!latest.watched && ratio >= STARTED_RATIO && ratio < WATCHED_RATIO) {
    return latest.mediaFileId === null ? null : { episode: latest, kind: 'resume' };
  }

  /*
   * Terminé — vu, ou au-delà des 90 %. On propose le suivant dans l'ordre de
   * diffusion, ce qui traverse naturellement les fins de saison.
   */
  if (latest.watched || ratio >= WATCHED_RATIO) {
    const next = episodes
      .filter((episode) => byAiring(episode, latest) > 0 && !episode.watched && episode.mediaFileId !== null)
      .sort(byAiring)[0];

    return next === undefined ? null : { episode: next, kind: 'next' };
  }

  /*
   * À peine commencé : rien à proposer. Ouvrir un épisode deux minutes ne doit
   * pas faire surgir la série dans la rangée.
   */
  return null;
}
