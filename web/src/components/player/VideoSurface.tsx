import { useEffect, useRef } from 'react';

import type { PlaybackSource, SubtitleTrack } from '../../api';

/**
 * L'ÉLÉMENT VIDÉO ET SON BRANCHEMENT DE SOURCE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * C'est le SEUL endroit du code qui décide comment une source est attachée à
 * l'élément vidéo. Aucun autre composant n'écrit `src` sur une balise `video`,
 * et aucun ne raisonne sur une URL.
 *
 * Pourquoi cette contrainte : la lecture démarrera à terme sur une amorce
 * pré-transcodée pendant que ffmpeg produit la suite. Le reste du lecteur — la
 * barre de contrôle, les raccourcis, les états de chargement — n'a jamais eu à
 * savoir d'où viennent les images, et c'est ce qui a permis d'ajouter HLS ici
 * sans toucher à une seule autre ligne.
 *
 * Ce que ce fichier fait, et que personne d'autre ne fait : décider entre `src`
 * natif et hls.js, et rendre de quoi tout débrancher.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Le navigateur sait-il lire un manifeste HLS sans bibliothèque ? */
function supportsNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/**
 * Réglages hls.js.
 *
 * Le serveur produit les segments à la demande : un segment demandé peut mettre
 * une seconde ou deux à apparaître, le temps que ffmpeg y arrive. Les délais
 * par défaut de hls.js sont taillés pour un CDN qui répond en 50 ms — ils
 * abandonneraient bien trop tôt.
 */
const HLS_CONFIG = {
  // Une seule qualité par session : rien à choisir, rien à estimer.
  enableWorker: true,
  lowLatencyMode: false,
  /*
   * Le serveur relance ffmpeg à la position visée quand on saute loin devant.
   * La requête du segment reste ouverte pendant ce temps, d'où ces délais.
   */
  fragLoadingTimeOut: 40_000,
  fragLoadingMaxRetry: 4,
  fragLoadingRetryDelay: 500,
  manifestLoadingTimeOut: 20_000,
  /*
   * Marge de mémoire tampon. 60 s suffisent largement : au-delà, on ferait
   * produire à ffmpeg des segments que personne ne regardera, sur un NAS qui a
   * mieux à faire.
   */
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  backBufferLength: 30,
};

/**
 * Branche une source sur l'élément, et rend de quoi la débrancher.
 *
 * Le nettoyage compte autant que le branchement : sans lui, l'élément
 * continuerait de télécharger l'ancienne source après un changement d'épisode,
 * et hls.js garderait un lecteur entier en vie.
 */
async function attachSource(video: HTMLVideoElement, source: PlaybackSource): Promise<() => void> {
  /** Débranchement commun à la lecture native, fichier comme HLS Safari. */
  const detachNative = (): void => {
    video.removeAttribute('src');
    // Sans ce load(), Chrome poursuit le téléchargement de l'ancienne source.
    video.load();
  };

  switch (source.type) {
    case 'file': {
      video.src = source.url;
      video.load();
      return detachNative;
    }

    case 'hls': {
      /*
       * Safari et les navigateurs iOS lisent HLS nativement, et bien mieux que
       * n'importe quelle bibliothèque : on les laisse faire, et on n'a alors
       * même pas à télécharger hls.js.
       */
      if (supportsNativeHls(video)) {
        video.src = source.url;
        video.load();
        return detachNative;
      }

      /*
       * Import dynamique : hls.js pèse 525 Ko, soit le double du reste de
       * l'application. Il n'a aucune raison d'être téléchargé par quelqu'un qui
       * parcourt sa bibliothèque sans rien lancer.
       */
      const { default: Hls } = await import('hls.js');

      if (!Hls.isSupported()) {
        throw new Error(
          'Ce navigateur ne sait lire ni les manifestes HLS nativement, ni les ' +
            'Media Source Extensions dont hls.js a besoin.',
        );
      }

      const hls = new Hls(HLS_CONFIG);
      hls.loadSource(source.url);
      hls.attachMedia(video);

      return () => {
        // destroy() coupe les requêtes en cours, libère le worker et détache
        // le média. Rien ne doit survivre à un changement d'épisode.
        hls.destroy();
        detachNative();
      };
    }
  }
}

export interface VideoSurfaceProps {
  source: PlaybackSource;
  subtitles: SubtitleTrack[];
  /** Piste active, ou null pour « Désactivés ». */
  activeSubtitleId: number | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  onAttachError: (message: string) => void;
  className?: string;
}

export function VideoSurface({
  source,
  subtitles,
  activeSubtitleId,
  videoRef,
  onAttachError,
  className,
}: VideoSurfaceProps) {
  const errorHandler = useRef(onAttachError);
  errorHandler.current = onAttachError;

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;

    /*
     * Le branchement est asynchrone — hls.js est chargé à la demande — donc il
     * peut se terminer APRÈS le démontage. Le drapeau garantit qu'on débranche
     * alors immédiatement ce qui vient d'être branché, plutôt que de laisser
     * un lecteur orphelin télécharger dans le vide.
     */
    let cancelled = false;
    let detach: (() => void) | null = null;

    void attachSource(video, source)
      .then((cleanup) => {
        if (cancelled) cleanup();
        else detach = cleanup;
      })
      .catch((error: unknown) => {
        if (!cancelled) errorHandler.current((error as Error).message);
      });

    return () => {
      cancelled = true;
      detach?.();
    };
  }, [source.url, source.type, videoRef]);

  /*
   * Les pistes de texte sont pilotées par leur `mode`, pas par le montage :
   * démonter un `track` actif laisse parfois le rendu à l'écran sous Chrome.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;

    for (const track of Array.from(video.textTracks)) {
      const id = Number(track.id);
      track.mode = activeSubtitleId !== null && id === activeSubtitleId ? 'showing' : 'disabled';
    }
  }, [activeSubtitleId, subtitles, videoRef]);

  return (
    <video
      ref={videoRef}
      className={className}
      // Les contrôles natifs sont remplacés par les nôtres.
      controls={false}
      autoPlay
      playsInline
      preload="auto"
      crossOrigin="anonymous"
    >
      {subtitles.map((track) => (
        <track
          key={track.id}
          id={String(track.id)}
          kind="subtitles"
          src={track.url}
          srcLang={track.language ?? 'und'}
          label={track.label}
        />
      ))}
    </video>
  );
}
