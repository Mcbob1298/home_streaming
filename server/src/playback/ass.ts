/**
 * Conversion ASS/SSA vers WebVTT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CE QUI EST PERDU, ET POURQUOI C'EST ACCEPTABLE.
 *
 * ASS est un format de composition : positionnement au pixel, rotations,
 * dégradés, karaoké syllabe par syllabe, dessins vectoriels. WebVTT est un
 * format de sous-titres. Reproduire l'un dans l'autre demanderait un moteur de
 * rendu — c'est ce que fait libass, et ce n'est pas ce qu'on écrit ici.
 *
 * On garde donc ce qui porte le SENS : le texte, sa synchronisation, ses
 * retours à la ligne, et l'italique/gras/souligné, qui distinguent une pensée
 * d'un dialogue et ne coûtent rien puisque WebVTT les connaît. Tout le reste
 * des balises `{\...}` est retiré.
 *
 * Les lignes de DESSIN (`{\p1}`) sont supprimées entièrement : leur « texte »
 * est une suite de coordonnées, et l'afficher donnerait « m 0 0 l 100 0 100
 * 100 » au milieu de l'écran.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface AssCue {
  /** Début et fin en secondes. */
  start: number;
  end: number;
  text: string;
}

/** Ordre des champs quand la ligne « Format: » manque. C'est celui d'ASS v4+. */
const DEFAULT_EVENT_FIELDS = [
  'layer',
  'start',
  'end',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text',
];

/**
 * Horodatage ASS : « 0:01:02.50 », en CENTIÈMES et non en millièmes.
 *
 * Le piège est là : lire « .50 » comme 50 ms au lieu de 500 ms décalerait
 * chaque réplique d'un demi-seconde au maximum, ce qui passe inaperçu à la
 * relecture du code et saute aux yeux à l'écran.
 */
export function parseAssTime(value: string): number | null {
  const match = /^(\d+):([0-5]?\d):([0-5]?\d)[.,](\d{1,3})$/.exec(value.trim());
  if (match === null) return null;

  const [, hours, minutes, seconds, fraction] = match as unknown as string[];
  // « 5 » vaut 50 centièmes, « 50 » vaut 50 centièmes, « 500 » vaut 500 millièmes.
  const digits = (fraction as string).length;
  const fractional = Number(fraction) / 10 ** digits;

  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + fractional;
}

/**
 * « 3723.5 » → « 01:02:03.500 », la forme que WebVTT attend.
 *
 * L'arrondi se fait sur les millisecondes TOTALES, avant tout découpage : en
 * arrondissant la partie fractionnaire à part, 59,9996 s donnerait « 59.1000 »,
 * puis « 60 » après report — donc « 00:00:60.000 », qu'aucun lecteur n'accepte.
 */
export function formatVttTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));

  const millis = totalMs % 1000;
  const totalSeconds = (totalMs - millis) / 1000;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const rest = totalSeconds % 60;

  return (
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(rest).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
  );
}

/** U+00A0. Nommée pour rester visible : en clair, elle passe pour une espace. */
const NON_BREAKING_SPACE = '\u00A0';

/** Les trois styles que WebVTT sait rendre, et leur balise. */
const STYLE_TAGS = [
  { pattern: /^i([01])$/, tag: 'i' },
  { pattern: /^u([01])$/, tag: 'u' },
  { pattern: /^b(\d+)$/, tag: 'b' },
] as const;

/**
 * Texte d'une réplique, débarrassé de sa composition.
 *
 * Rend null quand il ne reste rien à afficher — ligne de dessin, ou réplique
 * vide une fois les balises retirées, ce qui arrive sur les effets purement
 * visuels.
 */
