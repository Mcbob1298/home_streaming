/**
 * Conversion des sous-titres externes en WebVTT.
 *
 * WebVTT est le seul format que l'élément `track` accepte. SRT en est très
 * proche : même structure, deux différences seulement — l'en-tête, et la
 * virgule décimale des horodatages. La conversion tient donc en quelques
 * substitutions, sans dépendance.
 *
 * Les sous-titres EMBARQUÉS dans les MKV ne passent pas par ici : les extraire
 * demande ffmpeg, ils viendront avec le transcodage.
 */

/** Formats qu'on sait servir. Le reste demande un vrai convertisseur. */
export const CONVERTIBLE_FORMATS = ['srt', 'vtt'] as const;

export function isConvertible(format: string): boolean {
  return (CONVERTIBLE_FORMATS as readonly string[]).includes(format.toLowerCase().replace(/^\./, ''));
}

/**
 * Horodatage SRT : « 00:01:02,500 ». WebVTT veut un point.
 *
 * Les heures sont facultatives en WebVTT et certains SRT les écrivent sur un
 * seul chiffre : le motif reste large plutôt que d'exiger deux chiffres et de
 * laisser passer un fichier non converti.
 */
const TIMESTAMP = /(\d{1,3}:[0-5]\d:[0-5]\d),(\d{1,3})/g;

/**
 * Convertit un sous-titre en WebVTT.
 *
 * Un fichier déjà en WebVTT est renvoyé tel quel, à la marque d'ordre des
 * octets près : la réécrire ferait échouer l'analyse du navigateur, qui exige
 * « WEBVTT » aux tout premiers caractères.
 */
export function toVtt(text: string): string {
  // La marque d'ordre des octets est fréquente sur les .srt écrits sous
  // Windows, et elle empêche la reconnaissance de l'en-tête.
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  if (clean.startsWith('WEBVTT')) return clean;

  return `WEBVTT\n\n${clean.replace(TIMESTAMP, '$1.$2').trimStart()}`;
}

/**
 * Libellé d'une piste, tel qu'il apparaît dans le menu.
 *
 * Le code ISO 639-2 de ffprobe et des noms de fichiers (« fre », « eng ») ne
 * dit rien à personne : on l'affiche en toutes lettres, et on retombe sur le
 * code brut pour une langue qu'on ne connaît pas plutôt que d'écrire
 * « inconnue » et de perdre l'information.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  fre: 'Français',
  fra: 'Français',
  fr: 'Français',
  eng: 'English',
  en: 'English',
  spa: 'Español',
  es: 'Español',
  ger: 'Deutsch',
  deu: 'Deutsch',
  de: 'Deutsch',
  ita: 'Italiano',
  it: 'Italiano',
  jpn: '日本語',
  ja: '日本語',
  por: 'Português',
  pt: 'Português',
  nld: 'Nederlands',
  dut: 'Nederlands',
  rus: 'Русский',
  ru: 'Русский',
  chi: '中文',
  zho: '中文',
  kor: '한국어',
  ara: 'العربية',
  und: 'Non renseignée',
};

export function languageLabel(language: string | null): string {
  if (language === null || language.trim() === '') return 'Non renseignée';
  const code = language.trim().toLowerCase();
  return LANGUAGE_NAMES[code] ?? language.trim();
}

/** Libellé complet d'une piste, mentions comprises. */
export function subtitleLabel(track: {
  language: string | null;
  forced: number;
  hearingImpaired: number;
}): string {
  const mentions = [
    track.forced === 1 ? 'forcés' : null,
    track.hearingImpaired === 1 ? 'sourds et malentendants' : null,
  ].filter((mention): mention is string => mention !== null);

  const base = languageLabel(track.language);
  return mentions.length === 0 ? base : `${base} (${mentions.join(', ')})`;
}
