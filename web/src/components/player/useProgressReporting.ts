import { useEffect, useRef } from 'react';

import { api, type ProgressReport } from '../../api';
import { REPORT_INTERVAL_MS, usableDuration, worthReporting } from './progressReporting';

/**
 * Enregistre la position de lecture auprès du serveur.
 *
 * Quatre déclencheurs, et un seul chemin d'envoi :
 *
 * - toutes les dix secondes tant que ça joue ;
 * - à la pause, qui est souvent le vrai « j'arrête là » ;
 * - après chaque saut, sinon reprendre ramènerait avant le saut ;
 * - à la fermeture de la page, où seul `sendBeacon` part encore.
 *
 * `sendBeacon` n'accepte pas d'en-tête : le corps part en `Blob` typé
 * `application/json`, ce que Fastify lit comme du JSON ordinaire. Sans ce type,
 * le corps arriverait en `text/plain` et la route répondrait 400.
 */
export function useProgressReporting(
  mediaFileId: number,
  video: React.RefObject<HTMLVideoElement | null>,
  onWatched?: () => void,
): void {
  // Dernière position réellement partie. Une ref et non un état : la modifier
  // ne doit rien redessiner, et l'intervalle doit en voir la valeur à jour.
  const lastReported = useRef<number | null>(null);

  useEffect(() => {
    lastReported.current = null;
  }, [mediaFileId]);

  useEffect(() => {
    const node = video.current;
    if (node === null) return;

    /** La position du moment, ou null s'il n'y a rien à enregistrer. */
    function pending(): ProgressReport | null {
      if (node === null) return null;
      const positionSeconds = node.currentTime;
      if (!worthReporting(positionSeconds, lastReported.current)) return null;
      return {
        mediaFileId,
        positionSeconds,
        durationSeconds: usableDuration(node.duration),
      };
    }

    function report(): void {
      const body = pending();
      if (body === null) return;
      lastReported.current = body.positionSeconds;
      void api
        .saveProgress(body)
        .then((result) => {
          // Le verdict « vu » appartient au serveur : on ne fait qu'en prendre
          // acte, pour rafraîchir la rangée d'où l'œuvre vient de sortir.
          if (result.watched) onWatched?.();
        })
        .catch(() => undefined);
    }

    /**
     * Dernier envoi, quand la page s'en va.
     *
     * Un fetch ordinaire est annulé avec le document ; `sendBeacon` est remis à
     * la pile réseau et part quand même. Le repli couvre les navigateurs qui le
     * refusent — la lecture ne doit jamais dépendre de cette route.
     */
    function reportFinal(): void {
      const body = pending();
      if (body === null) return;
      lastReported.current = body.positionSeconds;

      const payload = new Blob([JSON.stringify(body)], { type: 'application/json' });
      if (navigator.sendBeacon('/api/progress', payload)) return;
      void api.saveProgress(body).catch(() => undefined);
    }

    const timer = window.setInterval(() => {
      // Rien à enregistrer sur une vidéo en pause : la pause a déjà envoyé.
      if (!node.paused) report();
    }, REPORT_INTERVAL_MS);

    node.addEventListener('pause', report);
    node.addEventListener('seeked', report);
    node.addEventListener('ended', report);
    window.addEventListener('pagehide', reportFinal);

    return () => {
      window.clearInterval(timer);
      node.removeEventListener('pause', report);
      node.removeEventListener('seeked', report);
      node.removeEventListener('ended', report);
      window.removeEventListener('pagehide', reportFinal);
      // Quitter la page de lecture par la navigation interne ne déclenche pas
      // `pagehide` : le démontage est le dernier moment pour enregistrer.
      reportFinal();
    };
  }, [mediaFileId, video, onWatched]);
}
