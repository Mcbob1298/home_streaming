import { describe, expect, it } from 'vitest';

import { decidePlayback, directPlaySql, isRemuxable, mimeTypeFor, remuxSql, type PlayableFile } from './playability.js';

const URLS = { file: '/api/stream/1', hls: '/api/hls/1/index.m3u8' };
/** Le remux exige ffmpeg : la plupart des cas le supposent présent. */
const WITH_FFMPEG = { remuxAvailable: true };

function file(overrides: Partial<PlayableFile> = {}): PlayableFile {
  return {
    id: 1,
    extension: '.mp4',
    container: 'mov',
    videoCodec: 'h264',
    audioCodec: 'aac',
    ...overrides,
  };
}

describe('decidePlayback — lecture directe', () => {
  it('accepte MP4 + H.264 + AAC', () => {
    const decision = decidePlayback(file(), URLS, WITH_FFMPEG);
    expect(decision.mode).toBe('direct');
    expect(decision.source).toEqual({ url: URLS.file, type: 'file' });
  });

  it('accepte le .m4v', () => {
    expect(decidePlayback(file({ extension: '.m4v' }), URLS, WITH_FFMPEG).mode).toBe('direct');
  });

  it('ignore la casse de l’extension', () => {
    expect(decidePlayback(file({ extension: '.MP4' }), URLS, WITH_FFMPEG).mode).toBe('direct');
  });

  it('reporte les codecs tels quels', () => {
    const decision = decidePlayback(file(), URLS, WITH_FFMPEG);
    expect(decision.container).toBe('mov');
    expect(decision.videoCodec).toBe('h264');
    expect(decision.audioCodec).toBe('aac');
  });
});

/**
 * Le cœur du palier : 59,3 % de la bibliothèque est déjà en H.264 et n'a besoin
 * que d'un changement de conteneur, parfois d'un réencodage audio. Réencoder
 * leur vidéo coûterait des heures pour rien.
 */
describe('decidePlayback — remux', () => {
  it('remuxe du H.264 dans un MKV', () => {
    const decision = decidePlayback(
      file({ extension: '.mkv', container: 'matroska' }),
      URLS,
      WITH_FFMPEG,
    );
    expect(decision.mode).toBe('remux');
    expect(decision.source).toEqual({ url: URLS.hls, type: 'hls' });
  });

  it('remuxe du H.264 dont seul l’audio pose problème', () => {
    expect(decidePlayback(file({ audioCodec: 'eac3' }), URLS, WITH_FFMPEG).mode).toBe('remux');
    expect(decidePlayback(file({ audioCodec: 'dts' }), URLS, WITH_FFMPEG).mode).toBe('remux');
  });

  it('remuxe un H.264 dans un conteneur qui ment sur son extension', () => {
    expect(decidePlayback(file({ container: 'mpegts' }), URLS, WITH_FFMPEG).mode).toBe('remux');
  });

  it('dit que la vidéo n’est pas réencodée', () => {
    const decision = decidePlayback(file({ extension: '.mkv', container: 'matroska' }), URLS, WITH_FFMPEG);
    expect(decision.reason).toContain('copiée');
    expect(decision.reason).toContain('Matroska (MKV)');
  });

  it('refuse honnêtement quand ffmpeg est absent', () => {
    // Proposer une source que rien ne saurait produire serait pire que de dire
    // non : le lecteur échouerait sans expliquer pourquoi.
    const decision = decidePlayback(file({ extension: '.mkv', container: 'matroska' }), URLS, {
      remuxAvailable: false,
    });
    expect(decision.mode).toBe('unsupported');
    expect(decision.source).toBeNull();
    expect(decision.reason).toContain('FFMPEG_PATH');
  });
});

describe('decidePlayback — refus', () => {
  it('nomme le codec vidéo en clair', () => {
    const decision = decidePlayback(
      file({ extension: '.mkv', container: 'matroska', videoCodec: 'hevc' }),
      URLS,
      WITH_FFMPEG,
    );
    expect(decision.mode).toBe('unsupported');
    expect(decision.source).toBeNull();
    expect(decision.reason).toContain('HEVC (H.265)');
  });

  it('énumère plusieurs causes dans une seule phrase', () => {
    const decision = decidePlayback(
      file({ extension: '.mkv', container: 'matroska', videoCodec: 'hevc', audioCodec: 'dts' }),
      URLS,
      WITH_FFMPEG,
    );
    expect(decision.reason).toMatch(/HEVC.*DTS.*Matroska/s);
    expect(decision.reason).toContain(' et ');
  });

  it('garde un codec inconnu tel quel plutôt que de l’effacer', () => {
    const decision = decidePlayback(file({ videoCodec: 'prores' }), URLS, WITH_FFMPEG);
    expect(decision.mode).toBe('unsupported');
    expect(decision.reason).toContain('prores');
  });
});

