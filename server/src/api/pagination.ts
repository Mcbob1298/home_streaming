/** Pagination et lecture des paramètres de requête, partagées par les routes. */
import { titleKey } from '../util/text.js';

export const PAGE_SIZE = 50;

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function buildPage<T>(items: T[], page: number, total: number): Page<T> {
  return {
    items,
    page,
    pageSize: PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export function readPage(value: unknown): number {
  const page = Number(value);
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export type SortField = 'title' | 'year' | 'added';
export type SortOrder = 'asc' | 'desc';

export function readSort(value: unknown): SortField {
  if (value === 'year' || value === 'added') return value;
  return 'title';
}

export function readOrder(value: unknown, field: SortField): SortOrder {
  if (value === 'asc' || value === 'desc') return value;
  // Par défaut : alphabétique croissant, mais du plus récent au plus ancien
  // pour l'année et la date d'ajout — c'est ce qu'on veut voir en premier.
  return field === 'title' ? 'asc' : 'desc';
}

/**
 * Fragment ORDER BY. Les valeurs sont issues d'une liste fermée, jamais de la
 * chaîne envoyée par le client : pas d'injection SQL possible.
 *
 * `year IS NULL` en premier critère met les entrées sans année à la fin, quel
 * que soit le sens de tri.
 */
export function buildOrderBy(field: SortField, order: SortOrder): string {
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  if (field === 'year') return `year IS NULL, year ${direction}, sort_title ASC`;
  if (field === 'added') return `added_at ${direction}, sort_title ASC`;
  return `sort_title ${direction}`;
}

export interface SearchClause {
  sql: string;
  parameters: string[];
}

/**
 * Recherche par mots : chaque mot doit apparaître dans le titre normalisé.
 *
 * On compare sur `title_key`, qui est sans accents ni ponctuation : chercher
 * « amelie » trouve « Amélie », et « ocean 11 » trouve « Ocean's 11 ».
 * Les caractères spéciaux de LIKE (% et _) disparaissent à la normalisation,
 * il n'y a donc rien à échapper.
 */
export function buildSearchClause(search: string | null): SearchClause {
  if (search === null) return { sql: '', parameters: [] };

  const words = titleKey(search).split(' ').filter((word) => word !== '');
  if (words.length === 0) return { sql: '', parameters: [] };

  return {
    sql: words.map(() => `AND title_key LIKE '%' || ? || '%'`).join(' '),
    parameters: words,
  };
}
