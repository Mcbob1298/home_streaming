/**
 * Tests des libellés et des choix de pistes.
 *
 * Les cas ne sont pas inventés : tous les titres cités viennent de la base,
 * relevés par « SELECT title, COUNT(*) FROM audio_track GROUP BY title ». Le
 * fichier #365 (Avatar) fournit les cas extrêmes — six pistes audio dont trois
 * en russe, seize sous-titres dont quatre PGS.
 */
import { describe, expect, it } from 'vitest';

import {
  channelLabel,
  informativeTitle,
  isAudioDescription,
  isExtractable,
  isFrench,
  labelAudioTracks,
  labelSubtitleTracks,
  languageLabel,
  languageTag,
  filterExposedAudio,
  pickDefaultAudio,
  pickDefaultSubtitle,
  preferenceFrom,
  resolveAudioChoice,
  resolveSubtitleChoice,
  selectSubtitleTracks,
  subtitleKindOf,
  titleMarkers,
  type AudioTrackRow,
  type SubtitleTrackRow,
  type TrackPreference,
} from './tracks.js';

function preference(overrides: Partial<TrackPreference> = {}): TrackPreference {
  return {
    audioLanguage: null,
    subtitlesEnabled: false,
    subtitleLanguage: null,
    subtitleKind: null,
    ...overrides,
  };
}

function audio(overrides: Partial<AudioTrackRow> = {}): AudioTrackRow {
  return {
    streamIndex: 1,
    codec: 'ac3',
    channels: 6,
    language: 'fre',
    title: null,
    isDefault: false,
    ...overrides,
  };
}

function subtitle(overrides: Partial<SubtitleTrackRow> = {}): SubtitleTrackRow {
  return {
    streamIndex: 7,
    codec: 'subrip',
    language: 'fre',
    title: null,
    isForced: false,
    isDefault: false,
    isImageBased: false,
    ...overrides,
  };
}

/** Les six pistes audio d'Avatar, telles qu'elles sont en base. */
const AVATAR_AUDIO: AudioTrackRow[] = [
  { streamIndex: 1, codec: 'dts', channels: 6, language: 'fre', title: 'VFF DTS @768 kb/s (5.1)', isDefault: true },
  { streamIndex: 2, codec: 'dts', channels: 6, language: 'rus', title: '| Дублированный |', isDefault: false },
  { streamIndex: 3, codec: 'dts', channels: 6, language: 'rus', title: '| Дублированный |*', isDefault: false },
  { streamIndex: 4, codec: 'ac3', channels: 6, language: 'rus', title: '| Дублированный, AC3 |', isDefault: false },
  { streamIndex: 5, codec: 'ac3', channels: 6, language: 'ukr', title: '| Дублированный |', isDefault: false },
  { streamIndex: 6, codec: 'dts', channels: 6, language: 'eng', title: '| Original |', isDefault: false },
];

// ---------------------------------------------------------------------------

describe('languageLabel — en français, pas en langue d’origine', () => {
  it('traduit les codes ISO 639-2 courants', () => {
    expect(languageLabel('fre')).toBe('Français');
    expect(languageLabel('eng')).toBe('Anglais');
    expect(languageLabel('jpn')).toBe('Japonais');
    expect(languageLabel('rus')).toBe('Russe');
  });

  it('accepte les variantes à deux et trois lettres', () => {
    expect(languageLabel('fr')).toBe('Français');
    expect(languageLabel('fra')).toBe('Français');
    expect(languageLabel('deu')).toBe('Allemand');
    expect(languageLabel('ger')).toBe('Allemand');
  });

  it('garde le code brut d’une langue inconnue', () => {
    // Mieux vaut « nno » que « inconnue » : l'information reste.
    expect(languageLabel('nno')).toBe('nno');
  });

  it('nomme l’absence de langue', () => {
    expect(languageLabel(null)).toBe('Non renseignée');
    expect(languageLabel('')).toBe('Non renseignée');
    expect(languageLabel('und')).toBe('Non renseignée');
  });
});

describe('languageTag — étiquette du manifeste', () => {
  it('réduit le code à deux lettres, comme la RFC 8216 l’attend', () => {
    expect(languageTag('fre')).toBe('fr');
    expect(languageTag('jpn')).toBe('ja');
    expect(languageTag('eng')).toBe('en');
  });

  it('rend « und » quand la langue manque', () => {
    expect(languageTag(null)).toBe('und');
    expect(languageTag('')).toBe('und');
  });
});

