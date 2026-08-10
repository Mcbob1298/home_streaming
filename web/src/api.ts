/**
 * Accès à l'API. Un seul endroit qui connaît les URL et les formes de données.
 *
 * Les types reprennent exactement ce que renvoie le serveur : si l'API change,
 * TypeScript signale les pages à corriger.
 */

export interface Library {
  id: string;
  label: string;
  type: 'movie' | 'show';
  itemCount: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface MovieSummary {
  id: number;
  libraryId: string;
  title: string;
  year: number | null;
  /** Prévu pour les affiches, toujours null pour l'instant. */
  posterPath: string | null;
  addedAt: string;
  fileCount: number;
}

export interface ShowSummary {
  id: number;
  libraryId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  addedAt: string;
  seasonCount: number;
  episodeCount: number;
}

export interface SubtitleInfo {
  id: number;
  fileName: string;
  format: string;
  language: string | null;
  forced: number;
  hearingImpaired: number;
}

export interface MediaFileInfo {
  id: number;
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  resolution: string | null;
  durationSeconds: number | null;
  rootPath: string;
  subtitles: SubtitleInfo[];
}

export interface MovieDetail {
  id: number;
  libraryId: string;
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  addedAt: string;
  files: MediaFileInfo[];
}

export interface EpisodeSummary {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeNumberEnd: number | null;
  title: string | null;
  overview: string | null;
  fileCount: number;
}

export interface SeasonDetail {
  seasonNumber: number;
  title: string | null;
  episodes: EpisodeSummary[];
}

export interface ShowDetail {
  id: number;
  libraryId: string;
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  addedAt: string;
  seasons: SeasonDetail[];
}

export type SortField = 'title' | 'year' | 'added';

export interface ListParams {
  library?: string;
  search?: string;
  sort?: SortField;
  page?: number;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${response.status} — ${message || response.statusText}`);
  }
  return (await response.json()) as T;
}

function buildQuery(params: ListParams): string {
  const search = new URLSearchParams();
  if (params.library !== undefined) search.set('library', params.library);
  if (params.search !== undefined && params.search !== '') search.set('search', params.search);
  if (params.sort !== undefined) search.set('sort', params.sort);
  if (params.page !== undefined && params.page > 1) search.set('page', String(params.page));
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

export const api = {
  libraries: () => getJson<Library[]>('/api/libraries'),
  movies: (params: ListParams) => getJson<Page<MovieSummary>>(`/api/movies${buildQuery(params)}`),
  shows: (params: ListParams) => getJson<Page<ShowSummary>>(`/api/shows${buildQuery(params)}`),
  movie: (id: number | string) => getJson<MovieDetail>(`/api/movies/${id}`),
  show: (id: number | string) => getJson<ShowDetail>(`/api/shows/${id}`),
};
