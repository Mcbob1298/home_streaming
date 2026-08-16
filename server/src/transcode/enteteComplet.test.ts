/**
 * UN EN-TÊTE EN COURS D'ÉCRITURE NE DOIT JAMAIS PASSER POUR COMPLET.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CES TESTS FIXENT.
 *
 * `init-stable.mp4` a été servi à ZÉRO OCTET en HTTP 200, sur un fichier dont la
 * lecture ne pouvait donc pas démarrer. La cause : le garde-fou attendait le
 * premier segment — signal indirect — alors qu'avec un prélude ce segment est
 * déjà là avant que ffmpeg n'ait écrit quoi que ce soit.
 *
 * Un client ne peut PAS distinguer un 200 vide d'un succès : hls.js ouvre un
 * SourceBuffer sur rien et attend indéfiniment, sans erreur ni journal. Seul le
 * rechargement le masquait.
 *
 * Ces tests décrivent tous les états qu'un en-tête traverse pendant que ffmpeg
 * l'écrit. Avant la correction, aucun n'était vérifié — la seule question posée
 * était « le fichier existe-t-il ».
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from 'vitest';

import { analyserEntete, enteteComplet, pourquoiIncomplet } from './enteteComplet.js';

/** Une boîte ISO-BMFF : taille sur 4 octets, type sur 4, puis le contenu. */
function boite(type: string, contenu: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(8 + contenu.length);
  b.writeUInt32BE(8 + contenu.length, 0);
  b.write(type, 4, 'latin1');
  contenu.copy(b, 8);
  return b;
}

const FTYP = boite('ftyp', Buffer.from('isom\0\0\x02\0', 'latin1'));
const MOOV = boite('moov', Buffer.alloc(400, 7));

describe('analyserEntete — les états traversés pendant l’écriture', () => {
  it('accepte un en-tête entier', () => {
    const etat = analyserEntete(Buffer.concat([FTYP, MOOV]));
    expect(etat.complet).toBe(true);
    expect(etat.boites).toEqual(['ftyp', 'moov']);
  });

  /*
   * L'ÉTAT EXACT QUI A ÉTÉ SERVI. Le fichier venait d'être créé par ffmpeg et
   * ne contenait encore rien.
   */
  it('REFUSE un fichier vide — le cas qui a été servi en HTTP 200', () => {
    const etat = analyserEntete(Buffer.alloc(0));
    expect(etat.complet).toBe(false);
    expect(etat.boites).toEqual([]);
    expect(pourquoiIncomplet(etat)).toContain('vide');
  });

  it('REFUSE un ftyp seul, moov pas encore écrit', () => {
    const etat = analyserEntete(FTYP);
    expect(etat.complet).toBe(false);
    expect(pourquoiIncomplet(etat)).toContain('moov');
  });

  it('REFUSE un moov annoncé plus long que ce qui est écrit', () => {
    // Le cas le plus traître : les huit premiers octets sont là, le contenu non.
    const tronque = Buffer.concat([FTYP, MOOV.subarray(0, 40)]);
    const etat = analyserEntete(tronque);
    expect(etat.complet).toBe(false);
    expect(etat.tronquee).toBe('moov');
    expect(pourquoiIncomplet(etat)).toContain('en cours d’écriture');
  });

  it('REFUSE une taille nulle — « jusqu’à la fin du fichier », donc indécidable', () => {
    const ouverte = Buffer.alloc(8);
    ouverte.writeUInt32BE(0, 0);
    ouverte.write('moov', 4, 'latin1');
    expect(analyserEntete(Buffer.concat([FTYP, ouverte])).complet).toBe(false);
  });

  it('REFUSE des octets qui ne sont pas des boîtes', () => {
    expect(enteteComplet(Buffer.alloc(64, 0xff))).toBe(false);
  });

  /*
   * Croissance octet par octet : à AUCUN moment un préfixe ne doit être déclaré
   * complet avant le dernier. C'est la propriété qui rend la publication sûre,
   * et elle vaut quelle que soit la granularité d'écriture de ffmpeg.
   */
  it('n’est complet qu’au tout dernier octet, jamais avant', () => {
    const entier = Buffer.concat([FTYP, MOOV]);
    for (let n = 0; n < entier.length; n += 1) {
      expect(enteteComplet(entier.subarray(0, n)), `${n} octets sur ${entier.length}`).toBe(false);
    }
    expect(enteteComplet(entier)).toBe(true);
  });

  it('accepte une boîte à taille 64 bits', () => {
    // `size = 1` annonce la vraie taille sur huit octets après le type.
    const large = Buffer.alloc(16 + 32);
    large.writeUInt32BE(1, 0);
    large.write('moov', 4, 'latin1');
    large.writeBigUInt64BE(BigInt(large.length), 8);
    expect(analyserEntete(Buffer.concat([FTYP, large])).complet).toBe(true);
  });

  it('tolère ce qui suit moov sans s’en formaliser', () => {
    // Un `free` ou un `moof` derrière ne rend pas l'en-tête moins valable.
    const suite = Buffer.concat([FTYP, MOOV, boite('free', Buffer.alloc(16))]);
    expect(enteteComplet(suite)).toBe(true);
  });
});
