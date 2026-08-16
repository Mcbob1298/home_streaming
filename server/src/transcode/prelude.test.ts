/**
 * Tests du prélude.
 *
 * Ce qui compte ici n'est pas qu'il se pose, c'est qu'il REFUSE de se poser dès
 * que quoi que ce soit a changé. Un prélude encodé avec d'autres paramètres
 * produirait une jonction fausse, et rien dans la lecture ne le signalerait.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bitrateFor, outputGeometry } from './encode.js';
import { planAudioSegments, planSegments } from './segments.js';
import {
  PRELUDE_SECONDS,
  planPrelude,
  preludeDirOf,
  preludeSignature,
  seedFromPrelude,
  usablePrelude,
} from './prelude.js';
import type { SessionInput, SessionOptions } from './session.js';

let racine: string;

beforeEach(() => {
  racine = mkdtempSync(path.join(tmpdir(), 'prelude-'));
});
afterEach(() => {
  rmSync(racine, { recursive: true, force: true });
});

const OPTIONS: SessionOptions = {
  ffmpegBinary: 'ffmpeg',
  workDir: '/tmp/w',
  hardware: 'vaapi',
  device: '/dev/dri/renderD128',
  toneMap: 'tonemap_vaapi',
  onLog: () => undefined,
};

function entree(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    mediaFileId: 365,
    inputPath: '/m/avatar.mkv',
    sizeBytes: 101_176_206_425,
    mtimeMs: 1_700_000_000_000,
    plan: planSegments(10_690),
    mode: 'transcode',
    source: { width: 3840, height: 2160, frameRate: 23.976, hdr: 'hdr10' },
    muxedAudio: { kind: 'none' },
    audioPlan: planAudioSegments(10_690),
    audioRenditions: [
      { streamIndex: 1, channels: 6 },
      { streamIndex: 6, channels: 6 },
    ],
    ...overrides,
  };
}

/** Écrit un prélude complet et valide sur le disque. */
function poser(input: SessionInput, options: SessionOptions = OPTIONS): string {
  const dir = preludeDirOf(racine, input.mediaFileId, input.sizeBytes, input.mtimeMs);
  const plan = planPrelude(input);
  mkdirSync(path.join(dir, 'v'), { recursive: true });
  writeFileSync(path.join(dir, 'v', 'init.mp4'), 'init');
  for (let i = 0; i < plan.videoSegments; i += 1) {
    writeFileSync(path.join(dir, 'v', `seg-${String(i).padStart(5, '0')}.m4s`), `v${i}`);
  }
  for (const s of plan.streams) {
    mkdirSync(path.join(dir, `a-${s}`), { recursive: true });
    writeFileSync(path.join(dir, `a-${s}`, 'init.mp4'), 'init');
    for (let i = 0; i < plan.audioSegments; i += 1) {
      writeFileSync(path.join(dir, `a-${s}`, `seg-${String(i).padStart(5, '0')}.m4s`), `a${i}`);
    }
  }
  writeFileSync(
    path.join(dir, 'prelude.json'),
    JSON.stringify({
      format: 1,
      signature: preludeSignature(input, options),
      videoSegments: plan.videoSegments,
      audioSegments: plan.audioSegments,
      streams: plan.streams,
      builtAt: '2026-08-14T00:00:00.000Z',
      bytes: 1234,
    }),
  );
  return dir;
}

// ---------------------------------------------------------------------------

