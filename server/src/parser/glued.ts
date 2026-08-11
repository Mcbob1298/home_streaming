/**
 * Segmentation des titres écrits d'un seul tenant.
 *
 *   TheLordoftheRingsTheFellowshipoftheRing
 *   -> The Lord of the Rings The Fellowship of the Ring
 *
 * Deux passages sont nécessaires. Couper sur les majuscules seules donnerait
 * « The Lordofthe Rings The Fellowshipofthe Ring » : les mots-outils collés en
 * minuscules (of, the, de, la…) ne portent pas de majuscule et restent soudés
 * au mot précédent. Un second passage les décolle.
 *
 * La règle ne s'applique QU'AUX fragments entièrement collés. Un titre qui
 * contient déjà des séparateurs garde ses mots tels quels : les segmenter
 * casserait des titres corrects.
 */

/**
 * Mots-outils anglais et français susceptibles d'être collés en minuscules.
 * Liste volontairement courte : chaque entrée est une occasion de mal couper.
 */
const FUNCTION_WORDS = [
  // anglais
  'of',
  'the',
  'and',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'a',
  'an',
  // français
  'de',
  'des',
  'du',
  'la',
  'le',
  'les',
  'un',
  'une',
  'et',
  'au',
  'aux',
  'dans',
  'sur',
  'par',
];

/** Longueur minimale d'un fragment pour être considéré comme « collé ». */
const MIN_GLUED_LENGTH = 12;

/** Nombre minimal de majuscules internes pour soupçonner un titre collé. */
const MIN_INTERNAL_CAPITALS = 2;

/**
 * Longueur minimale d'un fragment avant d'essayer de lui décoller un
 * mot-outil. En dessous, le risque d'amputer un vrai mot l'emporte :
 * « Grand » se terminerait par « and », « Island » par « and ».
 */
const MIN_PEEL_LENGTH = 8;

/** Longueur minimale du reste après décollage, pour la même raison. */
const MIN_STEM_LENGTH = 3;

/** Nombre maximal de mots-outils décollés d'un même fragment. */
const MAX_PEELS = 4;

/**
 * Longueur maximale du reste, une fois les mots-outils décollés.
 *
 * Le décollage ne sert que s'il fait apparaître un mot plausible. Sur
 * « Latourmontparnasseinfernale » — un titre entièrement en minuscules, que
 * rien ne permet de segmenter — il ne grignotait que la fin et produisait
 * « Latourmontparnasseinfern a le », pire que l'original. Si le reste demeure
 * manifestement soudé, on renonce et on laisse le fragment intact.
 */
const MAX_STEM_AFTER_PEEL = 14;

function countInternalCapitals(value: string): number {
  let count = 0;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character >= 'A' && character <= 'Z') count += 1;
  }
  return count;
}

/** Un fragment sans séparateur, long, et truffé de majuscules internes. */
export function looksGlued(fragment: string): boolean {
  if (fragment.length < MIN_GLUED_LENGTH) return false;
  if (/[\s._]/.test(fragment)) return false;
  return countInternalCapitals(fragment) >= MIN_INTERNAL_CAPITALS;
}

/**
 * Premier passage : coupe aux changements de nature.
 *
 * minuscule→majuscule, majuscule→début de mot, lettre→chiffre, chiffre→majuscule.
 *
 * La deuxième règle traite « OnionAKnives » : le « A » est une majuscule collée
 * à une autre majuscule, que la première règle ne voit pas. On exige au moins
 * deux minuscules derrière pour ne couper que devant un vrai mot — sans cela,
 * « MULTi » deviendrait « MUL Ti » et cesserait d'être reconnu comme du bruit.
 */
function splitOnTransitions(fragment: string): string[] {
  return fragment
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll}{2,})/gu, '$1 $2')
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .replace(/(\d)(\p{Lu})/gu, '$1 $2')
    .split(' ')
    .filter((part) => part !== '');
}

/**
 * Second passage : décolle les mots-outils agglutinés à la fin d'un fragment.
 * « Fellowshipofthe » -> « Fellowship of the »
 */
function peelFunctionWords(fragment: string): string[] {
  if (fragment.length < MIN_PEEL_LENGTH) return [fragment];

  const peeled: string[] = [];
  let stem = fragment;

  for (let round = 0; round < MAX_PEELS; round += 1) {
    const lower = stem.toLowerCase();
    // Le mot-outil le plus long d'abord : « the » avant « he » n'existe pas
    // dans la liste, mais « des » doit passer avant « de ».
    const candidates = FUNCTION_WORDS.filter((word) => lower.endsWith(word)).sort(
      (a, b) => b.length - a.length,
    );

    /*
     * Le premier mot décollé doit faire au moins trois lettres.
     *
     * Les mots-outils de deux lettres (an, of, de, le, et…) sont des fins de
     * mot beaucoup trop banales : « Klansman » se terminait par « an » et
     * devenait « Klansm an ». Une fois qu'un mot de trois lettres a été trouvé,
     * la suite est fiable : « Fellowshipofthe » donne « the » puis « of ».
     */
    const minimum = round === 0 ? 3 : 2;
    const word = candidates.find(
      (candidate) => candidate.length >= minimum && stem.length - candidate.length >= MIN_STEM_LENGTH,
    );
    if (word === undefined) break;

    peeled.unshift(stem.slice(stem.length - word.length));
    stem = stem.slice(0, stem.length - word.length);
  }

  if (peeled.length === 0) return [fragment];
  // Le reste est toujours un bloc soudé : le décollage n'a rien segmenté du
  // tout, il a seulement rogné la fin. Mieux vaut ne rien faire.
  if (stem.length > MAX_STEM_AFTER_PEEL) return [fragment];

  return [stem, ...peeled];
}

/**
 * Segmente les fragments collés d'un nom, en laissant le reste intact.
 *
 * Le nom est d'abord découpé sur ses séparateurs existants : seuls les
 * morceaux réellement soudés sont segmentés. « Titre.2019.1080p.BluRay » n'est
 * donc pas touché, ses morceaux étant trop courts.
 */
const FUNCTION_WORD_SET = new Set(FUNCTION_WORDS);

/**
 * La segmentation a-t-elle produit quelque chose de crédible ?
 *
 * Un vrai titre soudé se découpe en mots. Une graphie stylisée, elle, se
 * découpe en miettes : « BlacKkKlansman » donne « Blac Kk Klansman », où
 * « Kk » ne veut rien dire. Ce genre de fragment est le signe qu'on a eu tort
 * de découper, et qu'il vaut mieux laisser le nom tel quel.
 *
 * Les sigles et chiffres romains en capitales (« IX », « UTT ») sont admis :
 * ce sont de vrais fragments.
 */
function segmentationLooksSane(fragments: readonly string[]): boolean {
  return fragments.every((fragment) => {
    if (fragment.length > 2) return true;
    if (!/^\p{L}+$/u.test(fragment)) return true; // chiffres, ponctuation
    if (fragment === fragment.toUpperCase()) return true; // sigle ou chiffre romain
    return FUNCTION_WORD_SET.has(fragment.toLowerCase());
  });
}

export function segmentGluedWords(value: string): string {
  const parts = value.split(/[\s._]+/).filter((part) => part !== '');

  const rebuilt = parts.flatMap((part) => {
    if (!looksGlued(part)) return [part];
    const fragments = splitOnTransitions(part).flatMap(peelFunctionWords);
    return segmentationLooksSane(fragments) ? fragments : [part];
  });

  return rebuilt.join(' ');
}
