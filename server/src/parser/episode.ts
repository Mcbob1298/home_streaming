/**
 * Parser de séries. Pur : entrée = un chemin relatif à la racine, sortie = un objet.
 */
import {
  cleanTitle,
  extractTitleAndYear,
  splitExtension,
  splitPathSegments,
  type ParseOptions,
  type TitleAndYear,
} from './common.js';
import { isMeaninglessTitle, isOnlyNoise } from './noise.js';

export interface ParsedEpisode {
  kind: 'episode';
  showTitle: string;
  showYear: number | null;
  seasonNumber: number;
  episodeNumber: number;
  /** Renseigné pour les épisodes doubles (S01E01-E02), sinon null. */
  episodeNumberEnd: number | null;
  episodeTitle: string | null;
  /** D'où vient le titre de la série : dossier (fiable) ou nom de fichier. */
  source: 'folder' | 'file';
}

/**
 * « S01E02 », « S01 E02 », « S01.E02 », « Saison 1 Episode 2 »,
 * « Season 01 - Episode 02 », et les épisodes doubles « S01E01-E02 »,
 * « S01E01E02 », « S01E01-02 ».
 *
 * Groupes : 1 = saison, 2 = épisode, 3 = fin de plage (forme « -E02 »),
 * 4 = fin de plage (forme « E01E02 »).
 *
 * La garde finale est `(?!\d)` et non `(?![\p{L}\p{N}])` : certains fichiers
 * collent le tag de langue au numéro, sans séparateur — « S11E17Multi.Web-DL ».
 * Interdire seulement un chiffre suffit à ne pas tronquer le numéro d'épisode,
 * et les lettres qui suivent seront de toute façon reconnues comme du bruit.
 */
const RE_SEASON_EPISODE =
  /(?<![\p{L}\p{N}])(?:saison|season|s)[ ._-]*(\d{1,2})[ ._-]*(?:épisode|episode|ep|e)[ ._-]*(\d{1,3})(?:[ ._-]*[-–][ ._-]*(?:s\d{1,2}[ ._-]*)?(?:épisode|episode|ep|e)?[ ._-]*(\d{1,3})|(?:épisode|episode|ep|e)(\d{1,3}))?(?!\d)/diu;

/**
 * « 1x02 », « 01x02 », « 1x02-03 ».
 * Le `\d{1,2}` avant le « x » empêche de confondre avec « 1920x1080 ».
 */
const RE_X_FORMAT =
  /(?<![\p{L}\p{N}])(\d{1,2})x(\d{1,3})(?:[ ._-]*[-–][ ._-]*(?:\d{1,2}x)?(\d{1,3}))?(?![\p{L}\p{N}])/diu;

/** « Episode 02 », « Ep02 », « E02 » — seulement si un dossier de saison existe. */
const RE_EPISODE_ONLY =
  /(?<![\p{L}\p{N}])(?:épisode|episode|ep|e)[ ._-]*(\d{1,3})(?:[ ._-]*[-–][ ._-]*(?:épisode|episode|ep|e)?[ ._-]*(\d{1,3}))?(?![\p{L}\p{N}])/diu;

/** « 01 - Titre.mkv » — dernier recours, seulement dans un dossier de saison. */
const RE_LEADING_NUMBER = /^[ ._-]*(\d{1,3})(?![\p{L}\p{N}])/u;

/** « Season 01 », « Saison 1 », « S01 », « Series 1 ». */
const RE_SEASON_FOLDER = /^(?:saison|season|series|s[ée]rie|s)[ ._-]*(\d{1,3})$/iu;

/** Dossiers de bonus numérotés saison 0. */
const RE_SPECIALS_FOLDER = /^(?:specials?|sp[ée]ciaux|sp[ée]cial|hors[ ._-]*s[ée]rie)$/iu;

/** « Show.Name.S01 » ou « Show Name - Intégrale » → « Show Name ». */
const RE_TRAILING_SEASON =
  /[ ._-]+(?:s\d{1,2}|saison[ ._-]*\d{1,2}|season[ ._-]*\d{1,2}|int[ée]grale|complete|complet)$/iu;

