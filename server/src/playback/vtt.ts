/**
 * Conversion des sous-titres en WebVTT.
 *
 * WebVTT est le seul format que l'élément `track` et hls.js acceptent. SRT en
 * est très proche : même structure, deux différences seulement — l'en-tête, et
 * la virgule décimale des horodatages. ASS demande un vrai analyseur, qui vit
 * dans `ass.ts`.
 *
 * Ce module est le point d'entrée unique : on lui donne un format et un texte,
 * il rend du WebVTT. Les sous-titres EXTERNES et les pistes EMBARQUÉES
 * extraites par ffmpeg passent exactement par la même porte, ce qui garantit
 * qu'un ASS externe et un ASS de MKV se dégradent de la même façon.
 */
import { assToVtt } from './ass.js';
import { languageLabel } from './tracks.js';

/*
 * Les noms de langue vivent dans `tracks.ts`, avec ceux des pistes embarquées :
 * une seule table, un seul « Anglais ». La réexportation évite d'avoir à savoir
 * lequel des deux modules la détient.
 */
export { languageLabel };

/** Formats qu'on sait convertir, extension ou nom de codec ffmpeg. */
export const CONVERTIBLE_FORMATS = ['srt', 'subrip', 'vtt', 'webvtt', 'ass', 'ssa', 'mov_text', 'text'] as const;

/** Ceux qui demandent l'analyseur ASS plutôt qu'une substitution. */
const ASS_FORMATS = new Set(['ass', 'ssa']);

function normalizeFormat(format: string): string {
  return format.toLowerCase().replace(/^\./, '').trim();
}

export function isConvertible(format: string): boolean {
  return (CONVERTIBLE_FORMATS as readonly string[]).includes(normalizeFormat(format));
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
 * Convertit un sous-titre en WebVTT, d'après son format.
 *
 * Le format est TOUJOURS passé explicitement : le deviner d'après le contenu
 * marcherait la plupart du temps et se tromperait sur les cas tordus — un ASS
 * sans section `[Script Info]`, un SRT dont la première réplique commence par
 * un crochet.
 */
export function convertToVtt(text: string, format: string): string {
  return ASS_FORMATS.has(normalizeFormat(format)) ? assToVtt(text) : toVtt(text);
}

/**
 * Convertit un SRT — ou laisse passer un WebVTT.
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
 * Libellé d'un sous-titre EXTERNE, dont les mentions viennent du nom de fichier.
 *
 * Les pistes embarquées ont leur propre construction dans `tracks.ts` : elles
 * partent de métadonnées, pas d'un nom de fichier, et distinguent trois natures
 * là où celui-ci n'a que deux drapeaux.
 */
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
