/**
 * Sélection des personnes à retenir dans les crédits TMDB.
 *
 * TMDB renvoie des distributions de plusieurs dizaines de noms et des équipes
 * techniques de plusieurs centaines de lignes. On n'en garde que ce que la
 * fiche affiche : la réalisation et les six premiers rôles.
 *
 * Module pur — entrée : la réponse TMDB, sortie : des objets. Aucun accès à la
 * base ni au réseau, donc entièrement testable.
 */

/** Nombre d'acteurs retenus, tel qu'affiché dans l'onglet Détails. */
export const CAST_LIMIT = 6;

export interface TmdbCastEntry {
  id?: number;
  name?: string;
  profile_path?: string | null;
  character?: string;
  order?: number;
}

export interface TmdbCrewEntry {
  id?: number;
  name?: string;
  profile_path?: string | null;
  department?: string;
  job?: string;
}

export interface TmdbCredits {
  cast?: TmdbCastEntry[];
  crew?: TmdbCrewEntry[];
}

/** Créateurs d'une série : TMDB les expose à part, hors du bloc `credits`. */
export interface TmdbCreatedBy {
  id?: number;
  name?: string;
  profile_path?: string | null;
}

/**
 * `cast` regroupe les interprètes, `director` et `creator` la paternité de
 * l'œuvre. Les trois se distinguent à l'affichage : « Réalisation » pour un
 * film, « Création » pour une série, « Distribution » pour les interprètes.
 */
export type CreditRole = 'cast' | 'director' | 'creator';

export interface SelectedCredit {
  personId: number;
  name: string;
  profilePath: string | null;
  role: CreditRole;
  character: string | null;
  /** Département TMDB, conservé tel quel — « Directing », « Acting », ou rien. */
  department: string | null;
  /** Rang dans la distribution, tel que TMDB le donne. */
  order: number | null;
}

function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Distribution principale, dans l'ordre de TMDB.
 *
 * Deux précautions :
 *
 * - Le tri se fait sur `order`, pas sur l'ordre du tableau. TMDB les fait
 *   généralement coïncider, mais rien ne le garantit et un `order` absent doit
 *   passer en dernier plutôt que de remonter en tête avec un NaN.
 * - Un acteur interprétant deux personnages apparaît deux fois dans `cast`. Il
 *   ne doit occuper qu'une des six places, sinon une seule tête mange la
 *   moitié de la liste.
 */
export function selectCast(credits: TmdbCredits | undefined): SelectedCredit[] {
  const entries = credits?.cast ?? [];

  const usable = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry.id === 'number' && cleanText(entry.name) !== null)
    .sort((a, b) => {
      const left = a.entry.order ?? Number.POSITIVE_INFINITY;
      const right = b.entry.order ?? Number.POSITIVE_INFINITY;
      // À rang égal, l'ordre du tableau tranche : le tri reste déterministe.
      return left === right ? a.index - b.index : left - right;
    });

  const seen = new Set<number>();
  const selected: SelectedCredit[] = [];

  for (const { entry } of usable) {
    const personId = entry.id as number;
    if (seen.has(personId)) continue;
    seen.add(personId);

    selected.push({
      personId,
      name: cleanText(entry.name) as string,
      profilePath: cleanText(entry.profile_path),
      role: 'cast',
      character: cleanText(entry.character),
      department: 'Acting',
      order: entry.order ?? null,
    });

    if (selected.length >= CAST_LIMIT) break;
  }

  return selected;
}

/**
 * Réalisateurs d'un film.
 *
 * Le filtre porte sur le couple département + poste. « Directing » seul ne
 * suffit pas : ce département contient aussi les assistants réalisateur et les
 * scriptes, qui ne sont pas ce que la fiche annonce.
 *
 * Plusieurs réalisateurs sont possibles et tous sont retenus — les frères
 * Coen, les Wachowski, Pixar en tandem.
 */
export function selectDirectors(credits: TmdbCredits | undefined): SelectedCredit[] {
  const seen = new Set<number>();
  const selected: SelectedCredit[] = [];

  for (const entry of credits?.crew ?? []) {
    if (entry.department !== 'Directing' || entry.job !== 'Director') continue;
    if (typeof entry.id !== 'number') continue;
    const name = cleanText(entry.name);
    if (name === null || seen.has(entry.id)) continue;
    seen.add(entry.id);

    selected.push({
      personId: entry.id,
      name,
      profilePath: cleanText(entry.profile_path),
      role: 'director',
      character: null,
      department: 'Directing',
      order: null,
    });
  }

  return selected;
}

/** Créateurs d'une série, depuis `created_by`. */
export function selectCreators(createdBy: TmdbCreatedBy[] | undefined): SelectedCredit[] {
  const seen = new Set<number>();
  const selected: SelectedCredit[] = [];

  for (const entry of createdBy ?? []) {
    if (typeof entry.id !== 'number') continue;
    const name = cleanText(entry.name);
    if (name === null || seen.has(entry.id)) continue;
    seen.add(entry.id);

    selected.push({
      personId: entry.id,
      name,
      profilePath: cleanText(entry.profile_path),
      role: 'creator',
      character: null,
      department: null,
      order: null,
    });
  }

  return selected;
}

/** Crédits retenus pour un film : réalisation puis distribution. */
export function selectMovieCredits(details: { credits?: TmdbCredits }): SelectedCredit[] {
  return [...selectDirectors(details.credits), ...selectCast(details.credits)];
}

/** Crédits retenus pour une série : création puis distribution. */
export function selectShowCredits(details: {
  credits?: TmdbCredits;
  created_by?: TmdbCreatedBy[];
}): SelectedCredit[] {
  return [...selectCreators(details.created_by), ...selectCast(details.credits)];
}
