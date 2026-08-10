import { describe, expect, it } from 'vitest';

import { parseMediaPath, parseMovie, parseEpisode, parseSubtitleName } from './index.js';
import { sortTitle, titleKey } from '../util/text.js';

/**
 * Année maximale figée pour que les tests restent vrais dans le temps.
 * En vrai, la valeur par défaut est « année courante + 1 ».
 */
const OPTIONS = { maxYear: 2030 };

describe('parseMovie — dossier « Titre (année) »', () => {
  it('lit le titre et l’année depuis le dossier parent', () => {
    expect(parseMovie('Titre (2019)\\Titre (2019).mkv', OPTIONS)).toEqual({
      kind: 'movie',
      title: 'Titre',
      year: 2019,
      source: 'folder',
    });
  });

  it('accepte les accents et les espaces', () => {
    expect(parseMovie('Le Roi Lion (1994)\\Le Roi Lion (1994).mkv', OPTIONS)).toMatchObject({
      title: 'Le Roi Lion',
      year: 1994,
    });
  });

  it('fait confiance au dossier même si le fichier est mal nommé', () => {
    expect(parseMovie('Titre (2019)\\CD1.mkv', OPTIONS)).toMatchObject({
      title: 'Titre',
      year: 2019,
      source: 'folder',
    });
  });

  it('regroupe les versions d’un même film sur le même titre', () => {
    const theatrical = parseMovie('Le Seigneur des Anneaux (2001)\\Le Seigneur des Anneaux (2001).mkv', OPTIONS);
    const extended = parseMovie(
      'Le Seigneur des Anneaux (2001)\\Le Seigneur des Anneaux (2001) - Version Longue.mkv',
      OPTIONS,
    );
    expect(theatrical).toEqual(extended);
  });
});

describe('parseMovie — nom « scène »', () => {
  it('coupe au premier marqueur technique', () => {
    expect(parseMovie('Titre.2019.1080p.BluRay.x264-GROUPE.mkv', OPTIONS)).toEqual({
      kind: 'movie',
      title: 'Titre',
      year: 2019,
      source: 'file',
    });
  });

  it('conserve les tirets du titre', () => {
    expect(parseMovie('Spider-Man.Far.From.Home.2019.MULTi.1080p.BluRay.x264-GRP.mkv', OPTIONS)).toMatchObject({
      title: 'Spider-Man Far From Home',
      year: 2019,
    });
  });

  it('traite les underscores comme des séparateurs', () => {
    expect(parseMovie('Titre_2019_1080p_WEB-DL.mkv', OPTIONS)).toMatchObject({ title: 'Titre', year: 2019 });
  });

  it('ignore les mentions VF / VOSTFR / MULTI', () => {
    expect(parseMovie('Titre.2019.MULTi.VOSTFR.1080p.mkv', OPTIONS)).toMatchObject({ title: 'Titre', year: 2019 });
  });

  it('ignore les blocs entre crochets', () => {
    expect(parseMovie('[GROUPE] Titre (2019).mkv', OPTIONS)).toMatchObject({ title: 'Titre', year: 2019 });
  });

  it('ignore la mention d’édition, pour que les deux versions se rejoignent', () => {
    expect(parseMovie('Titre.2019.EXTENDED.1080p.BluRay.mkv', OPTIONS)).toMatchObject({
      title: 'Titre',
      year: 2019,
    });
  });

  it('ne confond pas un mot de titre avec un marqueur technique', () => {
    // « French » est un marqueur de langue courant, mais pas en tête de nom.
    expect(parseMovie('French.Kiss.1995.1080p.BluRay.mkv', OPTIONS)).toMatchObject({
      title: 'French Kiss',
      year: 1995,
    });
  });

  it('ne prend pas un nombre du titre pour une année', () => {
    expect(parseMovie('Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.mkv', OPTIONS)).toMatchObject({
      title: 'Blade Runner 2049',
      year: 2017,
    });
  });

  it('accepte un film dont le titre est une année', () => {
    expect(parseMovie('2012.2009.1080p.BluRay.x264.mkv', OPTIONS)).toMatchObject({
      title: '2012',
      year: 2009,
    });
  });
});