/**
 * Une plage d'épisodes n'est retenue que si elle est croissante et courte.
 * Sans ce garde-fou, « S01E01 - 24 heures chrono » donnerait un épisode 1 à 24.
 */
const MAX_EPISODE_RANGE = 8;

interface SeasonFolder {
  index: number;
  seasonNumber: number;
}

/** Cherche le dossier de saison le plus profond parmi les dossiers parents. */
function findSeasonFolder(directories: string[]): SeasonFolder | null {
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    const name = directories[index];
    if (name === undefined) continue;

    const numbered = RE_SEASON_FOLDER.exec(name);
    if (numbered?.[1] !== undefined) return { index, seasonNumber: Number(numbered[1]) };

    if (RE_SPECIALS_FOLDER.test(name)) return { index, seasonNumber: 0 };
  }
  return null;
}

interface EpisodeMarker {
  seasonNumber: number | null;
  episodeNumber: number;
  episodeNumberEnd: number | null;
  start: number;
  end: number;
}

function normalizeRangeEnd(start: number, end: number | undefined): number | null {
  if (end === undefined) return null;
  if (end <= start) return null;
  if (end - start > MAX_EPISODE_RANGE) return null;
  return end;
}

/**
 * Fin du marqueur dans le nom de fichier — c'est là que commence le titre
 * d'épisode.
 *
 * Quand la plage est refusée (« S01E01 - 24 heures » : 24 n'est pas une fin de
 * plage plausible), la fin du marqueur doit revenir juste après le numéro
 * d'épisode, sinon le « 24 » serait avalé et le titre deviendrait « heures ».
 * D'où le drapeau `d` sur les expressions régulières, qui donne accès à la
 * position de chaque groupe.
 */
function markerEnd(match: RegExpExecArray, episodeGroup: number, rangeAccepted: boolean): number {
  const fullEnd = match.index + match[0].length;
  if (rangeAccepted) return fullEnd;
  return match.indices?.[episodeGroup]?.[1] ?? fullEnd;
}

/**
 * Cherche le marqueur d'épisode dans le nom de fichier, du motif le plus
 * explicite au plus permissif. Les deux derniers motifs (« E02 » et « 01 - … »)
 * ne sont tentés que si un dossier de saison donne déjà le numéro de saison,
 * sinon ils produiraient trop de faux positifs.
 */
function matchEpisodeMarker(base: string, hasSeasonFolder: boolean): EpisodeMarker | null {
  const seasonEpisode = RE_SEASON_EPISODE.exec(base);
  if (seasonEpisode?.[1] !== undefined && seasonEpisode[2] !== undefined) {
    const episodeNumber = Number(seasonEpisode[2]);
    const rawEnd = seasonEpisode[3] ?? seasonEpisode[4];
    const episodeNumberEnd = normalizeRangeEnd(
      episodeNumber,
      rawEnd === undefined ? undefined : Number(rawEnd),
    );
    return {
      seasonNumber: Number(seasonEpisode[1]),
      episodeNumber,
      episodeNumberEnd,
      start: seasonEpisode.index,
      end: markerEnd(seasonEpisode, 2, episodeNumberEnd !== null),
    };
  }

  const xFormat = RE_X_FORMAT.exec(base);
  if (xFormat?.[1] !== undefined && xFormat[2] !== undefined) {
    const episodeNumber = Number(xFormat[2]);
    const episodeNumberEnd = normalizeRangeEnd(
      episodeNumber,
      xFormat[3] === undefined ? undefined : Number(xFormat[3]),
    );
    return {
      seasonNumber: Number(xFormat[1]),
      episodeNumber,
      episodeNumberEnd,
      start: xFormat.index,
      end: markerEnd(xFormat, 2, episodeNumberEnd !== null),
    };
  }

  if (!hasSeasonFolder) return null;

  const episodeOnly = RE_EPISODE_ONLY.exec(base);
  if (episodeOnly?.[1] !== undefined) {
    const episodeNumber = Number(episodeOnly[1]);
    const episodeNumberEnd = normalizeRangeEnd(
      episodeNumber,
      episodeOnly[2] === undefined ? undefined : Number(episodeOnly[2]),
    );
    return {
      seasonNumber: null,
      episodeNumber,
      episodeNumberEnd,
      start: episodeOnly.index,
      end: markerEnd(episodeOnly, 1, episodeNumberEnd !== null),
    };
  }

  const leadingNumber = RE_LEADING_NUMBER.exec(base);
  if (leadingNumber?.[1] !== undefined) {
    return {
      seasonNumber: null,
      episodeNumber: Number(leadingNumber[1]),
      episodeNumberEnd: null,
      start: 0,
      end: leadingNumber[0].length,
    };
  }

  return null;
}

