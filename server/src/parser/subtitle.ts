/**
 * Détection de la langue d'un sous-titre externe depuis son nom de fichier.
 * Pur : entrée = deux noms de fichiers, sortie = un objet.
 *
 *   film.fr.srt              -> fr
 *   film.en.forced.srt       -> en, forcé
 *   film.VOSTFR.srt          -> fr
 *   film.fre.sdh.srt         -> fr, sourds et malentendants
 *   film.srt                 -> langue inconnue
 */
import { nfc, stripDiacritics } from '../util/text.js';
import { splitExtension } from './common.js';

export interface ParsedSubtitle {
  /** Code ISO 639-1 sur deux lettres, ou null si indéterminé. */
  language: string | null;
  forced: boolean;
  hearingImpaired: boolean;
}

/**
 * Codes et noms rencontrés dans la nature, ramenés à un code ISO 639-1.
 * Volontairement court : on ajoute au fil des besoins.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr', francais: 'fr', vf: 'fr', vff: 'fr', vfq: 'fr',
  vostfr: 'fr', truefrench: 'fr', subfrench: 'fr',
  en: 'en', eng: 'en', english: 'en', anglais: 'en',
  es: 'es', spa: 'es', esp: 'es', spanish: 'es', espagnol: 'es',
  de: 'de', ger: 'de', deu: 'de', german: 'de', allemand: 'de',
  it: 'it', ita: 'it', italian: 'it', italien: 'it',
  pt: 'pt', por: 'pt', portuguese: 'pt', ptbr: 'pt',
  nl: 'nl', dut: 'nl', nld: 'nl', dutch: 'nl',
  ja: 'ja', jpn: 'ja', jap: 'ja', japanese: 'ja', japonais: 'ja',
  zh: 'zh', chi: 'zh', zho: 'zh', chinese: 'zh',
  ko: 'ko', kor: 'ko', korean: 'ko',
  ru: 'ru', rus: 'ru', russian: 'ru',
  ar: 'ar', ara: 'ar', arabic: 'ar',
  pl: 'pl', pol: 'pl',
  tr: 'tr', tur: 'tr',
  sv: 'sv', swe: 'sv',
  da: 'da', dan: 'da',
  no: 'no', nor: 'no',
  fi: 'fi', fin: 'fi',
  cs: 'cs', cze: 'cs', ces: 'cs',
  hu: 'hu', hun: 'hu',
  el: 'el', gre: 'el', ell: 'el',
  he: 'he', heb: 'he',
  ro: 'ro', ron: 'ro', rum: 'ro',
};

const FORCED_TOKENS = new Set(['forced', 'force', 'forces']);
const HEARING_IMPAIRED_TOKENS = new Set(['sdh', 'cc', 'hi', 'sourds', 'malentendants']);

/** Nombre de jetons examinés quand le nom du sous-titre ne reprend pas celui de la vidéo. */
const TAIL_TOKENS_TO_INSPECT = 3;

function tokenize(value: string): string[] {
  return stripDiacritics(nfc(value))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
}

/**
 * `videoFileName` sert à isoler le suffixe : dans « film.en.forced.srt » posé à
 * côté de « film.mkv », seuls « en » et « forced » sont examinés. Sans lui (ou
 * si les noms ne correspondent pas), on ne regarde que les derniers jetons, là
 * où les marqueurs de langue sont posés par convention — sinon « Le film en
 * Français.srt » se ferait détecter comme anglais à cause du mot « en ».
 */
export function parseSubtitleName(subtitleFileName: string, videoFileName?: string): ParsedSubtitle {
  const subtitleBase = splitExtension(nfc(subtitleFileName)).base;

  let tokens: string[];
  const videoBase = videoFileName === undefined ? '' : splitExtension(nfc(videoFileName)).base;

  if (videoBase !== '' && subtitleBase.toLowerCase().startsWith(videoBase.toLowerCase())) {
    tokens = tokenize(subtitleBase.slice(videoBase.length));
  } else {
    tokens = tokenize(subtitleBase).slice(-TAIL_TOKENS_TO_INSPECT);
  }

  const forced = tokens.some((token) => FORCED_TOKENS.has(token));
  const hearingImpaired = tokens.some((token) => HEARING_IMPAIRED_TOKENS.has(token));

  // On remonte depuis la fin : par convention le code de langue est le dernier
  // élément du nom, et c'est ce qui départage « Le film en Francais.srt »
  // (français) d'une lecture naïve qui verrait le « en » au milieu.
  let language: string | null = null;
  for (let index = tokens.length - 1; index >= 0 && language === null; index -= 1) {
    const token = tokens[index];
    if (token !== undefined && Object.hasOwn(LANGUAGE_ALIASES, token)) {
      language = LANGUAGE_ALIASES[token] ?? null;
    }
  }

  return { language, forced, hearingImpaired };
}
