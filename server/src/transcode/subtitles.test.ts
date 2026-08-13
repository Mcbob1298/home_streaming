/**
 * Tests du rendu audio séparé et de l'extraction des sous-titres.
 *
 * Les lignes de commande se vérifient sans lancer un seul processus : c'est
 * indispensable ici, un `-map` mal formé ne se voit qu'au moment où le lecteur
 * réclame un segment qui n'arrivera jamais.
 */
import { describe, expect, it } from 'vitest';

import { audioMapArgs, buildAudioArgs, channelsOf, downmixFilter } from './args.js';
import { AUDIO_SEGMENT_DURATION } from './segments.js';
import { buildExtractArgs, cacheKey, conversionFormat, rawFileName } from './subtitles.js';

function audioOptions(overrides: Partial<Parameters<typeof buildAudioArgs>[0]> = {}) {
  return {
    input: '/volume1/plex/Media/Films/avatar.mkv',
    startTime: 0,
    startNumber: 0,
    endTime: null,
    outputDir: '/app/data/transcode/mf-365/a-1',
    streamIndex: 1,
    channels: 6,
    segmentDuration: AUDIO_SEGMENT_DURATION,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('audioMapArgs — l’index est ABSOLU', () => {
  it('désigne le flux par son index dans le fichier', () => {
    // Sur le fichier #365, les pistes audio sont les flux 1 à 6, la vidéo
    // étant le flux 0. « 0:a:N » supposerait qu'ils soient contigus.
    expect(audioMapArgs({ kind: 'stream', streamIndex: 4, channels: 6 })).toEqual(['-map', '0:4']);
  });

  it('retombe sur la première piste quand rien n’est désigné', () => {
    // Le « ? » rend la sélection facultative : un fichier muet ne fait pas
    // échouer l'exécution entière.
    expect(audioMapArgs({ kind: 'auto', channels: null })).toEqual(['-map', '0:a:0?']);
  });

  it('coupe le son quand il est rendu à part', () => {
    expect(audioMapArgs({ kind: 'none' })).toEqual(['-an']);
  });
});

describe('channelsOf', () => {
  it('rend les canaux de la piste retenue', () => {
    expect(channelsOf({ kind: 'stream', streamIndex: 2, channels: 8 })).toBe(8);
    expect(channelsOf({ kind: 'auto', channels: 6 })).toBe(6);
  });

  it('n’en rend aucun sans piste', () => {
    expect(channelsOf({ kind: 'none' })).toBeNull();
  });
});

describe('downmixFilter', () => {
  it('remonte la voix sur du 5.1', () => {
    // Le downmix par défaut de ffmpeg enterre le canal central — donc les
    // dialogues — sous la musique et les effets.
    const filter = downmixFilter(6);
    expect(filter).toContain('pan=stereo');
    expect(filter).toContain('0.8*FC');
  });

  it('traite le 7.1 avec ses canaux latéraux', () => {
    expect(downmixFilter(8)).toContain('SL');
    expect(downmixFilter(8)).toContain('SR');
  });

  it('ne mélange rien en stéréo et en mono', () => {
    expect(downmixFilter(2)).not.toContain('pan=stereo');
    expect(downmixFilter(1)).not.toContain('pan=stereo');
    expect(downmixFilter(null)).not.toContain('pan=stereo');
  });
});

// ---------------------------------------------------------------------------

describe('buildAudioArgs', () => {
  it('ne produit QUE la piste demandée', () => {
    const args = buildAudioArgs(audioOptions({ streamIndex: 6 }));
    expect(args).toContain('0:6');
    expect(args).toContain('-vn');
    expect(args).toContain('-sn');
    expect(args).toContain('-dn');
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
  });

  it('impose la fréquence d’échantillonnage', () => {
    // C'est elle qui rend les bornes de segment exactes : 8 s font alors
    // exactement 375 trames AAC.
    const args = buildAudioArgs(audioOptions());
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
  });

  it('applique le downmix de CETTE piste', () => {
    const cinqUn = buildAudioArgs(audioOptions({ channels: 6 }));
    expect(cinqUn[cinqUn.indexOf('-af') + 1]).toContain('pan=stereo');

    const stereo = buildAudioArgs(audioOptions({ channels: 2 }));
    expect(stereo[stereo.indexOf('-af') + 1]).not.toContain('pan=stereo');
  });

  it('découpe en segments de huit secondes', () => {
    const args = buildAudioArgs(audioOptions());
    expect(args[args.indexOf('-hls_time') + 1]).toBe('8');
    expect(args[args.indexOf('-hls_segment_type') + 1]).toBe('fmp4');
  });

  it('place -ss AVANT -i et décale les horodatages', () => {
    const args = buildAudioArgs(audioOptions({ startTime: 2400, startNumber: 300 }));
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-output_ts_offset') + 1]).toBe('2400.000');
    expect(args[args.indexOf('-start_number') + 1]).toBe('300');
  });

  it('n’ajoute aucun déplacement au départ du fichier', () => {
    const args = buildAudioArgs(audioOptions());
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-output_ts_offset');
  });

  it('écrit dans le répertoire du rendu, pas dans celui de la vidéo', () => {
    const args = buildAudioArgs(audioOptions({ outputDir: '/w/mf-365/a-6' }));
    expect(args[args.indexOf('-hls_segment_filename') + 1]).toBe('/w/mf-365/a-6/seg-%05d.m4s');
  });

  it('borne l’analyse du fichier d’entrée', () => {
    const args = buildAudioArgs(audioOptions());
    expect(args.indexOf('-probesize')).toBeLessThan(args.indexOf('-i'));
  });
});

// ---------------------------------------------------------------------------

describe('buildExtractArgs — UNE passe, toutes les pistes', () => {
  it('sort chaque piste dans un fichier, sur une seule entrée', () => {
    /*
     * Les paquets de sous-titres sont entrelacés d'un bout à l'autre du
     * conteneur : ffmpeg doit démultiplexer le fichier ENTIER pour les
     * collecter. Extraire les douze pistes texte du fichier #365 une par une
     * coûterait douze traversées au lieu d'une.
     */
    const args = buildExtractArgs(
      '/volume1/avatar.mkv',
      [
        { streamIndex: 7, codec: 'subrip' },
        { streamIndex: 9, codec: 'ass' },
        { streamIndex: 18, codec: 'mov_text' },
      ],
      '/cache/365',
    );

    expect(args.filter((arg) => arg === '-i')).toHaveLength(1);
    expect(args).toContain('0:7');
    expect(args).toContain('0:9');
    expect(args).toContain('0:18');
    expect(args.filter((arg) => arg === '-map')).toHaveLength(3);
  });

  it('extrait en format NATIF plutôt qu’en WebVTT', () => {
    /*
     * ffmpeg sait écrire du WebVTT directement. On ne s'en sert pas : sa
     * conversion ASS n'est ni testable sans machine, ni pilotable. En sortant
     * l'ASS tel quel, chaque dégradation devient une décision vérifiée par un
     * test dans ass.ts.
     */
    const args = buildExtractArgs('/a.mkv', [{ streamIndex: 9, codec: 'ass' }], '/cache/1');
    expect(args[args.indexOf('-c:s') + 1]).toBe('copy');
    expect(args[args.indexOf('-f') + 1]).toBe('ass');
    expect(args.at(-1)).toMatch(/9\.ass$/);
  });

  it('copie le SubRip sans le réécrire', () => {
    const args = buildExtractArgs('/a.mkv', [{ streamIndex: 7, codec: 'subrip' }], '/cache/1');
    expect(args[args.indexOf('-c:s') + 1]).toBe('copy');
    expect(args.at(-1)).toMatch(/7\.srt$/);
  });

  it('convertit mov_text, qu’aucun fichier texte ne porte', () => {
    const args = buildExtractArgs('/a.mp4', [{ streamIndex: 2, codec: 'mov_text' }], '/cache/1');
    expect(args[args.indexOf('-c:s') + 1]).toBe('srt');
  });

  it('ignore un codec qu’on ne sait pas extraire', () => {
    // Liste blanche : 167 pistes de la bibliothèque ont un codec que ffprobe
    // n'a pas nommé, et tenter l'extraction à l'aveugle échouerait.
    const args = buildExtractArgs(
      '/a.mkv',
      [
        { streamIndex: 7, codec: 'subrip' },
        { streamIndex: 19, codec: 'hdmv_pgs_subtitle' },
      ],
      '/cache/1',
    );
    expect(args).toContain('0:7');
    expect(args).not.toContain('0:19');
  });

  it('n’écrase pas le fichier source', () => {
    const args = buildExtractArgs('/a.mkv', [{ streamIndex: 7, codec: 'subrip' }], '/cache/1');
    expect(args.indexOf('-y')).toBeLessThan(args.indexOf('-i'));
  });
});

describe('rawFileName et conversionFormat', () => {
  it('nomment le fichier selon le codec', () => {
    expect(rawFileName({ streamIndex: 9, codec: 'ass' })).toBe('9.ass');
    expect(rawFileName({ streamIndex: 7, codec: 'subrip' })).toBe('7.srt');
    expect(rawFileName({ streamIndex: 3, codec: 'hdmv_pgs_subtitle' })).toBeNull();
  });

  it('annoncent le format à passer au convertisseur', () => {
    expect(conversionFormat('ass')).toBe('ass');
    expect(conversionFormat('subrip')).toBe('srt');
    expect(conversionFormat('mov_text')).toBe('srt');
    expect(conversionFormat('hdmv_pgs_subtitle')).toBeNull();
  });
});

describe('cacheKey', () => {
  it('change dès que le fichier change', () => {
    // Taille et date de modification : le même couple qui rend le scan
    // incrémental. Un fichier réencodé sur place rend son cache inatteignable.
    const avant = cacheKey(365, 30_000_000_000, 1_700_000_000_000);
    expect(cacheKey(365, 30_000_000_001, 1_700_000_000_000)).not.toBe(avant);
    expect(cacheKey(365, 30_000_000_000, 1_700_000_000_001)).not.toBe(avant);
    expect(cacheKey(365, 30_000_000_000, 1_700_000_000_000)).toBe(avant);
  });

  it('sépare deux fichiers dont l’identifiant est un préfixe de l’autre', () => {
    // Sans le tiret, la purge du fichier 12 emporterait les caches du 123.
    expect(cacheKey(12, 1, 1).startsWith('12-')).toBe(true);
    expect(cacheKey(123, 1, 1).startsWith('12-')).toBe(false);
  });
});
