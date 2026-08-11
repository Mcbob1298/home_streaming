import { describe, expect, it } from 'vitest';

import { ffprobeFor, parseKeyframeTimes } from './keyframes.js';
import { countSegmentsBefore, planFromKeyframes } from './segments.js';

describe('parseKeyframeTimes', () => {
  it('ne retient que les paquets marqués K', () => {
    const output = ['0.000000,K__', '0.040000,___', '2.080000,___', '10.000000,K__', '10.040000,___'].join('\n');
    expect(parseKeyframeTimes(output)).toEqual([0, 10]);
  });

  it('accepte les drapeaux composés', () => {
    // Un paquet peut être clé ET rejeté à l'affichage.
    expect(parseKeyframeTimes('0.000000,K_\n5.000000,KD')).toEqual([0, 5]);
  });

  it('ignore les horodatages absents', () => {
    expect(parseKeyframeTimes('N/A,K__\n4.000000,K__')).toEqual([0]);
  });

  it('remet la première clé à zéro', () => {
    // Certains conteneurs horodatent la première image un peu après zéro ; la
    // découpe, elle, commence forcément au début du fichier.
    expect(parseKeyframeTimes('0.083000,K__\n10.000000,K__')).toEqual([0, 10]);
  });

  it('remet les clés dans l’ordre de présentation', () => {
    // L'ordre des paquets suit le décodage, qui réordonne les images B.
    expect(parseKeyframeTimes('8.000000,K__\n0.000000,K__\n4.000000,K__')).toEqual([0, 4, 8]);
  });

  it('accepte les fins de ligne Windows et une sortie vide', () => {
    expect(parseKeyframeTimes('0.000000,K__\r\n4.000000,K__\r\n')).toEqual([0, 4]);
    expect(parseKeyframeTimes('')).toEqual([]);
  });
});

/**
 * Ces cas décrivent la règle de ffmpeg : nouveau segment à la première image
 * clé dont l'horodatage atteint « début courant + hls_time ».
 */
describe('planFromKeyframes', () => {
  it('groupe les images clés jusqu’à atteindre la durée visée', () => {
    // Clés toutes les 2 s, cible 4 s : un segment sur deux clés.
    const keyframes = [0, 2, 4, 6, 8, 10, 12];
    const plan = planFromKeyframes(keyframes, 14, { target: 4 });
    expect(plan.map((s) => s.start)).toEqual([0, 4, 8, 12]);
    expect(plan.map((s) => s.duration)).toEqual([4, 4, 4, 2]);
  });

  it('n’invente pas de coupure entre deux images clés éloignées', () => {
    // Le cas mesuré sur la bibliothèque : dix secondes entre deux clés.
    // Un segment « de 4 s » en fera dix, et le manifeste doit le dire.
    const plan = planFromKeyframes([0, 10, 20, 30], 40, { target: 4 });
    expect(plan.map((s) => s.duration)).toEqual([10, 10, 10, 10]);
  });

  it('suit des écarts irréguliers, en sautant les clés trop rapprochées', () => {
    // Écarts relevés sur un vrai fichier : 10, 10, 9.96, 2.21, 9.96…
    // La clé à 32.17 n'arrive que 2,21 s après le début du segment courant,
    // sous le minimum de 4 s : ffmpeg ne coupe pas là, et nous non plus.
    const keyframes = [0, 10, 20, 29.96, 32.17, 42.13];
    const plan = planFromKeyframes(keyframes, 50, { target: 4 });
    expect(plan.map((s) => s.start)).toEqual([0, 10, 20, 29.96, 42.13]);
  });

  it('respecte le minimum : deux clés rapprochées tiennent dans un segment', () => {
    const plan = planFromKeyframes([0, 1, 2, 3, 4, 5, 6, 7, 8], 9, { target: 4 });
    expect(plan.map((s) => s.start)).toEqual([0, 4, 8]);
  });

  it('vise plus court sur les premiers segments', () => {
    const plan = planFromKeyframes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 13, {
      target: 4,
      primerCount: 3,
      primerTarget: 2,
    });
    // Trois segments de 2 s, puis 4 s.
    expect(plan.map((s) => s.start)).toEqual([0, 2, 4, 6, 10]);
  });

  it('couvre exactement la durée', () => {
    const plan = planFromKeyframes([0, 3.5, 9.2, 14.8], 20, { target: 4 });
    const last = plan.at(-1) as { start: number; duration: number };
    expect(last.start + last.duration).toBeCloseTo(20, 3);
  });

  it('numérote sans trou', () => {
    const plan = planFromKeyframes([0, 5, 11, 17, 23], 30, { target: 4 });
    expect(plan.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('rend un plan vide sans images clés ou sans durée', () => {
    expect(planFromKeyframes([], 100, {})).toEqual([]);
    expect(planFromKeyframes([0, 4], 0, {})).toEqual([]);
  });
});

describe('countSegmentsBefore', () => {
  const plan = planFromKeyframes([0, 2, 4, 6, 10, 14], 18, { target: 2 });

  it('compte les segments d’une exécution bornée', () => {
    // C'est ce qui donne le -start_number de l'exécution suivante : le deviner
    // laisserait des trous que rien ne remplirait jamais.
    expect(countSegmentsBefore(plan, 6)).toBe(3);
    expect(countSegmentsBefore(plan, 0)).toBe(0);
  });

  it('compte tout au-delà de la fin', () => {
    expect(countSegmentsBefore(plan, 999)).toBe(plan.length);
  });
});

describe('ffprobeFor', () => {
  it('déduit ffprobe du chemin de ffmpeg', () => {
    expect(ffprobeFor('C:\\ff\\bin\\ffmpeg.exe')).toBe('C:\\ff\\bin\\ffprobe.exe');
    expect(ffprobeFor('/usr/bin/ffmpeg')).toBe('/usr/bin/ffprobe');
    expect(ffprobeFor('ffmpeg')).toBe('ffprobe');
  });
});
