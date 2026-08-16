import { describe, expect, it } from 'vitest';

import { buildRemuxArgs } from './args.js';
import { aElaguer, bridageArgs, DEBIT_MAXIMAL, RAFALE_SECONDES, RECUL_SECONDES } from './debit.js';

const base = {
  input: '/films/avatar.mkv',
  startTime: 0,
  startNumber: 0,
  segmentDuration: 4,
  endTime: null,
  outputDir: '/tmp/s',
  audio: { kind: 'none' } as const,
};

describe('bridageArgs', () => {
  it('accorde une rafale AVANT d’imposer le plafond', () => {
    // Sans la rafale, le lecteur démarrerait avec la même avance famélique
    // qu'avant — c'est elle qui remplace le tampon de soixante secondes de Plex.
    const args = bridageArgs();
    expect(args[args.indexOf('-readrate_initial_burst') + 1]).toBe(String(RAFALE_SECONDES));
    expect(args[args.indexOf('-readrate') + 1]).toBe(String(DEBIT_MAXIMAL));
  });

  it('plafonne à peine au-dessus du temps réel', () => {
    /*
     * Le plafond doit dépasser 1 — sinon l'avance ne se reconstitue jamais après
     * un à-coup — sans s'en éloigner : à 49× le remux remplirait le tmpfs d'un
     * gigaoctet en quelques secondes.
     */
    expect(DEBIT_MAXIMAL).toBeGreaterThan(1);
    expect(DEBIT_MAXIMAL).toBeLessThanOrEqual(2);
  });
});

describe('buildRemuxArgs — bridage', () => {
  it('place le bridage du côté de l’ENTRÉE, avant -i', () => {
    // `-readrate` est une option d'entrée : après `-i`, ffmpeg l'ignorerait.
    const args = buildRemuxArgs(base);
    expect(args.indexOf('-readrate')).toBeGreaterThan(-1);
    expect(args.indexOf('-readrate')).toBeLessThan(args.indexOf('-i'));
    expect(args.indexOf('-readrate_initial_burst')).toBeLessThan(args.indexOf('-i'));
  });

  it('bride aussi une relance en cours de film', () => {
    // Chaque relance repart avec sa propre rafale : c'est ce qui redonne de
    // l'avance après un déplacement, là où elle tombait à trois secondes.
    const args = buildRemuxArgs({ ...base, startTime: 2400, startNumber: 600 });
    expect(args.indexOf('-readrate')).toBeLessThan(args.indexOf('-i'));
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });
});

describe('aElaguer — le cas qui a échappé aux tests', () => {
  /** Plan de remux : des segments de 10 s, comme les images clés d'Avatar. */
  const plan = Array.from({ length: 400 }, (_, i) => ({ start: i * 10 }));
  const fichier = (i: number) => `seg-${String(i).padStart(5, '0')}.m4s`;

  it('efface les segments de positions ANTÉRIEURES après des sauts', () => {
    /*
     * LE CAS QUI A ÉCHAPPÉ. La première version descendait les index depuis la
     * position lue et s'arrêtait au premier fichier absent — or après un saut,
     * les index juste avant la nouvelle position n'existent pas. Elle
     * n'atteignait donc jamais les segments des sauts précédents.
     *
     * En conditions réelles : huit sauts, 58 segments accumulés, 2742 Mo de
     * tmpfs occupés, pas un fichier effacé. Une lecture linéaire ne le montre
     * pas, puisque les index s'y suivent sans trou.
     */
    const presents = [60, 61, 90, 91, 180, 181, 240, 241].map(fichier);
    const aEffacer = aElaguer(presents, plan, 240);

    // On lit à 2400 s : tout ce qui précède 2370 s doit partir.
    expect(aEffacer).toEqual([60, 61, 90, 91, 180, 181].map(fichier));
    expect(aEffacer).not.toContain(fichier(240));
  });

  it('garde ce qui est dans la marge de recul', () => {
    const presents = [237, 238, 239, 240].map(fichier);
    // 2370 s est la limite exacte : le segment 237 commence là, il reste.
    expect(aElaguer(presents, plan, 240)).toEqual([]);
  });

  it('n’efface rien au début du film', () => {
    const presents = [0, 1, 2].map(fichier);
    expect(aElaguer(presents, plan, 2)).toEqual([]);
  });

  it('ignore ce qu’il ne sait pas situer', () => {
    // Un fichier hors plan, ou qui n'est pas un segment : on n'y touche pas.
    const presents = ['init.mp4', 'init-stable.mp4', 'internal.m3u8', fichier(9999)];
    expect(aElaguer(presents, plan, 240)).toEqual([]);
  });
});

describe('RECUL_SECONDES', () => {
  it('couvre un recul ordinaire sans relancer ffmpeg', () => {
    // Le bouton « −10 s » et les ajustements de barre doivent tomber dedans.
    expect(RECUL_SECONDES).toBeGreaterThanOrEqual(20);
  });

  it('reste dans ce que le tmpfs peut porter', () => {
    // 78 Mo par segment de 10 s en remux 4K, tmpfs d'un gigaoctet : au-delà
    // d'une minute conservée en arrière, deux sessions ne tiendraient plus.
    const moParSeconde = 78 / 10;
    expect(RECUL_SECONDES * moParSeconde).toBeLessThan(300);
  });
});
