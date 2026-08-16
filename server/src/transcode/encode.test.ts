import { describe, expect, it } from 'vitest';

import {
  TARGET_HEIGHT,
  bitrateFor,
  buildTranscodeArgs,
  downmixFilter,
  keyframeArgs,
  needsToneMapping,
  outputGeometry,
  outputHeight,
  outputSize,
  shouldResize,
  softwareFilterChain,
  qsvFilterChain,
  supportedBackend,
  vaapiFilterChain,
  type TranscodeRunOptions,
} from './encode.js';

function options(overrides: Partial<TranscodeRunOptions> = {}): TranscodeRunOptions {
  return {
    input: '/volume1/plex/Media/Films/a.mkv',
    startTime: 0,
    startNumber: 0,
    segmentDuration: 4,
    endTime: null,
    outputDir: '/app/data/transcode/mf-1',
    audio: { kind: 'auto', channels: 6 },
    sourceWidth: 3840,
    sourceHeight: 2160,
    frameRate: 24,
    hdr: null,
    hardware: 'vaapi',
    device: '/dev/dri/renderD128',
    toneMap: 'libplacebo',
    ...overrides,
  };
}

describe('outputHeight', () => {
  it('ramène une source 4K à 1080p', () => {
    expect(outputHeight(2160)).toBe(TARGET_HEIGHT);
  });

  it('n’agrandit JAMAIS une source plus petite', () => {
    expect(outputHeight(720)).toBe(720);
    expect(outputHeight(576)).toBe(576);
  });

  it('vise 1080p quand la hauteur est inconnue', () => {
    expect(outputHeight(null)).toBe(TARGET_HEIGHT);
  });
});

describe('bitrateFor', () => {
  it('choisit selon la hauteur de SORTIE', () => {
    // Un 4K réduit en 1080p n'a aucun besoin du débit de sa source.
    expect(bitrateFor(1080)).toBe(6_000_000);
    expect(bitrateFor(720)).toBe(3_000_000);
    expect(bitrateFor(480)).toBe(1_500_000);
  });

  it('monte pour une sortie au-dessus de 1080p', () => {
    expect(bitrateFor(2160)).toBeGreaterThan(bitrateFor(1080));
  });
});

