/**
 * Accès à l'API. Un seul endroit qui connaît les URL et les formes de données.
 *
 * Les types reprennent exactement ce que renvoie le serveur : si l'API change,
 * TypeScript signale les pages à corriger.
 */

export interface Library {
  id: string;
  label: string;
  type: 'movie' | 'show';
  itemCount: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface MovieSummary {
  id: number;
  libraryId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  posterSrcSet: string | null;
  backdropPath: string | null;
  backdropSrcSet: string | null;
  /** Logo du titre, incrusté sur la vignette. Null pour 9 œuvres sur 481. */
  logoPath: string | null;
  logoSrcSet: string | null;
  addedAt: string;
  voteAverage: number | null;
  runtime: number | null;
  /** Accroche TMDB, utilisée comme sur-titre du repli sans logo. */
  tagline: string | null;
  genres: string[];
  /** Synopsis, tronqué à l'affichage dans le hero. */
  overview: string | null;
  fileCount: number;
  /** TEMPORAIRE — nombre de fichiers lisibles sans transcodage. Voir ListParams. */
  playableFileCount: number;
}

export interface ShowSummary {
  id: number;
  libraryId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  posterSrcSet: string | null;
  backdropPath: string | null;
  backdropSrcSet: string | null;
  logoPath: string | null;
  logoSrcSet: string | null;
  addedAt: string;
  voteAverage: number | null;
  status: string | null;
  genres: string[];
  overview: string | null;
  seasonCount: number;
  episodeCount: number;
  /** TEMPORAIRE — nombre d'épisodes lisibles sans transcodage. Voir ListParams. */
  playableFileCount: number;
}

export interface SubtitleInfo {
  id: number;
  fileName: string;
  format: string;
  language: string | null;
  forced: number;
  hearingImpaired: number;
}

export interface AudioTrackInfo {
  codec: string | null;
  channels: number | null;
  language: string | null;
}

export interface MediaFileInfo {
  id: number;
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  resolution: string | null;
  durationSeconds: number | null;
  rootPath: string;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  hdr: string | null;
  addedAt: string;
  subtitles: SubtitleInfo[];
  audioTracks: AudioTrackInfo[];
  embeddedSubtitles: { language: string | null; codec: string | null; isImageBased: number }[];
}

export interface GenreRef {
  id: number;
  name: string;
}

export interface PersonRef {
  id: number;
  name: string;
}

/**
 * Crédits d'une œuvre, déjà groupés par le serveur.
 *
 * Un film a des réalisateurs, une série des créateurs : les deux listes
 * existent toujours, l'une des deux est simplement vide.
 */
export interface Credits {
  directors: PersonRef[];
  creators: PersonRef[];
  cast: (PersonRef & { character: string | null })[];
}

/**
 * Synthèse des fichiers d'une œuvre.
 *
 * Une série n'a pas de fichier : ceux de ses épisodes sont agrégés ici. Quand
 * plusieurs valeurs coexistent — 1080p et 720p dans une même série — toutes
 * sont présentes.
 */
export interface FileSummary {
  fileCount: number;
  probedCount: number;
  totalBytes: number;
  durationSeconds: number | null;
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

export interface MovieDetail {
  id: number;
  libraryId: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  tagline: string | null;
  posterPath: string | null;
  posterSrcSet: string | null;
  backdropPath: string | null;
  backdropSrcSet: string | null;
  logoPath: string | null;
  logoSrcSet: string | null;
  addedAt: string;
  releaseDate: string | null;
  runtime: number | null;
  voteAverage: number | null;
  tmdbId: number | null;
  /** Classification par âge : « Tous publics », « 12 »… Null si TMDB n'en a pas. */
  certification: string | null;
  genres: GenreRef[];
  credits: Credits;
  files: MediaFileInfo[];
  fileSummary: FileSummary;
}

export interface EpisodeSummary {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeNumberEnd: number | null;
  title: string | null;
  overview: string | null;
  stillPath: string | null;
  stillSrcSet: string | null;
  airDate: string | null;
  runtime: number | null;
  fileCount: number;
  /** Fichier à ouvrir au clic sur « Lire ». */
  mediaFileId: number;
  /** TEMPORAIRE — 1 si l'épisode part tel quel dans un navigateur. */
  playableDirect: number;
}

export interface SeasonDetail {
  seasonNumber: number;
  title: string | null;
  overview: string | null;
  posterPath: string | null;
  airDate: string | null;
  episodes: EpisodeSummary[];
}

export interface ShowDetail {
  id: number;
  libraryId: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  posterSrcSet: string | null;
  backdropPath: string | null;
  backdropSrcSet: string | null;
  logoPath: string | null;
  logoSrcSet: string | null;
  addedAt: string;
  firstAirDate: string | null;
  status: string | null;
  numberOfSeasons: number | null;
  voteAverage: number | null;
  tmdbId: number | null;
  certification: string | null;
  genres: GenreRef[];
  credits: Credits;
  fileSummary: FileSummary;
  seasons: SeasonDetail[];
}

export interface Genre {
  id: number;
  name: string;
  movieCount: number;
  showCount: number;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/**
 * `remux` et `transcode` arriveront à l'étape suivante ; les nommer dès
 * maintenant fait signaler par TypeScript tout endroit qui ne les traite pas.
 */
export type PlaybackMode = 'direct' | 'unsupported';

/**
 * UNE SOURCE N'EST PAS UN FICHIER.
 *
 * Le type est explicite et fait autorité : rien dans le code ne doit déduire la
 * nature d'une source de son extension. Le jour où la lecture démarrera sur une
 * amorce pré-transcodée suivie d'un flux continu, `type` vaudra `hls` et seul
 * le branchement dans VideoSurface changera.
 */
export type SourceType = 'file' | 'hls';

export interface PlaybackSource {
  url: string;
  type: SourceType;
}

export interface SubtitleTrack {
  id: number;
  url: string;
  language: string | null;
  label: string;
  format: string;
  forced: number;
  hearingImpaired: number;
}

export interface PlaybackContext {
  kind: 'movie' | 'episode';
  /** Titre du film, ou de la série pour un épisode. */
  title: string;
  /** « S01:E04 Le goût du risque » pour un épisode, null pour un film. */
  subtitle: string | null;
  workId: number;
  backdropPath: string | null;
  backdropSrcSet: string | null;
  durationSeconds: number | null;
}

/** Une piste proposée dans le menu de l'engrenage. */
export interface TrackOption {
  /** Index ABSOLU du flux dans le fichier. C'est l'identifiant de la piste. */
  streamIndex: number;
  label: string;
  language: string | null;
}

export interface SubtitleOption extends TrackOption {
  kind: 'forced' | 'sdh' | 'full';
  /**
   * Le WebVTT est-il extrait et servable ?
   *
   * Une extraction traverse le fichier entier — plus de cinq minutes sur un
   * remux 4K. La lecture démarre sans attendre, et les pistes deviennent
   * disponibles au fur et à mesure.
   */
  ready?: boolean;
}

/** Ce que le sélecteur affiche pendant qu'une extraction tourne. */
export interface SubtitleReadiness {
  tracks: (SubtitleOption & { ready: boolean })[];
  /** Vrai tant qu'il reste des pistes à produire. */
  preparing: boolean;
  imageOnlySubtitles: boolean;
}

export interface Playability {
  mediaFileId: number;
  mode: PlaybackMode;
  /** Null quand il n'y a rien à lire. */
  source: PlaybackSource | null;
  reason: string;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  media: PlaybackContext | null;
  next: { mediaFileId: number; label: string } | null;
  subtitles: SubtitleTrack[];
  /**
   * Position de reprise, en secondes. Zéro si l'œuvre n'a jamais été commencée.
   *
   * Elle arrive AVEC la décision de lecture, dans la même réponse : demandée à
   * part, la vidéo démarrerait à zéro puis sauterait sous les yeux du spectateur.
   */
  resumeSeconds: number;

