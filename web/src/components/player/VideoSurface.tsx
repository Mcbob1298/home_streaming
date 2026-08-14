import { useEffect, useRef, useState } from 'react';

import type { PlaybackSource, SubtitleOption, SubtitleTrack, TrackOption } from '../../api';

/**
 * Le sous-titre affiché, quelle qu'en soit la provenance.
 *
 * Deux mécanismes coexistent — un fichier `.srt` posé à côté du film devient un
 * élément `track`, une piste de MKV devient un rendu du manifeste — et le reste
 * du lecteur n'a pas à savoir lequel s'applique. Il choisit, VideoSurface
 * exécute.
 */
export type SubtitleChoice =
  | { kind: 'off' }
  | { kind: 'external'; id: number }
  | { kind: 'embedded'; streamIndex: number };

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

/**
 * Les Media Source Extensions sont-elles disponibles ?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * C'EST CETTE QUESTION QUI DÉCIDE, PAS « SAIS-TU LIRE DU HLS ? ».
 *
 * `canPlayType('application/vnd.apple.mpegurl')` rend « maybe » dans Chrome —
 * mesuré sur Chrome 151, Windows. « maybe » veut dire « peut-être », et le code
 * le lisait comme « oui, nativement ». Chrome partait donc en lecture native,
 * hls.js n'était JAMAIS chargé, et le changement de piste audio ne pouvait pas
 * fonctionner : il n'y avait aucune instance à piloter. Vérifié dans le
 * navigateur — zéro appel à `attachMedia`.
 *
 * La vidéo se lisait quand même, ce qui rendait le défaut invisible : Chrome
 * sait désormais lire du HLS tout seul, mais il n'expose pas `audioTracks` sur
 * l'élément vidéo. Une lecture qui marche, sans aucun moyen de changer de piste.
 *
 * On teste donc les MSE, ce dont hls.js a réellement besoin. Là où elles
 * existent — Chrome, Firefox, Edge, Safari de bureau — hls.js pilote, et les
 * pistes sont sélectionnables. Là où elles manquent — Safari iOS — la lecture
 * native prend le relais, et c'est elle qui expose `audioTracks`.
 *
 * Le test se fait SANS charger hls.js : sur iPhone, télécharger 525 Ko pour ne
 * pas s'en servir serait un mauvais échange.
 * ═════════════════════════════════════════════════════════════════════════════
 */
function supportsMse(): boolean {
  return (
    typeof MediaSource !== 'undefined' &&
    typeof MediaSource.isTypeSupported === 'function' &&
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
  );
}

/** Le navigateur sait-il lire un manifeste HLS sans bibliothèque ? */
function supportsNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/**
 * Les pistes audio que l'ÉLÉMENT expose, en lecture native.
 *
 * Déclarée à la main : `HTMLMediaElement.audioTracks` ne figure pas dans la
 * bibliothèque standard de TypeScript, parce que peu de navigateurs
 * l'implémentent. Safari le fait, et c'est le seul qui emprunte ce chemin.
 */
interface NativeAudioTrack {
  enabled: boolean;
}
interface NativeAudioTrackList {
  readonly length: number;
  [index: number]: NativeAudioTrack;
}