describe('isFrench', () => {
  it('reconnaît les trois écritures du français', () => {
    expect(isFrench('fre')).toBe(true);
    expect(isFrench('fra')).toBe(true);
    expect(isFrench('FR')).toBe(true);
  });

  it('ne se trompe pas de langue', () => {
    expect(isFrench('eng')).toBe(false);
    expect(isFrench(null)).toBe(false);
  });
});

describe('channelLabel', () => {
  it('nomme les dispositions courantes', () => {
    expect(channelLabel(6)).toBe('5.1');
    expect(channelLabel(8)).toBe('7.1');
    expect(channelLabel(2)).toBe('Stéréo');
    expect(channelLabel(1)).toBe('Mono');
  });

  it('se tait quand le nombre de canaux est inconnu', () => {
    expect(channelLabel(null)).toBeNull();
    expect(channelLabel(0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('informativeTitle — le titre apporte-t-il quelque chose ?', () => {
  it('écarte un titre qui ne fait que répéter la langue', () => {
    expect(informativeTitle('French')).toBeNull();
    expect(informativeTitle('English')).toBeNull();
    expect(informativeTitle('français')).toBeNull();
  });

  it('écarte les notes d’encodage', () => {
    // Les quatre titres les plus fréquents de la bibliothèque après « French ».
    expect(informativeTitle('JAP-AC3')).toBeNull();
    expect(informativeTitle('FR-AC3')).toBeNull();
    expect(informativeTitle('ENG VO : AC3 5.1')).toBeNull();
    expect(informativeTitle('French - AAC LC 2.0 @ 128 kb/s')).toBeNull();
    expect(informativeTitle('FR VFF : AC3 5.1')).toBeNull();
    expect(informativeTitle('French EAC3')).toBeNull();
  });

  it('écarte un titre en alphabet non latin', () => {
    // « Дублированный » veut dire « doublé », mais personne ici ne le lit.
    expect(informativeTitle('| Дублированный |*')).toBeNull();
    expect(informativeTitle('| Дублированный, AC3 |')).toBeNull();
  });

  it('écarte un titre vide ou purement décoratif', () => {
    expect(informativeTitle(null)).toBeNull();
    expect(informativeTitle('')).toBeNull();
    expect(informativeTitle('   ')).toBeNull();
    expect(informativeTitle('| |*')).toBeNull();
    expect(informativeTitle('---')).toBeNull();
  });

  it('écarte les mentions déjà traitées ailleurs', () => {
    expect(informativeTitle('Forced')).toBeNull();
    expect(informativeTitle('SDH')).toBeNull();
    expect(informativeTitle('French Forced')).toBeNull();
    expect(informativeTitle('FR Full : SRT')).toBeNull();
    expect(informativeTitle('VFF')).toBeNull();
    expect(informativeTitle('AD')).toBeNull();
  });

  it('garde un titre réellement descriptif, dans sa forme nettoyée', () => {
    expect(informativeTitle("Na'vi parts only")).toBe("Na'vi parts only");
    expect(informativeTitle('Commentaire du réalisateur')).toBe('Commentaire du réalisateur');
    expect(informativeTitle('| Version longue |')).toBe('Version longue');
  });

  it('tronque un titre trop long pour le menu', () => {
    const long = informativeTitle('Commentaire audio du réalisateur et de son équipe technique complète');
    expect(long).not.toBeNull();
    expect((long as string).length).toBeLessThanOrEqual(42);
    expect(long).toMatch(/…$/);
  });
});

describe('titleMarkers', () => {
  it('reconnaît les versions françaises', () => {
    expect(titleMarkers('VFF DTS @768 kb/s (5.1)')).toEqual(['VFF']);
    expect(titleMarkers('FR VFQ : AC3 5.1')).toEqual(['VFQ']);
    expect(titleMarkers('FR VFi : AC3 5.1')).toEqual(['VFI']);
  });

  it('reconnaît la version originale', () => {
    expect(titleMarkers('| Original |')).toEqual(['VO']);
    expect(titleMarkers('anglais [VO]')).toEqual(['VO']);
  });

  it('reconnaît l’audiodescription', () => {
    expect(titleMarkers('AD')).toEqual(['Audiodescription']);
    expect(titleMarkers('VFF AD')).toEqual(['Audiodescription', 'VFF']);
    expect(titleMarkers('French (France) AD')).toEqual(['Audiodescription']);
  });

  it('ne voit rien dans un titre sans mention', () => {
    expect(titleMarkers('French')).toEqual([]);
    expect(titleMarkers(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('labelAudioTracks — le menu du fichier #365', () => {
  const labels = labelAudioTracks(AVATAR_AUDIO).map((track) => track.label);

  it('construit un libellé lisible pour chaque piste', () => {
    expect(labels[0]).toBe('Français VFF 5.1');
    expect(labels[5]).toBe('Anglais (VO) 5.1');
    expect(labels[4]).toBe('Ukrainien 5.1');
  });

  it('rend TOUS les libellés distincts', () => {
    // Trois pistes russes 5.1, dont deux en DTS : sans départage, choisir dans
    // le menu reviendrait à tirer au sort.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('départage d’abord par codec, puis par index de flux', () => {
    expect(labels[3]).toBe('Russe 5.1 (AC3)');
    expect(labels[1]).toBe('Russe 5.1 (DTS) · piste 2');
    expect(labels[2]).toBe('Russe 5.1 (DTS) · piste 3');
  });

  it('n’alourdit pas les libellés déjà uniques', () => {
    // L'anglais est seul dans sa langue : ni codec ni numéro de piste.
    expect(labels[5]).not.toMatch(/DTS|piste/);
  });
});

describe('labelAudioTracks — cas ordinaires', () => {
  it('construit depuis la langue et les canaux quand le titre manque', () => {
    // 1 677 pistes sur 5 298 n'ont aucun titre.
    const [track] = labelAudioTracks([audio({ title: null, channels: 6 })]);
    expect(track?.label).toBe('Français 5.1');
  });

  it('ne mentionne pas la stéréo, qui est le cas ordinaire', () => {
    const [track] = labelAudioTracks([audio({ language: 'jpn', channels: 2, title: null })]);
    expect(track?.label).toBe('Japonais');
  });

  it('mentionne la stéréo quand elle départage deux pistes', () => {
    const labelled = labelAudioTracks([
      audio({ streamIndex: 1, channels: 6 }),
      audio({ streamIndex: 2, channels: 2 }),
    ]);
    expect(labelled.map((track) => track.label)).toEqual(['Français 5.1', 'Français Stéréo']);
  });

  it('signale l’audiodescription', () => {
    const [track] = labelAudioTracks([audio({ title: 'VFF AD', channels: 6 })]);
    expect(track?.label).toBe('Français Audiodescription 5.1');
  });

  it('reprend un titre descriptif', () => {
    const [track] = labelAudioTracks([audio({ language: 'eng', title: 'Commentaire du réalisateur' })]);
    expect(track?.label).toBe('Anglais Commentaires — Commentaire du réalisateur 5.1');
  });
});

// ---------------------------------------------------------------------------

describe('filterExposedAudio — français, anglais, et la piste par défaut', () => {
  it('ne garde que fr et en sur Avatar, dont les six pistes en comptent quatre autres', () => {
    // Les trois russes et l'ukrainienne partent : c'est ce qui libère les deux
    // tiers du magasin audio statique.
    const gardees = filterExposedAudio(AVATAR_AUDIO).map((track) => track.streamIndex);
    expect(gardees).toEqual([1, 6]);
  });

  it('garde la piste par défaut même si elle n’est ni française ni anglaise', () => {
    /*
     * Sans cette exception, un film dont toutes les pistes sont japonaises
     * n'aurait plus AUCUNE piste : un film muet plutôt qu'un film sous-titré.
     */
    const pistes = [
      audio({ streamIndex: 1, language: 'jpn', isDefault: true }),
      audio({ streamIndex: 2, language: 'kor' }),
    ];
    expect(filterExposedAudio(pistes).map((t) => t.streamIndex)).toEqual([1]);
  });

  it('rend les pistes dans l’ordre des flux, quel que soit l’ordre d’ajout', () => {
    // La piste par défaut est ajoutée en dernier ; le plan et l'empreinte du
    // magasin dépendent de cet ordre, il doit rester celui du fichier.
    const pistes = [
      audio({ streamIndex: 1, language: 'jpn', isDefault: true }),
      audio({ streamIndex: 2, language: 'eng' }),
    ];
    expect(filterExposedAudio(pistes).map((t) => t.streamIndex)).toEqual([1, 2]);
  });

  it('ne touche pas à un fichier monopiste, fût-il d’une langue écartée', () => {
    // Une seule piste reste muxée dans la vidéo : la retirer rendrait le film muet.
    const pistes = [audio({ streamIndex: 1, language: 'rus' })];
    expect(filterExposedAudio(pistes)).toHaveLength(1);
  });

  it('accepte les variantes de codes : fra, fr, eng', () => {
    const pistes = [
      audio({ streamIndex: 1, language: 'fra' }),
      audio({ streamIndex: 2, language: 'rus' }),
      audio({ streamIndex: 3, language: 'eng' }),
    ];
    expect(filterExposedAudio(pistes).map((t) => t.streamIndex)).toEqual([1, 3]);
  });
});

describe('pickDefaultAudio', () => {
  it('choisit le français quand il existe', () => {
    expect(pickDefaultAudio(AVATAR_AUDIO)).toBe(1);
  });

  it('choisit le français même s’il n’est pas la piste par défaut du fichier', () => {
    const tracks = [
      audio({ streamIndex: 1, language: 'eng', isDefault: true }),
      audio({ streamIndex: 2, language: 'fre', isDefault: false }),
    ];
    expect(pickDefaultAudio(tracks)).toBe(2);
  });

  it('retombe sur la piste marquée par défaut dans le fichier', () => {
    const tracks = [
      audio({ streamIndex: 1, language: 'jpn', isDefault: false }),
      audio({ streamIndex: 2, language: 'eng', isDefault: true }),
    ];
    expect(pickDefaultAudio(tracks)).toBe(2);
  });

  it('retombe enfin sur la première piste', () => {
    const tracks = [audio({ streamIndex: 3, language: 'jpn' }), audio({ streamIndex: 4, language: 'eng' })];
    expect(pickDefaultAudio(tracks)).toBe(3);
  });

  it('n’impose JAMAIS l’audiodescription', () => {
    // Un film ouvert sur l'audiodescription serait incompréhensible pour qui ne
    // l'a pas demandée : une voix décrit l'image par-dessus les dialogues.
    const tracks = [
      audio({ streamIndex: 1, language: 'fre', title: 'VFF AD', isDefault: true }),
      audio({ streamIndex: 2, language: 'fre', title: 'VFF' }),
    ];
    expect(pickDefaultAudio(tracks)).toBe(2);
  });

  it('accepte l’audiodescription s’il n’y a rien d’autre', () => {
    const tracks = [audio({ streamIndex: 1, language: 'fre', title: 'AD' })];
    expect(pickDefaultAudio(tracks)).toBe(1);
  });

  it('rend null sur un fichier muet', () => {
    expect(pickDefaultAudio([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('subtitleKindOf', () => {
  it('croit la disposition du fichier', () => {
    expect(subtitleKindOf(subtitle({ isForced: true, title: null }))).toBe('forced');
  });

  it('lit le titre quand la disposition ne dit rien', () => {
    // 351 pistes s'appellent « Forced » sans que la disposition soit posée.
    expect(subtitleKindOf(subtitle({ title: 'Forced' }))).toBe('forced');
    expect(subtitleKindOf(subtitle({ title: 'French Forced' }))).toBe('forced');
    expect(subtitleKindOf(subtitle({ title: 'French (Forced)' }))).toBe('forced');
    expect(subtitleKindOf(subtitle({ title: 'VFF Forced' }))).toBe('forced');
  });

  it('reconnaît les pistes pour sourds et malentendants', () => {
    expect(subtitleKindOf(subtitle({ title: 'SDH' }))).toBe('sdh');
    expect(subtitleKindOf(subtitle({ title: 'English SDH' }))).toBe('sdh');
    expect(subtitleKindOf(subtitle({ title: 'French (SDH)' }))).toBe('sdh');
    expect(subtitleKindOf(subtitle({ title: 'anglais [CC]' }))).toBe('sdh');
  });

  it('classe le reste en complet', () => {
    expect(subtitleKindOf(subtitle({ title: 'French' }))).toBe('full');
    expect(subtitleKindOf(subtitle({ title: 'FR Full : SRT' }))).toBe('full');
    expect(subtitleKindOf(subtitle({ title: null }))).toBe('full');
  });

  it('donne la priorité au forçage sur le SDH', () => {
    // C'est le forçage qui décide si la piste peut être proposée d'office.
    expect(subtitleKindOf(subtitle({ title: 'SDH Forced' }))).toBe('forced');
  });
});

describe('labelSubtitleTracks', () => {
  it('distingue forcés et complets dans le libellé', () => {
    const labels = labelSubtitleTracks([
      subtitle({ streamIndex: 7, title: 'Francais Forces', isForced: true }),
      subtitle({ streamIndex: 8, title: 'Francais Complet' }),
    ]).map((track) => track.label);

    expect(labels).toEqual(['Français (forcés)', 'Français']);
  });

  it('marque les pistes pour sourds et malentendants', () => {
    const [track] = labelSubtitleTracks([subtitle({ language: 'eng', title: 'SDH' })]);
    expect(track?.label).toBe('Anglais (sourds et malentendants)');
  });

  it('garde un titre descriptif', () => {
    const [track] = labelSubtitleTracks([subtitle({ language: 'eng', title: "Na'vi parts only" })]);
    expect(track?.label).toBe("Anglais — Na'vi parts only");
  });

  it('départage deux pistes indiscernables', () => {
    const labels = labelSubtitleTracks([
      subtitle({ streamIndex: 12, language: 'rus', title: 'Forced', isForced: true }),
      subtitle({ streamIndex: 15, language: 'rus', title: 'Forced', isForced: true }),
    ]).map((track) => track.label);

    expect(new Set(labels).size).toBe(2);
    expect(labels).toEqual(['Russe (forcés) · piste 12', 'Russe (forcés) · piste 15']);
  });
});

// ---------------------------------------------------------------------------

describe('selectSubtitleTracks — texte contre image', () => {
  it('n’expose que le texte quand les deux coexistent', () => {
    // 166 fichiers sont dans ce cas. Une piste PGS demanderait une incrustation
    // dans la vidéo, pour un service que la piste texte rend déjà.
    const selection = selectSubtitleTracks([
      subtitle({ streamIndex: 8, codec: 'subrip', language: 'fre' }),
      subtitle({ streamIndex: 19, codec: 'hdmv_pgs_subtitle', language: 'fre', isImageBased: true }),
    ]);

    expect(selection.tracks.map((track) => track.streamIndex)).toEqual([8]);
    expect(selection.imageOnly).toBe(false);
  });

  it('n’expose rien et le signale quand il n’y a que de l’image', () => {
    // 168 fichiers. Ne rien afficher laisserait croire à une absence de
    // sous-titres, ce qui est faux.
    const selection = selectSubtitleTracks([
      subtitle({ streamIndex: 3, codec: 'hdmv_pgs_subtitle', isImageBased: true }),
      subtitle({ streamIndex: 4, codec: 'dvd_subtitle', isImageBased: true }),
    ]);

    expect(selection.tracks).toEqual([]);
    expect(selection.imageOnly).toBe(true);
  });

  it('ne signale rien sur un fichier sans aucun sous-titre', () => {
    expect(selectSubtitleTracks([])).toEqual({ tracks: [], imageOnly: false });
  });

  it('écarte un codec texte qu’on ne sait pas extraire', () => {
    // 167 pistes ont un codec que ffprobe n'a pas nommé : tenter l'extraction
    // à l'aveugle échouerait au moment de la lecture.
    const selection = selectSubtitleTracks([subtitle({ codec: null }), subtitle({ streamIndex: 9, codec: 'eia_608' })]);
    expect(selection.tracks).toEqual([]);
    expect(selection.imageOnly).toBe(false);
  });

  it('accepte les trois codecs texte de la bibliothèque', () => {
    const selection = selectSubtitleTracks([
      subtitle({ streamIndex: 1, codec: 'subrip' }),
      subtitle({ streamIndex: 2, codec: 'ass' }),
      subtitle({ streamIndex: 3, codec: 'mov_text' }),
    ]);
    expect(selection.tracks).toHaveLength(3);
  });

  it('trie le fichier #365 : douze pistes texte, quatre PGS écartées', () => {
    const avatar: SubtitleTrackRow[] = [
      subtitle({ streamIndex: 7, codec: 'subrip', language: 'fre', title: 'Francais Forces', isForced: true }),
      subtitle({ streamIndex: 8, codec: 'subrip', language: 'fre', title: 'Francais Complet' }),
      subtitle({ streamIndex: 9, codec: 'ass', language: 'rus', title: 'Forced Stylized', isForced: true }),
      subtitle({ streamIndex: 10, codec: 'ass', language: 'rus', title: 'Full Coloured' }),
      subtitle({ streamIndex: 11, codec: 'subrip', language: 'rus', title: 'Forced Coloured', isForced: true }),
      subtitle({ streamIndex: 12, codec: 'subrip', language: 'rus', title: 'Forced', isForced: true }),
      subtitle({ streamIndex: 13, codec: 'subrip', language: 'rus', title: 'Full' }),
      subtitle({ streamIndex: 14, codec: 'subrip', language: 'rus', title: 'Full Coloured' }),
      subtitle({ streamIndex: 15, codec: 'subrip', language: 'ukr', title: 'Forced', isForced: true }),
      subtitle({ streamIndex: 16, codec: 'subrip', language: 'eng', title: 'Forced', isForced: true }),
      subtitle({ streamIndex: 17, codec: 'subrip', language: 'eng', title: 'Full' }),
      subtitle({ streamIndex: 18, codec: 'subrip', language: 'eng', title: 'SDH' }),
      subtitle({ streamIndex: 19, codec: 'hdmv_pgs_subtitle', language: 'rus', title: 'Full', isImageBased: true }),
      subtitle({ streamIndex: 20, codec: 'hdmv_pgs_subtitle', language: 'eng', title: 'Full', isImageBased: true }),
      subtitle({ streamIndex: 21, codec: 'hdmv_pgs_subtitle', language: 'eng', title: 'SDH', isImageBased: true }),
      subtitle({
        streamIndex: 22,
        codec: 'hdmv_pgs_subtitle',
        language: 'eng',
        title: "Na'vi parts only",
        isImageBased: true,
      }),
    ];

    const selection = selectSubtitleTracks(avatar);
    expect(selection.tracks).toHaveLength(12);
    expect(selection.imageOnly).toBe(false);
    expect(new Set(selection.tracks.map((track) => track.label)).size).toBe(12);
    expect(selection.tracks[0]?.label).toBe('Français (forcés)');
    expect(selection.tracks[11]?.label).toBe('Anglais (sourds et malentendants)');
  });
});

describe('pickDefaultSubtitle', () => {
  it('n’active aucun sous-titre à l’ouverture', () => {
    // Et surtout pas un forcé : il ne contient que les passages en langue
    // étrangère, l'écran resterait vide deux heures durant.
    expect(pickDefaultSubtitle()).toBeNull();
  });
});

describe('isExtractable', () => {
  it('accepte les codecs texte connus', () => {
    expect(isExtractable('subrip')).toBe(true);
    expect(isExtractable('ass')).toBe(true);
    expect(isExtractable('MOV_TEXT')).toBe(true);
  });

  it('refuse l’image et l’inconnu', () => {
    expect(isExtractable('hdmv_pgs_subtitle')).toBe(false);
    expect(isExtractable('dvd_subtitle')).toBe(false);
    expect(isExtractable(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('resolveAudioChoice — la préférence mémorisée', () => {
  const anime: AudioTrackRow[] = [
    audio({ streamIndex: 1, language: 'fre', channels: 6, isDefault: true }),
    audio({ streamIndex: 2, language: 'jpn', channels: 2 }),
  ];

  it('suit la langue mémorisée plutôt que le français', () => {
    const choix = resolveAudioChoice(anime, {
      audioLanguage: 'jpn',
      subtitlesEnabled: true,
      subtitleLanguage: 'fre',
      subtitleKind: 'full',
    });
    expect(choix).toBe(2);
  });

  it('accepte une autre écriture du même code', () => {
    // « fre » et « fra » désignent la même langue.
    expect(resolveAudioChoice(anime, preference({ audioLanguage: 'fra' }))).toBe(1);
  });

  it('retombe sur la règle automatique quand la langue manque du fichier', () => {
    // Un épisode sans piste japonaise s'ouvre en français plutôt que muet.
    const sansJaponais = [audio({ streamIndex: 1, language: 'fre' }), audio({ streamIndex: 2, language: 'eng' })];
    expect(resolveAudioChoice(sansJaponais, preference({ audioLanguage: 'jpn' }))).toBe(1);
  });

  it('n’impose jamais l’audiodescription, même à langue demandée', () => {
    const avecAD = [
      audio({ streamIndex: 1, language: 'jpn', title: 'AD' }),
      audio({ streamIndex: 2, language: 'jpn', title: null }),
    ];
    expect(resolveAudioChoice(avecAD, preference({ audioLanguage: 'jpn' }))).toBe(2);
  });

  it('préfère la piste marquée par défaut à langue égale', () => {
    const deux = [
      audio({ streamIndex: 1, language: 'jpn', isDefault: false }),
      audio({ streamIndex: 2, language: 'jpn', isDefault: true }),
    ];
    expect(resolveAudioChoice(deux, preference({ audioLanguage: 'jpn' }))).toBe(2);
  });

  it('applique la règle automatique sans préférence', () => {
    expect(resolveAudioChoice(anime, null)).toBe(1);
  });
});

describe('resolveSubtitleChoice', () => {
  const pistes = labelSubtitleTracks([
    subtitle({ streamIndex: 7, language: 'fre', title: 'Forced', isForced: true }),
    subtitle({ streamIndex: 8, language: 'fre', title: 'Complet' }),
    subtitle({ streamIndex: 9, language: 'eng', title: 'SDH' }),
  ]);

  it('n’active rien quand les sous-titres sont éteints', () => {
    expect(resolveSubtitleChoice(pistes, preference({ subtitlesEnabled: false }))).toBeNull();
    expect(resolveSubtitleChoice(pistes, null)).toBeNull();
  });

  it('retrouve la langue ET la nature mémorisées', () => {
    const choix = resolveSubtitleChoice(
      pistes,
      preference({ subtitlesEnabled: true, subtitleLanguage: 'fre', subtitleKind: 'full' }),
    );
    expect(choix).toBe(8);
  });

  it('ne substitue JAMAIS un forcé à un complet', () => {
    /*
     * Un forcé ne contient que les passages en langue étrangère : l'activer à
     * la place d'un complet donnerait un écran vide la plupart du temps, ce qui
     * ressemble à une panne plutôt qu'à un choix.
     */
    const sansComplet = labelSubtitleTracks([
      subtitle({ streamIndex: 7, language: 'fre', title: 'Forced', isForced: true }),
    ]);
    expect(
      resolveSubtitleChoice(
        sansComplet,
        preference({ subtitlesEnabled: true, subtitleLanguage: 'fre', subtitleKind: 'full' }),
      ),
    ).toBeNull();
  });

  it('accepte une autre nature de la même langue à défaut de l’exacte', () => {
    const seulementSdh = labelSubtitleTracks([subtitle({ streamIndex: 9, language: 'eng', title: 'SDH' })]);
    expect(
      resolveSubtitleChoice(
        seulementSdh,
        preference({ subtitlesEnabled: true, subtitleLanguage: 'eng', subtitleKind: 'full' }),
      ),
    ).toBe(9);
  });

  it('n’active rien quand la langue mémorisée manque', () => {
    expect(
      resolveSubtitleChoice(
        pistes,
        preference({ subtitlesEnabled: true, subtitleLanguage: 'jpn', subtitleKind: 'full' }),
      ),
    ).toBeNull();
  });
});

describe('preferenceFrom', () => {
  it('retient la langue, jamais l’index de flux', () => {
    // Un index ne veut rien dire d'un épisode à l'autre.
    const [piste] = labelAudioTracks([audio({ streamIndex: 4, language: 'jpn' })]);
    const [sousTitre] = labelSubtitleTracks([subtitle({ streamIndex: 9, language: 'fre', title: 'Complet' })]);

    expect(preferenceFrom(piste, sousTitre)).toEqual({
      audioLanguage: 'jpn',
      subtitlesEnabled: true,
      subtitleLanguage: 'fre',
      subtitleKind: 'full',
    });
  });

  it('retient l’extinction des sous-titres', () => {
    const [piste] = labelAudioTracks([audio({ language: 'fre' })]);
    expect(preferenceFrom(piste, undefined)).toMatchObject({ subtitlesEnabled: false, subtitleLanguage: null });
  });
});

describe('isAudioDescription', () => {
  it('repère les 158 pistes d’audiodescription de la bibliothèque', () => {
    expect(isAudioDescription(audio({ title: 'AD' }))).toBe(true);
    expect(isAudioDescription(audio({ title: 'VFF AD' }))).toBe(true);
    expect(isAudioDescription(audio({ title: 'French (France) AD' }))).toBe(true);
    expect(isAudioDescription(audio({ title: 'French' }))).toBe(false);
  });
});
