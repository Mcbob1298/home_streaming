/**
 * Briques communes aux parsers film et série.
 * Tout est pur : aucune de ces fonctions ne touche au disque.
 */
import { nfc } from '../util/text.js';
import { findNoiseCutIndex, normalizeSeparators, stripBracketBlocks, trimJunk } from './noise.js';

/** Bornes de plausibilité d'une année de sortie. */
export const DEFAULT_MIN_YEAR = 1900;

/**
 * Par défaut on refuse les années trop lointaines, ce qui évite de prendre
 * « Blade Runner 2049 » pour un film de 2049. Le paramètre reste réglable pour
 * que les tests soient reproductibles dans le temps.
 */
export const DEFAULT_MAX_YEAR = new Date().getUTCFullYear() + 1;

export interface ParseOptions {
  minYear?: number;
  maxYear?: number;
}

export interface TitleAndYear {
  title: string;
  year: number | null;
}

/** Découpe un chemin relatif en segments, quel que soit le séparateur. */
export function splitPathSegments(relativePath: string): string[] {
  return nfc(relativePath)
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.');
}

/** Sépare « Titre (2019).mkv » en base = « Titre (2019) » et ext = « .mkv ». */
export function splitExtension(fileName: string): { base: string; ext: string } {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return { base: fileName, ext: '' };
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot).toLowerCase() };
}

/**
 * Nettoie un titre : blocs entre crochets, séparateurs scène, ponctuation
 * résiduelle. Avec `cutNoise`, coupe aussi au premier marqueur technique.
 */
export function cleanTitle(raw: string, options: { cutNoise?: boolean } = {}): string {
  let value = normalizeSeparators(stripBracketBlocks(nfc(raw)));
  if (options.cutNoise) {
    const cut = findNoiseCutIndex(value);
    if (cut !== -1) value = value.slice(0, cut);
  }
  return trimJunk(value);
}

const PAREN_YEAR_RE = /[([](\d{4})[)\]]/g;
const STANDALONE_YEAR_RE = /(?<![\p{L}\p{N}])(\d{4})(?![\p{L}\p{N}])/gu;

interface YearMatch {
  year: number;
  index: number;
}

function findStandaloneYears(value: string, minYear: number, maxYear: number): YearMatch[] {
  const found: YearMatch[] = [];
  STANDALONE_YEAR_RE.lastIndex = 0;
  for (let match = STANDALONE_YEAR_RE.exec(value); match; match = STANDALONE_YEAR_RE.exec(value)) {
    const year = Number(match[1]);
    if (year >= minYear && year <= maxYear) found.push({ year, index: match.index });
  }
  return found;
}

/**
 * Extrait le titre et l'année d'un nom (de fichier ou de dossier).
 *
 * Deux chemins, du plus fiable au moins fiable :
 *
 * 1. Une année entre parenthèses ou crochets — « Titre (2019) ». C'est une
 *    intention explicite : tout ce qui précède est le titre, tel quel. On ne
 *    coupe pas au bruit ici, pour ne pas casser un vrai titre du genre
 *    « Web Therapy (2011) ».
 *
 * 2. Sinon, nom « scène » : « Titre.2019.1080p.BluRay.x264-GROUPE ». On coupe
 *    au plus tôt entre la première année isolée et le premier marqueur
 *    technique.
 *
 * Renvoie un titre vide si rien d'exploitable n'a été trouvé — c'est au
 * parser appelant de décider que le fichier est non interprétable.
 */
export function extractTitleAndYear(raw: string, options: ParseOptions = {}): TitleAndYear {
  const minYear = options.minYear ?? DEFAULT_MIN_YEAR;
  const maxYear = options.maxYear ?? DEFAULT_MAX_YEAR;
  const source = nfc(raw);

  PAREN_YEAR_RE.lastIndex = 0;
  for (let match = PAREN_YEAR_RE.exec(source); match; match = PAREN_YEAR_RE.exec(source)) {
    const year = Number(match[1]);
    if (year < minYear || year > maxYear) continue;
    const title = cleanTitle(source.slice(0, match.index));
    if (title !== '') return { title, year };
  }

  const normalized = normalizeSeparators(stripBracketBlocks(source));
  const noiseCut = findNoiseCutIndex(normalized);

  for (const candidate of findStandaloneYears(normalized, minYear, maxYear)) {
    const cut = noiseCut === -1 ? candidate.index : Math.min(noiseCut, candidate.index);
    const title = trimJunk(normalized.slice(0, cut));
    // Un titre vide veut dire que l'année est en tête (« 2012.2009.1080p ») :
    // on essaie l'année suivante.
    if (title !== '') return { title, year: candidate.year };
  }

  const cut = noiseCut === -1 ? normalized.length : noiseCut;
  return { title: trimJunk(normalized.slice(0, cut)), year: null };
}
