/**
 * LA SIMULATION N'ÉCRIT RIEN — sur un fichier qui n'a PAS déjà son prélude.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LE CAS D'AVATAR NE PROUVAIT RIEN, ET C'EST TOUT LE SUJET.
 *
 * `npm run prelude -- --file 365 --dry` répondait « Déjà valable » et ne créait
 * aucun fichier. On aurait pu conclure que `--dry` fonctionnait. Faux : le
 * prélude d'Avatar étant valide, `fabriquerPrelude` sortait AVANT d'atteindre la
 * question de la simulation. Le drapeau n'était jamais lu.
 *
 * Le cas qui tranche est donc un fichier SANS prélude valable — celui où la
 * fonction doit choisir entre simuler et encoder. Soixante-neuf des soixante-dix
 * fichiers HDR10 sont dans ce cas, et `--dry` y aurait produit vingt secondes
 * d'encodage chacun.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planAudioSegments, planSegments } from './segments.js';

/*
 * `resolvePlayback` interroge la base et sonde le fichier avec ffprobe : ni
 * l'une ni l'autre n'existent dans un test unitaire. On lui substitue une
 * réponse fixe, celle d'un 4K HDR10 en transcodage — le cas du transport HDR.
 */
vi.mock('../playback/resolve.js', () => ({
  findMedia: (_db: unknown, id: number) => ({
    id,
    path: `/m/film-${id}.mkv`,
    rawPath: null,
    sizeBytes: 42_000,
    mtimeMs: 1_700_000_000_000,
    bitrate: 60_000_000,
  }),
  resolvePlayback: () =>
    Promise.resolve({
      decision: { mode: 'transcode' as const },
      plan: planSegments(600),
      source: { width: 3840, height: 2160, frameRate: 23.976, hdr: 'HDR10' as const },
      muxedAudio: { kind: 'none' as const },
      audioPlan: planAudioSegments(600),
      audioRenditions: [{ streamIndex: 1, channels: 6 }],
    }),
}));

const { fabriquerPrelude, lireIntention } = await import('./fabriquePrelude.js');

let racine: string;

beforeEach(() => {
  racine = mkdtempSync(path.join(tmpdir(), 'prelude-dry-'));
});
afterEach(() => {
  rmSync(racine, { recursive: true, force: true });
});

/** Ce que la commande passerait à la fabrique, capacités matérielles comprises. */
function options(overrides: Record<string, unknown> = {}) {
  return {
    db: {} as never,
    id: 12,
    config: { transcode: { hdrMaxHeight: 2160 } } as never,
    capabilities: { binary: '/bin/false', device: '/dev/dri/renderD128', toneMap: null } as never,
    backend: { backend: 'vaapi' as const, unsupported: null } as never,
    preludeRoot: racine,
    pourClientSdr: false,
    ...overrides,
  };
}

describe('lireIntention — le drapeau doit exister AVANT d’être transporté', () => {
  it('reconnaît --dry', () => {
    expect(lireIntention(['--file', '12', '--dry']).simulation).toBe(true);
  });

  it('ne simule PAS sans le drapeau', () => {
    expect(lireIntention(['--file', '12']).simulation).toBe(false);
  });

  it('lit les trois intentions ensemble', () => {
    expect(lireIntention(['--file', '365', '--sdr', '--dry'])).toEqual({
      fileId: 365,
      pourClientSdr: true,
      simulation: true,
    });
  });
});

describe('fabriquerPrelude en simulation', () => {
  it('N’ÉCRIT RIEN sur un fichier sans prélude valable', async () => {
    const avant = readdirSync(racine);
    expect(avant).toEqual([]);

    const resultat = await fabriquerPrelude(options({ simulation: true }));

    expect(resultat.etat).toBe('simule');
    // Ni répertoire de travail, ni staging, ni prélude publié.
    expect(readdirSync(racine)).toEqual([]);
  });

  /*
   * Le garde-fou du garde-fou : si un jour la fabrique sortait « déjà valable »
   * sur ce montage, le test ci-dessus ne prouverait plus rien — c'est
   * exactement ce qui rendait le cas d'Avatar trompeur.
   */
  it('atteint bien la question de la simulation, et ne sort pas avant', async () => {
    const resultat = await fabriquerPrelude(options({ simulation: true }));
    expect(resultat.etat).not.toBe('deja-valable');
  });
});