  /** Pistes audio du fichier, libellées. Vide sur un fichier muet. */
  audioTracks: TrackOption[];
  /** Piste à ouvrir : préférence mémorisée, sinon règle automatique. */
  defaultAudioStream: number | null;
  /** Sous-titres embarqués exposés. Les pistes image en sont écartées. */
  embeddedSubtitles: SubtitleOption[];
  /** Sous-titre à activer à l'ouverture. Null pour « Désactivés ». */
  defaultSubtitleStream: number | null;
  /**
   * Le fichier n'a QUE des sous-titres image.
   *
   * Le sélecteur le dit alors explicitement : ne rien afficher laisserait
   * croire que le fichier n'en a aucun, ce qui est faux.
   */
  imageOnlySubtitles: boolean;
}

// ---------------------------------------------------------------------------
// Reprise de lecture
// ---------------------------------------------------------------------------

/** Ce que la progression désigne : un film, ou un épisode précis. Jamais une série. */
export type MediaType = 'movie' | 'episode';

/**
 * Une entrée de « Continuer à regarder ».
 *
 * La progression est portée par l'ŒUVRE : `mediaId` désigne le film ou
 * l'épisode dont la position est retenue, `workId` le film ou la SÉRIE dont la
 * fiche s'ouvre au clic.
 */
export interface ContinueEntry {
  kind: 'movie' | 'show';
  workId: number;
  title: string;
  subtitle: string | null;
  mediaFileId: number;
  positionSeconds: number;
  /** Entre 0 et 1, pour la barre de la vignette. */
  ratio: number;
  /** « Il reste 36 min », ou « Épisode suivant ». */
  label: string;
  updatedAt: string;
  backdropPath: string | null;
  backdropSrcSet: string | null;
  logoPath: string | null;
  logoSrcSet: string | null;
  posterPath: string | null;
  posterSrcSet: string | null;
  year: number | null;
  genres: string[];
  mediaType: MediaType;
  mediaId: number;
}

/** Ce que le lecteur envoie. Des faits : jamais le verdict « vu », qui est au serveur. */
export interface ProgressReport {
  mediaFileId: number;
  positionSeconds: number;
  durationSeconds: number | null;
}

export interface ProgressSnapshot {
  positionSeconds: number;
  durationSeconds: number | null;
  watched: boolean;
  /** Dernier fichier ouvert, pour rouvrir la même version. Null si jamais commencé. */
  mediaFileId: number | null;
}

/** Progression d'un épisode dans la grille d'une série. */
export interface EpisodeProgress {
  episodeId: number;
  positionSeconds: number;
  durationSeconds: number | null;
  watched: boolean;
  /** Entre 0 et 1. Zéro pour un épisode jamais commencé. */
  ratio: number;
}

/**
 * Où reprendre une série.
 *
 * `resume` désigne l'épisode en cours, `next` le suivant quand le dernier
 * regardé est terminé. La règle est celle de la rangée d'accueil : la fiche et
 * l'accueil ne peuvent pas désigner deux épisodes différents.
 */
export interface ShowResume {
  kind: 'resume' | 'next';
  episodeId: number;
  mediaFileId: number;
  /** « S01:E04 Le goût du risque ». */
  label: string;
  /** « S01:E04 » seul, pour les boutons. */
  numbering: string;
  positionSeconds: number;
}

export interface ShowProgress {
  episodes: EpisodeProgress[];
  resume: ShowResume | null;
}

export type SortField = 'title' | 'year' | 'added';

export interface ListParams {
  library?: string;
  search?: string;
  sort?: SortField;
  page?: number;
  /** Identifiant de genre, pour les rangées thématiques et les filtres. */
  genre?: number;
  /**
   * TEMPORAIRE — `direct` ne garde que les œuvres lisibles sans transcodage.
   *
   * 143 fichiers sur 2796 sont dans ce cas, éparpillés dans la bibliothèque.
   * Le filtre, la pastille des vignettes et « npm run playable » disparaîtront
   * ensemble quand le transcodage rendra tout lisible.
   */
  playable?: 'direct';
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${response.status} — ${message || response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * Écriture. Même traitement d'erreur que `getJson`, et tolère le 204 sans corps
 * que renvoient les routes de marquage.
 */
async function send<T>(url: string, method: 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${response.status} — ${message || response.statusText}`);
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

function buildQuery(params: ListParams): string {
  const search = new URLSearchParams();
  if (params.library !== undefined) search.set('library', params.library);
  if (params.search !== undefined && params.search !== '') search.set('search', params.search);
  if (params.sort !== undefined) search.set('sort', params.sort);
  if (params.page !== undefined && params.page > 1) search.set('page', String(params.page));
  if (params.genre !== undefined) search.set('genre', String(params.genre));
  if (params.playable !== undefined) search.set('playable', params.playable);
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

export const api = {
  libraries: () => getJson<Library[]>('/api/libraries'),
  genres: () => getJson<Genre[]>('/api/genres'),
  movies: (params: ListParams) => getJson<Page<MovieSummary>>(`/api/movies${buildQuery(params)}`),
  shows: (params: ListParams) => getJson<Page<ShowSummary>>(`/api/shows${buildQuery(params)}`),
  movie: (id: number | string) => getJson<MovieDetail>(`/api/movies/${id}`),
  show: (id: number | string) => getJson<ShowDetail>(`/api/shows/${id}`),
  playability: (mediaFileId: number | string) =>
    getJson<Playability>(`/api/stream/${mediaFileId}/playability`),

  /**
   * Mémorise un choix de piste.
   *
   * On envoie des index de flux — ce que le lecteur connaît ; le serveur en
   * retient la LANGUE, qui seule traverse les épisodes d'une série.
   */
  saveTrackChoice: (
    mediaFileId: number,
    choice: { audioStream: number | null; subtitleStream: number | null },
  ) => send<null>(`/api/stream/${mediaFileId}/tracks`, 'POST', choice),

  // --- Reprise de lecture --------------------------------------------------
  continueWatching: () => getJson<ContinueEntry[]>('/api/progress/continue'),

  progressOf: (mediaType: MediaType, mediaId: number | string) =>
    getJson<ProgressSnapshot>(`/api/progress/${mediaType}/${mediaId}`),

  /** État d'extraction des sous-titres embarqués, interrogé pendant la préparation. */
  subtitleReadiness: (mediaFileId: number | string) =>
    getJson<SubtitleReadiness>(`/api/stream/${mediaFileId}/subtitles`),

  /** Progression de tous les épisodes d'une série, et son point de reprise. */
  showProgress: (showId: number | string) => getJson<ShowProgress>(`/api/progress/show/${showId}`),

  /**
   * Enregistre une position. Le corps est aussi celui qu'envoie `sendBeacon` à
   * la fermeture de la page : les deux chemins doivent rester identiques.
   */
  saveProgress: (body: ProgressReport) =>
    send<{ watched: boolean; mediaType: MediaType; mediaId: number }>('/api/progress', 'POST', body),

  setWatched: (mediaType: MediaType, mediaId: number, watched: boolean) =>
    send<null>(`/api/progress/${mediaType}/${mediaId}/${watched ? 'watched' : 'unwatched'}`, 'POST'),

  forgetProgress: (mediaType: MediaType, mediaId: number) =>
    send<null>(`/api/progress/${mediaType}/${mediaId}`, 'DELETE'),
};
