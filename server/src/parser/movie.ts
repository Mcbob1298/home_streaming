/**
 * Parser de films. Pur : entrée = un chemin relatif à la racine, sortie = un objet.
 */
import { extractTitleAndYear, splitExtension, splitPathSegments, type ParseOptions } from './common.js';

export interface ParsedMovie {
  kind: 'movie';
  title: string;
  year: number | null;
  /** D'où vient le titre : utile pour comprendre un résultat surprenant. */
  source: 'folder' | 'file';
}

/**
 * Conventions traitées, de la plus fiable à la moins fiable :
 *
 * 1. « Titre (2019)/Titre (2019).mkv » — le dossier parent porte une année.
 *    C'est la convention la plus explicite, elle l'emporte sur le nom du
 *    fichier (qui peut être « CD1.mkv » ou « Titre - version longue.mkv »).
 * 2. « Titre.2019.1080p.BluRay.x264-GROUPE.mkv » — nom scène.
 * 3. Fichier à plat, sans année : « Titre.mkv ».
 *
 * Le dossier parent n'est retenu que s'il porte une année. Sinon c'est
 * probablement un dossier de rangement (« Action/ », « À voir/ ») et pas le
 * dossier du film.
 *
 * Renvoie `null` si aucun titre n'a pu être dégagé.
 */
export function parseMovie(relativePath: string, options: ParseOptions = {}): ParsedMovie | null {
  const segments = splitPathSegments(relativePath);
  const fileName = segments.at(-1);
  if (fileName === undefined) return null;

  const directories = segments.slice(0, -1);
  const parentDirectory = directories.at(-1);

  const fromFile = extractTitleAndYear(splitExtension(fileName).base, options);
  const fromFolder = parentDirectory === undefined ? null : extractTitleAndYear(parentDirectory, options);

  if (fromFolder !== null && fromFolder.title !== '' && fromFolder.year !== null) {
    return { kind: 'movie', title: fromFolder.title, year: fromFolder.year, source: 'folder' };
  }

  if (fromFile.title !== '') {
    return {
      kind: 'movie',
      title: fromFile.title,
      year: fromFile.year ?? fromFolder?.year ?? null,
      source: 'file',
    };
  }

  if (fromFolder !== null && fromFolder.title !== '') {
    return { kind: 'movie', title: fromFolder.title, year: fromFolder.year, source: 'folder' };
  }

  return null;
}
