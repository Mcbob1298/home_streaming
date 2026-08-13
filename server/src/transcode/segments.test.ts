import { describe, expect, it } from 'vitest';

import { buildRemuxArgs, planRuns } from './args.js';
import {
  PRIMER_COUNT,
  PRIMER_DURATION,
  PRIMER_END,
  SEGMENT_DURATION,
  buildPlaylist,
  planFromKeyframes,
  planSegments,
  segmentFileName,
  segmentIndexAt,
} from './segments.js';

describe('planSegments', () => {
  it('commence par trois segments de deux secondes', () => {
    const plan = planSegments(60);
    expect(plan.slice(0, PRIMER_COUNT).map((s) => s.duration)).toEqual([2, 2, 2]);
    expect(plan.slice(0, PRIMER_COUNT).map((s) => s.start)).toEqual([0, 2, 4]);
  });

  it('passe ensuite à quatre secondes', () => {
    const plan = planSegments(60);
    expect(plan[3]).toEqual({ index: 3, start: PRIMER_END, duration: SEGMENT_DURATION });
    expect(plan[4]).toEqual({ index: 4, start: 10, duration: 4 });
  });

  it('couvre exactement la durée du fichier', () => {
    for (const duration of [60, 2455.21, 3600, 7325.5]) {
      const plan = planSegments(duration);
      const covered = plan.reduce((sum, segment) => sum + segment.duration, 0);
      expect(covered).toBeCloseTo(duration, 2);
      const last = plan.at(-1) as { start: number; duration: number };
      expect(last.start + last.duration).toBeCloseTo(duration, 2);
    }
  });

  it('tronque le dernier segment', () => {
    // 11 s : trois segments de 2, puis un de 4, puis un de 1.
    const plan = planSegments(11);
    expect(plan.map((s) => s.duration)).toEqual([2, 2, 2, 4, 1]);
  });

  it('gère un fichier plus court que l’amorce', () => {
    expect(planSegments(3).map((s) => s.duration)).toEqual([2, 1]);
    expect(planSegments(1.5).map((s) => s.duration)).toEqual([1.5]);
  });

  it('rend un plan vide sur une durée inconnue', () => {
    // La durée vient de ffprobe : un fichier non sondé n'en a pas.
    expect(planSegments(0)).toEqual([]);
    expect(planSegments(Number.NaN)).toEqual([]);
    expect(planSegments(-10)).toEqual([]);
  });

  it('numérote sans trou', () => {
    const plan = planSegments(2455.21);
    expect(plan.map((s) => s.index)).toEqual(plan.map((_, index) => index));
  });
});

describe('segmentIndexAt', () => {
  const plan = planSegments(2455.21); // un épisode de Gossip Girl

  it('trouve le segment contenant une position', () => {
    expect(segmentIndexAt(plan, 0)).toBe(0);
    expect(segmentIndexAt(plan, 1.9)).toBe(0);
    expect(segmentIndexAt(plan, 2)).toBe(1);
    expect(segmentIndexAt(plan, 6)).toBe(3);
    expect(segmentIndexAt(plan, 9.999)).toBe(3);
    expect(segmentIndexAt(plan, 10)).toBe(4);
  });

  it('trouve le bon segment loin dans le film', () => {
    // 40 minutes = 2400 s → (2400 − 6) / 4 + 3 = 601,5 → segment 601.
    const index = segmentIndexAt(plan, 2400);
    const segment = plan[index] as { start: number; duration: number };
    expect(segment.start).toBeLessThanOrEqual(2400);
    expect(segment.start + segment.duration).toBeGreaterThan(2400);
  });

  it('borne aux extrémités', () => {
    expect(segmentIndexAt(plan, -50)).toBe(0);
    expect(segmentIndexAt(plan, 999_999)).toBe(plan.length - 1);
  });

  it('rend zéro sur un plan vide', () => {
    expect(segmentIndexAt([], 42)).toBe(0);
  });
});