function stripTrailingSeasonMarker(value: string): string {
  return value.replace(RE_TRAILING_SEASON, '');
}

/**
 * Conventions traitées :
 *
 *   Série (2015)/Season 01/Série - S01E02 - Titre épisode.mkv
 *   Série (2015)/Saison 1/Série - 1x02.mkv
 *   Série/S01/Episode 02 - Titre.mkv
 *   Série/Saison 1/01 - Titre.mkv
 *   Série.S01E01-E02.1080p.WEB-DL.x264-GRP.mkv
 *
 * Le titre de la série vient du dossier quand il y en a un (plus fiable), et
 * du début du nom de fichier sinon.
 *
 * Renvoie `null` si aucun numéro d'épisode ou aucun titre n'a pu être dégagé.
 */
export function parseEpisode(relativePath: string, options: ParseOptions = {}): ParsedEpisode | null {
  const segments = splitPathSegments(relativePath);
  const fileName = segments.at(-1);
  if (fileName === undefined) return null;

  const directories = segments.slice(0, -1);
  const { base } = splitExtension(fileName);

  const seasonFolder = findSeasonFolder(directories);
  const marker = matchEpisodeMarker(base, seasonFolder !== null);
  if (marker === null) return null;

  const seasonNumber = marker.seasonNumber ?? seasonFolder?.seasonNumber ?? null;
  if (seasonNumber === null) return null;

  // Le dossier de la série est celui juste au-dessus du dossier de saison ;
  // s'il n'y a pas de dossier de saison, c'est le dossier parent direct.
  const showDirectoryIndex = seasonFolder !== null ? seasonFolder.index - 1 : directories.length - 1;
  const showDirectory = showDirectoryIndex >= 0 ? directories[showDirectoryIndex] : undefined;

  const fromFolder =
    showDirectory === undefined
      ? null
      : extractTitleAndYear(stripTrailingSeasonMarker(showDirectory), options);
  const fromPrefix = extractTitleAndYear(stripTrailingSeasonMarker(base.slice(0, marker.start)), options);

  /*
   * Titre ET année viennent de la MÊME source.
   *
   * C'est indispensable pour que tous les fichiers d'un même dossier de série
   * désignent la même œuvre. Sinon, un dossier « Clem » dont certaines saisons
   * sont nommées « Clem.S01E01 » et d'autres « Clem.2010.S10E01 » produirait
   * deux fiches : une sans année, une de 2010 — alors que c'est une seule série.
   *
   * Autrement dit : si le dossier de la série ne porte pas d'année, la série
   * n'en a pas, même si un nom de fichier en mentionne une.
   */
  const folderHasTitle = fromFolder !== null && fromFolder.title !== '';
  const identity = folderHasTitle ? (fromFolder as TitleAndYear) : fromPrefix;
  if (identity.title === '') return null;

  const rest = base.slice(marker.end);
  const candidate = isOnlyNoise(rest) ? '' : cleanTitle(rest, { cutNoise: true });
  const episodeTitle = isMeaninglessTitle(candidate) ? null : candidate;

  return {
    kind: 'episode',
    showTitle: identity.title,
    showYear: identity.year,
    seasonNumber,
    episodeNumber: marker.episodeNumber,
    episodeNumberEnd: marker.episodeNumberEnd,
    episodeTitle,
    source: folderHasTitle ? 'folder' : 'file',
  };
}
