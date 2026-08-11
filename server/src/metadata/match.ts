/**
 * Choix du bon résultat TMDB, et mesure de la confiance qu'on lui accorde.
 *
 * Module pur : on lui donne ce qu'on cherche et ce que TMDB a renvoyé, il rend
 * un classement. Aucun accès réseau, aucun accès base — donc testable.
 *
 * Le principe directeur : **ne jamais deviner en silence.** Une correspondance
 * douteuse n'est pas appliquée, elle est marquée « à vérifier ». Mieux vaut une
 * fiche vide qu'une fiche fausse : une fiche vide se voit, une fiche fausse non.
 */
import { titleKey } from '../util/text.js';
import type { TmdbSearchResult } from './tmdb.js';

/** Au-dessus, on applique sans demander. En dessous, on demande. */
export const CONFIDENCE_THRESHOLD = 0.8;

export interface MatchQuery {
  title: string;
  year: number | null;
}

export interface Candidate {
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  popularity: number;
}

/** Quel titre du candidat a servi à la comparaison. */
export type MatchedOn = 'localisé' | 'original' | 'alternatif';

export interface ScoredCandidate extends Candidate {
  confidence: number;
  reason: string;
  /** Le titre est identique au nôtre, à la ponctuation et aux accents près. */
  exact: boolean;
  /** Sur quel titre la correspondance a été établie — pour un rapport lisible. */
  matchedOn: MatchedOn;
  /** Le titre effectivement comparé, quand ce n'est pas le titre localisé. */
  matchedTitle: string | null;
}

export interface MatchOutcome {
  /** Meilleur candidat, ou null si TMDB n'a rien renvoyé. */
  best: ScoredCandidate | null;
  /** Les cinq premiers, conservés pour l'écran de review. */
  candidates: ScoredCandidate[];
  /** Vrai si la confiance suffit pour écrire les métadonnées sans demander. */
  confident: boolean;
}

