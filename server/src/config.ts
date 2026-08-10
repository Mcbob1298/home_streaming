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

export interface AppConfig {
  databasePath: string;
  libraries: LibraryConfig[];
}

/**
 * Racine du dépôt, déduite de l'emplacement de ce fichier.
 * En dev  : server/src/config.ts  -> ../../
 * Compilé : server/dist/config.js -> ../../
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');
export const DATA_DIR = path.join(REPO_ROOT, 'data');

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

  return { databasePath: databasePath.trim(), libraries: parsed };
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