describe('planPrelude — la grille RÉELLE, pas la durée visée', () => {
  it('s’arrête sur des bornes de segment', () => {
    const plan = planPrelude(entree());
    /*
     * L'amorce puis la croisière : 0,2,4 puis 6,10,14,18,22 — huit segments qui
     * commencent avant 24 s, et le dernier finit à 26. Le prélude va donc un peu
     * PLUS loin que la durée visée, ce qui est le comportement voulu : on prend
     * des segments entiers, jamais une fraction de segment.
     */
    expect(plan.videoSegments).toBe(8);
    expect(plan.videoEnd).toBe(26);
    // Audio : 8 s exactement, donc 0,8,16 → 3 segments jusqu'à 24 s.
    expect(plan.audioSegments).toBe(3);
    expect(plan.audioEnd).toBe(24);
  });

  it('couvre au moins la durée visée', () => {
    const plan = planPrelude(entree());
    expect(plan.videoEnd).toBeGreaterThanOrEqual(PRELUDE_SECONDS);
    expect(plan.audioEnd).toBeGreaterThanOrEqual(PRELUDE_SECONDS);
  });

  it('couvre TOUTES les pistes audio', () => {
    // Le prélude vidéo sans son audio ferait démarrer l'image puis attendre le
    // son : pire que pas de prélude.
    expect(planPrelude(entree()).streams).toEqual([1, 6]);
  });

  it('ne déborde pas d’un fichier plus court que le prélude', () => {
    const court = entree({ plan: planSegments(10), audioPlan: planAudioSegments(10) });
    const plan = planPrelude(court);
    expect(plan.videoEnd).toBeLessThanOrEqual(10);
    expect(plan.audioEnd).toBeLessThanOrEqual(10);
  });
});

describe('preludeSignature — elle change dès que les octets changeraient', () => {
  const base = preludeSignature(entree(), OPTIONS);

  it('est stable à entrée identique', () => {
    expect(preludeSignature(entree(), OPTIONS)).toBe(base);
  });

  it('change si le mode change', () => {
    expect(preludeSignature(entree({ mode: 'remux' }), OPTIONS)).not.toBe(base);
  });

  it('change si le TONE MAPPING change', () => {
    // Avatar passe par tonemap_vaapi : un prélude encodé avec un autre moteur
    // n'aurait pas les mêmes couleurs, et la jonction se verrait à l'écran.
    expect(preludeSignature(entree(), { ...OPTIONS, toneMap: 'libplacebo' })).not.toBe(base);
  });

  it('change si l’accélération change', () => {
    expect(preludeSignature(entree(), { ...OPTIONS, hardware: null })).not.toBe(base);
  });

  it('change si la définition de la source change', () => {
    const autre = entree({ source: { width: 1920, height: 1080, frameRate: 23.976, hdr: 'hdr10' } });
    expect(preludeSignature(autre, OPTIONS)).not.toBe(base);
  });

  it('change si la GRILLE change', () => {
    // Le cas le plus dangereux : mêmes réglages d'encodage, autres bornes.
    const autre = entree({ plan: planSegments(10_690).map((s) => ({ ...s, duration: s.duration + 1 })) });
    expect(preludeSignature(autre, OPTIONS)).not.toBe(base);
  });

  it('SUIT le débit et les dimensions produits, même quand l’entrée ne bouge pas', () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * UN TEST À VALEUR FIGÉE, ET C'EST DÉLIBÉRÉ.
     *
     * Toutes les entrées de `outputGeometry` — dimensions de la source,
     * accélération, mode, transport HDR — sont DÉJÀ des clés de l'empreinte.
     * Aucun jeu d'entrées ne peut donc isoler la géométrie : sa vraie valeur
     * est de réagir aux CONSTANTES — le plafond par défaut, l'échelle de
     * `bitrateFor` — qu'un test ne peut pas faire varier.
     *
     * D'où la valeur figée. Elle échoue dès que les octets produits
     * changeraient — ce qui est exactement le rôle du garde-fou. La faire
     * évoluer est normal ; la faire évoluer SANS régénérer les préludes ne
     * l'est pas, et c'est ce que cet échec vient rappeler.
     * ═══════════════════════════════════════════════════════════════════════
     */
    expect(outputGeometry({
      sourceWidth: 3840,
      sourceHeight: 2160,
      hardware: 'vaapi',
      mode: 'transcode',
      hdrPassthrough: true,
      hdrMaxHeight: 2160,
    })).toEqual({ passthrough: true, width: 3840, height: 2160, bitrate: 12_000_000 });

    // Le débit VIENT de la résolution : ces deux-là ne doivent jamais diverger.
    expect(bitrateFor(2160)).toBe(12_000_000);
  });

  it('change si une piste audio est ajoutée', () => {
    const autre = entree({ audioRenditions: [{ streamIndex: 1, channels: 6 }] });
    expect(preludeSignature(autre, OPTIONS)).not.toBe(base);
  });

  it('ne change PAS pour ce qui ne touche pas aux octets', () => {
    // Le binaire ffmpeg et le périphérique ne changent pas la sortie ; les
    // inclure invaliderait les préludes à chaque mise à jour du conteneur.
    expect(preludeSignature(entree(), { ...OPTIONS, ffmpegBinary: '/autre/ffmpeg' })).toBe(base);
  });
});