describe('outputGeometry', () => {
  const vaapi = { hardware: 'vaapi' as const };

  it('suit la source jusqu’au plafond du transport HDR', () => {
    // Une source 4K est lue en 4K, et son débit tombe de la même règle que le
    // reste : `bitrateFor(2160)` vaut les 12 Mbps validés à la mesure.
    const g = outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, ...vaapi, hdrPassthrough: true, hdrMaxHeight: 2160 });
    expect(g).toEqual({ passthrough: true, width: 3840, height: 2160, bitrate: bitrateFor(2160) });
  });

  /*
   * LE PREMIER GARDE-FOU : ON NE MONTE JAMAIS.
   *
   * Il ne dépend d'aucun réglage — c'est le `Math.min` d'`outputHeight` — et
   * aucune valeur de plafond ne peut le contourner. Un plafond absurde est donc
   * sans effet sur une source modeste, plutôt que d'agrandir.
   */
  it('n’agrandit JAMAIS, quel que soit le plafond', () => {
    for (const plafond of [1080, 2160, 4320]) {
      const g = outputGeometry({
        sourceWidth: 1280,
        sourceHeight: 720,
        ...vaapi,
        hdrPassthrough: true,
        hdrMaxHeight: plafond,
      });
      expect(g, `plafond ${plafond}`).toMatchObject({ width: 1280, height: 720, bitrate: bitrateFor(720) });
    }
  });

  /* LE SECOND : le plafond se redescend, et ramène tout avec lui. */
  it('redescend en 1080p quand le plafond le demande', () => {
    const g = outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, ...vaapi, hdrPassthrough: true, hdrMaxHeight: 1080 });
    expect(g).toEqual({ passthrough: true, width: 1920, height: 1080, bitrate: bitrateFor(1080) });
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * SANS PLAFOND EXPLICITE, ON ÉCHOUE. C'EST UN REVIREMENT.
   *
   * Ce test affirmait l'inverse : en l'absence de `hdrMaxHeight`, la géométrie
   * retombait sur 1080p. Le repli n'était jamais atteint en production, mais sa
   * conséquence s'il l'avait été aurait été la pire possible — du 4K HDR servi
   * en 1080p sans erreur, sans journal, indistinguable d'un choix délibéré.
   *
   * Une exception se voit à la première requête. Un plafond silencieux se
   * découvre en mesurant la mauvaise chose pendant une soirée.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('ÉCHOUE bruyamment quand le plafond du transport HDR manque', () => {
    expect(() =>
      outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, ...vaapi, hdrPassthrough: true }),
    ).toThrow(/plafond explicite/);
  });

  it('n’exige ce plafond QUE sur le chemin du transport HDR', () => {
    // Le chemin ordinaire a le sien, en dur et assumé : il ne doit pas échouer.
    expect(() => outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, ...vaapi })).not.toThrow();
    expect(() =>
      outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, ...vaapi, mode: 'remux' }),
    ).not.toThrow();
  });

  it('ne laisse PAS le plafond HDR déborder sur le chemin ordinaire', () => {
    // Un 4K SDR reste normalisé en 1080p même si le transport HDR vise 2160.
    const g = outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, ...vaapi, hdrMaxHeight: 2160 });
    expect(g).toMatchObject({ passthrough: false, width: 1920, height: 1080 });
  });

  it('réduit à 1080p et à son débit sans le transport HDR', () => {
    const g = outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, ...vaapi });
    expect(g.passthrough).toBe(false);
    expect(g).toMatchObject({ width: 1920, height: 1080, bitrate: bitrateFor(1080) });
  });

  /*
   * Le garde-fou du transport : hors VAAPI, aucun encodeur ne porte le 10 bits
   * ici. Annoncer 20 Mbps de HEVC là où passe du H.264 tromperait le lecteur.
   */
  it('ignore le transport HDR quand l’accélération n’est pas VAAPI', () => {
    const g = outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, hardware: null, hdrPassthrough: true });
    expect(g.passthrough).toBe(false);
    expect(g.bitrate).toBe(bitrateFor(1080));
  });

  /*
   * LE CAS QUI A MOTIVÉ LA FONCTION : le manifeste et l'encodeur avaient
   * divergé. Ces deux tests fixent l'accord plutôt que les valeurs.
   */
  it('donne au manifeste EXACTEMENT ce que l’encodeur produit — transport HDR', () => {
    const args = buildTranscodeArgs(options({ sourceWidth: 3840, sourceHeight: 2160, hdrPassthrough: true, hdrMaxHeight: 2160 }));
    const g = outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, ...vaapi, hdrPassthrough: true, hdrMaxHeight: 2160 });

    expect(args[args.indexOf('-b:v') + 1]).toBe(String(g.bitrate));
    expect(args.join(' ')).toContain(`scale_vaapi=w=${g.width}:h=${g.height}:format=p010`);
  });

  it('donne au manifeste EXACTEMENT ce que l’encodeur produit — chemin ordinaire', () => {
    const args = buildTranscodeArgs(options({ sourceWidth: 3840, sourceHeight: 2160 }));
    const g = outputGeometry({ sourceWidth: 3840, sourceHeight: 2160, ...vaapi });

    expect(args[args.indexOf('-b:v') + 1]).toBe(String(g.bitrate));
    expect(args.join(' ')).toContain(`w=${g.width}:h=${g.height}`);
  });

  /*
   * En REMUX le flux est COPIÉ. Le réduire sur le papier annoncerait 1080p là où
   * transitent des 4K, et 6 Mbps là où en passent soixante-quinze.
   */
  it('laisse le remux à ses dimensions et à son débit de source', () => {
    const g = outputGeometry({
      sourceWidth: 3840,
      sourceHeight: 2160,
      ...vaapi,
      mode: 'remux',
      sourceBitrate: 75_719_053,
    });
    expect(g).toMatchObject({ width: 3840, height: 2160, bitrate: 75_719_053 });
  });

  it('retombe sur la règle de hauteur quand le débit source est inconnu', () => {
    const g = outputGeometry({ sourceWidth: 1920, sourceHeight: 1080, ...vaapi, mode: 'remux', sourceBitrate: null });
    expect(g.bitrate).toBe(bitrateFor(1080));
  });

  it('survit à une source sans dimensions connues', () => {
    const g = outputGeometry({ sourceWidth: null, sourceHeight: null, ...vaapi });
    expect(g.height).toBe(TARGET_HEIGHT);
    expect(g.width).toBeNull();
  });
});

