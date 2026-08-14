/**
 * Tests du magasin de pistes audio pré-générées.
 *
 * Ce qui compte : REFUSER de servir un jeu qui ne correspond plus. Servir la
 * moitié d'un jeu ferait retomber l'autre moitié sur la session — donc sur le
 * chemin fragile qu'on cherche précisément à supprimer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { audioDirOf, audioSignature, staticInit, staticSegment, usableAudio } from './audioStore.js';
import { planAudioSegments } from './segments.js';

let racine: string;
const PLAN = planAudioSegments(600);
const PISTES = [
  { streamIndex: 1, channels: 6 },
  { streamIndex: 6, channels: 6 },
];

beforeEach(() => {
  racine = mkdtempSync(path.join(tmpdir(), 'audio-'));
});
afterEach(() => {
  rmSync(racine, { recursive: true, force: true });
});

function poser(pistes = PISTES, plan = PLAN, streams = pistes.map((p) => p.streamIndex)): string {
  const dir = audioDirOf(racine, 365, 1000, 2000);
  for (const s of streams) {
    mkdirSync(path.join(dir, `a-${s}`), { recursive: true });
    writeFileSync(path.join(dir, `a-${s}`, 'init.mp4'), 'i');
    for (let i = 0; i < plan.length; i += 1) {
      writeFileSync(path.join(dir, `a-${s}`, `seg-${String(i).padStart(5, '0')}.m4s`), `s${i}`);
    }
  }
  writeFileSync(
    path.join(dir, 'audio.json'),
    JSON.stringify({
      format: 1,
      signature: audioSignature(plan, pistes),
      streams,
      segments: plan.length,
      builtAt: '2026-08-14T00:00:00.000Z',
      bytes: 1,
    }),
  );
  return dir;
}

describe('usableAudio', () => {
  it('accepte un jeu complet et correspondant', () => {
    const dir = poser();
    expect(usableAudio(racine, 365, 1000, 2000, PLAN, PISTES)).toBe(dir);
  });

  it('refuse quand une piste MANQUE', () => {
    // Servir la piste 1 en statique et la 6 par session remettrait la seconde
    // sur le chemin fragile, sans que rien ne le signale.
    poser(PISTES, PLAN, [1]);
    expect(usableAudio(racine, 365, 1000, 2000, PLAN, PISTES)).toBeNull();
  });

  it('refuse quand le nombre de canaux a changé', () => {
    // Le downmix en dépend : 5.1 et stéréo ne produisent pas les mêmes octets.
    poser();
    const autres = [
      { streamIndex: 1, channels: 2 },
      { streamIndex: 6, channels: 6 },
    ];
    expect(usableAudio(racine, 365, 1000, 2000, PLAN, autres)).toBeNull();
  });

  it('refuse quand la GRILLE a changé', () => {
    poser();
    expect(usableAudio(racine, 365, 1000, 2000, planAudioSegments(900), PISTES)).toBeNull();
  });

  it('refuse quand le fichier a changé', () => {
    poser();
    expect(usableAudio(racine, 365, 1001, 2000, PLAN, PISTES)).toBeNull();
  });

  it('refuse quand il n’y a aucune piste séparée', () => {
    // Fichier monopiste ou audio muxé : rien à pré-générer, et rien à servir.
    poser();
    expect(usableAudio(racine, 365, 1000, 2000, PLAN, [])).toBeNull();
  });

  it('refuse un format inconnu', () => {
    const dir = poser();
    writeFileSync(path.join(dir, 'audio.json'), JSON.stringify({ format: 99, signature: 'x', streams: [1, 6] }));
    expect(usableAudio(racine, 365, 1000, 2000, PLAN, PISTES)).toBeNull();
  });
});

describe('staticSegment / staticInit', () => {
  it('rendent le fichier quand il est là', () => {
    const dir = poser();
    expect(staticInit(dir, 1)).toContain('a-1');
    expect(staticSegment(dir, 6, 2)).toContain('seg-00002.m4s');
  });

  it('rendent null au-delà de ce qui existe', () => {
    const dir = poser();
    expect(staticSegment(dir, 1, 99_999)).toBeNull();
    expect(staticInit(dir, 42)).toBeNull();
  });
});
