/**
 * Client TMDB.
 *
 * Trois précautions qui comptent plus que le reste :
 *
 * 1. **Le jeton passe en en-tête**, jamais en paramètre d'URL. Un paramètre
 *    d'URL se retrouve dans les journaux des serveurs et des proxys traversés,
 *    dans l'historique du navigateur, dans les rapports d'erreur. Un en-tête
 *    `Authorization` n'y est pas.
 * 2. **Le débit est plafonné.** TMDB limite par adresse IP ; se faire bloquer
 *    au milieu d'une passe de 481 œuvres serait pénible. On s'impose un
 *    intervalle minimum entre deux requêtes, avec un recul exponentiel sur les
 *    429 et les 5xx.
 * 3. **Les réponses sont mises en cache sur disque.** Un ré-essai après une
 *    interruption ne redemande pas ce qu'on a déjà obtenu. C'est aussi ce qui
 *    rend la mise au point du parsing possible sans marteler l'API.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TmdbContentRatings, TmdbReleaseDates } from './certification.js';
import type { TmdbCreatedBy, TmdbCredits } from './credits.js';
import { sleep } from '../util/concurrency.js';

const BASE_URL = 'https://api.themoviedb.org/3';

/** ~10 requêtes par seconde au maximum, comme demandé. */
const MIN_INTERVAL_MS = 100;

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;

export class TmdbTokenMissingError extends Error {}

export class TmdbHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TmdbClientOptions {
  cacheDir: string;
  /** Ignore le cache disque et réinterroge l'API. */
  refresh?: boolean;
}

export class TmdbClient {
  private readonly token: string;
  private readonly cacheDir: string;
  private readonly refresh: boolean;

  /** Horodatage du prochain créneau de départ autorisé. */
  private nextSlotAt = 0;

  private requestCount = 0;
  private cacheHitCount = 0;
  private retryCount = 0;

  constructor(options: TmdbClientOptions) {
    const token = process.env.TMDB_ACCESS_TOKEN?.trim();
    if (token === undefined || token === '') {
      throw new TmdbTokenMissingError(
        [
          'TMDB_ACCESS_TOKEN est absent.',
          '',
          'Copiez .env.example en .env à la racine du dépôt, puis renseignez',
          'votre « API Read Access Token » TMDB (et non la clé API) :',
          '    https://www.themoviedb.org/settings/api',
          '',
          '.env n’est jamais versionné.',
        ].join('\n'),
      );
    }

    this.token = token;
    this.cacheDir = options.cacheDir;
    this.refresh = options.refresh === true;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  get stats(): { requests: number; cacheHits: number; retries: number } {
    return { requests: this.requestCount, cacheHits: this.cacheHitCount, retries: this.retryCount };
  }

  /**
   * Espace les départs de requêtes.
   *
   * Chaque appel réserve le créneau suivant avant de rendre la main, donc
   * plusieurs appels concurrents s'ordonnent d'eux-mêmes sans se marcher dessus.
   */
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + MIN_INTERVAL_MS;
    if (slot > now) await sleep(slot - now);
  }

  private cachePathFor(url: string): string {
    // Le jeton n'entre pas dans la clé : il n'apparaît nulle part sur le disque.
    const digest = createHash('sha1').update(url).digest('hex');
    return path.join(this.cacheDir, `${digest}.json`);
  }

  private async readCache(url: string): Promise<unknown | undefined> {
    if (this.refresh) return undefined;
    try {
      return JSON.parse(await readFile(this.cachePathFor(url), 'utf8'));
    } catch {
      return undefined;
    }
  }

  private async writeCache(url: string, payload: unknown): Promise<void> {
    try {
      await writeFile(this.cachePathFor(url), JSON.stringify(payload), 'utf8');
    } catch {
      // Un cache non écrit n'est pas une raison d'échouer.
    }
  }

  /**
   * Appelle un point d'entrée de l'API et rend la réponse décodée.
   *
   * Les 404 remontent en `TmdbHttpError` : c'est à l'appelant de décider si
   * une ressource absente est une erreur ou un cas normal.
   */
  async get<T>(endpoint: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const href = url.toString();

    const cached = await this.readCache(href);
    if (cached !== undefined) {
      this.cacheHitCount += 1;
      return cached as T;
    }

    let lastError: Error = new Error('échec inconnu');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.waitForSlot();

      let response: Response;
      try {
        this.requestCount += 1;
        response = await fetch(href, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        // Coupure réseau ou délai dépassé : on retente.
        lastError = error as Error;
        this.retryCount += 1;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      if (response.ok) {
        const payload = (await response.json()) as T;
        await this.writeCache(href, payload);
        return payload;
      }

      if (response.status === 401 || response.status === 403) {
        throw new TmdbHttpError(
          response.status,
          'TMDB refuse le jeton (401/403). Vérifiez TMDB_ACCESS_TOKEN dans .env : ' +
            'ce doit être l’« API Read Access Token », pas la clé API.',
        );
      }

      // 429 : trop de requêtes. TMDB indique combien de temps patienter.
      // 5xx : panne passagère de leur côté.
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : BASE_BACKOFF_MS * 2 ** (attempt - 1);
        lastError = new TmdbHttpError(response.status, `HTTP ${response.status}`);
        this.retryCount += 1;
        await sleep(waitMs);
        continue;
      }

      throw new TmdbHttpError(response.status, `HTTP ${response.status} sur ${endpoint}`);
    }

    throw lastError;
  }
}

