/**
 * L'INVARIANT : TOUT SEGMENT SERVI PORTE UN HORODATAGE ABSOLU.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EXISTE
 *
 * Un fragment fMP4 dit à quel instant il commence dans sa boîte `tfdt`
 * (« base media decode time »). ffmpeg n'y écrit JAMAIS une position absolue :
 * quelle que soit l'option employée, une exécution relancée à 40 minutes produit
 * des fragments dont le `tfdt` repart de zéro, et range le décalage dans l'edit
 * list de l'EN-TÊTE. Vérifié sur quatre variantes — `-output_ts_offset`,
 * `-avoid_negative_ts disabled`, `-muxdelay 0`, `-movflags
 * +negative_cts_offsets` — toutes donnent `tfdt = 0` et `elst = 2 400 000 ms`.
 * (`-copyts` provoque un segmentation fault avec la chaîne VAAPI.)
 *
 * Or le lecteur ne recharge jamais `EXT-X-MAP` : l'en-tête qu'il détient est
 * celui du premier run. Les fragments d'une relance étaient donc placés à la
 * distance du saut de leur vraie place.
 *
 * Pire, les deux natures coexistent sur le disque : les segments déjà produits
 * par le run initial sont absolus, ceux d'une relance sont relatifs. hls.js
 * déduit un décalage de la vidéo et l'applique aux deux — ce qui DOUBLE la
 * position de tout ce qui était déjà absolu. Mesuré : un saut à 900 s plaçait
 * l'audio à 1792 s.
 *
 * On ne demande donc rien à ffmpeg ni à hls.js : on garantit la propriété au
 * moment de servir. Le fragment part toujours avec un `tfdt` absolu, d'où qu'il
 * vienne — run initial, relance, prélude ou magasin statique.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * L'opération est IDEMPOTENTE, et c'est ce qui rend l'invariant tenable : sur un
 * fragment déjà absolu, le début de run déduit vaut zéro et rien n'est réécrit.
 * Le prélude et les pistes pré-générées traversent la correction intacts, sans
 * être des cas particuliers.
 */
import { segmentIndexAt, type PlannedSegment } from './segments.js';

/**
 * Le `moof` est en tête de fragment : quelques kilo-octets suffisent.
 *
 * On ne charge donc jamais le segment entier — un segment vidéo pèse trois
 * mégaoctets, et il en passe un toutes les quatre secondes de lecture.
 */
export const TETE_OCTETS = 8192;

const TFDT = Buffer.from('tfdt');
const MDHD = Buffer.from('mdhd');

/** 2³² − 1 : au-delà, `tfdt` version 0 déborde. */
const MAX_32 = 0xffff_ffff;

/**
 * Cadence de la piste, lue dans le `mdhd` de l'en-tête.
 *
 * C'est l'unité de `tfdt`, et elle ne se trouve QUE dans l'en-tête — un fragment
 * seul ne la porte pas.
 */
export function lireTimescale(init: Buffer): number | null {
  const i = init.indexOf(MDHD);
  if (i < 0) return null;

  const version = init[i + 4];
  // version 0 : création et modification sur 4 octets ; version 1 : sur 8.
  const decalage = version === 1 ? 24 : 16;
  if (i + decalage + 4 > init.length) return null;

  const timescale = init.readUInt32BE(i + decalage);
  return timescale > 0 ? timescale : null;
}

/**
 * Borne de segment la plus proche d'un instant.
 *
 * Le début d'un run tombe TOUJOURS sur une borne du plan : ffmpeg est relancé à
 * `plan[n].start`. L'instant déduit, lui, porte l'erreur de quantification des
 * images clés — au plus une durée d'image, 41,7 ms à 23,976 i/s, 40 ms à 25 i/s.
 * Face à des bornes espacées de quatre secondes, l'arrondi est sans ambiguïté.
 */
export function bornePlusProche(plan: PlannedSegment[], instant: number): number {
  if (plan.length === 0) return 0;
  if (instant <= 0) return 0;

  const index = segmentIndexAt(plan, instant);
  const avant = (plan[index] as PlannedSegment).start;
  const apres = plan[index + 1]?.start;
  if (apres === undefined) return avant;

  return instant - avant <= apres - instant ? avant : apres;
}

export interface Rendu {
  /** Vrai si l'en-tête a été réécrit. Faux : le fragment était déjà absolu. */
  corrige: boolean;
  /** Début de l'exécution qui a produit ce fragment, en secondes. */
  debutRun: number;
}

/**
 * Rend absolu le `tfdt` d'un fragment, EN PLACE dans le tampon fourni.
 *
 * `debutDeclare` est la position que le manifeste annonce pour ce segment. La
 * différence avec ce que dit `tfdt` donne le début de l'exécution qui l'a
 * produit ; on ajoute ce début, et le fragment se présente là où il doit.
 *
 * Ajouter le début du run — plutôt qu'écrire `debutDeclare` directement —
 * préserve la contiguïté interne de l'exécution : deux segments consécutifs d'un
 * même run restent bout à bout, sans trou ni recouvrement.
 */
export function rendreAbsolu(
  tete: Buffer,
  timescale: number,
  debutDeclare: number,
  plan: PlannedSegment[],
): Rendu {
  const i = tete.indexOf(TFDT);
  if (i < 0 || timescale <= 0) return { corrige: false, debutRun: 0 };

  const version = tete[i + 4];
  const large = version === 1;
  const debutValeur = i + 8;
  if (debutValeur + (large ? 8 : 4) > tete.length) return { corrige: false, debutRun: 0 };

  const valeur = large ? tete.readBigUInt64BE(debutValeur) : BigInt(tete.readUInt32BE(debutValeur));
  const relatif = Number(valeur) / timescale;
  const debutRun = bornePlusProche(plan, debutDeclare - relatif);

  // Déjà absolu : le début déduit vaut zéro, il n'y a rien à faire.
  if (debutRun <= 0) return { corrige: false, debutRun: 0 };

  const nouvelle = valeur + BigInt(Math.round(debutRun * timescale));

  /*
   * Un `tfdt` version 0 tient sur 32 bits. À 24 000 unités par seconde, cela
   * couvre 49 heures — mais si un fichier débordait, réécrire un entier tronqué
   * placerait le fragment n'importe où. Mieux vaut ne rien faire.
   */
  if (!large && nouvelle > BigInt(MAX_32)) return { corrige: false, debutRun };

  if (large) tete.writeBigUInt64BE(nouvelle, debutValeur);
  else tete.writeUInt32BE(Number(nouvelle), debutValeur);

  return { corrige: true, debutRun };
}
