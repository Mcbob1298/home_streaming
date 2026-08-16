/**
 * QUI TRANSPORTE SON HDR INTACT — LA RÈGLE, ÉCRITE UNE SEULE FOIS.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DEUX APPELANTS, UNE SEULE DÉFINITION.
 *
 * La route HLS crée les sessions de lecture ; la commande `prelude` fabrique les
 * amorces. Les deux doivent répondre EXACTEMENT la même chose, sinon le prélude
 * est produit dans un codec que la session n'attend pas — c'est arrivé dès le
 * premier essai : une amorce H.264 tone-mappée pour une session HEVC.
 *
 * Le garde-fou d'empreinte l'a rattrapée, et c'est son rôle. Mais un garde-fou
 * qui se déclenche à chaque fabrication signale une règle dupliquée, pas une
 * règle qui marche.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA LISTE DE PÉRIMÈTRE A DISPARU, ELLE N'EST PAS DEVENUE UN INTERRUPTEUR.
 *
 * `transcode.hevcClientFiles` énumérait les fichiers autorisés à transporter
 * leur HDR. C'était un échafaudage assumé, le temps d'en valider un seul — et il
 * répondait à la mauvaise question, « ce FICHIER est-il concerné » plutôt que
 * « ce CLIENT sait-il décoder ».
 *
 * Elle n'a pas été gardée en secours à côté de la négociation : deux mécanismes
 * qui décident de la même chose finissent toujours par décider différemment, et
 * ce dépôt a payé cette leçon assez souvent — la géométrie de sortie, le débit
 * de l'empreinte, les bornes de sonde. Un seul chemin, ou l'autre.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { SourceInfo } from './session.js';

export interface PassthroughContext {
  /**
   * Ce client sait-il décoder le HEVC 10 bits ?
   *
   * Vient de `clientDecodesHevc()`, donc d'un en-tête posé par le lecteur après
   * un `MediaSource.isTypeSupported`. Faux par défaut : un client dont on ne
   * sait rien reçoit le chemin que tout le monde décode.
   */
  clientDecodesHevc: boolean;
  source: SourceInfo | undefined;
  mode: 'remux' | 'transcode';
}

/**
 * Ce fichier doit-il voir son HDR transporté intact ?
 *
 * Trois conditions, et chacune a sa raison :
 *
 *   • le client sait décoder le HEVC 10 bits — sans quoi il n'affiche RIEN ;
 *   • être en HDR10 — le Dolby Vision est écarté, ses métadonnées dynamiques ne
 *     survivraient pas au réencodage et aucun navigateur ne les décode en MSE ;
 *   • être réencodé — un remux copie le flux tel quel, il n'y a rien à décider.
 */
export function hdrPassthroughFor(context: PassthroughContext): boolean {
  return context.clientDecodesHevc && context.source?.hdr === 'HDR10' && context.mode === 'transcode';
}
