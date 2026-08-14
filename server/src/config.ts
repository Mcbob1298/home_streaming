/**
 * Lecture et validation de `config.json`, à la racine du dépôt.
 *
 * Les chemins relatifs (`./data/media.db`) sont résolus par rapport à la racine
 * du dépôt, PAS par rapport au dossier courant. Sans ça, `npm run scan` lancé
 * depuis /server et depuis la racine ne viseraient pas le même fichier.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pathKey } from './util/text.js';

export type LibraryType = 'movie' | 'show';

export interface LibraryConfig {
  id: string;
  label: string;
  type: LibraryType;
  /** Une bibliothèque peut être répartie sur plusieurs racines (deux partages NAS). */
  paths: string[];
}

/**
 * Réglages de transcodage.
 *
 * `workDir` reçoit les segments des sessions en cours. Il est écrit et relu
 * sans arrêt : en production ce sera un tmpfs, comme le /transcode de Plex.
 * Tout y est effaçable — le contenu d'une session interrompue ne vaut rien.
 */
export interface TranscodeConfig {
  workDir: string;
  /** Sessions ffmpeg simultanées. Au-delà, les demandes attendent leur tour. */
  maxSessions: number;
  /** Une session sans requête depuis ce délai est tuée. */
  idleSeconds: number;
}

export interface AppConfig {
  databasePath: string;
  /**
   * Où sont rangées les affiches téléchargées. Comme la base, ce dossier doit
   * rester sur le stockage rapide local — jamais sur le NAS : on y écrit des
   * milliers de petits fichiers, et on les relit à chaque affichage de grille.
   */
  imagesPath: string;
  transcode: TranscodeConfig;
  libraries: LibraryConfig[];
}

const DEFAULT_IMAGES_PATH = './data/images';

const DEFAULT_TRANSCODE: TranscodeConfig = {
  workDir: './data/transcode',
  // Un seul moteur matériel sur le NAS : trois sessions saturent déjà le NAS
  // sans que la quatrième n'apporte quoi que ce soit.
  maxSessions: 3,
  idleSeconds: 60,
};

/**
 * Racine du dépôt, déduite de l'emplacement de ce fichier.
 * En dev  : server/src/config.ts  -> ../../
 * Compilé : server/dist/config.js -> ../../
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Fichier de configuration.
 *
 * `HOME_STREAMING_CONFIG` permet d'en désigner un autre, ce qui fait coexister
 * le poste de développement et le NAS sans qu'ils se marchent dessus : le dépôt
 * porte `config.json` (chemins Windows) ET `config.production.json` (chemins
 * Linux), et c'est l'environnement qui tranche. Aucun des deux n'écrase l'autre
 * au transfert.
 */
export const CONFIG_PATH =
  process.env.HOME_STREAMING_CONFIG !== undefined && process.env.HOME_STREAMING_CONFIG !== ''
    ? resolveFromRepoRootEarly(process.env.HOME_STREAMING_CONFIG)
    : path.join(REPO_ROOT, 'config.json');

export const DATA_DIR = path.join(REPO_ROOT, 'data');

/**
 * Le cache des sous-titres préparés.
 *
 * Dans DATA_DIR, à côté de la base, et NON dans le répertoire de transcodage :
 * celui-ci est effacé à chaque démarrage et monte en tmpfs, alors qu'une
 * extraction coûte une traversée complète du fichier.
 *
 * Déclaré ici parce que trois entrées y accèdent — le serveur, `npm run
 * subtitles`, et le rattrapage de la page d'administration. Le même chemin
 * recalculé à trois endroits est un chemin qui finit par diverger à deux.
 */
export const SUBTITLE_CACHE_DIR = path.join(DATA_DIR, 'subtitles');

/**
 * Racine des préludes — les premières secondes encodées d'avance.
 *
 * Dans DATA_DIR, donc sur /volume1 : le répertoire de transcodage monte en
 * tmpfs et disparaît à chaque démarrage, alors qu'un prélude coûte un encodage
 * matériel de ses vingt-quatre secondes. Il n'est jamais évincé.
 */
export const PRELUDE_DIR = path.join(DATA_DIR, 'preludes');

/** Même résolution que `resolveFromRepoRoot`, utilisable avant sa déclaration. */
function resolveFromRepoRootEarly(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

/** Résout un chemin de la config par rapport à la racine du dépôt. */
export function resolveFromRepoRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(
    `${message}\n\nFichier attendu : ${CONFIG_PATH}\nPartez de config.example.json pour le créer.`,
  );
}

