/**
 * Le « bruit » : tout ce qui, dans un nom de fichier, décrit le fichier et non
 * l'œuvre — qualité, codecs, langue de doublage, nom du groupe de release…
 *
 * Stratégie retenue : plutôt que de supprimer ces mots un par un (ce qui laisse
 * des morceaux de titre recollés bizarrement), on cherche LA PREMIÈRE occurrence
 * de bruit dans le nom et on coupe tout à partir de là. Dans la pratique les
 * noms sont toujours construits « titre d'abord, technique ensuite », donc
 * couper au premier marqueur technique donne un titre propre :
 *
 *   Titre.2019.1080p.BluRay.x264-GROUPE
 *                ^ on coupe ici
 *
 * Deux listes, parce que tous les marqueurs ne se valent pas :
 *
 * - FORT   : ne peut pas être un mot de titre (1080p, x264, HEVC, VOSTFR…).
 *            Coupe toujours, même en première position — un nom qui commence
 *            par « 1080p » n'a tout simplement pas de titre exploitable.
 * - FAIBLE : pourrait être un vrai mot de titre (« Web » Therapy,
 *            « French » Kiss, « Opus »). Ne coupe que s'il y a déjà du texte
 *            avant lui.
 *
 * C'est volontairement simple et prévisible. Ajouter un motif dans la bonne
 * liste suffit à traiter une nouvelle convention.
 */

/**
 * Motifs qui ne peuvent pas faire partie d'un titre.
 *
 * Remarque : les noms sont passés dans `normalizeSeparators()` avant d'être
 * testés, donc les points ont déjà été remplacés par des espaces. Les motifs
 * composés utilisent `[-. ]` pour accepter indifféremment « web-dl », « web dl »
 * ou « web.dl ».
 */
const STRONG_NOISE: string[] = [
  // --- Résolution / définition ---
  '\\d{3,4}p', // 480p, 576p, 720p, 1080p, 2160p
  '\\d{3,4}i', // 1080i
  '4k',
  'uhd',
  'fullhd',
  'hdlight',
  'hqcam',

  // --- Source ---
  'blu[-. ]?ray',
  'bdrip',
  'brrip',
  'bd[-. ]?remux',
  'bdmux',
  'bdmv',
  'remux',
  'web[-. ]?dl',
  'web[-. ]?rip',
  'webhd',
  'hdtv',
  'pdtv',
  'sdtv',
  'tvrip',
  'dvd[-. ]?rip',
  'dvd[-. ]?scr(?:eener)?',
  'dvdr[59]?',
  'dvd[59]',
  'vhsrip',
  'hdcam',
  'cam[-. ]?rip',
  'telesync',
  'telecine',
  'screener',
  'r5',

  // --- Codecs vidéo ---
  'x[-. ]?26[45]',
  'h[-. ]?26[45]',
  'hevc',
  'avc',
  'xvid',
  'divx',
  'vp9',
  'av1',
  'mpeg[-. ]?[24]',
  'hi10p',
  '(?:8|10|12)[-. ]?bits?',

  // --- Codecs / pistes audio ---
  'dts[-. ]?hd(?:[-. ]?ma)?',
  'dts[-. ]?x',
  'dts',
  'truehd',
  'atmos',
  'e?[-. ]?ac[-. ]?3',
  'ddp?\\+?[-. ]?[0-9][-. ][01]',
  'ddp',
  'dd\\+',
  'aac(?:[-. ]?[0-9][-. ][01])?',
  'flac',
  'lpcm',
  '[0-9][-. ][01]ch',
  '[0-9][-. ][01]', // 5.1, 7.1, 2.0 (les points sont devenus des espaces)

  // --- HDR ---
  'hdr10\\+?',
  'hdr',
  'dolby[-. ]?vision',
  'dovi',
  'sdr',

  // --- Langues / doublage ---
  'vostfr',
  'vosta',
  'vost',
  'vf[fqib]?',
  'truefrench',
  'subfrench',
  'multi(?:lang(?:ue)?s?)?',
  'dual[-. ]?audio',
];

/**
 * Motifs qui coupent seulement s'il y a déjà du texte avant eux.
 *
 * Les mentions d'édition (Extended, Final Cut, Remastered…) sont ici : deux
 * versions d'un même film doivent se regrouper sur la même fiche, avec deux
 * fichiers rattachés — c'est exactement la relation « un film, plusieurs
 * fichiers » prévue par le modèle de données.
 */
