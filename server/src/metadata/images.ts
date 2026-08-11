/**
 * Téléchargement local des affiches.
 *
 * On ne pointe jamais vers TMDB au moment de l'affichage : une grille de 50
 * affiches ferait 50 requêtes vers un service tiers à chaque chargement de
 * page, avec sa latence, ses coupures et son suivi. Les images sont donc
 * rapatriées une fois, rangées sur le stockage local rapide, et servies par
 * Fastify.
 *
 * L'arborescence reprend le nom de fichier TMDB, qui est déjà un condensat
 * unique et immuable :
 *
 *   data/images/poster/w342/abc123.jpg
 *   data/images/poster/w500/abc123.jpg
 *   data/images/backdrop/w1280/def456.jpg
 *   data/images/still/w300/ghi789.jpg
 */
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

/** Formats demandés : deux tailles d'affiche, une de backdrop, une de vignette. */
export const IMAGE_KINDS = {
  /** Grilles. */
  posterSmall: { kind: 'poster', size: 'w342' },
  /** Page détail. */
  posterLarge: { kind: 'poster', size: 'w500' },
  /** Fond de page détail et hero d'accueil. */
  backdrop: { kind: 'backdrop', size: 'w1280' },
  /** Vignette d'épisode. */
  still: { kind: 'still', size: 'w300' },
} as const;

export type ImageKind = keyof typeof IMAGE_KINDS;

/** Chemin relatif servi par l'API, à partir du chemin TMDB (« /abc.jpg »). */
export function publicImagePath(tmdbPath: string, kind: ImageKind): string {
  const { kind: folder, size } = IMAGE_KINDS[kind];
  return `/images/${folder}/${size}${tmdbPath.startsWith('/') ? tmdbPath : `/${tmdbPath}`}`;
}

function localPathFor(baseDir: string, tmdbPath: string, kind: ImageKind): string {
  const { kind: folder, size } = IMAGE_KINDS[kind];
  const fileName = tmdbPath.replace(/^\//, '');
  return path.join(baseDir, folder, size, fileName);
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
}

export class ImageDownloader {
  readonly stats: ImageDownloadStats = { downloaded: 0, skipped: 0, failed: 0 };

  constructor(private readonly baseDir: string) {}

  /**
   * Rapatrie une image si elle n'est pas déjà là.
   * Rend `true` si le fichier est présent à l'arrivée, quelle qu'en soit la raison.
   */
  async fetchOne(tmdbPath: string | null | undefined, kind: ImageKind): Promise<boolean> {
    if (tmdbPath === null || tmdbPath === undefined || tmdbPath === '') return false;

    const destination = localPathFor(this.baseDir, tmdbPath, kind);
    if (await exists(destination)) {
      this.stats.skipped += 1;
      return true;
    }

    const { size } = IMAGE_KINDS[kind];
    const url = `${IMAGE_BASE_URL}/${size}${tmdbPath.startsWith('/') ? tmdbPath : `/${tmdbPath}`}`;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        this.stats.failed += 1;
        return false;
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
      return true;
    } catch {
      this.stats.failed += 1;
      return false;
    }
  }

  /** Les deux tailles d'affiche d'un coup. */
  async fetchPoster(tmdbPath: string | null | undefined): Promise<void> {
    await this.fetchOne(tmdbPath, 'posterSmall');
    await this.fetchOne(tmdbPath, 'posterLarge');
  }
}
