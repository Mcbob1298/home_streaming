import { describe, expect, it } from 'vitest';

import { cleanCueText, convertToVtt, isConvertible, languageLabel, subtitleLabel, toVtt } from './vtt.js';

describe('isConvertible', () => {
  it('accepte SRT et VTT', () => {
    expect(isConvertible('srt')).toBe(true);
    expect(isConvertible('vtt')).toBe(true);
    expect(isConvertible('.SRT')).toBe(true);
  });

  it('accepte désormais ASS, qui a son analyseur', () => {
    expect(isConvertible('ass')).toBe(true);
    expect(isConvertible('ssa')).toBe(true);
  });

  it('accepte les noms de codec de ffmpeg, pas seulement les extensions', () => {
    // Une piste embarquée arrive avec « subrip » ou « mov_text », jamais « srt ».
    expect(isConvertible('subrip')).toBe(true);
    expect(isConvertible('mov_text')).toBe(true);
  });

  it('refuse les formats image', () => {
    expect(isConvertible('sub')).toBe(false);
    expect(isConvertible('hdmv_pgs_subtitle')).toBe(false);
  });
});

describe('convertToVtt — la porte d’entrée unique', () => {
  it('aiguille un ASS vers son analyseur', () => {
    const ass = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Texte{\\i0}',
    ].join('\n');

    expect(convertToVtt(ass, 'ass')).toContain('00:00:01.000 --> 00:00:02.000');
    expect(convertToVtt(ass, 'ass')).toContain('<i>Texte</i>');
  });

  it('aiguille un SRT vers la substitution', () => {
    expect(convertToVtt('1\n00:00:01,000 --> 00:00:02,000\nTexte.\n', 'subrip')).toContain(
      '00:00:01.000 --> 00:00:02.000',
    );
  });

  it('se fie au format annoncé, jamais au contenu', () => {
    // Deviner marcherait presque toujours, et se tromperait sur un SRT dont la
    // première réplique commence par un crochet.
    const piege = '1\n00:00:01,000 --> 00:00:02,000\n[Events] au générique\n';
    expect(convertToVtt(piege, 'srt')).toContain('[Events] au générique');
  });
});

describe('toVtt', () => {
  const srt = ['1', '00:00:01,000 --> 00:00:04,000', 'Première réplique.', '', '2', '00:01:02,500 --> 00:01:05,120', 'Seconde réplique.', ''].join(
    '\n',
  );

  it('ajoute l’en-tête WEBVTT', () => {
    expect(toVtt(srt).startsWith('WEBVTT\n\n')).toBe(true);
  });

  it('remplace la virgule décimale des horodatages par un point', () => {
    const result = toVtt(srt);
    expect(result).toContain('00:00:01.000 --> 00:00:04.000');
    expect(result).toContain('00:01:02.500 --> 00:01:05.120');
    expect(result).not.toContain(',000');
  });

  it('conserve le texte des répliques', () => {
    expect(toVtt(srt)).toContain('Première réplique.');
    expect(toVtt(srt)).toContain('Seconde réplique.');
  });

  it('ne touche pas aux virgules du texte', () => {
    const result = toVtt('1\n00:00:01,000 --> 00:00:02,000\nOui, bien sûr, allons-y.\n');
    expect(result).toContain('Oui, bien sûr, allons-y.');
  });

  it('normalise les fins de ligne Windows', () => {
    expect(toVtt('1\r\n00:00:01,000 --> 00:00:02,000\r\nTexte.\r\n')).not.toContain('\r');
  });

  it('retire la marque d’ordre des octets', () => {
    // Très fréquente sur les .srt écrits sous Windows, elle empêche le
    // navigateur de reconnaître l'en-tête WEBVTT.
    const result = toVtt('﻿1\n00:00:01,000 --> 00:00:02,000\nTexte.\n');
    expect(result.startsWith('WEBVTT')).toBe(true);
  });

  it('laisse un WebVTT tel quel', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTexte.\n';
    expect(toVtt(vtt)).toBe(vtt);
  });

  it('retire la marque d’ordre des octets d’un WebVTT aussi', () => {
    expect(toVtt('﻿WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTexte.\n').startsWith('WEBVTT')).toBe(true);
  });

  it('accepte une heure sur un seul chiffre', () => {
    expect(toVtt('1\n0:00:01,000 --> 0:00:02,000\nTexte.\n')).toContain('0:00:01.000 --> 0:00:02.000');
  });

  it('accepte un fichier vide sans planter', () => {
    expect(toVtt('')).toBe('WEBVTT\n\n');
  });
});

describe('languageLabel', () => {
  it('traduit les codes ISO courants, EN FRANÇAIS', () => {
    // L'interface est en français : « Anglais », pas « English » ni « 日本語 ».
    // La table est celle de tracks.ts, partagée avec les pistes embarquées.
    expect(languageLabel('fre')).toBe('Français');
    expect(languageLabel('fra')).toBe('Français');
    expect(languageLabel('eng')).toBe('Anglais');
    expect(languageLabel('JPN')).toBe('Japonais');
  });

  it('garde un code inconnu plutôt que d’écrire « inconnue »', () => {
    expect(languageLabel('kab')).toBe('kab');
  });

  it('nomme l’absence de langue', () => {
    expect(languageLabel(null)).toBe('Non renseignée');
    expect(languageLabel('  ')).toBe('Non renseignée');
  });
});