describe('parseMovie — fichiers à plat et cas limites', () => {
  it('accepte un fichier sans dossier ni année', () => {
    expect(parseMovie('Titre.mkv', OPTIONS)).toEqual({
      kind: 'movie',
      title: 'Titre',
      year: null,
      source: 'file',
    });
  });

  it('ignore un dossier de rangement sans année', () => {
    expect(parseMovie('Action\\Titre.2019.1080p.mkv', OPTIONS)).toMatchObject({
      title: 'Titre',
      year: 2019,
      source: 'file',
    });
  });

  it('rend null quand il ne reste aucun titre', () => {
    expect(parseMovie('1080p.BluRay.x264-GRP.mkv', OPTIONS)).toBeNull();
  });

  it('normalise les accents décomposés renvoyés par SMB', () => {
    const decomposed = 'Amélie (2001)\\Amélie (2001).mkv';
    expect(parseMovie(decomposed, OPTIONS)).toMatchObject({ title: 'Amélie', year: 2001 });
  });

  it('accepte indifféremment / et \\ comme séparateurs', () => {
    expect(parseMovie('Titre (2019)/Titre (2019).mkv', OPTIONS)).toEqual(
      parseMovie('Titre (2019)\\Titre (2019).mkv', OPTIONS),
    );
  });
});

describe('parseEpisode — conventions principales', () => {
  it('lit « Série (2015)/Season 01/Série - S01E02 - Titre épisode.mkv »', () => {
    expect(parseEpisode('Série (2015)\\Season 01\\Série - S01E02 - Titre épisode.mkv', OPTIONS)).toEqual({
      kind: 'episode',
      showTitle: 'Série',
      showYear: 2015,
      seasonNumber: 1,
      episodeNumber: 2,
      episodeNumberEnd: null,
      episodeTitle: 'Titre épisode',
      source: 'folder',
    });
  });

  it('accepte la variante française « Saison 1 » et la notation 1x02', () => {
    expect(parseEpisode('Série (2015)\\Saison 1\\Série - 1x02.mkv', OPTIONS)).toMatchObject({
      showTitle: 'Série',
      showYear: 2015,
      seasonNumber: 1,
      episodeNumber: 2,
      episodeTitle: null,
    });
  });

  it('accepte un dossier de saison nommé « S01 »', () => {
    expect(parseEpisode('Série\\S01\\Episode 02 - Titre.mkv', OPTIONS)).toMatchObject({
      showTitle: 'Série',
      seasonNumber: 1,
      episodeNumber: 2,
      episodeTitle: 'Titre',
    });
  });

  it('accepte « Season 1 Episode 2 »', () => {
    expect(parseEpisode('Série (2015)\\Série - Season 1 Episode 2 - Pilote.mkv', OPTIONS)).toMatchObject({
      showTitle: 'Série',
      seasonNumber: 1,
      episodeNumber: 2,
      episodeTitle: 'Pilote',
    });
  });

  it('accepte « Saison 1 Épisode 2 » avec accent', () => {
    expect(parseEpisode('Série\\Saison 1\\Série - Saison 1 Épisode 2.mkv', OPTIONS)).toMatchObject({
      seasonNumber: 1,
      episodeNumber: 2,
    });
  });

  it('accepte un simple numéro dans un dossier de saison', () => {
    expect(parseEpisode('Série\\Saison 1\\01 - Titre.mkv', OPTIONS)).toMatchObject({
      showTitle: 'Série',
      seasonNumber: 1,
      episodeNumber: 1,
      episodeTitle: 'Titre',
    });
  });

  it('range les bonus en saison 0', () => {
    expect(parseEpisode('Série (2015)\\Specials\\Série - S00E01 - Bonus.mkv', OPTIONS)).toMatchObject({
      seasonNumber: 0,
      episodeNumber: 1,
      episodeTitle: 'Bonus',
    });
  });
});

describe('parseEpisode — épisodes doubles', () => {
  it('lit « S01E01-E02 »', () => {
    expect(parseEpisode('Show.S01E01-E02.1080p.WEB-DL.x264-GRP.mkv', OPTIONS)).toMatchObject({
      showTitle: 'Show',
      seasonNumber: 1,
      episodeNumber: 1,
      episodeNumberEnd: 2,
      episodeTitle: null,
    });
  });

  it('lit « S01E01E02 »', () => {
    expect(parseEpisode('Show.S01E01E02.mkv', OPTIONS)).toMatchObject({
      episodeNumber: 1,
      episodeNumberEnd: 2,
    });
  });

  it('lit « S01E01-02 »', () => {
    expect(parseEpisode('Show - S01E01-02.mkv', OPTIONS)).toMatchObject({
      showTitle: 'Show',
      episodeNumber: 1,
      episodeNumberEnd: 2,
    });
  });

  it('lit « 1x02-03 »', () => {
    expect(parseEpisode('Show\\Saison 1\\Show - 1x02-03.mkv', OPTIONS)).toMatchObject({
      episodeNumber: 2,
      episodeNumberEnd: 3,
    });
  });

  it('ne prend pas un titre commençant par un nombre pour une plage', () => {
    expect(parseEpisode('Show\\Saison 1\\Show - S01E01 - 24 heures.mkv', OPTIONS)).toMatchObject({
      episodeNumber: 1,
      episodeNumberEnd: null,
      episodeTitle: '24 heures',
    });
  });
});

