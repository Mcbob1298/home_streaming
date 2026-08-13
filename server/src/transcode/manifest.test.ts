/**
 * Tests du plan de segments audio et du manifeste maître.
 *
 * La durée de segment audio n'est pas un réglage de confort : elle est dictée
 * par la trame AAC, et le test le vérifie plutôt que de le supposer.
 */
import { describe, expect, it } from 'vitest';

import type { LabelledAudioTrack, LabelledSubtitleTrack } from '../playback/tracks.js';
import {
  AUDIO_GROUP,
  SUBTITLE_GROUP,
  buildMasterPlaylist,
  estimateBandwidth,
  needsMaster,
  needsSeparateAudio,
} from './manifest.js';
import {
  AAC_FRAME_SAMPLES,
  AUDIO_SAMPLE_RATE,
  AUDIO_SEGMENT_DURATION,
  buildSubtitlePlaylist,
  planAudioSegments,
} from './segments.js';

function audio(overrides: Partial<LabelledAudioTrack> = {}): LabelledAudioTrack {
  return {
    streamIndex: 1,
    label: 'Français 5.1',
    language: 'fre',
    channels: 6,
    codec: 'dts',
    isDefault: true,
    ...overrides,
  };
}

function subtitle(overrides: Partial<LabelledSubtitleTrack> = {}): LabelledSubtitleTrack {
  return {
    streamIndex: 8,
    label: 'Français',
    language: 'fre',
    kind: 'full',
    codec: 'subrip',
    ...overrides,
  };
}

const URLS = {
  video: '/api/hls/365/video.m3u8',
  audio: (index: number) => `/api/hls/365/audio-${index}.m3u8`,
  subtitle: (index: number) => `/api/hls/365/sub-${index}.m3u8`,
};

// ---------------------------------------------------------------------------

describe('durée de segment audio — dictée par la trame AAC', () => {
  it('vaut un nombre ENTIER de trames', () => {
    /*
     * C'est toute la raison des huit secondes. À quatre, il faudrait 187,5
     * trames : ffmpeg coupe alors à la trame suivante, et la quantification
     * cesse d'être additive — après un déplacement, les bornes réelles
     * s'écartent du manifeste d'une trame par segment.
     *
     * Mesuré sur ffmpeg 9 : 8.000000 partout, y compris après reprise à 16 s.
     */
    const frames = (AUDIO_SEGMENT_DURATION * AUDIO_SAMPLE_RATE) / AAC_FRAME_SAMPLES;
    expect(frames).toBe(375);
    expect(Number.isInteger(frames)).toBe(true);
  });
});

describe('planAudioSegments', () => {
  it('découpe en segments de huit secondes', () => {
    expect(planAudioSegments(24)).toEqual([
      { index: 0, start: 0, duration: 8 },
      { index: 1, start: 8, duration: 8 },
      { index: 2, start: 16, duration: 8 },
    ]);
  });

  it('tronque le dernier segment à la durée réelle', () => {
    const plan = planAudioSegments(20);
    expect(plan).toHaveLength(3);
    expect(plan.at(-1)).toEqual({ index: 2, start: 16, duration: 4 });
  });

  it('absorbe une queue trop courte dans le segment précédent', () => {
    /*
     * L'encodeur AAC ajoute toujours quelques trames de bourrage : ffmpeg
     * produit alors un dernier fichier de 21 ms. Le déclarer n'apporterait
     * rien, et SOUS-déclarer est sans danger — un segment produit en trop est
     * ignoré, alors qu'un segment déclaré et jamais produit fait attendre le
     * lecteur jusqu'à l'expiration.
     */
    const plan = planAudioSegments(16.02);
    expect(plan).toHaveLength(2);
    expect(plan.at(-1)?.duration).toBeCloseTo(8.02, 3);
  });

  it('garde un fichier plus court qu’un segment', () => {
    expect(planAudioSegments(5)).toEqual([{ index: 0, start: 0, duration: 5 }]);
  });

  it('ne planifie rien sans durée exploitable', () => {
    expect(planAudioSegments(0)).toEqual([]);
    expect(planAudioSegments(Number.NaN)).toEqual([]);
    expect(planAudioSegments(-10)).toEqual([]);
  });

  it('couvre toute la durée, sans trou ni recouvrement', () => {
    const plan = planAudioSegments(3600);
    expect(plan[0]?.start).toBe(0);
    for (let index = 1; index < plan.length; index += 1) {
      const previous = plan[index - 1] as { start: number; duration: number };
      expect(plan[index]?.start).toBeCloseTo(previous.start + previous.duration, 6);
    }
    const last = plan.at(-1) as { start: number; duration: number };
    expect(last.start + last.duration).toBeCloseTo(3600, 6);
  });
});

// ---------------------------------------------------------------------------

