/**
 * Tests du résumé rendu par « Rechercher ce qui manque ».
 *
 * La phrase compte : c'est la seule chose que le bouton produise à l'écran. Une
 * recherche qui remet trois cents fichiers en file et une qui ne trouve rien ont
 * exactement le même effet visible à l'instant du clic.
 */
import { describe, expect, it } from 'vitest';

import { resumeRecherche, type EnqueueResult } from './preparation';

/** Le formateur de la page, reproduit tel quel. */
function octets(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} Tio`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} Mo`;
  return `${Math.round(bytes / 1024)} Ko`;
}

function resultat(overrides: Partial<EnqueueResult> = {}): EnqueueResult {
  return { added: 0, reactivated: 0, unchanged: 0, missing: 0, missingBytes: 0, ...overrides };
}

describe('resumeRecherche', () => {
  it('dit clairement qu’il n’y a rien à faire', () => {
    // « 0 nouveaux, 0 modifiés » ne disait pas si le bouton avait cherché.
    expect(resumeRecherche(resultat({ unchanged: 2796 }), octets)).toBe(
      'Rien à rattraper : chaque fichier présent a ses sous-titres.',
    );
  });

  it('rend compte des fichiers sans WebVTT sur le disque', () => {
    expect(resumeRecherche(resultat({ missing: 2306, missingBytes: 5_640_000_000_000 }), octets)).toBe(
      'Remis en file : 2306 sans sous-titres sur le disque (5.13 Tio à relire).',
    );
  });

  it('énumère les trois causes quand elles se cumulent', () => {
    expect(
      resumeRecherche(resultat({ added: 3, reactivated: 1, missing: 12, missingBytes: 4_294_967_296 }), octets),
    ).toBe(
      'Remis en file : 3 nouveau(x), 1 modifié(s) depuis leur préparation, ' +
        '12 sans sous-titres sur le disque (4.0 Go à relire).',
    );
  });

  it('ne mentionne pas une cause à zéro', () => {
    expect(resumeRecherche(resultat({ added: 5, unchanged: 100 }), octets)).toBe('Remis en file : 5 nouveau(x).');
  });
});