export function convertAssText(raw: string): string | null {
  // Dessin vectoriel : le contenu n'est pas du texte.
  if (/\\p[1-9]/.test(raw)) return null;

  /*
   * L'échappement vient EN PREMIER : un « < » présent dans le dialogue doit
   * devenir « &lt; » avant qu'on n'insère nos propres balises, sinon on
   * échapperait celles-ci du même coup.
   */
  const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let output = '';
  const open: string[] = [];
  let position = 0;

  while (position < escaped.length) {
    const brace = escaped.indexOf('{', position);
    if (brace === -1) {
      output += escaped.slice(position);
      break;
    }

    output += escaped.slice(position, brace);
    const close = escaped.indexOf('}', brace);
    if (close === -1) {
      // Accolade jamais refermée : c'est du texte, pas une balise.
      output += escaped.slice(brace);
      break;
    }

    output += applyOverrides(escaped.slice(brace + 1, close), open);
    position = close + 1;
  }

  // Les balises restées ouvertes sont refermées : WebVTT n'accepte pas qu'une
  // réplique déborde sur la suivante.
  while (open.length > 0) output += `</${open.pop() as string}>`;

  const text = output
    // `\N` est un retour à la ligne dur, `\n` un retour souple : à l'écran, les
    // deux se traduisent par un passage à la ligne.
    .replace(/\\[Nn]/g, '\n')
    /*
     * `\h` est une espace INSÉCABLE, nommée plutôt qu'écrite en clair :
     * un U+00A0 posé littéralement dans le source est indiscernable d’une
     * espace ordinaire à la relecture, et se perdrait au premier reformatage.
     */
    .replace(/\\h/g, NON_BREAKING_SPACE)
    // Les échappements ASS des accolades.
    .replace(/\\([{}])/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();

  return text === '' ? null : text;
}

/** Traduit un bloc `{\...}` en balises WebVTT, et rend ce qu'il faut écrire. */
function applyOverrides(block: string, open: string[]): string {
  let output = '';

  for (const command of block.split('\\')) {
    if (command === '') continue;

    // `\r` réinitialise le style : tout ce qui est ouvert se referme.
    if (command === 'r' || command.startsWith('r')) {
      while (open.length > 0) output += `</${open.pop() as string}>`;
      continue;
    }

    for (const style of STYLE_TAGS) {
      const match = style.pattern.exec(command);
      if (match === null) continue;

      const on = Number(match[1]) !== 0;
      const alreadyOpen = open.includes(style.tag);

      if (on && !alreadyOpen) {
        open.push(style.tag);
        output += `<${style.tag}>`;
      } else if (!on && alreadyOpen) {
        /*
         * Les balises doivent se refermer dans l'ordre inverse de l'ouverture :
         * « <i><b>x</i></b> » n'est pas du balisage valide. On dépile donc
         * jusqu'à celle qu'on ferme, puis on rouvre ce qu'on a dû fermer.
         */
        const reopen: string[] = [];
        while (open.length > 0) {
          const tag = open.pop() as string;
          output += `</${tag}>`;
          if (tag === style.tag) break;
          reopen.unshift(tag);
        }
        for (const tag of reopen) {
          open.push(tag);
          output += `<${tag}>`;
        }
      }
    }
  }

  return output;
}

/**
 * Répliques d'un fichier ASS, triées par instant de début.
 *
 * Le tri n'est pas cosmétique : WebVTT exige que les répliques apparaissent
 * dans l'ordre chronologique, et certains fichiers ASS listent les incrustations
 * de titres après les dialogues qu'elles recouvrent.
 */
export function parseAssCues(text: string): AssCue[] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

  let inEvents = false;
  let fields = DEFAULT_EVENT_FIELDS;
  const cues: AssCue[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (trimmed.startsWith('[')) {
      inEvents = trimmed.toLowerCase().startsWith('[events]');
      continue;
    }
    if (!inEvents) continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;

    const kind = trimmed.slice(0, separator).trim().toLowerCase();
    const body = trimmed.slice(separator + 1);

    if (kind === 'format') {
      fields = body.split(',').map((field) => field.trim().toLowerCase());
      continue;
    }

    // « Comment: » est une réplique désactivée : elle ne s'affiche pas.
    if (kind !== 'dialogue') continue;

    const cue = readDialogue(body, fields);
    if (cue !== null) cues.push(cue);
  }

  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Une ligne « Dialogue: », découpée selon l'ordre annoncé par « Format: ».
 *
 * PIÈGE : le texte contient presque toujours des virgules, et il est TOUJOURS
 * le dernier champ. Un `split(',')` naïf le tronquerait à la première virgule
 * de dialogue — on ne découpe donc que `fields.length - 1` fois.
 */
function readDialogue(body: string, fields: string[]): AssCue | null {
  const parts: string[] = [];
  let rest = body;

  for (let index = 0; index < fields.length - 1; index += 1) {
    const comma = rest.indexOf(',');
    if (comma === -1) return null;
    parts.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);

  const start = parseAssTime(parts[fields.indexOf('start')] ?? '');
  const end = parseAssTime(parts[fields.indexOf('end')] ?? '');
  const raw = parts[fields.indexOf('text')];

  if (start === null || end === null || raw === undefined) return null;
  // Une réplique de durée nulle ou négative ne s'affiche jamais.
  if (end <= start) return null;

  const text = convertAssText(raw);
  return text === null ? null : { start, end, text };
}

/**
 * Convertit un fichier ASS complet en WebVTT.
 *
 * Les chevauchements sont CONSERVÉS tels quels : WebVTT les gère nativement en
 * empilant les répliques, et c'est exactement ce que fait ASS quand une
 * incrustation de lieu apparaît pendant un dialogue. Les fusionner perdrait de
 * l'information et décalerait les fins.
 */
export function assToVtt(text: string): string {
  const cues = parseAssCues(text);

  const lines = ['WEBVTT', ''];
  for (const cue of cues) {
    lines.push(`${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}`);
    lines.push(cue.text);
    lines.push('');
  }

  return lines.join('\n');
}
