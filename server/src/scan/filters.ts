/**
 * Ce qu'on garde et ce qu'on ignore pendant le parcours.
 * Pur : que des tests sur des noms, aucun accès disque.
 */
import { stripDiacritics } from '../util/text.js';

export const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts']);
export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.sub', '.vtt']);

/** En dessous, c'est un extrait, une bande-annonce ou un fichier cassé. */
export const MIN_VIDEO_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Dossiers techniques : miniatures Synology, corbeilles, dossiers de travail,
 * et les versions ré-encodées générées par Plex (qu'on ne veut surtout pas
 * compter comme des fichiers supplémentaires).
 */
const IGNORED_DIRECTORY_NAMES = new Set([
  '@eadir',
  '#recycle',
  '.grab',
  'plex versions',
  '$recycle.bin',
  'system volume information',
  'lost+found',
]);

const IGNORED_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * Mots qui signalent un contenu annexe. Testés comme des mots entiers, pour ne
 * pas éliminer un film qui contiendrait « resample » ou « extraordinaire ».
 */
const SIDE_CONTENT_RE =
  /(?<![\p{L}\p{N}])(?:samples?|extras?|featurettes?|behind[ -]the[ -]scenes|trailers?)(?![\p{L}\p{N}])/u;

export type SkipReason =
  | 'dossier-technique'
  | 'contenu-annexe'
  | 'fichier-cache'
  | 'extension-ignoree'
  | 'trop-petit'
  | 'erreur-de-lecture';

/**
 * Normalise un nom pour les tests d'exclusion : sans accents, en minuscules,
 * points et underscores remplacés par des espaces — « Behind.The.Scenes » et
 * « behind the scenes » doivent se comporter pareil.
 */
function normalizeForMatching(name: string): string {
  return stripDiacritics(name).toLowerCase().replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Fichier caché. Sous Windows le vrai marqueur est un attribut du système de
 * fichiers, que Node n'expose pas ; on se contente donc du point initial, ce
 * qui couvre .DS_Store, .grab et les fichiers venus de macOS ou Linux.
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

export function shouldIgnoreDirectory(name: string): SkipReason | null {
  const normalized = normalizeForMatching(name);
  if (IGNORED_DIRECTORY_NAMES.has(normalized)) return 'dossier-technique';
  if (isHiddenName(name)) return 'fichier-cache';
  if (SIDE_CONTENT_RE.test(normalized)) return 'contenu-annexe';
  return null;
}

export type FileKind = 'video' | 'subtitle';

export interface FileClassification {
  kind: FileKind | null;
  skipReason: SkipReason | null;
}

export function classifyFile(name: string, extension: string): FileClassification {
  const normalized = normalizeForMatching(name);

  if (IGNORED_FILE_NAMES.has(normalized)) return { kind: null, skipReason: 'dossier-technique' };
  if (isHiddenName(name)) return { kind: null, skipReason: 'fichier-cache' };

  if (VIDEO_EXTENSIONS.has(extension)) {
    if (SIDE_CONTENT_RE.test(normalized)) return { kind: null, skipReason: 'contenu-annexe' };
    return { kind: 'video', skipReason: null };
  }

  if (SUBTITLE_EXTENSIONS.has(extension)) {
    if (SIDE_CONTENT_RE.test(normalized)) return { kind: null, skipReason: 'contenu-annexe' };
    return { kind: 'subtitle', skipReason: null };
  }

  return { kind: null, skipReason: 'extension-ignoree' };
}
