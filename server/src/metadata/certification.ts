/**
 * Classification par âge (« Tous publics », « 12 », « TV-MA »…).
 *
 * L'onglet Détails l'affiche, mais elle ne figure ni dans le détail du film ni
 * dans celui de la série : TMDB la range dans deux blocs distincts, et sous
 * deux formes différentes.
 *
 * - Films : `release_dates`, une liste de dates par pays, chacune portant une
 *   classification et un `type` (1 = première, 3 = sortie en salle, 4 = vidéo…).
 * - Séries : `content_ratings`, un simple couple pays / classification.
 *
 * Module pur, comme le reste de la sélection TMDB.
 */

/** Pays interrogés, dans l'ordre. La France d'abord, faute de quoi les États-Unis. */
export const CERTIFICATION_COUNTRIES = ['FR', 'US'] as const;

export interface TmdbReleaseDates {
  results?: {
    iso_3166_1?: string;
    release_dates?: { certification?: string; type?: number }[];
  }[];
}

export interface TmdbContentRatings {
  results?: { iso_3166_1?: string; rating?: string }[];
}

function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Classification d'un film.
 *
 * TMDB renvoie souvent plusieurs entrées pour un même pays — sortie en salle,
 * vidéo, télévision — dont certaines sans classification. On prend la première
 * qui en porte une, dans l'ordre donné par TMDB.
 */
export function pickMovieCertification(
  releaseDates: TmdbReleaseDates | undefined,
  countries: readonly string[] = CERTIFICATION_COUNTRIES,
): string | null {
  const results = releaseDates?.results ?? [];
  for (const country of countries) {
    const entry = results.find((row) => row.iso_3166_1 === country);
    for (const release of entry?.release_dates ?? []) {
      const certification = cleanText(release.certification);
      if (certification !== null) return certification;
    }
  }
  return null;
}

/** Classification d'une série. */
export function pickShowCertification(
  contentRatings: TmdbContentRatings | undefined,
  countries: readonly string[] = CERTIFICATION_COUNTRIES,
): string | null {
  const results = contentRatings?.results ?? [];
  for (const country of countries) {
    const entry = results.find((row) => row.iso_3166_1 === country);
    const rating = cleanText(entry?.rating);
    if (rating !== null) return rating;
  }
  return null;
}