// ---------------------------------------------------------------------------
// Formes de réponse utilisées
// ---------------------------------------------------------------------------

export interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
}

export interface TmdbSearchResponse {
  results?: TmdbSearchResult[];
  total_results?: number;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

/**
 * Bloc `images` renvoyé par `append_to_response=images`.
 *
 * Combiné à la requête de détail, il évite un appel supplémentaire par œuvre.
 * Le paramètre `include_image_language` filtre les langues côté serveur.
 */
export interface TmdbImages {
  logos?: { file_path?: string; iso_639_1?: string | null; vote_average?: number; width?: number }[];
}

export interface TmdbMovieDetails {
  id: number;
  title?: string;
  original_title?: string;
  overview?: string;
  tagline?: string;
  release_date?: string;
  runtime?: number | null;
  vote_average?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genres?: TmdbGenre[];
  /** Rempli par `append_to_response=translations`, pour le repli en anglais. */
  translations?: { translations?: { iso_639_1?: string; data?: { overview?: string; tagline?: string } }[] };
  images?: TmdbImages;
  /** Rempli par `append_to_response=credits`. */
  credits?: TmdbCredits;
  /** Rempli par `append_to_response=release_dates` : porte la classification. */
  release_dates?: TmdbReleaseDates;
}

export interface TmdbShowDetails {
  id: number;
  name?: string;
  original_name?: string;
  overview?: string;
  first_air_date?: string;
  status?: string;
  number_of_seasons?: number;
  vote_average?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genres?: TmdbGenre[];
  seasons?: { season_number?: number; id?: number; name?: string; overview?: string; air_date?: string; poster_path?: string | null }[];
  translations?: { translations?: { iso_639_1?: string; data?: { overview?: string } }[] };
  images?: TmdbImages;
  credits?: TmdbCredits;
  /**
   * Créateurs de la série. Ils sont à la racine du détail, PAS dans `credits` :
   * une série n'a pas de réalisateur au sens d'un film, et TMDB traite donc la
   * paternité à part.
   */
  created_by?: TmdbCreatedBy[];
  /** Rempli par `append_to_response=content_ratings`. */
  content_ratings?: TmdbContentRatings;
}

export interface TmdbSeasonDetails {
  id?: number;
  air_date?: string;
  overview?: string;
  poster_path?: string | null;
  episodes?: {
    episode_number?: number;
    id?: number;
    name?: string;
    overview?: string;
    still_path?: string | null;
    air_date?: string;
    vote_average?: number;
    runtime?: number | null;
  }[];
}

/**
 * Titres alternatifs d'une œuvre, par pays.
 *
 * Indispensable pour les films non anglophones : `original_title` contient le
 * titre dans la langue d'origine (« 千と千尋の神隠し »), et le titre demandé est
 * en français (« Le Voyage de Chihiro »). Le titre anglais sous lequel le
 * fichier est rangé (« Spirited Away ») ne se trouve que là.
 *
 * Les films exposent `titles`, les séries `results` — même contenu, deux noms.
 */
export interface TmdbAlternativeTitles {
  titles?: { iso_3166_1?: string; title?: string; type?: string }[];
  results?: { iso_3166_1?: string; title?: string; type?: string }[];
}

/** Liste plate des titres alternatifs, doublons retirés. */
export async function fetchAlternativeTitles(
  client: TmdbClient,
  type: 'movie' | 'show',
  tmdbId: number,
): Promise<string[]> {
  const endpoint = type === 'movie' ? `/movie/${tmdbId}/alternative_titles` : `/tv/${tmdbId}/alternative_titles`;
  try {
    const response = await client.get<TmdbAlternativeTitles>(endpoint);
    const entries = response.titles ?? response.results ?? [];
    const titles = new Set<string>();
    for (const entry of entries) {
      const title = nonEmpty(entry.title);
      if (title !== null) titles.add(title);
    }
    return [...titles];
  } catch {
    // Une œuvre sans titres alternatifs n'est pas une erreur.
    return [];
  }
}

/**
 * Titre anglais officiel d'une œuvre.
 *
 * Il ne figure PAS dans les titres alternatifs : pour TMDB, « Princess
 * Mononoke » est le titre canonique en anglais, pas une variante. Les 45
 * titres alternatifs du film listent le portugais, le turc, le polonais…
 * mais pas l'anglais. Il faut donc le demander explicitement.
 */
export async function fetchEnglishTitle(
  client: TmdbClient,
  type: 'movie' | 'show',
  tmdbId: number,
): Promise<string | null> {
  const endpoint = type === 'movie' ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  try {
    const details = await client.get<{ title?: string; name?: string }>(endpoint, { language: 'en-US' });
    return nonEmpty(details.title ?? details.name);
  } catch {
    return null;
  }
}

/**
 * TMDB renvoie une CHAÎNE VIDE, pas null, quand la traduction demandée
 * n'existe pas. Un `??` ne suffit donc pas : il faut tester le vide.
 */
export function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Cherche une traduction de repli dans le bloc `translations`.
 * Utilisé quand le synopsis français est vide.
 */
export function fallbackOverview(
  translations: { translations?: { iso_639_1?: string; data?: { overview?: string } }[] } | undefined,
  languages: string[] = ['en'],
): string | null {
  const list = translations?.translations ?? [];
  for (const language of languages) {
    for (const entry of list) {
      if (entry.iso_639_1 === language) {
        const overview = nonEmpty(entry.data?.overview);
        if (overview !== null) return overview;
      }
    }
  }
  return null;
}
