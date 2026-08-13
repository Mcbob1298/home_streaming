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

/**
 * Version de ce convertisseur.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * À INCRÉMENTER DÈS QUE LA CONVERSION CHANGE CE QU'ELLE PRODUIT.
 *
 * Les WebVTT sont écrits une fois puis servis comme des fichiers statiques :
 * corriger le convertisseur ne corrige RIEN pour les fichiers déjà produits. Le
 * jour où le nettoyage des balises a été ajouté, 881 fichiers sur 1 993 en
 * portaient encore, et rien dans la base ne pouvait le savoir — l'empreinte du
 * fichier source n'avait pas bougé.
 *
 * Ce numéro est comparé au démarrage. S'il a changé, les fichiers préparés sont
 * remis en préparation et leur cache est effacé.
 *
 *   1 — conversion initiale
 *   2 — retrait des balises ASS/HTML résiduelles du texte des répliques
 * ═════════════════════════════════════════════════════════════════════════════
 */
export const CONVERTER_VERSION = 2;

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
 * Balises que WebVTT connaît. Tout le reste est du bruit à l'écran.
 *
 * `c` est la balise de classe, celle qui porte la couleur : `<c.magenta>`.
 */
const WEBVTT_TAGS = new Set(['i', 'b', 'u', 'ruby', 'rt', 'v', 'lang', 'c']);

/**
 * Les huit couleurs que WebVTT sait rendre, par classe.
 *
 * Le navigateur applique une feuille de style par défaut à ces classes : c'est
 * ce qui permet de traduire un `<font color>` sans perdre la couleur.
 */
const VTT_COLORS = new Set(['white', 'lime', 'cyan', 'red', 'yellow', 'magenta', 'blue', 'black']);

/**
 * Débarrasse le TEXTE d'une réplique de ce qui s'afficherait tel quel.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * UN SRT CONTIENT SOUVENT DU BALISAGE QUI N'EST PAS DU SRT.
 *
 * Relevé sur les 1 993 WebVTT produits : 881 en portaient. 24 514 blocs
 * `{\anN}` — du positionnement ASS glissé dans des sources SRT — et 26 029
 * `<font color>`. Les accolades n'ont aucun sens en WebVTT : le navigateur
 * affichait littéralement « {\an1}- Comme vous le voyez ici, ».
 *
 * Trois traitements, selon ce que la balise VEUT DIRE :
 *
 *   • `{\...}` — composition ASS. Retiré : WebVTT ne positionne pas.
 *   • `<font color="magenta">` — traduit en `<c.magenta>` quand la couleur est
 *     l'une des huit que WebVTT connaît. La couleur porte du sens dans les
 *     sous-titres pour sourds, où elle désigne QUI parle.
 *   • `<span>`, `<font color="#ab12cd">`, et tout inconnu — la balise part, le
 *     texte reste. Perdre un attribut vaut mieux que perdre une réplique.
 *
 * `<i>`, `<b>`, `<u>` sont GARDÉS : WebVTT les rend nativement, et ce sont les
 * 101 778 occurrences majoritaires.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function cleanCueText(line: string): string {
  const sansAss = line
    /*
     * Seuls les blocs qui commencent par une barre inverse sont des balises
     * ASS. Retirer toutes les accolades mangerait une réplique qui en contient
     * pour de bon — « {Musique} » n'est pas du balisage.
     */
    .replace(/\{\\[^}]*\}/g, '');

  return sansAss.replace(/<\/?([a-zA-Z]+)([^>]*)>/g, (balise, nom: string, attributs: string) => {
    const tag = nom.toLowerCase();
    const fermante = balise.startsWith('</');

    if (tag === 'font') {
      if (fermante) return '</c>';
      const couleur = /color\s*=\s*["']?([a-zA-Z]+)["']?/.exec(attributs)?.[1]?.toLowerCase();
      return couleur !== undefined && VTT_COLORS.has(couleur) ? `<c.${couleur}>` : '<c>';
    }

    return WEBVTT_TAGS.has(tag) ? balise : '';
  });
}

/** Applique le nettoyage aux seules lignes de TEXTE, jamais aux horodatages. */
function cleanCues(vtt: string): string {
  return vtt
    .split('\n')
    .map((line) => (line.includes('-->') ? line : cleanCueText(line)))
    .join('\n');
}

/**
 * Convertit un SRT — ou laisse passer un WebVTT.
 *
 * L'en-tête d'un fichier déjà en WebVTT est conservé intact : le navigateur
 * exige « WEBVTT » aux tout premiers caractères. Seul le texte des répliques est
 * nettoyé, et une source `webvtt` embarquée peut porter le même balisage
 * parasite qu'un SRT.
 */
export function toVtt(text: string): string {
  // La marque d'ordre des octets est fréquente sur les .srt écrits sous
  // Windows, et elle empêche la reconnaissance de l'en-tête.
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  if (clean.startsWith('WEBVTT')) return cleanCues(clean);

  return cleanCues(`WEBVTT\n\n${clean.replace(TIMESTAMP, '$1.$2').trimStart()}`);
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
