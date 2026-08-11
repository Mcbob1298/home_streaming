/**
 * Téléchargement local des images, en plusieurs tailles.
 *
 * On ne pointe jamais vers TMDB au moment de l'affichage : une grille de 50
 * affiches ferait 50 requêtes vers un service tiers à chaque chargement de
 * page, avec sa latence, ses coupures et son suivi.
 *
 * Chaque type d'image est rapatrié en PLUSIEURS tailles, servies ensuite en
 * `srcset` : le navigateur choisit selon la largeur d'affichage et la densité
 * de l'écran. Une seule taille ne peut pas convenir à la fois à une vignette de
 * 288 px sur un portable et à un hero plein écran sur un vidéoprojecteur.
 *
 * Règle de dimensionnement : au moins deux fois la taille d'affichage maximale,
 * pour couvrir les écrans à densité 2 et 3.
 *
 *   data/images/backdrop/w780/abc.jpg
 *   data/images/backdrop/original/abc.jpg
 */
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

export type ImageKind = 'poster' | 'backdrop' | 'still' | 'logo';

/**
 * Tailles téléchargées par type, de la plus petite à la plus grande.
 *
 * - `backdrop` sert aussi bien la vignette 288 px (w780 suffit largement) que
 *   le hero plein écran, qui a besoin de l'original : w1280 y était agrandi.
 * - `still` n'existe chez TMDB qu'en w92/w185/w300/original. Une vignette
 *   d'épisode de 232 px en densité 2 réclame 464 px : w300 ne suffit pas, il
 *   faut l'original.
 * - `logo` s'arrête à w500. Mesuré sur la bibliothèque, l'« original » d'un
 *   logo TMDB fait 508×300 — 1,6 % de pixels de plus que le w500 — pour 231 Mo
 *   de PNG à canal alpha mal compressés. Le rapport ne se défend pas. Les logos
 *   vectoriels gardent leur original, qui est leur seule taille disponible.
 */
export const IMAGE_SIZES: Record<ImageKind, readonly string[]> = {
  poster: ['w342', 'w500', 'w780'],
  backdrop: ['w780', 'w1280', 'original'],
  still: ['w300', 'original'],
  logo: ['w300', 'w500'],
};

/**
 * Largeur nominale de chaque taille, pour les descripteurs `w` du srcset.
 * « original » n'a pas de largeur connue à l'avance : on donne une valeur
 * plausible par type, qui n'est qu'une indication pour le navigateur.
 */
const NOMINAL_WIDTH: Record<string, number> = {
  w92: 92,
  w154: 154,
  w185: 185,
  w300: 300,
  w342: 342,
  w500: 500,
  w780: 780,
  w1280: 1280,
};

const ORIGINAL_WIDTH: Record<ImageKind, number> = {
  poster: 1000,
  backdrop: 1920,
  still: 1920,
  logo: 1000,
};

function widthOf(size: string, kind: ImageKind): number {
  return NOMINAL_WIDTH[size] ?? ORIGINAL_WIDTH[kind];
}

/**
 * Les logos vectoriels font exception : TMDB ne les redimensionne pas, ils ne
 * sont servis qu'en `original`.
 */
function sizesFor(tmdbPath: string, kind: ImageKind): readonly string[] {
  if (kind === 'logo' && tmdbPath.toLowerCase().endsWith('.svg')) return ['original'];
  return IMAGE_SIZES[kind];
}

function normalizePath(tmdbPath: string): string {
  return tmdbPath.startsWith('/') ? tmdbPath : `/${tmdbPath}`;
}

/** URL servie par l'API pour une taille donnée. */
export function publicImagePath(tmdbPath: string, kind: ImageKind, size: string): string {
  return `/images/${kind}/${size}${normalizePath(tmdbPath)}`;
}

/** Taille par défaut, celle de l'attribut `src`. La plus petite du jeu. */
export function defaultImagePath(tmdbPath: string, kind: ImageKind): string {
  const sizes = sizesFor(tmdbPath, kind);
  return publicImagePath(tmdbPath, kind, sizes[0] as string);
}

/** Attribut `srcset` complet, pour que le navigateur choisisse lui-même. */
export function buildSrcSet(tmdbPath: string, kind: ImageKind): string {
  return sizesFor(tmdbPath, kind)
    .map((size) => `${publicImagePath(tmdbPath, kind, size)} ${widthOf(size, kind)}w`)
    .join(', ');
}

function localPathFor(baseDir: string, tmdbPath: string, kind: ImageKind, size: string): string {
  return path.join(baseDir, kind, size, normalizePath(tmdbPath).replace(/^\//, ''));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    // Un fichier vide est le reliquat d'un téléchargement interrompu.
    return info.size > 0;
  } catch {
    return false;
  }
}

export interface ImageDownloadStats {
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
}

export class ImageDownloader {
  readonly stats: ImageDownloadStats = { downloaded: 0, skipped: 0, failed: 0, bytes: 0 };

  constructor(private readonly baseDir: string) {}

  /** Rapatrie UNE taille si elle n'est pas déjà là. */
  private async fetchSize(tmdbPath: string, kind: ImageKind, size: string): Promise<void> {
    const destination = localPathFor(this.baseDir, tmdbPath, kind, size);
    if (await exists(destination)) {
      this.stats.skipped += 1;
      return;
    }

    const url = `${IMAGE_BASE_URL}/${size}${normalizePath(tmdbPath)}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        this.stats.failed += 1;
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(path.dirname(destination), { recursive: true });

      /*
       * Écriture dans un fichier temporaire puis renommage : si le processus
       * est interrompu au milieu, on ne laisse pas une image tronquée que les
       * passes suivantes prendraient pour un téléchargement réussi.
       */
      const temporary = `${destination}.part`;
      await writeFile(temporary, buffer);
      await rename(temporary, destination);

      this.stats.downloaded += 1;
      this.stats.bytes += buffer.length;
    } catch {
      this.stats.failed += 1;
    }
  }

  /** Rapatrie toutes les tailles prévues pour ce type d'image. */
  async fetchAll(tmdbPath: string | null | undefined, kind: ImageKind): Promise<void> {
    if (tmdbPath === null || tmdbPath === undefined || tmdbPath === '') return;
    for (const size of sizesFor(tmdbPath, kind)) {
      await this.fetchSize(tmdbPath, kind, size);
    }
  }
}
