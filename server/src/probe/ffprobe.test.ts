/**
 * Tests de l'interprétation de la sortie ffprobe.
 * Pure : on donne du JSON, on vérifie l'objet. Aucun fichier vidéo requis.
 */
import { describe, expect, it } from 'vitest';

import { parseFfprobeOutput } from './ffprobe.js';

function output(streams: unknown[], format: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: { format_name: 'matroska,webm', duration: '5400.0', bit_rate: '8000000', ...format },
    streams,
  });
}

const H264 = { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 };

describe('parseFfprobeOutput', () => {
  it('lit conteneur, codecs, définition, durée et débit', () => {
    const result = parseFfprobeOutput(
      output([H264, { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 6 }]),
    );

    expect(result).toMatchObject({
      container: 'matroska',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      durationSeconds: 5400,
      bitrate: 8_000_000,
      hdr: null,
    });
  });

  it('ignore l’affiche intégrée et garde la vraie piste vidéo', () => {
    const result = parseFfprobeOutput(
      output([
        { index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 900, disposition: { attached_pic: 1 } },
        { ...H264, index: 1 },
      ]),
    );

    expect(result).toMatchObject({ videoCodec: 'h264', width: 1920 });
  });

  it('prend le codec audio de la piste marquée par défaut', () => {
    const result = parseFfprobeOutput(
      output([
        H264,
        { index: 1, codec_type: 'audio', codec_name: 'dts', channels: 6 },
        { index: 2, codec_type: 'audio', codec_name: 'aac', channels: 2, disposition: { default: 1 } },
      ]),
    );

    expect(result.audioCodec).toBe('aac');
    expect(result.audioTracks).toHaveLength(2);
  });

  it('lit langue, titre et nombre de canaux des pistes audio', () => {
    const result = parseFfprobeOutput(
      output([
        H264,
        {
          index: 1,
          codec_type: 'audio',
          codec_name: 'ac3',
          channels: 6,
          tags: { language: 'fre', title: 'VFF' },
          disposition: { default: 1 },
        },
      ]),
    );

    expect(result.audioTracks[0]).toEqual({
      streamIndex: 1,
      codec: 'ac3',
      channels: 6,
      language: 'fre',
      title: 'VFF',
      isDefault: true,
    });
  });

  it('accepte des clés de tags en casse variable', () => {
    const result = parseFfprobeOutput(
      output([H264, { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { LANGUAGE: 'eng' } }]),
    );

    expect(result.audioTracks[0]?.language).toBe('eng');
  });
});

describe('sous-titres embarqués', () => {
  it('distingue les sous-titres texte des sous-titres image', () => {
    const result = parseFfprobeOutput(
      output([
        H264,
        { index: 1, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'fre' } },
        { index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
        { index: 3, codec_type: 'subtitle', codec_name: 'dvd_subtitle' },
        { index: 4, codec_type: 'subtitle', codec_name: 'ass' },
      ]),
    );

    expect(result.subtitles.map((s) => [s.codec, s.isImageBased])).toEqual([
      ['subrip', false],
      ['hdmv_pgs_subtitle', true],
      ['dvd_subtitle', true],
      ['ass', false],
    ]);
  });

  it('lit les mentions « forcé » et « par défaut »', () => {
    const result = parseFfprobeOutput(
      output([
        H264,
        {
          index: 1,
          codec_type: 'subtitle',
          codec_name: 'subrip',
          disposition: { forced: 1, default: 1 },
          tags: { language: 'fre', title: 'Forcés' },
        },
      ]),
    );

    expect(result.subtitles[0]).toMatchObject({ isForced: true, isDefault: true, title: 'Forcés' });
  });
});

describe('détection HDR', () => {
  it('reconnaît HDR10 à la courbe PQ', () => {
    expect(parseFfprobeOutput(output([{ ...H264, color_transfer: 'smpte2084' }])).hdr).toBe('HDR10');
  });

  it('reconnaît HLG', () => {
    expect(parseFfprobeOutput(output([{ ...H264, color_transfer: 'arib-std-b67' }])).hdr).toBe('HLG');
  });

  it('reconnaît Dolby Vision, même si le fichier est aussi marqué PQ', () => {
    const result = parseFfprobeOutput(
      output([
        {
          ...H264,
          color_transfer: 'smpte2084',
          side_data_list: [{ side_data_type: 'DOVI configuration record' }],
        },
      ]),
    );
    expect(result.hdr).toBe('Dolby Vision');
  });

  it('reconnaît HDR10+ à ses métadonnées dynamiques', () => {
    const result = parseFfprobeOutput(
      output([
        { ...H264, side_data_list: [{ side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }] },
      ]),
    );
    expect(result.hdr).toBe('HDR10+');
  });

  it('rend null pour un fichier SDR', () => {
    expect(parseFfprobeOutput(output([{ ...H264, color_transfer: 'bt709' }])).hdr).toBeNull();
  });
});

describe('cas limites', () => {
  it('ne casse pas sur un fichier sans piste vidéo', () => {
    const result = parseFfprobeOutput(output([{ index: 0, codec_type: 'audio', codec_name: 'aac' }]));
    expect(result).toMatchObject({ videoCodec: null, width: null, height: null, hdr: null });
  });

  it('garde le premier nom de conteneur quand ffprobe en liste plusieurs', () => {
    const result = parseFfprobeOutput(output([H264], { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }));
    expect(result.container).toBe('mov');
  });

  it('se rabat sur la durée de la piste vidéo si le conteneur ne la donne pas', () => {
    const result = parseFfprobeOutput(
      output([{ ...H264, duration: '1200.5' }], { duration: undefined }),
    );
    expect(result.durationSeconds).toBe(1200.5);
  });
});
