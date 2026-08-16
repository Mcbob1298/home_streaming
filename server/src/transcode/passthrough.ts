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
 */
import type { AppConfig } from '../config.js';
import type { SourceInfo } from './session.js';

export interface PassthroughContext {
  mediaFileId: number;
  source: SourceInfo | undefined;
  mode: 'remux' | 'transcode';
}

/**
 * Ce fichier doit-il voir son HDR transporté intact ?
 *
 * Trois conditions, et chacune a sa raison :
 *
 *   • figurer dans la liste de périmètre — provisoire, en attendant que la
 *     négociation des capacités du client la remplace ;
 *   • être en HDR10 — le Dolby Vision est écarté, ses métadonnées dynamiques ne
 *     survivraient pas au réencodage et aucun navigateur ne les décode en MSE ;
 *   • être réencodé — un remux copie le flux tel quel, il n'y a rien à décider.
 */
export function hdrPassthroughFor(config: AppConfig, context: PassthroughContext): boolean {
  return (
    config.transcode.hevcClientFiles.includes(context.mediaFileId) &&
    context.source?.hdr === 'HDR10' &&
    context.mode === 'transcode'
  );
}