describe('buildPlaylist', () => {
  const plan = planSegments(30);
  const urls = { init: 'init.mp4', segment: (index: number) => segmentFileName(index) };
  const playlist = buildPlaylist(plan, urls);

  it('déclare une version compatible fMP4', () => {
    // EXT-X-MAP exige la version 7.
    expect(playlist).toContain('#EXT-X-VERSION:7');
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
  });

  it('est un manifeste VOD complet, avec sa fin', () => {
    // C'est ce qui autorise le lecteur à viser une position non encore produite.
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('annonce une durée cible au moins égale au plus long segment', () => {
    expect(playlist).toContain('#EXT-X-TARGETDURATION:4');
  });

  it('liste tous les segments avec leur durée', () => {
    const extinf = playlist.split('\n').filter((line) => line.startsWith('#EXTINF'));
    expect(extinf).toHaveLength(plan.length);
    expect(extinf[0]).toBe('#EXTINF:2.000000,');
    expect(extinf[3]).toBe('#EXTINF:4.000000,');
    expect(playlist).toContain('seg-00000.m4s');
    expect(playlist).toContain(segmentFileName(plan.length - 1));
  });

  it('déclare les segments indépendants', () => {
    expect(playlist).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
  });
});

describe('segmentFileName', () => {
  it('garde l’ordre alphabétique', () => {
    expect(segmentFileName(0)).toBe('seg-00000.m4s');
    expect(segmentFileName(42)).toBe('seg-00042.m4s');
    expect([segmentFileName(9), segmentFileName(10)].sort()).toEqual(['seg-00009.m4s', 'seg-00010.m4s']);
  });
});

describe('planRuns', () => {
  const plan = planSegments(2455.21);
  const runs = (index: number, from = plan) =>
    planRuns(index, from, PRIMER_COUNT, SEGMENT_DURATION, PRIMER_DURATION);

  it('enchaîne deux exécutions au départ du fichier', () => {
    // Une seule exécution ffmpeg ne change pas de durée de segment en route.
    const chain = runs(0);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toEqual({ startTime: 0, startNumber: 0, segmentDuration: 2, endTime: PRIMER_END });
    expect(chain[1]).toEqual({ startTime: PRIMER_END, startNumber: 3, segmentDuration: 4, endTime: null });
  });

  it('n’en fait qu’une au-delà de l’amorce', () => {
    const chain = runs(600);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.segmentDuration).toBe(4);
    expect(chain[0]?.startNumber).toBe(600);
    expect(chain[0]?.startTime).toBe((plan[600] as { start: number }).start);
  });

  /**
   * Le bogue qui a coûté trente secondes d'attente par segment : la borne de
   * la seconde exécution était une constante, pas une valeur lue dans le plan.
   * Sur un fichier dont les images clés sont espacées de dix secondes, l'amorce
   * ne produit qu'UN segment, et les numéros 1 et 2 n'arrivaient jamais.
   */
  it('reprend la seconde exécution là où le plan coupe vraiment', () => {
    // Plan issu d'images clés espacées de 10 s : l'amorce ne fait qu'un segment
    // de 10 s, et la croisière doit donc démarrer au segment 3 à t = 30 s.
    const irregulier = planFromKeyframes([0, 10, 20, 30, 40, 50], 60, {
      target: SEGMENT_DURATION,
      primerCount: PRIMER_COUNT,
      primerTarget: PRIMER_DURATION,
    });
    expect(irregulier.map((s) => s.start)).toEqual([0, 10, 20, 30, 40, 50]);

    const chain = runs(0, irregulier);
    expect(chain[0]?.endTime).toBe(30);
    expect(chain[1]).toEqual({ startTime: 30, startNumber: 3, segmentDuration: 4, endTime: null });
  });

  it('ne prévoit pas de suite sur un fichier plus court que l’amorce', () => {
    const court = planSegments(4);
    expect(runs(0, court)).toHaveLength(1);
    expect(runs(0, court)[0]?.endTime).toBeNull();
  });

  it('rend une chaîne vide sur un index hors plan', () => {
    expect(runs(99_999)).toEqual([]);
  });
});

describe('buildRemuxArgs', () => {
  const base = {
    input: 'D:\\Films\\a.mkv',
    startTime: 0,
    startNumber: 0,
    segmentDuration: 2,
    endTime: PRIMER_END,
    outputDir: 'D:\\work\\sess',
    audio: { kind: 'auto', channels: 6 } as const,
  };

  it('COPIE la vidéo — jamais de réencodage sur du H.264', () => {
    const args = buildRemuxArgs(base);
    const index = args.indexOf('-c:v');
    expect(args[index + 1]).toBe('copy');
    expect(args).not.toContain('libx264');
  });

  it('réencode l’audio en AAC stéréo', () => {
    const args = buildRemuxArgs(base);
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-ac') + 1]).toBe('2');
  });

  it('produit des segments fMP4', () => {
    const args = buildRemuxArgs(base);
    expect(args[args.indexOf('-hls_segment_type') + 1]).toBe('fmp4');
    expect(args[args.indexOf('-f') + 1]).toBe('hls');
  });

  it('place -ss AVANT -i, pour un déplacement rapide', () => {
    const args = buildRemuxArgs({ ...base, startTime: 2400 });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('2400.000');
  });

  it('n’ajoute pas de déplacement au départ du fichier', () => {
    expect(buildRemuxArgs(base)).not.toContain('-ss');
    expect(buildRemuxArgs(base)).not.toContain('-output_ts_offset');
  });

  it('décale les horodatages de sortie sur la position réelle', () => {
    // Sans cela, une relance à 40 minutes produirait des segments horodatés à
    // zéro et le lecteur croirait être revenu au début.
    const args = buildRemuxArgs({ ...base, startTime: 2400, startNumber: 601 });
    expect(args[args.indexOf('-output_ts_offset') + 1]).toBe('2400.000');
  });

  it('numérote les segments à partir de l’index demandé', () => {
    const args = buildRemuxArgs({ ...base, startNumber: 601 });
    expect(args[args.indexOf('-start_number') + 1]).toBe('601');
  });

  it('borne l’exécution d’amorce', () => {
    const args = buildRemuxArgs({ ...base, startTime: 0, endTime: 6 });
    expect(args[args.indexOf('-t') + 1]).toBe('6.000');
  });

  it('ne borne pas l’exécution de croisière', () => {
    expect(buildRemuxArgs({ ...base, endTime: null })).not.toContain('-t');
  });

  it('écrit les segments sous un nom temporaire', () => {
    // C'est ce qui garantit qu'un segment visible est un segment complet.
    expect(buildRemuxArgs(base)[buildRemuxArgs(base).indexOf('-hls_flags') + 1]).toContain('temp_file');
  });

  it('sélectionne une piste audio par son index ABSOLU', () => {
    expect(buildRemuxArgs({ ...base, audio: { kind: 'stream', streamIndex: 2, channels: 6 } })).toContain('0:2');
  });

  it('écarte explicitement sous-titres, données et chapitres', () => {
    // Le fichier #365 porte deux polices TrueType sur lesquelles ffmpeg échoue,
    // et deux couvertures MJPEG qu'il prendrait pour des flux vidéo.
    const args = buildRemuxArgs(base);
    expect(args).toContain('-sn');
    expect(args).toContain('-dn');
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
  });

  it('ne produit AUCUN son quand l’audio est rendu à part', () => {
    const args = buildRemuxArgs({ ...base, audio: { kind: 'none' } });
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
  });

  it('borne l’analyse du fichier d’entrée', () => {
    // Sans bornes, ffmpeg lit cinq secondes de contenu avant de se prononcer :
    // mesuré à 772 ms de démarrage contre 256 ms avec.
    const args = buildRemuxArgs(base);
    expect(args.indexOf('-probesize')).toBeLessThan(args.indexOf('-i'));
    expect(args.indexOf('-analyzeduration')).toBeLessThan(args.indexOf('-i'));
  });
});
