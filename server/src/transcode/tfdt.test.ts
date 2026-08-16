import { describe, expect, it } from 'vitest';

import { planSegments } from './segments.js';
import { bornePlusProche, lireTimescale, rendreAbsolu } from './tfdt.js';

/** Un `tfdt` isolé dans un tampon, comme en tête de fragment. */
function fragment(valeur: number, version: 0 | 1 = 0): Buffer {
  const taille = version === 1 ? 20 : 16;
  const b = Buffer.alloc(64);
  b.write('moof', 4, 'latin1');
  b.writeUInt32BE(taille, 8);
  b.write('tfdt', 12, 'latin1');
  b[16] = version;
  if (version === 1) b.writeBigUInt64BE(BigInt(valeur), 20);
  else b.writeUInt32BE(valeur, 20);
  return b;
}

function tfdtDe(b: Buffer, version: 0 | 1 = 0): number {
  const i = b.indexOf(Buffer.from('tfdt'));
  return version === 1 ? Number(b.readBigUInt64BE(i + 8)) : b.readUInt32BE(i + 8);
}

/** Un `mdhd` version 0, dont la cadence est à seize octets du nom. */
function enTete(timescale: number, version: 0 | 1 = 0): Buffer {
  const b = Buffer.alloc(80);
  b.write('mdhd', 8, 'latin1');
  b[12] = version;
  b.writeUInt32BE(timescale, 8 + (version === 1 ? 24 : 16));
  return b;
}

const PLAN = planSegments(3600);
const TS = 24_000;

/**
 * Des bornes RÉELLES du plan, lues dedans plutôt qu'écrites en dur.
 *
 * Ces tests portaient « 2400 » et « 1200 », qui étaient des bornes tant que la
 * grille était uniforme à quatre secondes. L'amorce les a déplacées : la
 * croisière compte depuis 6 s, donc les bornes valent 6 + 4k et 2400 n'en est
 * plus une. Une borne écrite en dur teste la grille d'hier ; celles-ci suivent
 * le plan, quelle qu'en soit la découpe.
 */
const BORNE = PLAN[600]!.start;
const BORNE_APRES = PLAN[601]!.start;
const AUTRE_BORNE = PLAN[300]!.start;

describe('lireTimescale', () => {
  it('lit la cadence d’un mdhd version 0', () => {
    expect(lireTimescale(enTete(24_000))).toBe(24_000);
  });

  it('lit la cadence d’un mdhd version 1, dont les dates sont sur huit octets', () => {
    expect(lireTimescale(enTete(48_000, 1), )).toBe(48_000);
  });

  it('rend null sans mdhd plutôt que de deviner', () => {
    expect(lireTimescale(Buffer.alloc(64))).toBeNull();
  });
});

describe('bornePlusProche', () => {
  it('ramène un instant bruité sur la borne du plan', () => {
    // La quantification des images clés décale d'au plus une durée d'image.
    expect(bornePlusProche(PLAN, BORNE + 0.0417)).toBe(BORNE);
    expect(bornePlusProche(PLAN, BORNE - 0.04)).toBe(BORNE);
  });

  it('rend zéro pour un instant nul ou négatif', () => {
    // C'est le cas d'un fragment DÉJÀ absolu : la soustraction donne ~0.
    expect(bornePlusProche(PLAN, 0)).toBe(0);
    expect(bornePlusProche(PLAN, -0.041)).toBe(0);
  });

  it('tient sur une cadence de 25 i/s, dont la dent de scie a une autre amplitude', () => {
    // À 25 i/s l'écart maximal est de 40 ms, à 29,97 de 33 ms : dans les deux
    // cas très loin des deux secondes qui feraient basculer l'arrondi.
    expect(bornePlusProche(PLAN, AUTRE_BORNE + 0.04)).toBe(AUTRE_BORNE);
    expect(bornePlusProche(PLAN, AUTRE_BORNE - 0.033)).toBe(AUTRE_BORNE);
  });
});

describe('rendreAbsolu', () => {
  it('ajoute le début du run à un fragment relatif', () => {
    // Segment 600 produit par une relance : son tfdt est reparti de zéro.
    const b = fragment(0);
    const rendu = rendreAbsolu(b, TS, BORNE, PLAN);
    expect(rendu).toEqual({ corrige: true, debutRun: BORNE });
    expect(tfdtDe(b)).toBe(BORNE * TS);
  });

  it('préserve la contiguïté interne d’une exécution', () => {
    // Deuxième segment du même run : 4,004 s plus loin. L'écart doit survivre.
    const a = fragment(0);
    const b = fragment(Math.round(4.004 * TS));
    rendreAbsolu(a, TS, BORNE, PLAN);
    rendreAbsolu(b, TS, BORNE_APRES, PLAN);
    expect(tfdtDe(b) - tfdtDe(a)).toBe(Math.round(4.004 * TS));
  });

  it('NE TOUCHE PAS un fragment déjà absolu', () => {
    /*
     * Le cœur de l'invariant. Prélude, magasin audio statique et segments du run
     * initial sont déjà absolus ; s'ils étaient corrigés une seconde fois, ils
     * atterriraient au double de leur position — le défaut mesuré à 1792 s pour
     * un saut à 900 s.
     */
    const b = fragment(BORNE * TS);
    expect(rendreAbsolu(b, TS, BORNE, PLAN)).toEqual({ corrige: false, debutRun: 0 });
    expect(tfdtDe(b)).toBe(BORNE * TS);
  });

  it('est idempotente : deux passages valent un', () => {
    const b = fragment(0);
    rendreAbsolu(b, TS, BORNE, PLAN);
    rendreAbsolu(b, TS, BORNE, PLAN);
    expect(tfdtDe(b)).toBe(BORNE * TS);
  });

  it('absorbe la dent de scie sans se tromper de borne', () => {
    // Le fragment dit 0,0417 s alors qu'il est annoncé à la borne : la
    // différence doit s'arrondir à cette borne, et non à la précédente.
    const b = fragment(Math.round(0.0417 * TS));
    expect(rendreAbsolu(b, TS, BORNE, PLAN).debutRun).toBe(BORNE);
  });

  it('gère un tfdt version 1, sur soixante-quatre bits', () => {
    const b = fragment(0, 1);
    expect(rendreAbsolu(b, TS, BORNE, PLAN).corrige).toBe(true);
    expect(tfdtDe(b, 1)).toBe(BORNE * TS);
  });

  it('renonce plutôt que de tronquer un entier 32 bits qui déborderait', () => {
    // Écrire une valeur tronquée placerait le fragment n'importe où.
    const b = fragment(0);
    const long = planSegments(200_000);
    const rendu = rendreAbsolu(b, 24_000, 190_000, long);
    expect(rendu.corrige).toBe(false);
    expect(tfdtDe(b)).toBe(0);
  });

  it('ne fait rien sans boîte tfdt', () => {
    expect(rendreAbsolu(Buffer.alloc(64), TS, 2400, PLAN).corrige).toBe(false);
  });
});
