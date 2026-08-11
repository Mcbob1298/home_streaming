import { describe, expect, it } from 'vitest';

import { migratePath, orderMappings, parseMapping, toPosix, validateMapping } from './paths.js';

/** Les quatre correspondances réelles du déploiement. */
const MAPPINGS = [
  { from: '\\\\NASSSITO\\Plex S1\\Vidéos\\films', to: '/mnt/@usb/sdb1/Vidéos/films' },
  { from: '\\\\NASSSITO\\Plex S1\\Vidéos\\séries', to: '/mnt/@usb/sdb1/Vidéos/séries' },
  { from: '\\\\NASSSITO\\plex\\Media\\Films', to: '/volume1/plex/Media/Films' },
  { from: '\\\\NASSSITO\\plex\\Media\\Séries', to: '/volume1/plex/Media/Séries' },
];

describe('migratePath — les quatre racines', () => {
  it('réécrit un film du partage USB', () => {
    expect(
      migratePath('\\\\NASSSITO\\Plex S1\\Vidéos\\films\\Avatar\\Avatar.mkv', MAPPINGS),
    ).toBe('/mnt/@usb/sdb1/Vidéos/films/Avatar/Avatar.mkv');
  });

  it('réécrit une série du volume principal', () => {
    expect(
      migratePath('\\\\NASSSITO\\plex\\Media\\Séries\\One Piece (1999)\\S01\\E01.mkv', MAPPINGS),
    ).toBe('/volume1/plex/Media/Séries/One Piece (1999)/S01/E01.mkv');
  });

  it('garde les espaces, les accents et la casse du reste du chemin', () => {
    expect(
      migratePath('\\\\NASSSITO\\Plex S1\\Vidéos\\films\\Le Fabuleux Destin d’Amélie Poulain.mkv', MAPPINGS),
    ).toBe('/mnt/@usb/sdb1/Vidéos/films/Le Fabuleux Destin d’Amélie Poulain.mkv');
  });

  it('réécrit la racine elle-même, sans slash surnuméraire', () => {
    expect(migratePath('\\\\NASSSITO\\Plex S1\\Vidéos\\films', MAPPINGS)).toBe('/mnt/@usb/sdb1/Vidéos/films');
    expect(migratePath('\\\\NASSSITO\\Plex S1\\Vidéos\\films\\', MAPPINGS)).toBe('/mnt/@usb/sdb1/Vidéos/films');
  });
});

describe('migratePath — correspondance sur des segments entiers', () => {
  it('ne confond pas deux dossiers de préfixe commun', () => {
    // « films » ne doit pas attraper « films-bonus ».
    expect(migratePath('\\\\NASSSITO\\Plex S1\\Vidéos\\films-bonus\\x.mkv', MAPPINGS)).toBeNull();
  });

  it('choisit la correspondance la plus spécifique', () => {
    const mappings = [
      { from: '\\\\NAS\\part', to: '/general' },
      { from: '\\\\NAS\\part\\films', to: '/specifique' },
    ];
    expect(migratePath('\\\\NAS\\part\\films\\a.mkv', mappings)).toBe('/specifique/a.mkv');
    expect(migratePath('\\\\NAS\\part\\autre\\a.mkv', mappings)).toBe('/general/autre/a.mkv');
  });
});

describe('migratePath — tolérances', () => {
  it('ignore la casse du préfixe, comme Windows', () => {
    expect(
      migratePath('\\\\nassssito\\PLEX S1\\vidéos\\FILMS\\a.mkv'.replace('nassssito', 'nasssito'), MAPPINGS),
    ).toBe('/mnt/@usb/sdb1/Vidéos/films/a.mkv');
  });

  it('reconnaît un chemin déjà écrit avec des slashs', () => {
    expect(migratePath('//NASSSITO/Plex S1/Vidéos/films/a.mkv', MAPPINGS)).toBe(
      '/mnt/@usb/sdb1/Vidéos/films/a.mkv',
    );
  });

  it('reconnaît un accent décomposé sans toucher à celui du reste', () => {
    /*
     * Le préfixe peut être stocké en forme décomposée : la comparaison
     * normalise pour le reconnaître. En revanche le RESTE du chemin est repris
     * octet pour octet — le renormaliser rendrait le fichier introuvable sur un
     * système qui l'a écrit décomposé.
     */
    const decomposed = '\\\\NASSSITO\\Plex S1\\Vidéos\\films\\Amélie.mkv'.normalize('NFD');
    const migrated = migratePath(decomposed, MAPPINGS) as string;

    expect(migrated.startsWith('/mnt/@usb/sdb1/Vidéos/films/')).toBe(true);
    expect(migrated.endsWith('Amélie.mkv'.normalize('NFD'))).toBe(true);
  });
});