/** Extrait l'année d'une date TMDB (« 2019-07-02 »). */
export function yearOf(date: string | undefined): number | null {
  if (date === undefined || date.length < 4) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

/** Normalise un résultat de recherche, film ou série. */
export function toCandidate(result: TmdbSearchResult): Candidate {
  return {
    tmdbId: result.id,
    title: result.title ?? result.name ?? '',
    originalTitle: result.original_title ?? result.original_name ?? null,
    year: yearOf(result.release_date ?? result.first_air_date),
    overview: result.overview === undefined || result.overview.trim() === '' ? null : result.overview,
    posterPath: result.poster_path ?? null,
    popularity: result.popularity ?? 0,
  };
}

/**
 * Deux écritures normalisées d'un même titre, à cause des apostrophes.
 *
 * `titleKey` supprime les apostrophes, pour que « Ocean's Eleven » rejoigne
 * « Oceans Eleven ». Mais un système de fichiers Windows les remplace souvent
 * par une espace : « À l'ancienne » devient « A l ancienne » sur le disque.
 * Les deux normalisations divergent alors (« a lancienne » contre
 * « a l ancienne ») et le titre ne se reconnaît plus lui-même.
 *
 * On garde donc les deux formes et on retient la meilleure correspondance.
 */
function titleVariants(title: string): string[] {
  const collapsed = titleKey(title);
  const spaced = titleKey(title.replace(/['’`]/g, ' '));
  return collapsed === spaced ? [collapsed] : [collapsed, spaced];
}

/** Similarité entre deux ensembles de mots, entre 0 et 1. */
function wordSimilarity(left: string, right: string): number {
  const a = new Set(left.split(' ').filter((word) => word !== ''));
  const b = new Set(right.split(' ').filter((word) => word !== ''));
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;

  // Moyenne harmonique : pénalise autant les mots manquants que les mots en trop.
  const precision = shared / a.size;
  const recall = shared / b.size;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Similarité entre deux titres, entre 0 et 1.
 *
 * On compare des ensembles de mots plutôt que des caractères : c'est robuste
 * aux inversions et aux mots manquants, qui sont les écarts courants entre un
 * nom de fichier et un titre officiel (« Le Seigneur des Anneaux » contre
 * « Le Seigneur des anneaux : La Communauté de l'anneau »).
 */
export function titleSimilarity(left: string, right: string): number {
  let best = 0;
  for (const a of titleVariants(left)) {
    for (const b of titleVariants(right)) best = Math.max(best, wordSimilarity(a, b));
  }
  return best;
}

/** Vrai si les deux titres sont identiques, à la ponctuation et aux accents près. */
export function titlesMatch(left: string, right: string): boolean {
  const variants = new Set(titleVariants(left));
  return titleVariants(right).some((variant) => variants.has(variant));
}

/**
 * Note un candidat entre 0 et 1.
 *
 * La règle demandée, telle quelle :
 * - titre normalisé identique ET même année  -> confiance haute ;
 * - titre approchant, ou année absente ou différente -> confiance basse.
 *
 * Le titre original est testé aussi : beaucoup de films sont rangés sous leur
 * titre anglais alors que TMDB répond en français, et inversement.
 */
export type ScoreParts = { confidence: number; reason: string; exact: boolean; matchedOn: MatchedOn; matchedTitle: string | null };

/**
 * Retient, parmi tous les titres connus du candidat, celui qui ressemble le
 * plus au nôtre.
 *
 * Trois sources, dans l'ordre de préférence à égalité de score : le titre
 * localisé (ce que TMDB renvoie en français), le titre original (la langue de
 * tournage), et les titres alternatifs (les sorties étrangères). C'est la
 * troisième qui rattrape les fichiers rangés sous leur titre anglais alors que
 * TMDB répond en français et que l'original est en japonais.
 */
function bestTitleMatch(
  query: MatchQuery,
  candidate: Candidate,
  alternativeTitles: readonly string[],
): { similarity: number; exact: boolean; matchedOn: MatchedOn; matchedTitle: string | null } {
  const sources: { title: string; matchedOn: MatchedOn }[] = [
    { title: candidate.title, matchedOn: 'localisé' },
  ];
  if (candidate.originalTitle !== null) {
    sources.push({ title: candidate.originalTitle, matchedOn: 'original' });
  }
  for (const title of alternativeTitles) {
    /*
     * Un titre qui ne laisse aucune lettre après normalisation ne sert à rien
     * et fausse la mesure : « პლატფორმა 2 » se réduit à « 2 », qui partage
     * 100 % de ses mots avec « The Platform 2 » et décrochait ainsi un meilleur
     * score que le vrai titre français. Les alphabets non latins sont écartés,
     * faute de pouvoir les comparer.
     */
    if (!/[a-z]/.test(titleKey(title))) continue;
    sources.push({ title, matchedOn: 'alternatif' });
  }

  let best = { similarity: 0, exact: false, matchedOn: 'localisé' as MatchedOn, matchedTitle: null as string | null };

  for (const source of sources) {
    const exact = titlesMatch(query.title, source.title);
    const similarity = exact ? 1 : titleSimilarity(query.title, source.title);
    // Une correspondance exacte l'emporte toujours sur une simple ressemblance.
    if (exact && !best.exact) {
      best = { similarity, exact, matchedOn: source.matchedOn, matchedTitle: source.matchedOn === 'localisé' ? null : source.title };
      continue;
    }
    if (!best.exact && similarity > best.similarity) {
      best = { similarity, exact, matchedOn: source.matchedOn, matchedTitle: source.matchedOn === 'localisé' ? null : source.title };
    }
  }

  return best;
}

export function scoreCandidate(
  query: MatchQuery,
  candidate: Candidate,
  alternativeTitles: readonly string[] = [],
): ScoreParts {
  const match = bestTitleMatch(query, candidate, alternativeTitles);
  const { exact, similarity, matchedOn, matchedTitle } = match;
  const via = matchedOn === 'localisé' ? '' : ` (titre ${matchedOn} « ${matchedTitle ?? ''} »)`;

  const parts = (confidence: number, reason: string): ScoreParts => ({
    confidence,
    reason: `${reason}${via}`,
    exact,
    matchedOn,
    matchedTitle,
  });

  if (query.year === null) {
    /*
     * Sans année, on ne peut pas départager des homonymes. La note reste donc
     * sous le seuil — mais `matchResults` la relèvera si TMDB ne renvoie
     * qu'UN SEUL titre exactement identique : il n'y a alors rien à départager.
     */
    if (exact) return parts(0.6, 'titre identique, mais aucune année dans le nom de fichier');
    return parts(similarity * 0.5, 'titre approchant et aucune année');
  }

  if (candidate.year === null) {
    return parts(similarity * 0.5, 'TMDB ne donne pas d’année pour ce résultat');
  }

  const gap = Math.abs(candidate.year - query.year);

  if (exact && gap === 0) return parts(1, 'titre et année identiques');
  // Un an d'écart est courant : date de sortie salle contre date de sortie
  // nationale, ou fin d'année civile.
  if (exact && gap === 1) return parts(0.85, 'titre identique, un an d’écart');
  if (exact) return parts(0.45, `titre identique mais ${gap} ans d’écart`);

  if (gap === 0 && similarity >= 0.8) return parts(0.82, 'année identique, titre très proche');

  /*
   * L'année identique ne vaut rien à elle seule.
   *
   * Cette branche accordait autrefois un plancher de 0,5 dès que l'année
   * correspondait, quelle que soit la ressemblance des titres : « bac nord »
   * décrochait 0,50 face à « Norm of the North: Family Vacation », qui ne
   * partage aucun mot avec lui. La note suit désormais la ressemblance, et
   * tombe à zéro quand elle est nulle.
   *
   * Le facteur 0,75 garde cette branche sous le seuil : au-delà de 0,8 de
   * ressemblance, c'est la branche précédente qui s'applique.
   */
  if (gap === 0) return parts(similarity * 0.75, 'année identique, titre approchant');

  return parts(similarity * 0.4, `titre approchant, ${gap} ans d’écart`);
}

/** Nombre de candidats conservés pour l'écran de review. */
export const CANDIDATES_KEPT = 5;

/**
 * Classe les résultats et décide si la correspondance est sûre.
 *
 * En cas d'égalité de confiance, la popularité TMDB départage : c'est le
 * meilleur indice disponible pour distinguer l'œuvre connue de son homonyme
 * confidentiel.
 */
export function matchResults(query: MatchQuery, results: readonly TmdbSearchResult[]): MatchOutcome {
  return rankCandidates(
    query,
    results.map((result) => {
      const candidate = toCandidate(result);
      return { ...candidate, ...scoreCandidate(query, candidate) };
    }),
  );
}

/**
 * Classe des candidats déjà notés et décide si la correspondance est sûre.
 * Séparé de `matchResults` pour pouvoir reclasser après avoir récupéré des
 * titres alternatifs.
 */
export function rankCandidates(query: MatchQuery, scored: ScoredCandidate[]): MatchOutcome {
  /*
   * Cas très courant pour les séries : le dossier ne porte pas d'année, donc
   * aucun candidat n'atteint le seuil. Mais si UN SEUL résultat porte
   * exactement notre titre, il n'y a rien à deviner — « Breaking Bad » n'a pas
   * d'homonyme. On relève la note.
   *
   * Dès qu'il y a deux titres exactement identiques (« Dune », deux séries
   * homonymes), on ne touche à rien : c'est précisément le cas qu'il faut
   * soumettre à l'utilisateur.
   */
  if (query.year === null) {
    const exactOnes = scored.filter((candidate) => candidate.exact);
    const only = exactOnes[0];
    if (exactOnes.length === 1 && only !== undefined) {
      only.confidence = 0.85;
      only.reason = 'titre identique et sans homonyme sur TMDB (aucune année dans le nom de fichier)';
    }
  }

  scored.sort((a, b) => b.confidence - a.confidence || b.popularity - a.popularity);

  const candidates = scored.slice(0, CANDIDATES_KEPT);
  const best = candidates[0] ?? null;

  /*
   * Deux candidats aussi crédibles l'un que l'autre, c'est justement le cas
   * qu'il ne faut pas trancher tout seul : deux remakes de la même année,
   * ou une série et son reboot. On demande.
   */
  const second = candidates[1];
  const ambiguous =
    best !== null && second !== undefined && best.confidence - second.confidence < 0.1 && second.confidence >= CONFIDENCE_THRESHOLD;

  return {
    best,
    candidates,
    confident: best !== null && best.confidence >= CONFIDENCE_THRESHOLD && !ambiguous,
  };
}
