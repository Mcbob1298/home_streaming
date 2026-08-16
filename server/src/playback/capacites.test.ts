/**
 * Tests de la négociation de capacité.
 *
 * Ce qui compte ici n'est pas qu'un client capable obtienne son HEVC : c'est que
 * TOUT LE RESTE ne l'obtienne pas. Le serveur s'ouvre à des appareils inconnus,
 * et un faux positif ne se traduit pas par une image moins belle mais par une
 * image absente.
 */
import { describe, expect, it } from 'vitest';

import { HEVC_HEADER, clientDecodesHevc } from './capacites.js';
import { HEVC_HEADER_RECU } from '../partage/entetes.js';
import { hdrPassthroughFor } from '../transcode/passthrough.js';
import type { SourceInfo } from '../transcode/session.js';

const HDR10: SourceInfo = { width: 3840, height: 2160, frameRate: 23.976, hdr: 'HDR10' };

describe('clientDecodesHevc', () => {
  it('reconnaît les formes affirmatives', () => {
    for (const valeur of ['1', 'true', 'yes', 'oui', 'TRUE', ' 1 ']) {
      expect(clientDecodesHevc({ [HEVC_HEADER_RECU]: valeur }), valeur).toBe(true);
    }
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * LE REPLI EST SÛR : TOUT CE QUI N'EST PAS UN OUI EXPLICITE VAUT NON.
   *
   * Chaque cas ci-dessous correspond à un client réel : celui qui n'a pas été
   * mis à jour, le mandataire qui filtre les en-têtes inconnus, le navigateur
   * qui répond honnêtement « non », et `curl`. Aucun ne doit recevoir du HEVC.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('refuse tout ce qui n’est pas un oui explicite', () => {
    const cas: Record<string, unknown>[] = [
      {},
      { [HEVC_HEADER_RECU]: '0' },
      { [HEVC_HEADER_RECU]: 'false' },
      { [HEVC_HEADER_RECU]: '' },
      { [HEVC_HEADER_RECU]: 'peut-être' },
      { [HEVC_HEADER_RECU]: undefined },
      { [HEVC_HEADER_RECU]: 1 },
      { [HEVC_HEADER_RECU]: true },
      { 'x-autre-chose': '1' },
    ];
    for (const headers of cas) {
      expect(clientDecodesHevc(headers), JSON.stringify(headers)).toBe(false);
    }
  });

  it('lit la première valeur quand l’en-tête est répété', () => {
    // Fastify rend un tableau si l'en-tête arrive deux fois.
    expect(clientDecodesHevc({ [HEVC_HEADER_RECU]: ['1', '0'] })).toBe(true);
    expect(clientDecodesHevc({ [HEVC_HEADER_RECU]: ['0', '1'] })).toBe(false);
  });
});

describe('hdrPassthroughFor — la règle complète', () => {
  it('transporte le HDR quand les trois conditions tiennent', () => {
    expect(hdrPassthroughFor({ clientDecodesHevc: true, source: HDR10, mode: 'transcode' })).toBe(true);
  });

  it('refuse à un client qui ne décode pas le HEVC', () => {
    // La condition qui remplace la liste de fichiers : sans elle, cet appareil
    // recevrait un flux qu'il n'affiche pas du tout.
    expect(hdrPassthroughFor({ clientDecodesHevc: false, source: HDR10, mode: 'transcode' })).toBe(false);
  });

  it('écarte le Dolby Vision, même sur un client capable', () => {
    // Métadonnées dynamiques qui ne survivraient pas au réencodage, et qu'aucun
    // navigateur ne décode en MSE. 94 fichiers de la bibliothèque.
    const dv: SourceInfo = { ...HDR10, hdr: 'Dolby Vision' };
    expect(hdrPassthroughFor({ clientDecodesHevc: true, source: dv, mode: 'transcode' })).toBe(false);
  });

  it('écarte le SDR', () => {
    const sdr: SourceInfo = { ...HDR10, hdr: null };
    expect(hdrPassthroughFor({ clientDecodesHevc: true, source: sdr, mode: 'transcode' })).toBe(false);
  });

  it('écarte le remux, où il n’y a rien à décider', () => {
    // La vidéo est copiée telle quelle : aucun encodeur n'intervient.
    expect(hdrPassthroughFor({ clientDecodesHevc: true, source: HDR10, mode: 'remux' })).toBe(false);
  });

  it('survit à une source inconnue', () => {
    expect(hdrPassthroughFor({ clientDecodesHevc: true, source: undefined, mode: 'transcode' })).toBe(false);
  });
});

describe('le nom de l’en-tête', () => {
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * DEUX FORMES, UN SEUL LITTÉRAL, ET LEUR LIEN EST TESTÉ.
   *
   * Le front envoie `X-Client-Hevc` ; Node normalise les en-têtes REÇUS en
   * minuscules, donc le serveur cherche `x-client-hevc`. Les deux étaient
   * écrites à la main dans deux fichiers — toutes deux justes, mais un
   * `grep x-client-hevc` sur le bundle servi n'a rien trouvé et a laissé croire
   * un instant que la sonde en était absente.
   *
   * La seconde est maintenant DÉRIVÉE de la première. Ce test fixe le lien :
   * changer la casse canonique ne peut plus désaccorder les deux moitiés.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('dérive la forme reçue de la forme canonique, sans la réécrire', () => {
    expect(HEVC_HEADER_RECU).toBe(HEVC_HEADER.toLowerCase());
  });

  it('est bien celui que le front pose', () => {
    // Si cette valeur change, le front DOIT changer avec — ils importent le
    // même module, donc la seule façon de les désaccorder serait de dupliquer.
    expect(HEVC_HEADER).toBe('X-Client-Hevc');
  });
});
