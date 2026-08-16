import { describe, expect, it } from 'vitest';

import { buildRemuxArgs, planRuns } from './args.js';
import {
  PRIMER_COUNT,
  PRIMER_DURATION,
  PRIMER_END,
  AUDIO_SEGMENT_DURATION,
  SEGMENT_DURATION,
  buildPlaylist,
  planAudioSegments,
  planFromKeyframes,
  planSegments,
  primerSegments,
  segmentFileName,
  segmentIndexAt,
} from './segments.js';

describe('planSegments', () => {
  it('ouvre sur l’amorce courte, puis passe à la croisière', () => {
    /*
     * L'amorce divise par deux le poids du premier segment, donc son temps de
     * transport — 870 ms sur un segment 4K de quatre secondes. Elle avait été
     * retirée parce que ses deux exécutions écrivaient deux en-têtes fMP4
     * différents ; la cause en était `-output_ts_offset`, supprimé depuis, et
     * les en-têtes ont été revérifiés identiques octet à octet.
     */
    const plan = planSegments(60);
    expect(plan.slice(0, 5).map((s) => s.duration)).toEqual([2, 2, 2, 4, 4]);
    expect(plan.slice(0, 5).map((s) => s.start)).toEqual([0, 2, 4, 6, 10]);
    expect(plan[3]).toEqual({ index: 3, start: PRIMER_END, duration: SEGMENT_DURATION });
  });

  it('fait tomber la frontière sur une borne du plan', () => {
    /*
     * L'amorce se divise en segments entiers, et la croisière reprend EXACTEMENT
     * là où elle s'arrête. Noter que 6 n'est PAS un multiple de 4 : la croisière
     * ne reprend pas une grille 0-4-8, elle compte depuis la frontière. Il n'y a
     * qu'une grille, celle du plan, donc rien à faire coïncider.
     */
    expect(PRIMER_END % PRIMER_DURATION).toBe(0);

    const plan = planSegments(60);
    expect(plan[PRIMER_COUNT - 1]!.start + plan[PRIMER_COUNT - 1]!.duration).toBe(PRIMER_END);
    expect(plan[PRIMER_COUNT]?.start).toBe(PRIMER_END);
    expect(plan.slice(3, 6).map((s) => s.start)).toEqual([6, 10, 14]);
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
    // 11 s : l'amorce (3 × 2), un segment de 4, puis le reste.
    expect(planSegments(11).map((s) => s.duration)).toEqual([2, 2, 2, 4, 1]);
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
    // L'amorce d'abord : 0-2, 2-4, 4-6. Puis la croisière : 6-10, 10-14, 14-18.
    expect(segmentIndexAt(plan, 0)).toBe(0);
    expect(segmentIndexAt(plan, 3.9)).toBe(1);
    expect(segmentIndexAt(plan, 4)).toBe(2);
    expect(segmentIndexAt(plan, 6)).toBe(3);
    expect(segmentIndexAt(plan, 12)).toBe(4);
    expect(segmentIndexAt(plan, 15.999)).toBe(5);
    expect(segmentIndexAt(plan, 18)).toBe(6);
  });

  it('trouve le bon segment loin dans le film', () => {
    // 40 minutes = 2400 s → 2400 / 4 = 600.
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
    // Les trois premiers portent l'amorce, le quatrième la croisière.
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
  const runs = (index: number, from = plan) => planRuns(index, from, SEGMENT_DURATION);

  it('enchaîne l’amorce puis la croisière au départ du fichier', () => {
    const chain = runs(0);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toEqual({
      startTime: 0,
      startNumber: 0,
      segmentDuration: PRIMER_DURATION,
      endTime: PRIMER_END,
    });
    expect(chain[1]).toEqual({
      startTime: PRIMER_END,
      startNumber: PRIMER_COUNT,
      segmentDuration: SEGMENT_DURATION,
      endTime: null,
    });
  });

  it('rend la main À la frontière, jamais au milieu d’un segment', () => {
    /*
     * `endTime` de l'amorce et `startTime` de la croisière doivent coïncider
     * avec une borne du plan. Un écart d'une image ici produirait un trou ou un
     * recouvrement, et c'est précisément ce que le lecteur ne pardonne pas.
     */
    const chain = runs(0);
    expect(chain[0]?.endTime).toBe(chain[1]?.startTime);
    expect(plan[PRIMER_COUNT]?.start).toBe(chain[1]?.startTime);
  });

  it('démarre au MILIEU de l’amorce sans perdre la croisière', () => {
    // Une reprise à 3 s tombe dans l'amorce : il faut encore les deux exécutions.
    const chain = runs(1);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({ startNumber: 1, segmentDuration: PRIMER_DURATION, endTime: PRIMER_END });
    expect(chain[1]).toMatchObject({ startNumber: PRIMER_COUNT, segmentDuration: SEGMENT_DURATION });
  });

  it('rend UNE exécution au-delà de l’amorce', () => {
    /*
     * C'EST LE CAS DE LOIN LE PLUS FRÉQUENT — tout déplacement y tombe. Une
     * seconde exécution ici ne servirait à rien et doublerait les processus.
     */
    for (const index of [PRIMER_COUNT, 300, 600]) {
      const chain = runs(index);
      expect(chain).toHaveLength(1);
      expect(chain[0]?.segmentDuration).toBe(SEGMENT_DURATION);
      expect(chain[0]?.startNumber).toBe(index);
      expect(chain[0]?.endTime).toBeNull();
    }
  });

  it('suit un plan irrégulier issu des images clés', () => {
    // Images clés espacées de 10 s : les segments en font dix, pas quatre.
    const irregulier = planFromKeyframes([0, 10, 20, 30, 40, 50], 60, { target: SEGMENT_DURATION });
    expect(irregulier.map((s) => s.start)).toEqual([0, 10, 20, 30, 40, 50]);

    // Aucun segment n'est plus court que la croisière : rien à enchaîner.
    const chain = runs(0, irregulier);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toEqual({ startTime: 0, startNumber: 0, segmentDuration: 4, endTime: null });
  });

  it('ne découpe PAS le plan audio, qui est uniforme', () => {
    /*
     * La découpe se lit dans le plan, pas dans une constante d'amorce : l'audio
     * l'obtient donc sans qu'on ait à le distinguer. Une seconde définition de
     * l'amorce ici finirait par diverger de celle de `segments.ts`.
     */
    const audio = planAudioSegments(2455.21);
    const chain = planRuns(0, audio, AUDIO_SEGMENT_DURATION);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.endTime).toBeNull();
  });

  it('rend UNE exécution sur un fichier entièrement contenu dans l’amorce', () => {
    // Quatre secondes : deux segments courts et rien après. Un seul processus.
    const court = planSegments(4);
    expect(court.map((s) => s.duration)).toEqual([2, 2]);
    expect(runs(0, court)).toHaveLength(1);
    expect(runs(0, court)[0]).toMatchObject({ segmentDuration: PRIMER_DURATION, endTime: null });
  });

  it('laisse le REMUX à son exécution unique, quelles que soient ses durées', () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * POURQUOI L'AMORCE SE RECONNAÎT À SA FORME, ET NON À « PLUS COURT QUE 4 ».
     *
     * Le remux ne passe pas par `planSegments` : son plan suit les images clés
     * de la source, et ses durées sont irrégulières. Un critère « le premier
     * segment est plus court que la croisière » y aurait déclenché une amorce
     * fantôme, avec un `-hls_time` bâtard, sur le chemin où la vidéo est COPIÉE.
     *
     * Cela dit, honnêtement : `planFromKeyframes` ne coupe qu'à `>= target`,
     * donc aucun segment de tête ne PEUT être plus court aujourd'hui. Le critère
     * naïf n'aurait rien cassé — il dépendait juste d'une propriété d'une AUTRE
     * fonction, sans le dire. Ce test fixe les deux : la propriété, et le fait
     * qu'on ne s'y adosse plus.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const irregulier = planFromKeyframes([0, 2.1, 4.3, 6.2, 9.5, 12.1, 17.4], 24, { target: SEGMENT_DURATION });

    // La propriété dont dépendait l'ancien critère, écrite noir sur blanc.
    for (const s of irregulier.slice(0, -1)) {
      expect(s.duration).toBeGreaterThanOrEqual(SEGMENT_DURATION);
    }
    expect(new Set(irregulier.slice(0, -1).map((s) => s.duration)).size).toBeGreaterThan(1);

    const chain = runs(0, irregulier);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ segmentDuration: SEGMENT_DURATION, endTime: null });
  });

  it('ne prend pas un plan d’images clés pour une amorce, même à 2 s pile', () => {
    // Le cas adverse : des segments de 2 s dans un plan qui n'est pas le nôtre.
    // `primerSegments` les compte — et c'est correct, la grille EST celle-là.
    const deuxSecondes = planFromKeyframes([0, 2, 4, 6, 8], 10, { target: PRIMER_DURATION });
    expect(primerSegments(deuxSecondes)).toBe(PRIMER_COUNT);
    expect(runs(0, deuxSecondes)).toHaveLength(2);
  });

  it('ne fabrique pas d’exécution pour le seul dernier segment tronqué', () => {
    /*
     * Le dernier segment est tronqué à la durée du fichier, donc plus court que
     * la croisière. Sans précaution, toute lecture de la fin lancerait une
     * exécution dédiée pour lui, puis une seconde pour rien.
     */
    const chain = runs(plan.length - 1);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.segmentDuration).toBe(SEGMENT_DURATION);
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
    segmentDuration: SEGMENT_DURATION,
    // Plus aucune exécution n'est bornée : elle produit jusqu'à la fin ou
    // jusqu'à ce qu'on la tue.
    endTime: null,
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

  it('ne décale JAMAIS les horodatages de sortie, même sur une relance', () => {
    /*
     * On croyait que sans ce décalage « le lecteur croirait être revenu au
     * début ». C'est l'inverse qui se produisait : ffmpeg n'applique pas
     * `-output_ts_offset` aux fragments, il l'inscrit dans l'edit list de
     * l'en-tête — et hls.js ne recharge jamais `EXT-X-MAP`. Le remux est touché
     * comme le transcodage. Ne pas le réintroduire.
     */
    const args = buildRemuxArgs({ ...base, startTime: 2400, startNumber: 601 });
    expect(args).not.toContain('-output_ts_offset');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
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
