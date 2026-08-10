/**
 * Tests du regroupement des œuvres au moment de l'indexation.
 *
 * Ils tournent sur une base SQLite en mémoire et sur des fichiers fictifs :
 * aucun accès au NAS, aucun fichier créé. Ce qui est vérifié ici, c'est la
 * décision « ces deux fichiers désignent-ils la même œuvre ? ».
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig, LibraryConfig } from '../config.js';
import { openDatabase, syncLibrariesFromConfig, type Db } from '../db/index.js';
import { indexLibrary, type RootWalk } from './indexer.js';
import type { WalkedFile } from './walk.js';

const SHOWS_LIBRARY: LibraryConfig = {
  id: 'series',
  label: 'Séries',
  type: 'show',
  paths: ['R:\\racine1', 'R:\\racine2'],
};

const CONFIG: AppConfig = { databasePath: ':memory:', libraries: [SHOWS_LIBRARY] };

/** Fabrique un fichier vidéo fictif à partir d'un chemin relatif. */
function file(rootPath: string, relativePath: string): WalkedFile {
  const absolutePath = `${rootPath}\\${relativePath}`;
  const fileName = relativePath.split('\\').at(-1) ?? relativePath;
  return {
    absolutePath,
    storedPath: absolutePath,
    relativePath,
    fileName,
    extension: '.mkv',
    directoryKey: absolutePath.slice(0, absolutePath.lastIndexOf('\\')).toLowerCase(),
    sizeBytes: 900 * 1024 * 1024,
    mtimeMs: 1_700_000_000_000,
  };
}

let db: Db;
let rootIds: number[];

beforeEach(() => {
  db = openDatabase(':memory:');
  const roots = syncLibrariesFromConfig(db, CONFIG).get('series') ?? [];
  rootIds = roots.map((root) => root.id);
});

/** Indexe une liste de chemins relatifs, répartis sur les racines indiquées. */
function index(filesByRoot: string[][]): void {
  const walks: RootWalk[] = filesByRoot.map((relativePaths, rootIndex) => ({
    libraryRootId: rootIds[rootIndex] as number,
    videos: relativePaths.map((relativePath) => file(`R:\\racine${rootIndex + 1}`, relativePath)),
    subtitles: [],
  }));
  indexLibrary(db, SHOWS_LIBRARY, walks, new Date().toISOString());
}

function shows(): { title: string; year: number | null; episodes: number }[] {
  return db
    .prepare(
      `SELECT s.title, s.year,
              (SELECT COUNT(DISTINCT e.id) FROM episode e WHERE e.show_id = s.id) AS episodes
       FROM show s ORDER BY s.title, IFNULL(s.year, -1)`,
    )
    .all() as { title: string; year: number | null; episodes: number }[];
}

describe('regroupement des séries', () => {
  it('garde distinctes deux séries de même titre et d’années différentes', () => {
    index([
      [
        'One Piece (1999)\\Saison 1\\One Piece - S01E01.mkv',
        'One Piece (1999)\\Saison 1\\One Piece - S01E02.mkv',
        'One Piece (2023)\\Saison 1\\One Piece - S01E01.mkv',
      ],
    ]);

    expect(shows()).toEqual([
      { title: 'One Piece', year: 1999, episodes: 2 },
      { title: 'One Piece', year: 2023, episodes: 1 },
    ]);
  });

  it('garde distinctes une série avec année et une homonyme sans année', () => {
    index([
      ['One Piece (1999)\\Saison 1\\One Piece - S01E01.mkv'],
      ['One Piece\\Saison 1\\One Piece - S01E01.mkv'],
    ]);

    // Deux fiches : sans année, on ne devine pas de quelle œuvre il s'agit.
    expect(shows()).toEqual([
      { title: 'One Piece', year: null, episodes: 1 },
      { title: 'One Piece', year: 1999, episodes: 1 },
    ]);
  });

  it('fusionne deux dossiers de même titre et de même année, sur des racines différentes', () => {
    index([
      ['Kaamelott (2005)\\Saison 1\\Kaamelott - S01E01.mkv'],
      ['Kaamelott (2005)\\Season 01\\Kaamelott.S01E02.1080p.WEB-DL.x264-GRP.mkv'],
    ]);

    expect(shows()).toEqual([{ title: 'Kaamelott', year: 2005, episodes: 2 }]);
  });

  it('rattache le même épisode trouvé sur les deux racines à une seule fiche', () => {
    index([
      ['Kaamelott (2005)\\Saison 1\\Kaamelott - S01E01.mkv'],
      ['Kaamelott (2005)\\Saison 1\\Kaamelott - S01E01.mkv'],
    ]);

    expect(shows()).toEqual([{ title: 'Kaamelott', year: 2005, episodes: 1 }]);

    const { files } = db
      .prepare(
        `SELECT COUNT(*) AS files FROM media_file
         WHERE episode_id = (SELECT id FROM episode LIMIT 1) AND present = 1`,
      )
      .get() as { files: number };
    // Une seule fiche d'épisode, mais bien deux fichiers rattachés.
    expect(files).toBe(2);
  });

  it('ne scinde pas une série dont seules certaines saisons portent l’année dans le nom de fichier', () => {
    index([
      [
        'Clem\\Saison 1\\Clem.S01E01.FRENCH.DVDRiP.XviD-GRP.avi',
        'Clem\\Saison 10\\Clem.2010.S10E01.FRENCH.1080p.WEBRip.x265-GRP.mkv',
      ],
    ]);

    expect(shows()).toEqual([{ title: 'Clem', year: null, episodes: 2 }]);
  });

  it('ignore les différences d’accents et de casse entre racines', () => {
    index([
      ['Engrenages (2005)\\Saison 1\\Engrenages - S01E01.mkv'],
      ['ENGRENAGES (2005)\\Saison 1\\engrenages - s01e01.mkv'],
    ]);

    expect(shows()).toHaveLength(1);
  });
});

describe('regroupement des films', () => {
  const MOVIES_LIBRARY: LibraryConfig = {
    id: 'films',
    label: 'Films',
    type: 'movie',
    paths: ['R:\\films1', 'R:\\films2'],
  };

  it('garde distincts deux films homonymes d’années différentes', () => {
    const movieDb = openDatabase(':memory:');
    const roots = syncLibrariesFromConfig(movieDb, {
      databasePath: ':memory:',
      libraries: [MOVIES_LIBRARY],
    }).get('films') as { id: number }[];

    indexLibrary(
      movieDb,
      MOVIES_LIBRARY,
      [
        {
          libraryRootId: (roots[0] as { id: number }).id,
          videos: [
            file('R:\\films1', 'Dune (1984)\\Dune (1984).mkv'),
            file('R:\\films1', 'Dune (2021)\\Dune (2021).mkv'),
            file('R:\\films1', 'Dune.2021.1080p.BluRay.x264-GRP.mkv'),
          ],
          subtitles: [],
        },
      ],
      new Date().toISOString(),
    );

    const rows = movieDb
      .prepare('SELECT title, year FROM movie ORDER BY IFNULL(year, -1)')
      .all() as { title: string; year: number | null }[];
    expect(rows).toEqual([
      { title: 'Dune', year: 1984 },
      { title: 'Dune', year: 2021 },
    ]);
  });
});
