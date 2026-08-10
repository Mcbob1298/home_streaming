/**
 * Helpers de texte partagés par le parser et le scanner.
 *
 * Règle générale du projet : TOUTE chaîne qui vient du système de fichiers
 * (nom de fichier, nom de dossier, chemin d'une racine) passe par `nfc()`
 * avant d'être stockée ou comparée.
 *
 * Pourquoi : « é » peut être encodé de deux façons en Unicode, soit un seul
 * caractère (U+00E9, forme composée NFC), soit « e » + un accent combinant
 * (U+0065 U+0301, forme décomposée NFD). Les deux s'affichent pareil mais
 * `"é" === "é"` est faux. SMB / macOS renvoient volontiers la forme décomposée,
 * ce qui créerait de faux doublons entre les deux racines. On force donc NFC
 * partout, une bonne fois.
 */

/** Forme normalisée Unicode utilisée dans tout le projet. */
export function nfc(value: string): string {
  return value.normalize('NFC');
}

/**
 * Clé de comparaison insensible à la casse, pour les chemins.
 * Windows ne distingue pas `D:\Films` de `d:\films`.
 */
export function pathKey(value: string): string {
  return nfc(value).toLowerCase();
}

/** Retire les accents (é → e) en passant par la forme décomposée. */
export function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Réduit les suites d'espaces à un seul et enlève les espaces aux extrémités. */
export function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Clé de regroupement d'un titre. C'est elle qui sert à dédupliquer un même
 * film présent sur les deux racines, et à faire une recherche insensible aux
 * accents et à la ponctuation.
 *
 *   "Amélie"            -> "amelie"
 *   "Ocean's Eleven"    -> "oceans eleven"
 *   "Fast & Furious"    -> "fast and furious"
 *   "Le.Roi.Lion"       -> "le roi lion"
 */
export function titleKey(title: string): string {
  return collapseSpaces(
    stripDiacritics(nfc(title))
      .toLowerCase()
      // Les apostrophes disparaissent au lieu de devenir des espaces, sinon
      // "Ocean's Eleven" et "Oceans Eleven" ne se rejoindraient jamais.
      .replace(/['’`]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' '),
  );
}

/** Articles ignorés pour le tri alphabétique. */
const LEADING_ARTICLE_RE = /^(?:the|a|an|le|la|les|un|une|des|l)\s+/;

/**
 * Titre utilisé pour le tri : minuscules, sans accents, sans article de tête.
 * « Le Roi Lion » se range à R, « The Matrix » à M.
 */
export function sortTitle(title: string): string {
  const base = titleKey(title);
  return base.replace(LEADING_ARTICLE_RE, '') || base;
}