function validateLibrary(raw: unknown, index: number): LibraryConfig {
  if (typeof raw !== 'object' || raw === null) fail(`libraries[${index}] doit être un objet.`);
  const library = raw as Record<string, unknown>;

  const { id, label, type, paths } = library;

  if (typeof id !== 'string' || id.trim() === '') fail(`libraries[${index}].id doit être une chaîne non vide.`);
  if (typeof label !== 'string' || label.trim() === '') fail(`libraries[${index}].label doit être une chaîne non vide.`);
  if (type !== 'movie' && type !== 'show') fail(`libraries[${index}].type doit valoir "movie" ou "show".`);
  if (!Array.isArray(paths) || paths.length === 0) fail(`libraries[${index}].paths doit contenir au moins un chemin.`);

  const normalizedPaths: string[] = [];
  const seen = new Set<string>();

  for (const [pathIndex, value] of paths.entries()) {
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`libraries[${index}].paths[${pathIndex}] doit être une chaîne non vide.`);
    }
    /*
     * Le chemin est conservé EXACTEMENT tel qu'il est écrit dans config.json :
     * c'est lui qu'on donnera à readdir, et NTFS/SMB compare les noms sans
     * appliquer de normalisation Unicode. Le normaliser ici rendrait une racine
     * accentuée introuvable si le NAS la stocke en forme décomposée.
     *
     * La normalisation NFC ne sert qu'à la clé de comparaison, qui détecte la
     * même racine écrite deux fois.
     */
    const trimmed = value.trim();
    const key = pathKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedPaths.push(trimmed);
  }

  return { id: id.trim(), label: label.trim(), type, paths: normalizedPaths };
}

/** Analyse un objet déjà décodé. Séparé de la lecture disque pour rester testable. */
export function validateConfig(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null) fail('config.json doit contenir un objet.');
  const config = raw as Record<string, unknown>;

  const databasePath = config.databasePath;
  if (typeof databasePath !== 'string' || databasePath.trim() === '') {
    fail('config.json doit définir "databasePath".');
  }

  const imagesPath = config.imagesPath;
  if (imagesPath !== undefined && (typeof imagesPath !== 'string' || imagesPath.trim() === '')) {
    fail('config.json : "imagesPath" doit être une chaîne non vide.');
  }

  const libraries = config.libraries;
  if (!Array.isArray(libraries) || libraries.length === 0) {
    fail('config.json doit définir au moins une bibliothèque dans "libraries".');
  }

  const parsed = libraries.map(validateLibrary);

  const ids = new Set<string>();
  for (const library of parsed) {
    if (ids.has(library.id)) fail(`Deux bibliothèques portent le même id "${library.id}".`);
    ids.add(library.id);
  }

  return {
    databasePath: databasePath.trim(),
    imagesPath: typeof imagesPath === 'string' ? imagesPath.trim() : DEFAULT_IMAGES_PATH,
    transcode: validateTranscode(config.transcode),
    libraries: parsed,
  };
}

/**
 * Section « transcode », entièrement optionnelle.
 *
 * Une configuration écrite avant ce palier reste valide : chaque champ absent
 * prend sa valeur par défaut plutôt que de faire échouer le démarrage.
 */
function validateTranscode(raw: unknown): TranscodeConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_TRANSCODE };
  if (typeof raw !== 'object') fail('config.json : "transcode" doit être un objet.');

  const section = raw as Record<string, unknown>;
  const { workDir, maxSessions, idleSeconds } = section;

  if (workDir !== undefined && (typeof workDir !== 'string' || workDir.trim() === '')) {
    fail('config.json : "transcode.workDir" doit être une chaîne non vide.');
  }
  if (maxSessions !== undefined && (typeof maxSessions !== 'number' || maxSessions < 1)) {
    fail('config.json : "transcode.maxSessions" doit être un entier positif.');
  }
  if (idleSeconds !== undefined && (typeof idleSeconds !== 'number' || idleSeconds < 5)) {
    fail('config.json : "transcode.idleSeconds" doit valoir au moins 5.');
  }

  return {
    workDir: typeof workDir === 'string' ? workDir.trim() : DEFAULT_TRANSCODE.workDir,
    maxSessions: typeof maxSessions === 'number' ? Math.floor(maxSessions) : DEFAULT_TRANSCODE.maxSessions,
    idleSeconds: typeof idleSeconds === 'number' ? Math.floor(idleSeconds) : DEFAULT_TRANSCODE.idleSeconds,
  };
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached !== null) return cached;

  let contents: string;
  try {
    contents = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    fail('config.json est introuvable.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    fail(`config.json n'est pas un JSON valide : ${(error as Error).message}`);
  }

  cached = validateConfig(raw);
  return cached;
}

/** Chemin absolu de la base SQLite, toujours en local. */
export function resolveDatabasePath(config: AppConfig): string {
  return resolveFromRepoRoot(config.databasePath);
}

/** Chemin absolu du dossier des affiches téléchargées. */
export function resolveImagesPath(config: AppConfig): string {
  return resolveFromRepoRoot(config.imagesPath);
}

/** Chemin absolu du répertoire de travail des sessions de transcodage. */
export function resolveTranscodePath(config: AppConfig): string {
  return resolveFromRepoRoot(config.transcode.workDir);
}

/**
 * Charge les variables du fichier .env à la racine du dépôt.
 *
 * `process.loadEnvFile` fait partie de Node depuis la 20.12 : pas besoin de
 * dépendance. Les variables déjà définies dans l'environnement l'emportent,
 * ce qui permet de surcharger ponctuellement sans modifier le fichier.
 */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile(path.join(REPO_ROOT, '.env'));
  } catch {
    // Pas de .env : ce n'est pas une erreur en soi. C'est la commande qui a
    // besoin d'un secret qui se plaindra, avec un message utile.
  }
}