describe('decidePlayback — fichier non sondé', () => {
  it('ne présume pas qu’un fichier non analysé est lisible', () => {
    const decision = decidePlayback(
      file({ container: null, videoCodec: null, audioCodec: null }),
      URLS,
      WITH_FFMPEG,
    );
    expect(decision.mode).toBe('unsupported');
    expect(decision.source).toBeNull();
    expect(decision.reason).toContain('npm run probe');
  });
});

describe('mimeTypeFor', () => {
  it('donne video/mp4 aux conteneurs MP4', () => {
    expect(mimeTypeFor('.mp4')).toBe('video/mp4');
    expect(mimeTypeFor('.m4v')).toBe('video/mp4');
    expect(mimeTypeFor('.MP4')).toBe('video/mp4');
  });

  it('reconnaît les conteneurs non lisibles, qu’on annonce quand même', () => {
    expect(mimeTypeFor('.mkv')).toBe('video/x-matroska');
    expect(mimeTypeFor('.avi')).toBe('video/x-msvideo');
  });

  it('retombe sur un type générique', () => {
    expect(mimeTypeFor('.xyz')).toBe('application/octet-stream');
  });
});

/**
 * Le SQL et la fonction expriment la MÊME règle sous deux formes.
 *
 * Deux expressions, c'est deux occasions de diverger — d'où ce test, qui rejoue
 * la clause SQL sur une base en mémoire et compare son verdict à celui de
 * `decidePlayback` sur chaque cas.
 */
describe('directPlaySql', () => {
  const cases: PlayableFile[] = [
    file(),
    file({ id: 2, extension: '.m4v' }),
    file({ id: 3, extension: '.mkv', container: 'matroska' }),
    file({ id: 4, container: 'mpegts' }),
    file({ id: 5, videoCodec: 'hevc' }),
    file({ id: 6, audioCodec: 'ac3' }),
    file({ id: 7, container: null, videoCodec: null, audioCodec: null }),
    file({ id: 8, videoCodec: 'h264', audioCodec: null }),
    file({ id: 9, extension: '.MP4', container: 'MOV', videoCodec: 'H264', audioCodec: 'AAC' }),
  ];

  it('classe exactement comme decidePlayback', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE media_file (
         id INTEGER PRIMARY KEY, extension TEXT, container TEXT,
         video_codec TEXT, audio_codec TEXT)`,
    );
    const insert = db.prepare(
      'INSERT INTO media_file (id, extension, container, video_codec, audio_codec) VALUES (?, ?, ?, ?, ?)',
    );
    for (const entry of cases) {
      insert.run(entry.id, entry.extension, entry.container, entry.videoCodec, entry.audioCodec);
    }

    const direct = new Set(
      (
        db.prepare(`SELECT id FROM media_file WHERE ${directPlaySql()}`).all() as { id: number }[]
      ).map((row) => row.id),
    );
    db.close();

    for (const entry of cases) {
      expect(direct.has(entry.id), `fichier ${entry.id}`).toBe(
        decidePlayback(entry, URLS, WITH_FFMPEG).mode === 'direct',
      );
    }
  });

  it('accepte un alias de table', () => {
    expect(directPlaySql('f')).toContain('f.extension');
    expect(directPlaySql('f')).not.toContain('media_file.extension');
  });
});

describe('remuxSql', () => {
  const cases: PlayableFile[] = [
    file({ id: 1 }), // direct, donc pas remux
    file({ id: 2, extension: '.mkv', container: 'matroska' }), // remux
    file({ id: 3, audioCodec: 'eac3' }), // remux
    file({ id: 4, extension: '.mkv', container: 'matroska', videoCodec: 'hevc' }), // ni l'un ni l'autre
    file({ id: 5, container: null, videoCodec: null, audioCodec: null }), // non sondé
  ];

  it('classe exactement comme isRemuxable', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE media_file (
         id INTEGER PRIMARY KEY, extension TEXT, container TEXT,
         video_codec TEXT, audio_codec TEXT)`,
    );
    const insert = db.prepare(
      'INSERT INTO media_file (id, extension, container, video_codec, audio_codec) VALUES (?, ?, ?, ?, ?)',
    );
    for (const entry of cases) {
      insert.run(entry.id, entry.extension, entry.container, entry.videoCodec, entry.audioCodec);
    }

    const remuxable = new Set(
      (db.prepare(`SELECT id FROM media_file WHERE ${remuxSql()}`).all() as { id: number }[]).map((r) => r.id),
    );
    db.close();

    for (const entry of cases) {
      expect(remuxable.has(entry.id), `fichier ${entry.id}`).toBe(isRemuxable(entry));
    }
  });

  it('n’inclut jamais un fichier déjà lisible tel quel', () => {
    expect(isRemuxable(file())).toBe(false);
  });

  it('n’inclut jamais une vidéo qui doit être réencodée', () => {
    expect(isRemuxable(file({ videoCodec: 'hevc' }))).toBe(false);
    expect(isRemuxable(file({ videoCodec: 'av1' }))).toBe(false);
    expect(isRemuxable(file({ videoCodec: null }))).toBe(false);
  });
});
