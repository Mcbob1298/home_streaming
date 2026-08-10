/**
 * Point d'entrée du parser.
 *
 * Tout ce module est PUR : aucune fonction ne lit le disque. On lui donne un
 * chemin relatif à une racine de bibliothèque, il rend un objet. C'est la
 * partie qui va le plus évoluer (chaque bibliothèque a ses habitudes de
 * nommage), donc elle est testable sans NAS ni base de données.
 */
import type { ParseOptions } from './common.js';
import { parseEpisode, type ParsedEpisode } from './episode.js';
import { parseMovie, type ParsedMovie } from './movie.js';

export type LibraryType = 'movie' | 'show';

/** Raison pour laquelle un fichier n'a pas pu être interprété. */
export type ParseFailureReason =
  | 'aucun-titre-exploitable'
  | 'aucun-numero-d-episode'
  | 'chemin-vide';

export interface ParsedUnknown {
  kind: 'unknown';
  reason: ParseFailureReason;
}

export type ParseResult = ParsedMovie | ParsedEpisode | ParsedUnknown;

/**
 * Analyse un chemin relatif selon le type de la bibliothèque qui le contient.
 * Ne renvoie jamais d'exception : un échec est un résultat `kind: 'unknown'`,
 * qui finira dans la liste des fichiers non interprétés du rapport de scan.
 */
export function parseMediaPath(
  relativePath: string,
  libraryType: LibraryType,
  options: ParseOptions = {},
): ParseResult {
  if (relativePath.trim() === '') return { kind: 'unknown', reason: 'chemin-vide' };

  if (libraryType === 'movie') {
    return parseMovie(relativePath, options) ?? { kind: 'unknown', reason: 'aucun-titre-exploitable' };
  }

  return parseEpisode(relativePath, options) ?? { kind: 'unknown', reason: 'aucun-numero-d-episode' };
}

export { parseEpisode, parseMovie };
export type { ParsedEpisode, ParsedMovie, ParseOptions };
export { parseSubtitleName, type ParsedSubtitle } from './subtitle.js';
export {
  cleanTitle,
  extractTitleAndYear,
  splitExtension,
  splitPathSegments,
  type TitleAndYear,
} from './common.js';
