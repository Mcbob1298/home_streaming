/**
 * Analyse de l'en-tête `Range`.
 *
 * C'est ce qui permet de se déplacer dans une vidéo sans la télécharger en
 * entier : le navigateur demande « donne-moi les octets 40000000 à 40999999 »
 * et le serveur répond 206 avec ce morceau. Sans cela, déplacer le curseur
 * relance le téléchargement depuis le début.
 *
 * Module pur, conforme à la RFC 7233. La règle qui compte : un en-tête `Range`
 * qu'on ne sait pas lire n'est pas une erreur, il doit être IGNORÉ — on répond
 * alors 200 avec le fichier entier. Seule une plage syntaxiquement valide mais
 * hors du fichier donne un 416.
 */

export type ParsedRange =
  /** Pas de plage demandée, ou plage illisible : répondre 200 avec tout. */
  | { kind: 'full' }
  /** Plage valide : répondre 206 avec ces octets, bornes comprises. */
  | { kind: 'partial'; start: number; end: number }
  /** Plage lisible mais hors du fichier : répondre 416. */
  | { kind: 'unsatisfiable' };

const BYTES_PREFIX = 'bytes=';

/** Entier décimal strict : « 12 » oui, « 1e3 », « +1 », « 1.5 » et « » non. */
function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseRange(header: string | undefined | null, size: number): ParsedRange {
  if (header === undefined || header === null) return { kind: 'full' };

  const trimmed = header.trim();
  // Une autre unité que l'octet ne nous concerne pas : on sert tout.
  if (!trimmed.toLowerCase().startsWith(BYTES_PREFIX)) return { kind: 'full' };

  const specifiers = trimmed.slice(BYTES_PREFIX.length).split(',');

  /*
   * Les plages multiples exigeraient une réponse multipart/byteranges. Aucun
   * lecteur vidéo n'en émet, et la servir à moitié serait pire que de ne pas
   * la servir : on renvoie le fichier entier, ce que la RFC autorise.
   */
  if (specifiers.length !== 1) return { kind: 'full' };

  const specifier = (specifiers[0] as string).trim();
  const separator = specifier.indexOf('-');
  if (separator === -1) return { kind: 'full' };

  const rawStart = specifier.slice(0, separator).trim();
  const rawEnd = specifier.slice(separator + 1).trim();

  // Un fichier vide n'a aucun octet à offrir : toute plage est insatisfiable.
  if (size === 0) return { kind: 'unsatisfiable' };

  // Forme suffixe : « bytes=-500 » demande les 500 DERNIERS octets.
  if (rawStart === '') {
    const suffix = parseInteger(rawEnd);
    if (suffix === null) return { kind: 'full' };
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = parseInteger(rawStart);
  if (start === null) return { kind: 'full' };

  // Au-delà du dernier octet : la plage est lisible mais ne désigne rien.
  if (start >= size) return { kind: 'unsatisfiable' };

  // Forme ouverte : « bytes=1000- » demande tout jusqu'à la fin.
  if (rawEnd === '') return { kind: 'partial', start, end: size - 1 };

  const end = parseInteger(rawEnd);
  if (end === null) return { kind: 'full' };
  if (end < start) return { kind: 'unsatisfiable' };

  // La fin est bornée au fichier : demander plus que ce qui existe est légitime.
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

/** En-tête `Content-Range` d'une réponse 206. */
export function contentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/**
 * En-tête `Content-Range` d'une réponse 416.
 *
 * La RFC impose d'y annoncer la taille réelle, pour que le client sache quoi
 * demander au coup suivant.
 */
export function unsatisfiableRange(size: number): string {
  return `bytes */${size}`;
}

/**
 * Validateur de cache d'un fichier : taille et date de modification.
 *
 * Validateur FORT — sans le préfixe `W/` — parce qu'il sert aussi aux requêtes
 * de plage : un validateur faible interdirait au client de reprendre un
 * téléchargement partiel.
 */
export function etagFor(sizeBytes: number, mtimeMs: number): string {
  return `"${sizeBytes.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/**
 * L'entité demandée est-elle celle que le client a déjà ?
 *
 * `If-None-Match` peut porter plusieurs valeurs, et `*` désigne n'importe
 * quelle entité existante.
 */
export function matchesEtag(ifNoneMatch: string | undefined | null, etag: string): boolean {
  if (ifNoneMatch === undefined || ifNoneMatch === null) return false;

  return ifNoneMatch
    .split(',')
    .map((value) => value.trim())
    .some((value) => {
      if (value === '*') return true;
      // Un client peut renvoyer en faible ce qu'on a émis en fort.
      const normalized = value.startsWith('W/') ? value.slice(2) : value;
      return normalized === etag;
    });
}
