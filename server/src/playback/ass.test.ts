/**
 * Tests de la conversion ASS vers WebVTT.
 *
 * Les extraits reproduisent la forme réelle des fichiers de la bibliothèque :
 * 187 pistes ASS, dont celles du fichier #365 intitulées « Forced Stylized » et
 * « Full Coloured » — des sous-titres composés, avec couleurs et positions.
 */
import { describe, expect, it } from 'vitest';

import { assToVtt, convertAssText, formatVttTime, parseAssCues, parseAssTime } from './ass.js';

/** En-tête complet, tel qu'Aegisub l'écrit. */
const HEADER = [
  '[Script Info]',
  'Title: Default file',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold',
  'Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
].join('\n');

function file(...dialogues: string[]): string {
  return `${HEADER}\n${dialogues.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

describe('parseAssTime — des CENTIÈMES, pas des millièmes', () => {
  it('lit deux décimales comme des centièmes', () => {
    // Le piège du format : « .50 » vaut un demi-seconde, pas cinquante
    // millisecondes. Lu de travers, tout le fichier dérive.
    expect(parseAssTime('0:00:01.50')).toBeCloseTo(1.5, 6);
    expect(parseAssTime('0:00:00.07')).toBeCloseTo(0.07, 6);
  });

  it('lit une seule décimale comme des dixièmes', () => {
    expect(parseAssTime('0:00:01.5')).toBeCloseTo(1.5, 6);
  });

  it('lit trois décimales comme des millièmes', () => {
    expect(parseAssTime('0:00:01.500')).toBeCloseTo(1.5, 6);
  });

  it('additionne heures, minutes et secondes', () => {
    expect(parseAssTime('1:02:03.00')).toBeCloseTo(3723, 6);
  });

  it('refuse ce qui n’est pas un horodatage', () => {
    expect(parseAssTime('Default')).toBeNull();
    expect(parseAssTime('')).toBeNull();
    expect(parseAssTime('0:00:01')).toBeNull();
  });
});

describe('formatVttTime', () => {
  it('écrit la forme complète attendue par WebVTT', () => {
    expect(formatVttTime(0)).toBe('00:00:00.000');
    expect(formatVttTime(3723.5)).toBe('01:02:03.500');
  });

  it('ne produit jamais soixante secondes', () => {
    // Arrondir la partie fractionnaire à part produisait « 00:00:60.000 ».
    expect(formatVttTime(59.9996)).toBe('00:01:00.000');
    expect(formatVttTime(3599.9999)).toBe('01:00:00.000');
  });
});

// ---------------------------------------------------------------------------

describe('convertAssText — ce qu’on garde et ce qu’on jette', () => {
  it('retire les balises de position et de couleur', () => {
    expect(convertAssText('{\\an8}{\\c&H00FFFF&}Attention !')).toBe('Attention !');
    expect(convertAssText('{\\pos(960,1000)\\fscx110}Bonjour')).toBe('Bonjour');
  });

  it('retire le karaoké sans perdre les syllabes', () => {
    // Le karaoké découpe le mot en balises de durée : le texte doit se
    // recoller, pas disparaître.
    expect(convertAssText('{\\k30}Ka{\\k25}ra{\\k40}o{\\k35}ké')).toBe('Karaoké');
  });

  it('conserve l’italique, le gras et le souligné', () => {
    expect(convertAssText('{\\i1}Une pensée.{\\i0}')).toBe('<i>Une pensée.</i>');
    expect(convertAssText('{\\b1}Fort{\\b0} puis normal')).toBe('<b>Fort</b> puis normal');
    expect(convertAssText('{\\u1}souligné{\\u0}')).toBe('<u>souligné</u>');
  });

  it('accepte le gras exprimé en graisse', () => {
    expect(convertAssText('{\\b700}Titre{\\b0}')).toBe('<b>Titre</b>');
  });

  it('referme les balises laissées ouvertes', () => {
    // Une réplique qui ouvre l'italique sans le fermer déborderait sur la
    // suivante : WebVTT ne l'accepte pas.
    expect(convertAssText('{\\i1}Sans fermeture')).toBe('<i>Sans fermeture</i>');
  });

  it('referme dans le bon ordre quand les balises s’imbriquent', () => {
    expect(convertAssText('{\\i1}pensée {\\b1}forte{\\i0} suite{\\b0}')).toBe(
      '<i>pensée <b>forte</b></i><b> suite</b>',
    );
  });

  it('traite la réinitialisation de style', () => {
    expect(convertAssText('{\\i1}italique{\\r}normal')).toBe('<i>italique</i>normal');
  });

  it('traduit les retours à la ligne', () => {
    expect(convertAssText('Première ligne\\NSeconde ligne')).toBe('Première ligne\nSeconde ligne');
    expect(convertAssText('Souple\\nsuite')).toBe('Souple\nsuite');
  });

  it('traduit l’espace insécable, et la garde insécable', () => {
    // U+00A0 et non une espace ordinaire : c'est tout l'objet de `\h`, qui sert
    // à empêcher une coupure de ligne au mauvais endroit.
    expect(convertAssText('Deux\\hmots')).toBe('Deux mots');
  });

  it('échappe ce que WebVTT prendrait pour du balisage', () => {
    expect(convertAssText('5 < 10 & 10 > 5')).toBe('5 &lt; 10 &amp; 10 &gt; 5');
  });

  it('n’échappe pas les balises qu’on vient d’écrire', () => {
    expect(convertAssText('{\\i1}a < b{\\i0}')).toBe('<i>a &lt; b</i>');
  });

  it('supprime les lignes de dessin vectoriel', () => {
    // Leur « texte » est une suite de coordonnées : l'afficher donnerait
    // « m 0 0 l 100 0 » au milieu de l'écran.
    expect(convertAssText('{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}')).toBeNull();
  });

  it('supprime une réplique vide après nettoyage', () => {
    expect(convertAssText('{\\fad(200,200)}')).toBeNull();
    expect(convertAssText('   ')).toBeNull();
  });

  it('laisse une accolade non refermée comme du texte', () => {
    expect(convertAssText('Accolade { seule')).toBe('Accolade { seule');
  });
});

// ---------------------------------------------------------------------------

describe('parseAssCues', () => {
  it('lit les répliques d’un fichier complet', () => {
    const cues = parseAssCues(
      file(
        'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Première réplique.',
        'Dialogue: 0,0:01:02.50,0:01:05.12,Default,,0,0,0,,Seconde réplique.',
      ),
    );

    expect(cues).toEqual([
      { start: 1, end: 4, text: 'Première réplique.' },
      { start: 62.5, end: 65.12, text: 'Seconde réplique.' },
    ]);
  });

  it('garde les virgules du dialogue', () => {
    // Le texte est le DERNIER champ et contient presque toujours des virgules :
    // un split(',') naïf le tronquerait à la première.
    const [cue] = parseAssCues(
      file('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Oui, bien sûr, allons-y.'),
    );
    expect(cue?.text).toBe('Oui, bien sûr, allons-y.');
  });

  it('ignore les répliques commentées', () => {
    const cues = parseAssCues(
      file(
        'Comment: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Note du traducteur.',
        'Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Visible.',
      ),
    );
    expect(cues.map((cue) => cue.text)).toEqual(['Visible.']);
  });

  it('ignore tout ce qui précède la section des événements', () => {
    const cues = parseAssCues(file('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Texte.'));
    expect(cues).toHaveLength(1);
  });

  it('suit l’ordre des champs annoncé par « Format: »', () => {
    // Certains fichiers déclarent un ordre différent : le lire est le seul
    // moyen de savoir où sont le début, la fin et le texte.
    const custom = [
      '[Events]',
      'Format: Start, End, Style, Text',
      'Dialogue: 0:00:02.00,0:00:03.00,Default,Ordre inhabituel',
    ].join('\n');

    expect(parseAssCues(custom)).toEqual([{ start: 2, end: 3, text: 'Ordre inhabituel' }]);
  });

  it('trie par instant de début', () => {
    // Les incrustations de titres sont souvent listées après les dialogues
    // qu'elles recouvrent, et WebVTT exige l'ordre chronologique.
    const cues = parseAssCues(
      file(
        'Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Plus tard.',
        'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,D’abord.',
      ),
    );
    expect(cues.map((cue) => cue.text)).toEqual(['D’abord.', 'Plus tard.']);
  });

  it('écarte une réplique de durée nulle ou inversée', () => {
    const cues = parseAssCues(
      file(
        'Dialogue: 0,0:00:05.00,0:00:05.00,Default,,0,0,0,,Jamais vue.',
        'Dialogue: 0,0:00:09.00,0:00:07.00,Default,,0,0,0,,Inversée.',
      ),
    );
    expect(cues).toEqual([]);
  });

  it('écarte une ligne tronquée sans planter', () => {
    expect(parseAssCues(file('Dialogue: 0,0:00:01.00'))).toEqual([]);
  });

  it('accepte un fichier sans section d’événements', () => {
    expect(parseAssCues('[Script Info]\nTitle: vide\n')).toEqual([]);
    expect(parseAssCues('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('assToVtt', () => {
  it('produit un WebVTT complet et synchronisé', () => {
    const vtt = assToVtt(
      file(
        'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\i1}Première{\\i0} réplique.',
        'Dialogue: 0,0:01:02.50,0:01:05.12,Default,,0,0,0,,Seconde\\Nréplique.',
      ),
    );

    expect(vtt).toBe(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:04.000',
        '<i>Première</i> réplique.',
        '',
        '00:01:02.500 --> 00:01:05.120',
        'Seconde',
        'réplique.',
        '',
      ].join('\n'),
    );
  });

  it('CONSERVE les chevauchements au lieu de les fusionner', () => {
    /*
     * Une incrustation de lieu apparaît pendant un dialogue : les deux doivent
     * s'afficher. WebVTT empile nativement les répliques qui se recouvrent —
     * les fusionner perdrait une ligne et décalerait les fins.
     */
    const vtt = assToVtt(
      file(
        'Dialogue: 0,0:00:01.00,0:00:06.00,Default,,0,0,0,,Dialogue qui dure.',
        'Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\an8}TOKYO, 1998',
      ),
    );

    expect(vtt).toContain('00:00:01.000 --> 00:00:06.000\nDialogue qui dure.');
    expect(vtt).toContain('00:00:02.000 --> 00:00:04.000\nTOKYO, 1998');
    // Les deux répliques sont bien présentes, chacune avec ses propres bornes.
    expect(vtt.split('-->').length - 1).toBe(2);
  });

  it('produit un fichier valide même sans aucune réplique', () => {
    // Un WebVTT vide reste un WebVTT : le lecteur affiche « aucun sous-titre »
    // plutôt que de signaler une piste cassée.
    expect(assToVtt('[Events]\n')).toBe('WEBVTT\n');
  });

  it('reste lisible sur un extrait composé, à la manière de « Full Coloured »', () => {
    const vtt = assToVtt(
      file(
        'Dialogue: 0,0:12:07.44,0:12:10.09,Coloured,,0,0,0,,{\\c&H4EA1F2&\\3c&H000000&\\fad(150,150)}' +
          '— Tu entends ça ?\\N{\\i1}— Oui, depuis un moment.{\\i0}',
      ),
    );

    expect(vtt).toContain('00:12:07.440 --> 00:12:10.090');
    expect(vtt).toContain('— Tu entends ça ?\n<i>— Oui, depuis un moment.</i>');
  });
});