describe('parseEpisode — nettoyage et cas limites', () => {
  it('ne garde pas un titre d’épisode qui n’est que du bruit', () => {
    expect(parseEpisode('Show\\Season 01\\Show.S01E02.1080p.WEB-DL.x264-GRP.mkv', OPTIONS)).toMatchObject({
      episodeTitle: null,
    });
  });

  it('ne confond pas une résolution 1920x1080 avec une notation 1x02', () => {
    expect(parseEpisode('Show.S01E02.1920x1080.mkv', OPTIONS)).toMatchObject({
      seasonNumber: 1,
      episodeNumber: 2,
    });
  });

  it('enlève le marqueur de saison collé au titre de la série', () => {
    expect(parseEpisode('Show.Name.S01\\Show.Name.S01E03.mkv', OPTIONS)).toMatchObject({
      showTitle: 'Show Name',
      seasonNumber: 1,
      episodeNumber: 3,
    });
  });

  it('ignore l’année du nom de fichier quand le dossier de série n’en porte pas', () => {
    // Cas réel : le dossier « Clem » contient des saisons nommées « Clem.S01E01 »
    // et d'autres « Clem.2010.S10E01 ». Les deux doivent désigner LA MÊME série,
    // sinon la bibliothèque se scinde en deux fiches.
    const sansAnnee = parseEpisode('Clem\\Saison 1\\Clem.S01E01.FRENCH.DVDRiP.XviD-GRP.avi', OPTIONS);
    const avecAnnee = parseEpisode('Clem\\Saison 10\\Clem.2010.S10E01.FRENCH.1080p.WEBRip.x265-GRP.mkv', OPTIONS);

    expect(sansAnnee).toMatchObject({ showTitle: 'Clem', showYear: null });
    expect(avecAnnee).toMatchObject({ showTitle: 'Clem', showYear: null });
  });

  it('garde l’année quand c’est le dossier de série qui la porte', () => {
    const anime = parseEpisode('One Piece (1999)\\Saison 1\\One.Piece.E001.MULTi.1080p.mkv', OPTIONS);
    const live = parseEpisode('One Piece (2023)\\Season 1\\One.Piece.2023.S01E01.MULTi.1080p.mkv', OPTIONS);

    expect(anime).toMatchObject({ showTitle: 'One Piece', showYear: 1999 });
    expect(live).toMatchObject({ showTitle: 'One Piece', showYear: 2023 });
  });

  it('prend le titre de la série dans le nom de fichier faute de dossier', () => {
    expect(parseEpisode('Show - S01E02.mkv', OPTIONS)).toMatchObject({
      showTitle: 'Show',
      source: 'file',
    });
  });

  it('rend null sans numéro d’épisode', () => {
    expect(parseEpisode('Série (2015)\\Season 01\\bande annonce.mkv', OPTIONS)).toBeNull();
  });

  it('accepte un tag collé au numéro d’épisode', () => {
    // Cas réel : « S11E17Multi » sans séparateur avant la mention de langue.
    expect(
      parseEpisode(
        'The big bang theory\\saison 11\\The.Big.Bang.Theory.S11E17Multi.Web-DL.1080p.x265-SN2P.mkv',
        OPTIONS,
      ),
    ).toMatchObject({
      showTitle: 'The big bang theory',
      seasonNumber: 11,
      episodeNumber: 17,
      episodeTitle: null,
    });
  });

  it('ne garde pas un résidu numérique comme titre d’épisode', () => {
    // Cas réel : « E22.5 », un épisode récapitulatif. Le « .5 » ne doit pas
    // devenir le titre de l'épisode 22.
    expect(
      parseEpisode('Kuruko\\Saison 1\\Kurokos.Basket.S01E22.5.MULTi.1080p.BluRay.x264-GRP.mkv', OPTIONS),
    ).toMatchObject({ seasonNumber: 1, episodeNumber: 22, episodeTitle: null });
  });

  it('ne garde pas un tag de release seul comme titre d’épisode', () => {
    expect(
      parseEpisode('Kuruko\\Saison 3\\Kurokos.Basket.S03E25.FiNAL.MULTi.1080p.BluRay.mkv', OPTIONS),
    ).toMatchObject({ episodeNumber: 25, episodeTitle: null });
  });

  it('garde un vrai titre qui commence par un de ces mots', () => {
    expect(parseEpisode('Sherlock\\Saison 4\\Sherlock - S04E03 - The Final Problem.mkv', OPTIONS)).toMatchObject({
      episodeNumber: 3,
      episodeTitle: 'The Final Problem',
    });
  });

  it('ignore une résolution placée après le numéro d’épisode', () => {
    expect(parseEpisode('Show\\Saison 1\\Show - S01E01 - 720p x264.mkv', OPTIONS)).toMatchObject({
      episodeNumber: 1,
      episodeNumberEnd: null,
      episodeTitle: null,
    });
  });
});