describe('usablePrelude — refuser vaut mieux que servir un prélude faux', () => {
  it('accepte un prélude qui correspond', () => {
    const input = entree();
    const dir = poser(input);
    expect(usablePrelude(racine, input, OPTIONS, input.sizeBytes, input.mtimeMs)).toBe(dir);
  });

  it('refuse quand le tone mapping a changé', () => {
    const input = entree();
    poser(input);
    const autre = { ...OPTIONS, toneMap: 'libplacebo' as const };
    expect(usablePrelude(racine, input, autre, input.sizeBytes, input.mtimeMs)).toBeNull();
  });

  it('refuse quand le FICHIER a changé', () => {
    // Réencodé sur place : le répertoire n'est même plus le bon.
    const input = entree();
    poser(input);
    expect(usablePrelude(racine, input, OPTIONS, input.sizeBytes + 1, input.mtimeMs)).toBeNull();
  });

  it('refuse un format inconnu', () => {
    const input = entree();
    const dir = poser(input);
    writeFileSync(path.join(dir, 'prelude.json'), JSON.stringify({ format: 99, signature: 'x' }));
    expect(usablePrelude(racine, input, OPTIONS, input.sizeBytes, input.mtimeMs)).toBeNull();
  });

  it('refuse quand il n’y a rien', () => {
    const input = entree();
    expect(usablePrelude(racine, input, OPTIONS, input.sizeBytes, input.mtimeMs)).toBeNull();
  });
});

describe('seedFromPrelude', () => {
  it('pose les segments et l’en-tête, et rien d’autre', () => {
    const input = entree();
    const dir = path.join(poser(input), 'v');
    const sortie = path.join(racine, 'session', 'v');
    mkdirSync(sortie, { recursive: true });

    // Tous les segments du plan, plus init.mp4. Le prelude.json n'est pas
    // dans « v ». Le compte est DÉDUIT du plan : le figer en dur ferait échouer
    // ce test à chaque changement de grille sans rien dire de `seedFromPrelude`.
    const attendus = planPrelude(input).videoSegments + 1;

    return seedFromPrelude(dir, sortie).then((poses) => {
      expect(poses).toBe(attendus);
    });
  });

  it('ne remplace pas un fichier déjà présent', async () => {
    const input = entree();
    const dir = path.join(poser(input), 'v');
    const sortie = path.join(racine, 'session2', 'v');
    mkdirSync(sortie, { recursive: true });
    writeFileSync(path.join(sortie, 'seg-00000.m4s'), 'deja la');

    // Un de moins que le compte complet : celui qui était déjà là.
    const poses = await seedFromPrelude(dir, sortie);
    expect(poses).toBe(planPrelude(input).videoSegments);
  });

  it('ne casse pas quand le prélude n’existe pas', async () => {
    const sortie = path.join(racine, 'session3');
    mkdirSync(sortie, { recursive: true });
    expect(await seedFromPrelude(path.join(racine, 'absent'), sortie)).toBe(0);
  });
});