describe('subtitleLabel', () => {
  it('donne la langue seule par défaut', () => {
    expect(subtitleLabel({ language: 'fre', forced: 0, hearingImpaired: 0 })).toBe('Français');
  });

  it('signale les sous-titres forcés', () => {
    expect(subtitleLabel({ language: 'fre', forced: 1, hearingImpaired: 0 })).toBe('Français (forcés)');
  });

  it('signale les deux mentions', () => {
    expect(subtitleLabel({ language: 'eng', forced: 1, hearingImpaired: 1 })).toBe(
      'Anglais (forcés, sourds et malentendants)',
    );
  });
});

// ---------------------------------------------------------------------------

describe('cleanCueText — le balisage qui fuyait dans le texte affiché', () => {
  it('retire le positionnement ASS glissé dans du SRT', () => {
    // Relevé 24 514 fois en production, affiché littéralement par le navigateur.
    expect(cleanCueText('{\\an8}"QUI A VOLÉ MON BAS DE LAINE ?"')).toBe('"QUI A VOLÉ MON BAS DE LAINE ?"');
    expect(cleanCueText('{\\an1}- Comme vous le voyez ici,')).toBe('- Comme vous le voyez ici,');
    expect(cleanCueText('{\\a6}MERCI POUR LA CARTE')).toBe('MERCI POUR LA CARTE');
  });

  it('retire aussi les blocs de composition plus riches', () => {
    expect(cleanCueText('{\\fad(2000,1200)\\1a&HFF}Texte')).toBe('Texte');
    expect(cleanCueText('{\\pos(192,230)}Ici{\\r}et là')).toBe('Iciet là');
  });

  it('ne touche PAS aux accolades qui sont du vrai texte', () => {
    // Sans la barre inverse, ce n'est pas du balisage : c'est ce qu'on affiche.
    expect(cleanCueText('{Musique douce}')).toBe('{Musique douce}');
    expect(cleanCueText('Tape { pour ouvrir')).toBe('Tape { pour ouvrir');
  });

  it('garde l’italique, le gras et le souligné', () => {
    // 101 778 occurrences : WebVTT les rend nativement.
    expect(cleanCueText('<i>Très cher lecteur.</i>')).toBe('<i>Très cher lecteur.</i>');
    expect(cleanCueText('<b>ARC DE L’EXAMEN</b>')).toBe('<b>ARC DE L’EXAMEN</b>');
    expect(cleanCueText('<u>souligné</u>')).toBe('<u>souligné</u>');
  });

  it('traduit une couleur connue en classe WebVTT', () => {
    // La couleur désigne QUI parle dans les sous-titres pour sourds : la perdre
    // rendrait le dialogue ambigu.
    expect(cleanCueText('<font color="magenta">Musique entraînante</font>')).toBe(
      '<c.magenta>Musique entraînante</c>',
    );
    expect(cleanCueText("<font color='yellow'>Jaune</font>")).toBe('<c.yellow>Jaune</c>');
  });

  it('garde le texte quand la couleur n’est pas traduisible', () => {
    expect(cleanCueText('<font color="#FFAA00">Orange</font>')).toBe('<c>Orange</c>');
  });

  it('retire les balises inconnues sans manger leur contenu', () => {
    expect(cleanCueText('<span style="bodyStyle"> Lucifer...</span>')).toBe(' Lucifer...');
    expect(cleanCueText('<div><p>Texte</p></div>')).toBe('Texte');
  });

  it('laisse une ligne ordinaire intacte', () => {
    expect(cleanCueText('Rien à nettoyer ici.')).toBe('Rien à nettoyer ici.');
    expect(cleanCueText('')).toBe('');
  });
});

describe('toVtt — le nettoyage porte sur le texte, pas sur les horodatages', () => {
  it('nettoie les répliques d’un SRT', () => {
    const srt = '1\n00:27:55,976 --> 00:27:57,686\n{\\an8}DAVIS & MAIN\n';
    expect(toVtt(srt)).toBe('WEBVTT\n\n1\n00:27:55.976 --> 00:27:57.686\nDAVIS & MAIN\n');
  });

  it('ne touche pas à une ligne d’horodatage qui contiendrait des accolades', () => {
    // Garde-fou : un horodatage n'est jamais réécrit par le nettoyage.
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{\\an8}Texte\n';
    expect(toVtt(vtt)).toContain('00:00:01.000 --> 00:00:02.000');
    expect(toVtt(vtt)).toContain('\nTexte\n');
  });

  it('nettoie aussi une source déjà en WebVTT', () => {
    // Une piste embarquée au codec `webvtt` peut porter le même bruit.
    expect(toVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{\\an2}Bas de l’écran\n')).toContain(
      '\nBas de l’écran\n',
    );
  });
});