const WEAK_NOISE: string[] = [
  'web',
  'vo',
  'french',
  'english',
  'mp3',
  'opus',
  'extended(?:[-. ]?cut)?',
  "director'?s?[-. ]?cut",
  'final[-. ]?cut',
  'theatrical(?:[-. ]?cut)?',
  'uncut',
  'unrated',
  'remaster(?:ed|is[ée]e?)?',
  'imax',
  'criterion',
  'int[ée]grale',
  'integrale',
  'proper',
  'repack',
  'readnfo',
  'internal',
  'limited',
  'complete',
];

/**
 * On encadre les motifs de « lookarounds » plutôt que de `\b` : certains
 * finissent par un caractère non alphanumérique (`dd\+`), pour lequel `\b` ne
 * se comporte pas comme on l'attend. `\p{L}` couvre aussi les lettres accentuées.
 */
function buildNoiseRegExp(patterns: string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${patterns.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

/** Non globales : `exec()` renvoie donc la première occurrence, la plus à gauche. */
export const STRONG_NOISE_RE = buildNoiseRegExp(STRONG_NOISE);
export const WEAK_NOISE_RE = buildNoiseRegExp(WEAK_NOISE);

/**
 * Index où couper le titre, ou -1 s'il n'y a rien à couper.
 * Le bruit « faible » en première position est ignoré.
 */
export function findNoiseCutIndex(value: string): number {
  const strong = STRONG_NOISE_RE.exec(value);
  const weak = WEAK_NOISE_RE.exec(value);

  const strongIndex = strong ? strong.index : -1;
  const weakIndex = weak && weak.index > 0 ? weak.index : -1;

  if (strongIndex === -1) return weakIndex;
  if (weakIndex === -1) return strongIndex;
  return Math.min(strongIndex, weakIndex);
}

/** Enlève les séparateurs et la ponctuation résiduelle en début et fin de titre. */
export function trimJunk(value: string): string {
  return value.replace(/^[\s._\-–—(\[{]+/, '').replace(/[\s._\-–—)\]}]+$/, '');
}

/** Supprime les blocs entre crochets ou accolades : `[GROUPE]`, `{edition}`. */
export function stripBracketBlocks(value: string): string {
  return value.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ');
}

/**
 * Remplace les séparateurs « scène » (points, underscores) par des espaces.
 * Les tirets sont conservés : ils font souvent partie du titre (« Spider-Man »).
 */
export function normalizeSeparators(value: string): string {
  return value.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Vrai si la chaîne ne contient rien d'autre que du bruit.
 * Sert à décider qu'un titre d'épisode est en fait absent :
 * « Show.S01E02.1080p.WEB-DL.x264-GRP » n'a pas de titre d'épisode.
 */
export function isOnlyNoise(value: string): boolean {
  const cleaned = trimJunk(normalizeSeparators(stripBracketBlocks(value)));
  if (cleaned === '') return true;
  const strong = STRONG_NOISE_RE.exec(cleaned);
  return strong !== null && strong.index === 0;
}

/**
 * Mots qui ne veulent rien dire *seuls*, mais qui sont parfaitement légitimes
 * à l'intérieur d'un titre.
 *
 * On ne peut donc pas les mettre dans les listes ci-dessus : « final » y
 * couperait « The Final Problem » après « The ». Ils ne sont testés que contre
 * le titre ENTIER, une fois nettoyé.
 *
 * Cas rencontrés en vrai :
 *   Kurokos.Basket.S01E22.5.MULTi.1080p...  -> il reste « 5 »
 *   Kurokos.Basket.S03E25.FiNAL.MULTi...    -> il reste « FiNAL »
 */
const STANDALONE_TAG_RE = /^(?:final|fin|end|complete|complet|proper|repack|internal|limited|\d+)$/i;

/**
 * Vrai si le titre obtenu n'est qu'un résidu : un nombre isolé, ou un tag de
 * release qui occupe tout le titre. Dans ce cas mieux vaut pas de titre du
 * tout qu'un titre trompeur.
 */
export function isMeaninglessTitle(value: string): boolean {
  const cleaned = trimJunk(value);
  return cleaned === '' || STANDALONE_TAG_RE.test(cleaned);
}