function nativeAudioTracks(video: HTMLVideoElement | null): NativeAudioTrackList | null {
  if (video === null) return null;
  const liste = (video as unknown as { audioTracks?: NativeAudioTrackList }).audioTracks;
  return liste ?? null;
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
 * Ce qu'on garde d'une instance hls.js pour piloter ses rendus.
 *
 * Typé à la main plutôt qu'importé : hls.js est chargé dynamiquement, et
 * importer son type au niveau du module ferait entrer les 525 ko dans le
 * paquet principal — exactement ce que l'import dynamique évite.
 */
interface HlsController {
  audioTracks: { id: number; name: string; lang?: string }[];
  subtitleTracks: { id: number; name: string; lang?: string }[];
  audioTrack: number;
  subtitleTrack: number;
}

/**
 * Branche une source sur l'élément, et rend de quoi la débrancher.
 *
 * Le nettoyage compte autant que le branchement : sans lui, l'élément
 * continuerait de télécharger l'ancienne source après un changement d'épisode,
 * et hls.js garderait un lecteur entier en vie.
 */
async function attachSource(
  video: HTMLVideoElement,
  source: PlaybackSource,
  onController: (controller: HlsController | null) => void,
): Promise<() => void> {
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
       * Sans MSE — Safari iOS — la lecture native est la seule voie, et c'est
       * une bonne voie : elle expose `audioTracks` sur l'élément vidéo, donc
       * les pistes restent sélectionnables.
       */
      if (!supportsMse()) {
        if (!supportsNativeHls(video)) {
          throw new Error(
            'Ce navigateur ne sait lire ni les manifestes HLS nativement, ni les ' +
              'Media Source Extensions dont hls.js a besoin.',
          );
        }
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
        if (!supportsNativeHls(video)) {
          throw new Error(
            'Ce navigateur ne sait lire ni les manifestes HLS nativement, ni les ' +
              'Media Source Extensions dont hls.js a besoin.',
          );
        }
        video.src = source.url;
        video.load();
        return detachNative;
      }

      const hls = new Hls(HLS_CONFIG);
      hls.loadSource(source.url);
      hls.attachMedia(video);
      onController(hls as unknown as HlsController);

      /*
       * ───────────────────────────────────────────────────────────────────────
       * LES RENDUS N'EXISTENT PAS ENCORE, ET PAS DAVANTAGE À MANIFEST_PARSED.
       *
       * Mesuré : `audioTracks` reste VIDE à la construction, après
       * `attachMedia`, et même au moment de MANIFEST_PARSED (+19 ms) — elle ne
       * se remplit qu'à AUDIO_TRACKS_UPDATED, une seconde et demie plus tard.
       *
       * Prévenir une seule fois, juste après `attachMedia`, revenait donc à
       * prévenir quand il n'y a rien à choisir : la piste mémorisée n'était
       * jamais appliquée à l'ouverture. On redit donc « voilà le contrôleur »
       * quand les rendus arrivent, ce qui relance l'application du choix.
       * ───────────────────────────────────────────────────────────────────────
       */
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => onController(hls as unknown as HlsController));
      hls.on(Hls.Events.MANIFEST_PARSED, () => onController(hls as unknown as HlsController));

      return () => {
        onController(null);
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
  /** Sous-titres EXTERNES, servis comme éléments `track`. */
  subtitles: SubtitleTrack[];
  /** Pistes audio du manifeste, dans l'ordre où il les déclare. */
  audioTracks: TrackOption[];
  /** Sous-titres EMBARQUÉS, rendus du manifeste, dans le même ordre. */
  embeddedSubtitles: SubtitleOption[];
  /** Piste audio voulue, par son index de flux. */
  audioStream: number | null;
  /** Sous-titre voulu, quelle qu'en soit la provenance. */
  subtitle: SubtitleChoice;
  /** Pour bâtir l URL des sous-titres embarqués. */
  mediaFileId: number;
  videoRef: React.RefObject<HTMLVideoElement>;
  onAttachError: (message: string) => void;
  className?: string;
}

/**
 * Position d'une piste dans le manifeste, à partir de son index de flux.
 *
 * hls.js numérote ses rendus dans l'ordre de déclaration du manifeste, qui est
 * celui de la liste qu'on a construite : la correspondance est donc positionnelle.
 * Rendre -1 quand la piste est introuvable laisse hls.js sur son choix courant,
 * ce qui vaut mieux que de couper le son.
 */
function positionOf(tracks: { streamIndex: number }[], streamIndex: number | null): number {
  if (streamIndex === null) return -1;
  return tracks.findIndex((track) => track.streamIndex === streamIndex);
}

/** URL du WebVTT d'une piste embarquée. Répond 202 tant qu'elle se prépare. */
function subtitleUrl(mediaFileId: number, streamIndex: number): string {
  return `/api/hls/${mediaFileId}/sub-${streamIndex}.vtt`;
}

export function VideoSurface({
  source,
  subtitles,
  audioTracks,
  embeddedSubtitles,
  audioStream,
  subtitle,
  mediaFileId,
  videoRef,
  onAttachError,
  className,
}: VideoSurfaceProps) {
  const errorHandler = useRef(onAttachError);
  errorHandler.current = onAttachError;

  /** L'instance hls.js en cours, quand la source en utilise une. */
  const controller = useRef<HlsController | null>(null);
  /** Incrémenté à chaque branchement, pour réappliquer les choix de piste. */
  const [attached, setAttached] = useState(0);

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

    void attachSource(video, source, (instance) => {
      controller.current = instance;
      /*
       * Le compteur relance l'application des choix. hls.js prévient PLUSIEURS
       * fois — à l'attache, puis quand ses rendus existent enfin — et chaque
       * avis doit compter : c'est le second qui applique la piste mémorisée.
       */
      if (!cancelled && instance !== null) setAttached((count) => count + 1);
    })
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
   * ───────────────────────────────────────────────────────────────────────────
   * CHANGER DE PISTE AUDIO NE RECHARGE RIEN.
   *
   * `hls.audioTrack` remplace le flux audio EN PLACE : la vidéo continue, la
   * position est conservée, seul le tampon audio est reconstruit. C'est
   * précisément ce que le manifeste maître achète — recharger la source
   * repartirait du début.
   *
   * L'écriture est retentée à chaque rendu utile parce que les rendus du
   * manifeste n'existent qu'après son analyse, qui est asynchrone.
   * ───────────────────────────────────────────────────────────────────────────
   */
  useEffect(() => {
    const position = positionOf(audioTracks, audioStream);
    if (position < 0) return;

    const hls = controller.current;
    if (hls !== null) {
      if (position < hls.audioTracks.length && hls.audioTrack !== position) hls.audioTrack = position;
      return;
    }

    /*
     * Lecture native — Safari iOS. `audioTracks` y est une AudioTrackList : on
     * active la piste voulue et on désactive les autres, l'élément se charge du
     * reste. Chrome n'expose pas cette liste, mais Chrome passe par hls.js.
     */
    const liste = nativeAudioTracks(videoRef.current);
    if (liste === null || position >= liste.length) return;
    for (let i = 0; i < liste.length; i += 1) {
      const piste = liste[i];
      if (piste !== undefined) piste.enabled = i === position;
    }
  }, [audioStream, audioTracks, attached, videoRef]);

  /**
   * hls.js ne pilote AUCUN sous-titre : le manifeste n'en déclare pas.
   *
   * Une piste embarquée n'existe qu'une fois extraite, ce qui prend des minutes
   * et arrive pendant la lecture. On la sert donc en élément « track », qui
   * s'attache sans toucher au manifeste. La remise à -1 défait ce qu'une
   * version précédente du manifeste aurait pu sélectionner.
   */
  useEffect(() => {
    const hls = controller.current;
    if (hls !== null && hls.subtitleTrack !== -1) hls.subtitleTrack = -1;
  }, [attached]);

  /*
   * Sous-titres EXTERNES : pilotés par leur `mode`, pas par le montage —
   * démonter un `track` actif laisse parfois le rendu à l'écran sous Chrome.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;

    /*
     * Les deux origines vivent dans le même espace de noms : « x- » pour un
     * fichier externe, « e- » pour une piste embarquée. Un préfixe plutôt qu'un
     * nombre, parce que l'identifiant d'un sous-titre externe et l'index de flux
     * d'une piste embarquée se recouvrent sans désigner la même chose.
     */
    const active =
      subtitle.kind === 'external'
        ? 'x-' + String(subtitle.id)
        : subtitle.kind === 'embedded'
          ? 'e-' + String(subtitle.streamIndex)
          : null;

    for (const track of Array.from(video.textTracks)) {
      if (track.id === '') continue;
      track.mode = track.id === active ? 'showing' : 'disabled';
    }
  }, [subtitle, subtitles, embeddedSubtitles, videoRef]);

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
      {/*
        Toutes les pistes sont servables : si ce titre est proposé, c'est que sa
        préparation est finie. Le « track » pointe sur un fichier WebVTT déjà
        écrit, que le serveur renvoie en quelques dizaines de millisecondes.
      */}
      {embeddedSubtitles.map((track) => (
        <track
          key={'e-' + String(track.streamIndex)}
          id={'e-' + String(track.streamIndex)}
          kind="subtitles"
          src={subtitleUrl(mediaFileId, track.streamIndex)}
          srcLang={track.language ?? 'und'}
          label={track.label}
        />
      ))}

      {subtitles.map((track) => (
        <track
          key={'x-' + String(track.id)}
          id={'x-' + String(track.id)}
          kind="subtitles"
          src={track.url}
          srcLang={track.language ?? 'und'}
          label={track.label}
        />
      ))}
    </video>
  );
}