describe('needsToneMapping', () => {
  it('reconnaît toutes les formes de HDR', () => {
    expect(needsToneMapping('HDR10')).toBe(true);
    expect(needsToneMapping('HDR10+')).toBe(true);
    expect(needsToneMapping('HLG')).toBe(true);
    // 93 des 94 fichiers Dolby Vision ont une couche de base HDR10.
    expect(needsToneMapping('Dolby Vision')).toBe(true);
  });

  it('laisse le SDR tranquille', () => {
    expect(needsToneMapping(null)).toBe(false);
  });
});

/** Les trois cas réels de la bibliothèque. */
const UHD_HDR = { targetHeight: 1080, sourceWidth: 3840, sourceHeight: 2160 } as const;
const UHD_DV = { targetHeight: 1080, sourceWidth: 3840, sourceHeight: 2064 } as const;
const HD_SDR = { targetHeight: 1080, sourceWidth: 1920, sourceHeight: 1088 } as const;
const PETIT_SDR = { targetHeight: 1080, sourceWidth: 1280, sourceHeight: 720 } as const;

describe('outputSize', () => {
  it('calcule des dimensions exactes plutôt que de déléguer à -2', () => {
    // scale_vaapi de ffmpeg 5.1 ne documente pas la convention -1/-2 : on
    // connaît la résolution source, autant n'envoyer que des entiers.
    expect(outputSize(3840, 2160, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(3840, 2064, 1080)).toEqual({ width: 2010, height: 1080 });
  });

  it('rend des dimensions PAIRES', () => {
    // H.264 en 4:2:0 n'accepte pas de dimension impaire.
    for (const [w, h] of [
      [3840, 2064],
      [1919, 1079],
      [2048, 858],
    ] as const) {
      const size = outputSize(w, h, 1080) as { width: number; height: number };
      expect(size.width % 2, `largeur pour ${w}x${h}`).toBe(0);
      expect(size.height % 2, `hauteur pour ${w}x${h}`).toBe(0);
    }
  });

  it('n’agrandit jamais', () => {
    expect(outputSize(1280, 720, 1080)).toEqual({ width: 1280, height: 720 });
  });

  it('rend null sans dimensions connues', () => {
    expect(outputSize(null, 1080, 1080)).toBeNull();
    expect(outputSize(1920, null, 1080)).toBeNull();
  });
});

describe('vaapiFilterChain — tout doit rester sur le GPU', () => {
  it('applique le tone mapping matériel sur une source HDR', () => {
    const chain = vaapiFilterChain({ ...UHD_HDR, hdr: 'HDR10' });
    expect(chain).toContain('tonemap_vaapi');
    expect(chain).toContain('transfer=bt709');
    expect(chain).toContain('format=nv12');
  });

  /**
   * Ce qui compte n'est pas « tout filtre finit par _vaapi » — libplacebo
   * travaille sur des surfaces Vulkan et ne portera jamais ce suffixe — mais
   * qu'AUCUNE image ne redescende en mémoire centrale.
   *
   * `hwmap` EXPOSE une surface d'une interface à l'autre sans la copier : les
   * deux partagent le même tampon via DRM. `hwdownload` et `hwupload`, eux,
   * font le voyage — ce sont eux qui feraient chuter le débit d'un facteur
   * cinq, et ce sont eux que ce test interdit.
   */
  const FILTRES_MEMOIRE_CENTRALE = ['hwdownload', 'hwupload', 'scale', 'format', 'zscale', 'tonemap'];

  it('ne redescend JAMAIS les images en mémoire centrale', () => {
    for (const toneMap of ['libplacebo', 'tonemap_vaapi', null] as const) {
      for (const hdr of ['HDR10', 'Dolby Vision', 'HLG', null] as const) {
        for (const base of [UHD_HDR, HD_SDR, PETIT_SDR]) {
          const chain = vaapiFilterChain({ ...base, hdr, toneMap });
          for (const filter of chain.split(',')) {
            const name = filter.split('=')[0] as string;
            expect(
              FILTRES_MEMOIRE_CENTRALE.includes(name),
              `« ${name} » ramène l'image en mémoire centrale, dans « ${chain} »`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('n’emploie que des filtres matériels : _vaapi, libplacebo ou hwmap', () => {
    const AUTORISES = /(_vaapi$|^libplacebo$|^hwmap$)/;
    for (const toneMap of ['libplacebo', 'tonemap_vaapi', null] as const) {
      for (const hdr of ['HDR10', null] as const) {
        const chain = vaapiFilterChain({ ...UHD_HDR, hdr, toneMap });
        for (const filter of chain.split(',')) {
          const name = filter.split('=')[0] as string;
          expect(AUTORISES.test(name), `filtre inattendu « ${name} » dans « ${chain} »`).toBe(true);
        }
      }
    }
  });

  it('passe par Vulkan et revient, sans copie, avec libplacebo', () => {
    const filters = vaapiFilterChain({ ...UHD_HDR, hdr: 'HDR10', toneMap: 'libplacebo' }).split(',');
    expect(filters[0]).toBe('scale_vaapi=w=1920:h=1080');
    expect(filters[1]).toBe('hwmap=derive_device=vulkan');
    expect(filters[2]).toContain('libplacebo=');
    expect(filters[3]).toBe('hwmap=derive_device=vaapi:reverse=1');
  });

  it('libplacebo produit du BT.709 en nv12', () => {
    // Même exigence que tonemap_vaapi : sortie 8 bits, sinon H.264 High 10.
    const chain = vaapiFilterChain({ ...UHD_HDR, hdr: 'HDR10', toneMap: 'libplacebo' });
    expect(chain).toContain('color_trc=bt709');
    expect(chain).toContain('format=nv12');
  });

  it('ne touche pas une source SDR, quel que soit le moteur', () => {
    // Une source SDR n'a rien à tone-mapper : aucun moteur ne doit apparaître.
    for (const toneMap of ['libplacebo', 'tonemap_vaapi', 'software', null] as const) {
      const chain = vaapiFilterChain({ ...HD_SDR, hdr: null, toneMap });
      expect(chain, `moteur ${toneMap}`).toBe('scale_vaapi=format=nv12');
    }
  });

  /**
   * `tonemap_vaapi` ne prend AUCUNE dimension — relevé par
   * `ffmpeg -h filter=tonemap_vaapi` sur la machine cible. Lui en passer fait
   * échouer l'initialisation du filtre, et c'est ce qui cassait le palier.
   */
  it('ne passe jamais de dimension à tonemap_vaapi', () => {
    for (const base of [UHD_HDR, UHD_DV, HD_SDR]) {
      const chain = vaapiFilterChain({ ...base, hdr: 'HDR10' });
      const tonemap = chain.split(',').find((f) => f.startsWith('tonemap_vaapi')) as string;
      expect(tonemap, chain).toBeDefined();
      expect(tonemap).not.toContain('w=');
      expect(tonemap).not.toContain('h=');
    }
  });

  it('redimensionne AVANT de tone-mapper', () => {
    // Tone-mapper en 4K puis réduire ferait travailler le moteur sur quatre
    // fois plus de pixels.
    const filters = vaapiFilterChain({ ...UHD_HDR, hdr: 'HDR10' }).split(',');
    expect(filters).toHaveLength(2);
    expect(filters[0]).toBe('scale_vaapi=w=1920:h=1080');
    expect(filters[1]).toContain('tonemap_vaapi');
  });

  it('laisse la précision intacte jusqu’au tone mapping', () => {
    // Réduire en nv12 8 bits AVANT de tone-mapper écrêterait les hautes
    // lumières — exactement ce que le tone mapping doit éviter.
    const filters = vaapiFilterChain({ ...UHD_HDR, hdr: 'HDR10' }).split(',');
    expect(filters[0]).not.toContain('format=');
  });

  it('ne redimensionne pas une source déjà sous la cible', () => {
    const chain = vaapiFilterChain({ ...PETIT_SDR, hdr: null });
    expect(chain).toBe('scale_vaapi=format=nv12');
  });

  it('impose le format même sans redimensionner', () => {
    // Sinon une source 10 bits produirait du H.264 High 10.
    expect(vaapiFilterChain({ ...PETIT_SDR, hdr: null })).toContain('format=nv12');
  });

  it('redimensionne et convertit en une passe sur du SDR', () => {
    expect(vaapiFilterChain({ ...UHD_HDR, hdr: null })).toBe('scale_vaapi=w=1920:h=1080:format=nv12');
  });
});

describe('softwareFilterChain — le repli', () => {
  it('impose yuv420p, toujours', () => {
    // Le défaut constaté : « profile High 10, yuv420p10le », qu'aucun
    // navigateur ne décode.
    for (const hdr of ['HDR10', null] as const) {
      for (const base of [UHD_HDR, PETIT_SDR]) {
        expect(softwareFilterChain({ ...base, hdr })).toContain('format=yuv420p');
      }
    }
  });

  it('termine par la conversion de format', () => {
    const chain = softwareFilterChain({ ...UHD_HDR, hdr: 'HDR10' });
    expect(chain.split(',').at(-1)).toBe('format=yuv420p');
  });

  it('convertit la plage dynamique sur une source HDR', () => {
    const chain = softwareFilterChain({ ...UHD_HDR, hdr: 'HDR10' });
    expect(chain).toContain('zscale');
    expect(chain).toContain('tonemap');
  });
});

describe('downmixFilter — les dialogues ne doivent pas disparaître', () => {
  it('remonte le canal central sur du 5.1', () => {
    const filter = downmixFilter(6);
    expect(filter).toContain('pan=stereo');
    // Le centre porte les dialogues : il doit peser plus que les surrounds.
    expect(filter).toContain('0.8*FC');
    expect(filter).toContain('0.5*BL');
  });

  it('traite aussi le 7.1', () => {
    const filter = downmixFilter(8);
    expect(filter).toContain('0.8*FC');
    expect(filter).toContain('SL');
  });

  it('ne mélange rien en stéréo ou en mono', () => {
    expect(downmixFilter(2)).not.toContain('pan=');
    expect(downmixFilter(1)).not.toContain('pan=');
    expect(downmixFilter(null)).not.toContain('pan=');
  });

  it('rééchantillonne dans tous les cas', () => {
    for (const channels of [null, 1, 2, 6, 8]) {
      expect(downmixFilter(channels)).toContain('aresample=async=1');
    }
  });
});

describe('keyframeArgs', () => {
  it('force les images clés sur les frontières de segment', () => {
    // La vidéo est réencodée : on place les images clés où l'on veut, ce que
    // la copie de flux du palier 1 ne permettait pas.
    const args = keyframeArgs(4, 24);
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*4)');
    expect(args[args.indexOf('-g') + 1]).toBe('96');
  });

  it('suit la durée de segment demandée', () => {
    expect(keyframeArgs(2, 25)[1]).toBe('expr:gte(t,n_forced*2)');
    expect(keyframeArgs(2, 25)[3]).toBe('50');
  });

  it('se passe de -g quand la cadence est inconnue', () => {
    expect(keyframeArgs(4, null)).not.toContain('-g');
  });
});

describe('buildTranscodeArgs', () => {
  it('décode ET encode en matériel', () => {
    const args = buildTranscodeArgs(options());
    // Sans -hwaccel_output_format, les images redescendent en mémoire centrale
    // et le décodage HEVC logiciel mange tout le gain.
    expect(args[args.indexOf('-hwaccel_output_format') + 1]).toBe('vaapi');
    expect(args.indexOf('-hwaccel')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-c:v') + 1]).toBe('h264_vaapi');
  });

  it('sélectionne explicitement les flux et écarte le reste', () => {
    // Avatar a 27 flux, dont deux polices TrueType sur lesquelles ffmpeg échoue.
    const args = buildTranscodeArgs(options());
    expect(args).toContain('0:v:0');
    expect(args).toContain('0:a:0?');
    expect(args).toContain('-sn');
    expect(args).toContain('-dn');
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
  });

  it('retient une piste audio désignée par son index ABSOLU', () => {
    /*
     * `audio_track.stream_index` porte l'index du flux dans le fichier : sur le
     * fichier #365, les pistes audio sont les flux 1 à 6. Les traduire en
     * « 0:a:N » supposerait qu'ils soient contigus et commencent à zéro.
     */
    const args = buildTranscodeArgs(options({ audio: { kind: 'stream', streamIndex: 3, channels: 6 } }));
    expect(args).toContain('0:3');
    expect(args).not.toContain('0:a:3');
  });

  it('ne produit AUCUN son quand l’audio est rendu à part', () => {
    const args = buildTranscodeArgs(options({ audio: { kind: 'none' } }));
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('-af');
  });

  it('NE REDIT PAS les métadonnées de couleur en matériel', () => {
    /*
     * ffmpeg 7 insère un auto_scale quand la ligne de commande redemande une
     * conversion que le filtre a déjà faite — et ce filtre logiciel ne sait pas
     * traiter une surface VAAPI. Résultat : aucun paquet écrit, les 164
     * fichiers HDR en échec. C'est le filtre qui étiquette, vérifié en sortie.
     */
    for (const hardware of ['vaapi', 'qsv'] as const) {
      const args = buildTranscodeArgs(options({ hdr: 'HDR10', hardware }));
      expect(args, hardware).not.toContain('-colorspace');
      expect(args, hardware).not.toContain('-color_trc');
    }
  });

  it('les garde en repli logiciel, où elles sont sans danger', () => {
    const args = buildTranscodeArgs(options({ hdr: 'HDR10', hardware: null }));
    expect(args[args.indexOf('-color_trc') + 1]).toBe('bt709');
    expect(args[args.indexOf('-colorspace') + 1]).toBe('bt709');
  });

  it('ne touche pas aux métadonnées d’une source SDR', () => {
    expect(buildTranscodeArgs(options({ hdr: null }))).not.toContain('-color_trc');
  });

  it('produit un profil décodable par les navigateurs', () => {
    expect(buildTranscodeArgs(options())[buildTranscodeArgs(options()).indexOf('-profile:v') + 1]).toBe('main');

    const logiciel = buildTranscodeArgs(options({ hardware: null }));
    expect(logiciel[logiciel.indexOf('-profile:v') + 1]).toBe('high');
    expect(logiciel[logiciel.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
  });

  it('n’ouvre aucun périphérique en repli logiciel', () => {
    const args = buildTranscodeArgs(options({ hardware: null }));
    expect(args).not.toContain('-hwaccel');
    expect(args).not.toContain('-hwaccel_output_format');
  });

  it('adapte le débit à la sortie, pas à la source', () => {
    const args = buildTranscodeArgs(options({ sourceWidth: 2160 === 2160 ? 3840 : 1920, sourceHeight: 2160 }));
    expect(args[args.indexOf('-b:v') + 1]).toBe('6000000');
  });

  it('ne décale JAMAIS les horodatages de sortie, même sur une relance', () => {
    /*
     * `-output_ts_offset` n'atteint pas les fragments : ffmpeg ramène leurs
     * horodatages à zéro et met le décalage dans l'edit list de l'en-tête, que
     * hls.js ne recharge jamais. Le segment se présentait alors à 0,041 s au
     * lieu de 2400 s. Sans l'argument, tous les runs écrivent le même en-tête
     * et c'est hls.js qui place les fragments. Ne pas le réintroduire.
     */
    const args = buildTranscodeArgs(options({ startTime: 2400, startNumber: 601 }));
    expect(args).not.toContain('-output_ts_offset');
    // Le déplacement se fait toujours à l'entrée, lui.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-start_number') + 1]).toBe('601');
  });

  it('produit des segments fMP4 sous un nom temporaire', () => {
    const args = buildTranscodeArgs(options());
    expect(args[args.indexOf('-hls_segment_type') + 1]).toBe('fmp4');
    expect(args[args.indexOf('-hls_flags') + 1]).toContain('temp_file');
  });

  it('applique le downmix de la piste RETENUE, pas de la première', () => {
    /*
     * Le nombre de canaux vient du choix de piste, et suit donc celle qu'on
     * produit réellement. C'est ce qui fait que la matrice s'applique à TOUTES
     * les pistes du fichier #365 et pas seulement à la première.
     */
    const cinqUn = buildTranscodeArgs(options({ audio: { kind: 'stream', streamIndex: 4, channels: 6 } }));
    expect(cinqUn[cinqUn.indexOf('-af') + 1]).toContain('pan=stereo');

    const stereo = buildTranscodeArgs(options({ audio: { kind: 'stream', streamIndex: 5, channels: 2 } }));
    expect(stereo[stereo.indexOf('-af') + 1]).not.toContain('pan=stereo');
  });

  it('impose la fréquence d’échantillonnage de sortie', () => {
    // C'est elle qui rend la découpe des segments audio calculable.
    const args = buildTranscodeArgs(options());
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
  });
});

/**
 * Le bourrage en macroblocs : beaucoup de fichiers « 1080p » sont encodés en
 * 1920×1088, parce que le H.264 travaille par blocs de 16 pixels. Les réduire
 * ferait travailler le moteur et dégraderait l'image pour 0,7 % de pixels.
 */
describe('shouldResize — le bourrage de macroblocs', () => {
  it('laisse passer un 1088 sans le toucher', () => {
    expect(shouldResize(1088, 1080)).toBe(false);
    expect(vaapiFilterChain({ targetHeight: 1080, sourceWidth: 1920, sourceHeight: 1088, hdr: null })).toBe(
      'scale_vaapi=format=nv12',
    );
  });

  it('réduit une vraie source plus grande', () => {
    expect(shouldResize(2160, 1080)).toBe(true);
    expect(shouldResize(1440, 1080)).toBe(true);
  });

  it('ne réduit pas une source plus petite', () => {
    expect(shouldResize(720, 1080)).toBe(false);
    expect(shouldResize(null, 1080)).toBe(false);
  });
});

describe('supportedBackend — le repli silencieux est fini', () => {
  it('accepte les deux moteurs réellement pilotés', () => {
    expect(supportedBackend('vaapi')).toEqual({ backend: 'vaapi', unsupported: null });
    expect(supportedBackend('qsv')).toEqual({ backend: 'qsv', unsupported: null });
  });

  it('n’invente rien quand rien n’a été détecté', () => {
    expect(supportedBackend(null)).toEqual({ backend: null, unsupported: null });
  });

  it('EXPLIQUE un moteur détecté mais non implémenté', () => {
    /*
     * C'est le défaut qui a fait transcoder en logiciel à x0,47 sans un mot :
     * `hardware === 'vaapi' ? 'vaapi' : null` ramenait QSV à null.
     */
    const choix = supportedBackend('nvenc');
    expect(choix.backend).toBeNull();
    expect(choix.unsupported).toContain('nvenc');
    expect(choix.unsupported).toContain('encode.ts');
  });
});

describe('qsvFilterChain', () => {
  it('fait tout d’un seul filtre', () => {
    const chaine = qsvFilterChain({ targetHeight: 1080, hdr: 'HDR10', sourceWidth: 3840, sourceHeight: 2160 });
    expect(chaine).toBe('vpp_qsv=w=1920:h=1080:tonemap=1:format=nv12');
  });

  it('n’active le tone mapping que sur du HDR', () => {
    const sdr = qsvFilterChain({ targetHeight: 1080, hdr: null, sourceWidth: 3840, sourceHeight: 2160 });
    expect(sdr).not.toContain('tonemap');
    expect(sdr).toBe('vpp_qsv=w=1920:h=1080:format=nv12');
  });

  it('ne redimensionne pas une source déjà sous la cible', () => {
    expect(qsvFilterChain({ targetHeight: 1080, hdr: null, sourceWidth: 1920, sourceHeight: 1080 })).toBe(
      'vpp_qsv=format=nv12',
    );
  });

  it('impose le format même sans rien d’autre à faire', () => {
    // Sans cela, une source 10 bits produirait du H.264 High 10.
    expect(qsvFilterChain({ targetHeight: 1080, hdr: null, sourceWidth: null, sourceHeight: null })).toContain(
      'format=nv12',
    );
  });
});

describe('buildTranscodeArgs — QSV', () => {
  it('ouvre le périphérique et décode en matériel', () => {
    const args = buildTranscodeArgs(options({ hardware: 'qsv' }));
    expect(args[args.indexOf('-init_hw_device') + 1]).toBe('qsv=hw:/dev/dri/renderD128');
    expect(args[args.indexOf('-hwaccel') + 1]).toBe('qsv');
    expect(args[args.indexOf('-hwaccel_output_format') + 1]).toBe('qsv');
    expect(args[args.indexOf('-c:v') + 1]).toBe('h264_qsv');
  });

  it('n’emprunte AUCUN chemin VAAPI', () => {
    const args = buildTranscodeArgs(options({ hardware: 'qsv' })).join(' ');
    expect(args).not.toContain('vaapi');
    expect(args).not.toContain('hwmap');
  });
});
