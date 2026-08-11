import { describe, expect, it } from 'vitest';

import { commonDirectory, showDirectory } from './fileSummary.js';

describe('commonDirectory', () => {
  it('remonte au dossier de la série à travers ses saisons', () => {
    expect(
      commonDirectory([
        '\\\\NAS\\Series\\One Piece\\Saison 01\\E01.mkv',
        '\\\\NAS\\Series\\One Piece\\Saison 01\\E02.mkv',
        '\\\\NAS\\Series\\One Piece\\Saison 02\\E01.mkv',
      ]),
    ).toBe('\\\\NAS\\Series\\One Piece');
  });

  it('descend au dossier de saison quand une seule a été indexée', () => {
    // Vrai mais trompeur pour la fiche : showDirectory remonte d'un cran.
    expect(
      commonDirectory(['D:\\Series\\Severance\\Saison 01\\E01.mkv', 'D:\\Series\\Severance\\Saison 01\\E02.mkv']),
    ).toBe('D:\\Series\\Severance\\Saison 01');
  });

  it('rend le dossier parent d’un fichier unique', () => {
    expect(commonDirectory(['D:\\Films\\Avatar (2009)\\Avatar.mkv'])).toBe('D:\\Films\\Avatar (2009)');
  });

  it('compare des segments entiers, pas des caractères', () => {
    // « Saison 1 » et « Saison 10 » partagent un préfixe de caractères mais
    // aucun dossier : le dossier commun est leur parent.
    expect(
      commonDirectory(['D:\\S\\Saison 1\\E01.mkv', 'D:\\S\\Saison 10\\E01.mkv']),
    ).toBe('D:\\S');
  });

  it('ignore la casse, comme Windows', () => {
    expect(
      commonDirectory(['D:\\Series\\One Piece\\a.mkv', 'd:\\series\\ONE PIECE\\b.mkv']),
    ).toBe('D:\\Series\\One Piece');
  });

  it('gère les chemins UNC', () => {
    expect(commonDirectory(['\\\\NAS\\part\\x\\a.mkv', '\\\\NAS\\part\\x\\b.mkv'])).toBe('\\\\NAS\\part\\x');
  });

  it('gère les séparateurs POSIX', () => {
    expect(commonDirectory(['/mnt/nas/serie/s1/a.mkv', '/mnt/nas/serie/s2/b.mkv'])).toBe('/mnt/nas/serie');
  });

  it('rend null quand rien n’est commun', () => {
    expect(commonDirectory([])).toBeNull();
    expect(commonDirectory(['C:\\a\\x.mkv', 'D:\\b\\y.mkv'])).toBeNull();
  });
});

describe('showDirectory', () => {
  const root = 'D:\\Series';

  it('remonte au-dessus du dossier de saison', () => {
    // Le cas d'une série dont une seule saison est sur le disque.
    expect(
      showDirectory(['D:\\Series\\Severance\\Saison 01\\E01.mkv', 'D:\\Series\\Severance\\Saison 01\\E02.mkv'], root),
    ).toBe('D:\\Series\\Severance');
  });

  it('reconnaît les différentes écritures d’un dossier de saison', () => {
    for (const folder of ['Saison 1', 'Saison 01', 'Season 2', 'seasons 3', 'S01', 's_2']) {
      expect(showDirectory([`D:\\Series\\X\\${folder}\\E01.mkv`], root)).toBe('D:\\Series\\X');
    }
  });

  it('ne remonte pas un dossier qui n’est pas une saison', () => {
    expect(showDirectory(['D:\\Series\\One Piece\\E01.mkv'], root)).toBe('D:\\Series\\One Piece');
    // « Saison des amours » n'est pas un numéro de saison.
    expect(showDirectory(['D:\\Series\\Saison des amours\\E01.mkv'], root)).toBe('D:\\Series\\Saison des amours');
  });

  it('laisse le dossier commun quand plusieurs saisons sont là', () => {
    expect(
      showDirectory(
        ['D:\\Series\\One Piece\\Saison 01\\E01.mkv', 'D:\\Series\\One Piece\\Saison 02\\E01.mkv'],
        root,
      ),
    ).toBe('D:\\Series\\One Piece');
  });

  it('ne remonte jamais au-dessus de la racine de bibliothèque', () => {
    // Série rangée à plat : remonter donnerait la racine entière.
    expect(showDirectory(['D:\\Series\\Saison 1\\E01.mkv'], root)).toBe('D:\\Series\\Saison 1');
  });

  it('rend null sans fichier', () => {
    expect(showDirectory([], root)).toBeNull();
  });
});