describe('parseMediaPath — aiguillage selon le type de bibliothèque', () => {
  it('renvoie un film pour une bibliothèque de films', () => {
    expect(parseMediaPath('Titre (2019)\\Titre (2019).mkv', 'movie', OPTIONS)).toMatchObject({ kind: 'movie' });
  });

  it('renvoie un épisode pour une bibliothèque de séries', () => {
    expect(parseMediaPath('Série\\Saison 1\\Série - S01E01.mkv', 'show', OPTIONS)).toMatchObject({
      kind: 'episode',
    });
  });

  it('signale les fichiers non interprétables au lieu de lever une erreur', () => {
    expect(parseMediaPath('Série\\Saison 1\\bonus.mkv', 'show', OPTIONS)).toEqual({
      kind: 'unknown',
      reason: 'aucun-numero-d-episode',
    });
    expect(parseMediaPath('1080p.x264-GRP.mkv', 'movie', OPTIONS)).toEqual({
      kind: 'unknown',
      reason: 'aucun-titre-exploitable',
    });
  });
});

describe('parseSubtitleName', () => {
  it('lit la langue depuis le suffixe', () => {
    expect(parseSubtitleName('film.fr.srt', 'film.mkv')).toEqual({
      language: 'fr',
      forced: false,
      hearingImpaired: false,
    });
  });

  it('lit langue et mention « forced »', () => {
    expect(parseSubtitleName('film.en.forced.srt', 'film.mkv')).toEqual({
      language: 'en',
      forced: true,
      hearingImpaired: false,
    });
  });

  it('comprend VOSTFR comme du français', () => {
    expect(parseSubtitleName('film.VOSTFR.srt', 'film.mkv')).toMatchObject({ language: 'fr' });
  });

  it('comprend les codes à trois lettres et la mention SDH', () => {
    expect(parseSubtitleName('film.fre.sdh.srt', 'film.mkv')).toEqual({
      language: 'fr',
      forced: false,
      hearingImpaired: true,
    });
  });

  it('rend une langue nulle quand le nom ne dit rien', () => {
    expect(parseSubtitleName('film.srt', 'film.mkv')).toMatchObject({ language: null });
  });

  it('ne se laisse pas piéger par un mot du titre sans nom de vidéo', () => {
    expect(parseSubtitleName('Le film en Francais.srt')).toMatchObject({ language: 'fr' });
  });
});

describe('titleKey — clé de regroupement entre les deux racines', () => {
  it('ignore accents, casse et ponctuation', () => {
    expect(titleKey('Amélie')).toBe(titleKey('AMELIE'));
    expect(titleKey("Ocean's Eleven")).toBe(titleKey('Oceans Eleven'));
    expect(titleKey('Fast & Furious')).toBe(titleKey('Fast and Furious'));
    expect(titleKey('Le.Roi.Lion')).toBe(titleKey('Le Roi Lion'));
  });

  it('ne confond pas deux titres différents', () => {
    expect(titleKey('Dune')).not.toBe(titleKey('Dunes'));
  });
});

describe('sortTitle — tri alphabétique', () => {
  it('ignore l’article de tête', () => {
    expect(sortTitle('Le Roi Lion')).toBe('roi lion');
    expect(sortTitle('The Matrix')).toBe('matrix');
  });
});
