/**
 * Choix du logo de titre parmi ceux que propose TMDB.
 *
 * Le « title treatment » est le logo graphique d'une œuvre, sur fond
 * transparent. C'est lui qui remplace le titre en texte sur les vignettes.
 * TMDB en renvoie souvent une dizaine — plusieurs langues, plusieurs formats,
 * plusieurs qualités — et il faut en désigner un seul.
 *
 * Pur : on lui donne la liste, il rend un chemin. Aucun accès réseau.
 */

export interface TmdbLogo {
  file_path?: string;
  iso_639_1?: string | null;
  vote_average?: number;
  width?: number;
}

/**
 * Ordre de préférence des langues.
 *
 * Le français d'abord, l'anglais ensuite, et en dernier les logos sans langue
 * déclarée — souvent les meilleurs pour les titres dont le graphisme ne
 * contient aucun mot traduisible, mais aussi les plus inégaux.
 */
const LANGUAGE_ORDER = ['fr', 'en', null] as const;

function languageRank(logo: TmdbLogo): number {
  const language = logo.iso_639_1 ?? null;
  const index = LANGUAGE_ORDER.findIndex((wanted) => wanted === language);
  // Une langue hors liste passe après tout le monde plutôt que d'être écartée.
  return index === -1 ? LANGUAGE_ORDER.length : index;
}

function isPng(logo: TmdbLogo): boolean {
  return (logo.file_path ?? '').toLowerCase().endsWith('.png');
}

/**
 * Retient le meilleur logo, ou null s'il n'y en a aucun.
 *
 * Trois critères, dans cet ordre : la langue, puis le format — le PNG est
 * préféré au SVG, que TMDB ne redimensionne pas et que tous les navigateurs
 * ne rendent pas de la même façon —, puis la note des contributeurs.
 */
export function pickLogo(logos: readonly TmdbLogo[] | undefined): string | null {
  const usable = (logos ?? []).filter((logo) => typeof logo.file_path === 'string' && logo.file_path !== '');
  if (usable.length === 0) return null;

  const best = [...usable].sort((left, right) => {
    const byLanguage = languageRank(left) - languageRank(right);
    if (byLanguage !== 0) return byLanguage;

    const byFormat = Number(isPng(right)) - Number(isPng(left));
    if (byFormat !== 0) return byFormat;

    return (right.vote_average ?? 0) - (left.vote_average ?? 0);
  })[0];

  return best?.file_path ?? null;
}
