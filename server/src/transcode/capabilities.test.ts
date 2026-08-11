import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RENDER_NODE,
  describeCapabilities,
  parseEncoders,
  probeArgs,
  summarizeFailure,
  type EncoderProbe,
  type FfmpegCapabilities,
} from './capabilities.js';

describe('parseEncoders', () => {
  const output = [
    'Encoders:',
    ' V..... = Video',
    ' ------',
    ' V..... h264_qsv             H.264 (Intel Quick Sync Video acceleration) (codec h264)',
    ' V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)',
    ' V....D libx264              libx264 H.264 / AVC',
    ' A....D aac                  AAC (Advanced Audio Coding)',
  ].join('\n');

  it('relève les noms d’encodeurs', () => {
    const encoders = parseEncoders(output);
    expect(encoders.has('h264_qsv')).toBe(true);
    expect(encoders.has('h264_vaapi')).toBe(true);
    expect(encoders.has('libx264')).toBe(true);
    expect(encoders.has('aac')).toBe(true);
  });

  it('écarte la ligne de séparation', () => {
    expect(parseEncoders(output).has('------')).toBe(false);
    expect(parseEncoders(output).has('=')).toBe(false);
  });

  it('accepte une sortie vide', () => {
    expect(parseEncoders('').size).toBe(0);
  });
});

describe('probeArgs', () => {
  const device = DEFAULT_RENDER_NODE;

  it('ouvre le périphérique pour QSV', () => {
    const args = probeArgs('qsv', device);
    expect(args).toContain('-init_hw_device');
    expect(args).toContain(`qsv=hw:${device}`);
    expect(args[args.indexOf('-c:v') + 1]).toBe('h264_qsv');
  });

  it('ouvre le périphérique pour VAAPI', () => {
    const args = probeArgs('vaapi', device);
    expect(args[args.indexOf('-vaapi_device') + 1]).toBe(device);
    expect(args[args.indexOf('-c:v') + 1]).toBe('h264_vaapi');
    // hwupload est indispensable : sans lui l'image reste en mémoire centrale
    // et l'encodeur matériel n'a rien à encoder.
    expect(args.join(' ')).toContain('hwupload');
  });

  it('n’a besoin d’aucun périphérique en logiciel', () => {
    const args = probeArgs('software', device);
    expect(args).not.toContain('-vaapi_device');
    expect(args).not.toContain('-init_hw_device');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
  });

  it('encode une mire, et n’écrit nulle part', () => {
    for (const name of ['qsv', 'vaapi', 'software'] as const) {
      const args = probeArgs(name, device);
      expect(args.join(' ')).toContain('lavfi');
      expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    }
  });
});

describe('summarizeFailure', () => {
  it('retient la ligne qui dit quelque chose', () => {
    // Le cas réel de ce NAS : ffmpeg empile des messages génériques après la
    // vraie cause.
    const stderr = [
      '[AVHWDeviceContext @ 0x5] Error initializing an internal MFX session: unsupported (-3)',
      'Device creation failed: -1313558101.',
      'Failed to set value for option init_hw_device',
    ].join('\n');
    expect(summarizeFailure(stderr)).toContain('MFX session');
  });

  it('retient la première ligne à défaut de mieux', () => {
    expect(summarizeFailure('quelque chose est arrivé\nsuite')).toBe('quelque chose est arrivé');
  });

  it('borne la longueur', () => {
    expect(summarizeFailure(`Error ${'x'.repeat(500)}`).length).toBeLessThanOrEqual(180);
  });

  it('ne rend jamais une chaîne vide', () => {
    expect(summarizeFailure('')).toBe('échec sans message');
    expect(summarizeFailure('\n\n  \n')).toBe('échec sans message');
  });
});

function capabilities(overrides: Partial<FfmpegCapabilities> = {}): FfmpegCapabilities {
  return {
    binary: 'ffmpeg',
    version: 'ffmpeg version 5.1.9',
    encoders: new Set(['h264_qsv', 'h264_vaapi', 'libx264', 'aac']),
    hardware: 'vaapi',
    device: DEFAULT_RENDER_NODE,
    probes: [],
    cached: false,
    ...overrides,
  };
}

const QSV_FAILED: EncoderProbe = {
  name: 'qsv',
  encoder: 'h264_qsv',
  ok: false,
  error: 'Error initializing an internal MFX session: unsupported (-3)',
  ms: 240,
};
const VAAPI_OK: EncoderProbe = { name: 'vaapi', encoder: 'h264_vaapi', ok: true, error: null, ms: 310 };

describe('describeCapabilities', () => {
  it('annonce ce qui a été retenu', () => {
    const lines = describeCapabilities(capabilities({ probes: [QSV_FAILED, VAAPI_OK] })).join('\n');
    expect(lines).toContain('VAAPI');
    expect(lines).toContain('h264_vaapi');
  });

  it('dit pourquoi les autres ont été écartés', () => {
    const lines = describeCapabilities(capabilities({ probes: [QSV_FAILED, VAAPI_OK] })).join('\n');
    expect(lines).toContain('Candidats écartés');
    expect(lines).toContain('MFX session');
  });

  /**
   * Le cœur du problème : « h264_qsv » est bien compilé dans ffmpeg 5.1, et
   * pourtant il ne s'initialise pas sur cet Alder Lake. Le journal doit le
   * dire, sinon la panne reste invisible.
   */
  it('signale un encodeur annoncé mais inopérant', () => {
    const lines = describeCapabilities(capabilities({ probes: [QSV_FAILED, VAAPI_OK] })).join('\n');
    expect(lines).toContain('pas ce qui fonctionne');
    expect(lines).toContain('h264_qsv');
  });

  it('est explicite quand tout échoue', () => {
    const lines = describeCapabilities(
      capabilities({ hardware: null, probes: [QSV_FAILED, { ...VAAPI_OK, ok: false, error: 'pas de display' }] }),
    ).join('\n');
    expect(lines).toContain('Aucune accélération matérielle utilisable');
    expect(lines).toContain('logiciel');
  });

  it('distingue une décision issue du cache', () => {
    const fresh = describeCapabilities(capabilities({ probes: [VAAPI_OK] })).join('\n');
    const cached = describeCapabilities(capabilities({ probes: [VAAPI_OK], cached: true })).join('\n');
    expect(fresh).toContain('après essai réel');
    expect(cached).toContain('depuis le cache');
  });

  it('signale l’absence de périphérique de rendu', () => {
    const lines = describeCapabilities(capabilities({ device: null, hardware: null })).join('\n');
    expect(lines).toContain('Aucun périphérique de rendu');
  });

  it('signale l’absence d’encodeur AAC', () => {
    const lines = describeCapabilities(capabilities({ encoders: new Set(['libx264']) })).join('\n');
    expect(lines).toContain('AAC absent');
  });
});