describe('needsMaster et needsSeparateAudio', () => {
  it('se passe de manifeste maître sur un fichier simple', () => {
    expect(needsMaster(1, 0)).toBe(false);
    expect(needsMaster(0, 0)).toBe(false);
  });

  it('impose un maître dès qu’il y a deux pistes audio', () => {
    expect(needsMaster(2, 0)).toBe(true);
  });

  it('impose un maître pour porter des sous-titres, même à une seule piste audio', () => {
    expect(needsMaster(1, 3)).toBe(true);
  });

  it('ne sépare l’audio qu’à partir de deux pistes', () => {
    // Séparer coûte un second ffmpeg qui relit le même fichier : sur SMB,
    // deux fois la lecture d'un film de 30 Go. À une piste, il n'achète rien.
    expect(needsSeparateAudio(1)).toBe(false);
    expect(needsSeparateAudio(0)).toBe(false);
    expect(needsSeparateAudio(2)).toBe(true);
  });
});

describe('estimateBandwidth', () => {
  it('additionne vidéo et audio', () => {
    expect(estimateBandwidth(6_000_000, 192_000)).toBe(6_192_000);
  });

  it('ne descend jamais à zéro', () => {
    expect(estimateBandwidth(0, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('buildMasterPlaylist', () => {
  it('déclare l’en-tête attendu', () => {
    const master = buildMasterPlaylist(URLS, {
      audio: [],
      defaultAudio: null,
      subtitles: [],
      bandwidth: 6_000_000,
      width: 1920,
      height: 1080,
    });

    expect(master.startsWith('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n')).toBe(true);
    expect(master.trimEnd().endsWith('/api/hls/365/video.m3u8')).toBe(true);
    expect(master).toContain('BANDWIDTH=6000000');
    expect(master).toContain('RESOLUTION=1920x1080');
  });

  it('n’annonce ni groupe audio ni groupe de sous-titres quand il n’y en a pas', () => {
    const master = buildMasterPlaylist(URLS, {
      audio: [],
      defaultAudio: null,
      subtitles: [],
      bandwidth: 6_000_000,
      width: null,
      height: null,
    });

    expect(master).not.toContain('AUDIO=');
    expect(master).not.toContain('SUBTITLES=');
    expect(master).not.toContain('RESOLUTION');
  });

  it('n’annonce JAMAIS les codecs', () => {
    /*
     * L'attribut est facultatif, et l'annoncer faux est pire que se taire : un
     * lecteur qui lit « avc1.640028 » sur un flux réellement en Main refuse
     * d'ouvrir la source. hls.js déduit les codecs du segment d'initialisation.
     */
    const master = buildMasterPlaylist(URLS, {
      audio: [audio()],
      defaultAudio: 1,
      subtitles: [],
      bandwidth: 6_000_000,
      width: null,
      height: null,
    });
    expect(master).not.toContain('CODECS');
  });

  it('déclare chaque piste audio comme rendu, avec son URI', () => {
    const master = buildMasterPlaylist(URLS, {
      audio: [
        audio({ streamIndex: 1, label: 'Français VFF 5.1', language: 'fre' }),
        audio({ streamIndex: 6, label: 'Anglais (VO) 5.1', language: 'eng' }),
      ],
      defaultAudio: 1,
      subtitles: [],
      bandwidth: 6_192_000,
      width: 1920,
      height: 1080,
    });

    expect(master).toContain(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Français VFF 5.1",LANGUAGE="fr",' +
        'DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6",URI="/api/hls/365/audio-1.m3u8"',
    );
    expect(master).toContain(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Anglais (VO) 5.1",LANGUAGE="en",' +
        'DEFAULT=NO,AUTOSELECT=NO,CHANNELS="6",URI="/api/hls/365/audio-6.m3u8"',
    );
    expect(master).toContain(`AUDIO="${AUDIO_GROUP}"`);
  });

  it('ne marque par défaut QUE la piste retenue', () => {
    const master = buildMasterPlaylist(URLS, {
      audio: [audio({ streamIndex: 1 }), audio({ streamIndex: 2 }), audio({ streamIndex: 3 })],
      defaultAudio: 2,
      subtitles: [],
      bandwidth: 1,
      width: null,
      height: null,
    });

    expect(master.match(/DEFAULT=YES/g)).toHaveLength(1);
  });

  it('déclare les rendus AVANT la variante qui les référence', () => {
    // Un lecteur qui lit EXT-X-STREAM-INF avant les EXT-X-MEDIA ne saurait pas
    // à quoi rattacher les groupes.
    const master = buildMasterPlaylist(URLS, {
      audio: [audio()],
      defaultAudio: 1,
      subtitles: [subtitle()],
      bandwidth: 1,
      width: null,
      height: null,
    });

    expect(master.indexOf('#EXT-X-MEDIA:TYPE=AUDIO')).toBeLessThan(master.indexOf('#EXT-X-STREAM-INF'));
    expect(master.indexOf('#EXT-X-MEDIA:TYPE=SUBTITLES')).toBeLessThan(master.indexOf('#EXT-X-STREAM-INF'));
  });

  it('n’autosélectionne jamais un sous-titre forcé', () => {
    /*
     * FORCED=YES dit la vérité sur la nature de la piste, mais AUTOSELECT=NO
     * empêche le lecteur de l'activer tout seul quand la langue audio ne
     * correspond pas. Un forcé activé d'office laisserait l'écran vide deux
     * heures durant, avec trois lignes au milieu.
     */
    const master = buildMasterPlaylist(URLS, {
      audio: [],
      defaultAudio: null,
      subtitles: [
        subtitle({ streamIndex: 7, label: 'Français (forcés)', kind: 'forced' }),
        subtitle({ streamIndex: 8, label: 'Français', kind: 'full' }),
      ],
      bandwidth: 1,
      width: null,
      height: null,
    });

    expect(master).toContain('NAME="Français (forcés)",LANGUAGE="fr",DEFAULT=NO,AUTOSELECT=NO,FORCED=YES');
    expect(master).toContain('NAME="Français",LANGUAGE="fr",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO');
    expect(master).not.toContain('DEFAULT=YES');
    expect(master).toContain(`SUBTITLES="${SUBTITLE_GROUP}"`);
  });

  it('marque les pistes pour sourds et malentendants', () => {
    const master = buildMasterPlaylist(URLS, {
      audio: [],
      defaultAudio: null,
      subtitles: [subtitle({ kind: 'sdh', label: 'Anglais (sourds et malentendants)' })],
      bandwidth: 1,
      width: null,
      height: null,
    });

    expect(master).toContain('CHARACTERISTICS="public.accessibility.describes-music-and-sound"');
  });

  it('neutralise un guillemet dans un libellé', () => {
    // Les libellés viennent de métadonnées de fichiers : un guillemet droit
    // couperait l'attribut en deux et rendrait la ligne illisible.
    const master = buildMasterPlaylist(URLS, {
      audio: [],
      defaultAudio: null,
      subtitles: [subtitle({ label: 'Anglais — "Na\'vi" only' })],
      bandwidth: 1,
      width: null,
      height: null,
    });

    expect(master).toContain(`NAME="Anglais — 'Na'vi' only"`);
    // Une seule paire de guillemets délimite bien l'attribut.
    const line = master.split('\n').find((entry) => entry.includes('NAME=')) as string;
    expect(line.split('NAME=')[1]?.split(',')[0]).toBe(`"Anglais — 'Na'vi' only"`);
  });

  it('construit le manifeste complet du fichier #365', () => {
    const master = buildMasterPlaylist(URLS, {
      audio: [
        audio({ streamIndex: 1, label: 'Français VFF 5.1', language: 'fre' }),
        audio({ streamIndex: 2, label: 'Russe 5.1 (DTS) — piste 2', language: 'rus' }),
        audio({ streamIndex: 6, label: 'Anglais (VO) 5.1', language: 'eng' }),
      ],
      defaultAudio: 1,
      subtitles: [
        subtitle({ streamIndex: 7, label: 'Français (forcés)', kind: 'forced' }),
        subtitle({ streamIndex: 8, label: 'Français', kind: 'full' }),
        subtitle({ streamIndex: 18, label: 'Anglais (sourds et malentendants)', language: 'eng', kind: 'sdh' }),
      ],
      bandwidth: 6_192_000,
      width: 1920,
      height: 1080,
    });

    const lines = master.trimEnd().split('\n');
    expect(lines.filter((line) => line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'))).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'))).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith('#EXT-X-STREAM-INF'))).toHaveLength(1);
    // Dernière ligne : l'URI de la variante, jamais une directive.
    expect(lines.at(-1)).toBe('/api/hls/365/video.m3u8');
  });
});

// ---------------------------------------------------------------------------

describe('buildSubtitlePlaylist', () => {
  it('déclare UN segment couvrant tout le film', () => {
    // Découper un WebVTT de 40 ko en tranches de huit secondes produirait neuf
    // cents fichiers, et obligerait à recalculer chaque horodatage.
    const playlist = buildSubtitlePlaylist(7200, '/api/hls/365/sub-8.vtt');

    expect(playlist).toContain('#EXT-X-TARGETDURATION:7200');
    expect(playlist).toContain('#EXTINF:7200.000000,\n/api/hls/365/sub-8.vtt');
    expect(playlist.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('n’annonce pas d’EXT-X-MAP', () => {
    // Le WebVTT n'est pas du fMP4 : il n'a pas d'en-tête séparé.
    expect(buildSubtitlePlaylist(120, '/x.vtt')).not.toContain('EXT-X-MAP');
  });

  it('reste valide sur une durée inconnue', () => {
    const playlist = buildSubtitlePlaylist(0, '/x.vtt');
    expect(playlist).toContain('#EXT-X-TARGETDURATION:1');
    expect(playlist).toContain('#EXTINF:0.000000,');
  });
});