describe('migratePath — refus', () => {
  it('rend null pour un chemin hors des racines connues', () => {
    expect(migratePath('D:\\Autre\\film.mkv', MAPPINGS)).toBeNull();
    expect(migratePath('\\\\AUTRENAS\\part\\film.mkv', MAPPINGS)).toBeNull();
  });

  it('rend null sans correspondance', () => {
    expect(migratePath('\\\\NASSSITO\\Plex S1\\Vidéos\\films\\a.mkv', [])).toBeNull();
  });

  it('ignore une correspondance vide', () => {
    expect(migratePath('n’importe quoi', [{ from: '', to: '/cible' }])).toBeNull();
  });
});

describe('toPosix', () => {
  it('retourne les antislashs', () => {
    expect(toPosix('films\\Avatar\\a.mkv')).toBe('films/Avatar/a.mkv');
  });

  it('retire le séparateur final', () => {
    expect(toPosix('films\\Avatar\\')).toBe('films/Avatar');
  });

  it('laisse la racine seule intacte', () => {
    expect(toPosix('/')).toBe('/');
  });

  it('n’abîme pas un chemin déjà POSIX', () => {
    expect(toPosix('/volume1/plex/Media')).toBe('/volume1/plex/Media');
  });
});

describe('orderMappings', () => {
  it('classe du plus spécifique au plus général', () => {
    const ordered = orderMappings([
      { from: '\\\\NAS\\a', to: '/1' },
      { from: '\\\\NAS\\a\\b\\c', to: '/2' },
      { from: '\\\\NAS\\a\\b', to: '/3' },
    ]);
    expect(ordered.map((m) => m.to)).toEqual(['/2', '/3', '/1']);
  });

  it('ne modifie pas le tableau reçu', () => {
    const original = [{ from: 'a', to: '/1' }, { from: 'aaa', to: '/2' }];
    orderMappings(original);
    expect(original.map((m) => m.to)).toEqual(['/1', '/2']);
  });
});

describe('parseMapping', () => {
  it('lit un argument --map', () => {
    expect(parseMapping('\\\\NAS\\part=>/volume1/part')).toEqual({
      from: '\\\\NAS\\part',
      to: '/volume1/part',
    });
  });

  it('accepte les espaces autour du séparateur', () => {
    expect(parseMapping(' \\\\NAS\\Plex S1 => /volume1/plex ')).toEqual({
      from: '\\\\NAS\\Plex S1',
      to: '/volume1/plex',
    });
  });

  it('refuse un argument sans séparateur', () => {
    expect(parseMapping('\\\\NAS\\part')).toBeNull();
    expect(parseMapping('\\\\NAS\\part=/volume1')).toBeNull();
  });

  it('refuse une moitié vide', () => {
    expect(parseMapping('=>/volume1')).toBeNull();
    expect(parseMapping('\\\\NAS\\part=>')).toBeNull();
  });
});

describe('validateMapping', () => {
  it('accepte une correspondance vers un chemin absolu', () => {
    expect(validateMapping({ from: '\\\\NAS\\p', to: '/volume1/p' })).toBeNull();
  });

  it('refuse une destination relative', () => {
    // Un chemin relatif dépendrait du dossier courant du conteneur.
    expect(validateMapping({ from: '\\\\NAS\\p', to: 'volume1/p' })).toContain('absolu');
  });

  it('refuse une moitié vide', () => {
    expect(validateMapping({ from: '', to: '/p' })).toContain('source');
    expect(validateMapping({ from: '\\\\NAS\\p', to: '  ' })).toContain('destination');
  });
});
