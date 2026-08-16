/**
 * CE QUE LE CLIENT SAIT DÉCODER — lu sur la requête, jamais deviné.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE CAPACITÉ ET NON UNE LISTE DE FICHIERS.
 *
 * Le transport HDR intact était gouverné par `transcode.hevcClientFiles`, une
 * liste d'identifiants dans la configuration. Elle a rendu le service qu'on lui
 * demandait — tenir un périmètre le temps de valider un fichier — mais elle
 * répond à la mauvaise question : « ce FICHIER est-il concerné ? » là où la
 * seule question qui compte est « ce CLIENT sait-il décoder ? ».
 *
 * La différence devient un mode de panne dès que plusieurs appareils accèdent au
 * serveur : une liste par fichier envoie du HEVC 10 bits au téléphone comme au
 * navigateur qui sait le lire, et le premier n'affiche rien du tout.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE REPLI EST SÛR PAR CONSTRUCTION : L'ABSENCE VAUT « NON ».
 *
 * Un client qui ne dit rien — vieux navigateur, mandataire qui filtre l'en-tête,
 * requête forgée à la main, `curl` — reçoit le chemin d'avant : H.264 tone-mappé,
 * que tout décode. Mieux vaut une image moins bonne qu'une image absente.
 *
 * C'est aussi pourquoi la fonction ne rend `true` que sur une valeur POSITIVE
 * explicite, et jamais sur « l'en-tête est présent ». Un `X-Client-Hevc: 0`
 * envoyé par un client prudent doit valoir non, pas oui.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/*
 * Le nom vit dans `partage/entetes.ts`, importé À L'IDENTIQUE par le front. Une
 * chaîne écrite deux fois se cherche deux fois — et c'est exactement ce qui a
 * fait croire un instant que la sonde manquait du bundle servi.
 *
 * Un en-tête et non un paramètre d'URL : la capacité doit accompagner le
 * manifeste maître, les playlists ET les segments, autant de routes qui peuvent
 * créer la session. `xhrSetup` de hls.js le pose sur tout, en un seul endroit.
 */
import { HEVC_HEADER, HEVC_HEADER_RECU } from '../partage/entetes.js';

export { HEVC_HEADER };

/**
 * CE QUE SAIT LE CLIENT, CONSTRUIT UNE FOIS À LA LISIÈRE HTTP.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * UN OBJET PASSÉ EN BLOC, ET NON DES CHAMPS COMPOSÉS PAR CHAQUE ROUTE.
 *
 * Quatre fois de suite, une valeur correctement lue à l'arrivée n'a pas été
 * fournie par l'un de ses appelants : le plafond HDR, le débit de l'empreinte,
 * la simulation des préludes, puis la capacité HEVC dans la route de playability
 * — laquelle portait, juste au-dessus, un commentaire annonçant ce défaut exact.
 * Un commentaire ne ferme rien.
 *
 * Le point commun des cas sains, relevé à l'audit : les commandes qui remplissent
 * UN objet d'options puis le passent en bloc n'ont jamais perdu de champ. Celles
 * qui composent leur appel champ par champ en ont perdu à chaque fois.
 *
 * D'où cette forme. Les routes ne composent plus rien : elles construisent les
 * capacités une fois, à l'entrée, et les transmettent telles quelles.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export interface CapacitesClient {
  /** Ce client décode-t-il le HEVC 10 bits (Main 10, niveau 5.1) ? */
  hevc: boolean;
}

/**
 * Les capacités d'un client dont on ne sait rien.
 *
 * Le repli sûr, nommé, pour les appelants qui n'ont pas de requête HTTP sous la
 * main — une commande, un diagnostic. Les écrire `{ hevc: false }` à la volée
 * marcherait aussi, mais ne dirait pas qu'il s'agit d'un choix.
 */
export const CLIENT_PRUDENT: CapacitesClient = Object.freeze({ hevc: false });

/** Les capacités portées par une requête. À appeler UNE fois, à la lisière. */
export function capacitesDe(headers: Record<string, unknown>): CapacitesClient {
  return { hevc: clientDecodesHevc(headers) };
}

/** Les valeurs qui valent OUI. Tout le reste, y compris l'absence, vaut non. */
const OUI = new Set(['1', 'true', 'yes', 'oui']);

/**
 * Ce client sait-il décoder le HEVC 10 bits (Main 10, niveau 5.1) ?
 *
 * La valeur vient de `MediaSource.isTypeSupported('hvc1.2.4.L153.B0')` évalué
 * dans le navigateur — et surtout PAS de `canPlayType`, qui répond « maybe »
 * pour des flux qu'il ne lit pas. Ce piège a déjà coûté des semaines sur ce
 * projet : hls.js ne se chargeait pas et rien ne le signalait.
 */
export function clientDecodesHevc(headers: Record<string, unknown>): boolean {
  const brut = headers[HEVC_HEADER_RECU];
  const valeur = Array.isArray(brut) ? brut[0] : brut;
  return typeof valeur === 'string' && OUI.has(valeur.trim().toLowerCase());
}
