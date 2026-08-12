import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { api, type Playability } from '../api';
import { PlayerChrome } from '../components/player/PlayerChrome';
import { VideoSurface } from '../components/player/VideoSurface';
import {
  IDLE_MS,
  actionForKey,
  isTypingTarget,
  seekTo,
  volumeAfter,
} from '../components/player/playerControls';
import { resumeAt, usableDuration } from '../components/player/progressReporting';
import { useProgressReporting } from '../components/player/useProgressReporting';
import { ErrorMessage, Loading } from '../components/States';

/**
 * Page de lecture, plein écran et fond noir.
 *
 * Le lecteur reçoit une SOURCE, jamais un chemin : la décision de lecture est
 * prise par le serveur et transportée par la route de playability. Le
 * branchement de cette source vit dans VideoSurface, et nulle part ailleurs.
 *
 * Cette étape ne lit que les fichiers qui partent tels quels dans un navigateur
 * — MP4 + H.264 + AAC, 143 sur 2796. Tout le reste s'ouvre quand même et
 * affiche pourquoi il n'est pas lisible : naviguer vers une impasse muette
 * serait pire que d'expliquer.
 */
export function WatchPage() {
  const { mediaFileId = '' } = useParams();
  const [search] = useSearchParams();

  /*
   * `?t=` impose le point de départ et l'emporte sur la position enregistrée.
   * C'est ce qui fait marcher « Depuis le début » (`?t=0`) sans avoir à effacer
   * la progression : on repart de zéro, mais l'entrée reste dans la rangée.
   */
  const requested = Number(search.get('t'));
  const startOverride = search.has('t') && Number.isFinite(requested) && requested >= 0 ? requested : null;

  const playability = useQuery({
    queryKey: ['playability', mediaFileId],
    queryFn: () => api.playability(mediaFileId),
    // La décision dépend de l'état de la base ; la revalider au retour de
    // l'onglet relancerait la vidéo pour rien.
    refetchOnWindowFocus: false,
  });

  if (playability.isPending) return <Shell><Loading /></Shell>;
  if (playability.error !== null) {
    return (
      <Shell>
        <div className="mx-auto max-w-xl px-8 text-center">
          <ErrorMessage error={playability.error} />
          <BackLink />
        </div>
      </Shell>
    );
  }

  const data = playability.data;
  // `direct` part tel quel, `remux` passe par un manifeste HLS. Le lecteur ne
  // fait pas la différence : il reçoit une source, pas un chemin.
  if (data.source === null) return <Unsupported data={data} />;

  // La clé force un remontage complet au changement d'épisode : l'état du
  // lecteur — position, tampon, piste active — n'a aucune raison de survivre.
  return <Player key={data.mediaFileId} data={data} startAt={startOverride ?? data.resumeSeconds} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-black text-texte">{children}</div>;
}

function BackLink() {
  return (
    <Link
      to="/"
      className="mt-6 inline-block rounded border border-[rgba(249,249,249,0.3)] px-5 py-2 text-[13px] font-semibold tracking-[0.16em] text-texte uppercase transition-colors hover:border-texte"
    >
      Revenir à l’accueil
    </Link>
  );
}

/**
 * Fichier non lisible : on dit POURQUOI, et quand ce sera résolu.
 *
 * Le message vient du serveur, qui a les codecs sous la main. Le retour à la
 * fiche est proposé plutôt qu'un cul-de-sac.
 */
function Unsupported({ data }: { data: Playability }) {
  const backTo =
    data.media === null
      ? '/'
      : data.media.kind === 'movie'
        ? `/movie/${data.media.workId}`
        : `/show/${data.media.workId}`;

  return (
    <Shell>
      <div className="mx-auto max-w-2xl px-8 py-24 text-center">
        <h1 className="text-[26px] font-bold">
          {data.media?.title ?? 'Ce fichier'}
          {data.media?.subtitle !== null && data.media?.subtitle !== undefined && (
            <span className="block pt-1 text-[16px] font-normal text-faible">{data.media.subtitle}</span>
          )}
        </h1>

        <p className="mt-6 text-[16px] leading-[1.7] text-[rgba(249,249,249,0.86)]">{data.reason}</p>

        <p className="mt-4 text-[14px] leading-[1.7] text-faible">
          La lecture de ces formats arrivera à l’étape suivante, avec le transcodage. Pour l’instant, seuls
          les fichiers MP4 en H.264 et AAC sont lisibles.
        </p>

        <dl className="mt-8 inline-grid grid-cols-2 gap-x-8 gap-y-2 text-left text-[13px]">
          <dt className="text-faible">Conteneur</dt>
          <dd className="font-semibold">{data.container ?? 'inconnu'}</dd>
          <dt className="text-faible">Codec vidéo</dt>
          <dd className="font-semibold">{data.videoCodec ?? 'inconnu'}</dd>
          <dt className="text-faible">Codec audio</dt>
          <dd className="font-semibold">{data.audioCodec ?? 'inconnu'}</dd>
        </dl>

        <div>
          <Link
            to={backTo}
            className="mt-8 inline-block rounded border border-[rgba(249,249,249,0.3)] px-5 py-2 text-[13px] font-semibold tracking-[0.16em] text-texte uppercase transition-colors hover:border-texte"
          >
            Revenir à la fiche
          </Link>
        </div>
      </div>
    </Shell>
  );
}

function Player({ data, startAt }: { data: Playability; startAt: number }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const video = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);

  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(data.media?.durationSeconds ?? null);
  const [buffered, setBuffered] = useState(0);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [activeSubtitleId, setActiveSubtitleId] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  // --- Effacement des contrôles -------------------------------------------
  const idleTimer = useRef<number | undefined>(undefined);

  const wake = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setControlsVisible(false), IDLE_MS);
  }, []);

  useEffect(() => {
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [wake]);

  // --- Commandes ----------------------------------------------------------
  const toggle = useCallback(() => {
    const node = video.current;
    if (node === null) return;
    if (node.paused) void node.play().catch(() => undefined);
    else node.pause();
  }, []);

  const seek = useCallback((seconds: number) => {
    const node = video.current;
    if (node === null) return;
    node.currentTime = seconds;
  }, []);

  const seekBy = useCallback(
    (delta: number) => {
      const node = video.current;
      if (node === null) return;
      seek(seekTo(node.currentTime, delta, Number.isFinite(node.duration) ? node.duration : null));
    },
    [seek],
  );

  const changeVolume = useCallback((value: number) => {
    const node = video.current;
    if (node === null) return;
    node.volume = value;
    // Monter le son sur une vidéo coupée doit la rétablir, sinon le réglage
    // n'a aucun effet audible et paraît cassé.
    if (value > 0) node.muted = false;
  }, []);

  const toggleMute = useCallback(() => {
    const node = video.current;
    if (node === null) return;
    node.muted = !node.muted;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const node = container.current;
    if (node === null) return;
    if (document.fullscreenElement === null) void node.requestFullscreen().catch(() => undefined);
    else void document.exitFullscreen().catch(() => undefined);
  }, []);

  /** Échap quitte le plein écran, puis revient en arrière. */
  const escape = useCallback(() => {
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void navigate(-1);
  }, [navigate]);

  const goNext = useCallback(() => {
    if (data.next === null) return;
    void navigate(`/watch/${data.next.mediaFileId}`, { replace: true });
  }, [data.next, navigate]);

  // --- Raccourcis clavier --------------------------------------------------
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target as HTMLElement | null)) return;

      const action = actionForKey(event);
      if (action === null) return;

      event.preventDefault();
      wake();

      const node = video.current;
      switch (action.kind) {
        case 'toggle':
          toggle();
          break;
        case 'seek':
          seekBy(action.delta);
          break;
        case 'seekRatio':
          if (node !== null && Number.isFinite(node.duration)) seek(action.ratio * node.duration);
          break;
        case 'volume':
          if (node !== null) changeVolume(volumeAfter(node.volume, action.delta));
          break;
        case 'mute':
          toggleMute();
          break;
        case 'fullscreen':
          toggleFullscreen();
          break;
        case 'escape':
          escape();
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle, seek, seekBy, changeVolume, toggleMute, toggleFullscreen, escape, wake]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /*
   * Prévenir le serveur qu'on s'en va.
   *
   * C'est le plus rapide des trois filets contre le ffmpeg orphelin : sans lui,
   * la session survivrait jusqu'au balayage. `sendBeacon` part même si l'onglet
   * se ferme, ce qu'un fetch ordinaire ne garantit pas.
   */
  useEffect(() => {
    if (data.source?.type !== 'hls') return;
    const url = `/api/hls/${data.mediaFileId}/session`;

    const end = () => {
      // sendBeacon ne fait que des POST : le DELETE part en fetch keepalive,
      // et le beacon sert de repli quand l'onglet se ferme brutalement.
      void fetch(url, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    };

    window.addEventListener('pagehide', end);
    return () => {
      window.removeEventListener('pagehide', end);
      end();
    };
  }, [data.mediaFileId, data.source?.type]);

  // --- Suivi de l'élément vidéo -------------------------------------------
  useEffect(() => {
    const node = video.current;
    if (node === null) return;

    const onTime = () => {
      setCurrentTime(node.currentTime);
      // La plage tamponnée qui contient la tête de lecture est la seule qui
      // compte : un saut en avant en crée d'autres, sans rapport.
      for (let index = 0; index < node.buffered.length; index += 1) {
        if (node.buffered.start(index) <= node.currentTime && node.currentTime <= node.buffered.end(index)) {
          setBuffered(node.buffered.end(index));
          return;
        }
      }
    };
    const onMeta = () => setDuration(Number.isFinite(node.duration) ? node.duration : null);
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    const onVolume = () => {
      setVolume(node.volume);
      setMuted(node.muted);
    };
    const onReady = () => setReady(true);
    const onError = () => {
      const code = node.error?.code;
      setFailure(
        code === MediaError.MEDIA_ERR_NETWORK
          ? 'La connexion au serveur a été interrompue. Vérifier que le partage est monté, puis recharger la page.'
          : code === MediaError.MEDIA_ERR_DECODE
            ? 'Le navigateur n’a pas réussi à décoder ce fichier, alors que ses codecs sont annoncés comme lisibles. Il est probablement abîmé.'
            : 'Ce fichier n’a pas pu être lu. Il a peut-être disparu du disque depuis le dernier scan.',
      );
    };

    node.addEventListener('timeupdate', onTime);
    node.addEventListener('progress', onTime);
    node.addEventListener('loadedmetadata', onMeta);
    node.addEventListener('play', onPlay);
    node.addEventListener('pause', onPause);
    node.addEventListener('volumechange', onVolume);
    node.addEventListener('loadeddata', onReady);
    node.addEventListener('playing', onReady);
    node.addEventListener('error', onError);

    return () => {
      node.removeEventListener('timeupdate', onTime);
      node.removeEventListener('progress', onTime);
      node.removeEventListener('loadedmetadata', onMeta);
      node.removeEventListener('play', onPlay);
      node.removeEventListener('pause', onPause);
      node.removeEventListener('volumechange', onVolume);
      node.removeEventListener('loadeddata', onReady);
      node.removeEventListener('playing', onReady);
      node.removeEventListener('error', onError);
    };
  }, []);

  /*
   * Reprise : la tête de lecture est posée AVANT la première image.
   *
   * `loadedmetadata` est le premier instant où `currentTime` est modifiable, et
   * il précède le décodage : le spectateur ne voit donc jamais le début du
   * fichier avant le saut. Le drapeau garantit qu'on ne le fait qu'une fois —
   * l'événement se répète sur un manifeste HLS à chaque changement de niveau,
   * et la lecture reviendrait alors sans cesse au point de reprise.
   */
  const resumed = useRef(false);
  useEffect(() => {
    const node = video.current;
    if (node === null) return;

    const apply = () => {
      if (resumed.current) return;
      resumed.current = true;
      const seconds = resumeAt(startAt, usableDuration(node.duration));
      if (seconds > 0) node.currentTime = seconds;
    };

    // La métadonnée peut être déjà là quand l'effet s'exécute.
    if (node.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    node.addEventListener('loadedmetadata', apply);
    return () => node.removeEventListener('loadedmetadata', apply);
  }, [startAt]);

  /*
   * Enregistrement de la progression. Le lecteur n'en sait rien de plus : il
   * donne sa position, le serveur en tire l'état « vu ».
   */
  const onWatched = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['progress'] });
  }, [queryClient]);

  useProgressReporting(data.mediaFileId, video, onWatched);

  const backdrop = data.media?.backdropPath ?? null;

  return (
    <div
      ref={container}
      onMouseMove={wake}
      onTouchStart={wake}
      className="relative h-screen w-screen overflow-hidden bg-black"
    >
      {/*
        Pendant la mise en tampon, le backdrop occupe l'écran et s'efface quand
        la première image est décodée : un écran noir vide donnerait
        l'impression que rien ne se passe.
      */}
      {backdrop !== null && (
        <div
          aria-hidden="true"
          className={`absolute inset-0 transition-opacity duration-500 motion-reduce:transition-none ${
            ready ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <img
            src={backdrop}
            srcSet={data.media?.backdropSrcSet ?? undefined}
            sizes="100vw"
            alt=""
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-[rgba(0,0,0,0.45)]" />
        </div>
      )}

      {!ready && failure === null && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <Spinner />
        </div>
      )}

      <VideoSurface
        source={data.source as NonNullable<Playability['source']>}
        subtitles={data.subtitles}
        activeSubtitleId={activeSubtitleId}
        videoRef={video}
        onAttachError={setFailure}
        className={`h-full w-full transition-opacity duration-500 motion-reduce:transition-none ${
          ready ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Cliquer sur l'image met en pause, comme partout ailleurs. */}
      <button
        type="button"
        onClick={toggle}
        onDoubleClick={toggleFullscreen}
        aria-label={paused ? 'Lire' : 'Mettre en pause'}
        className="absolute inset-0 z-10 cursor-default outline-none"
        tabIndex={-1}
      />

      {failure !== null && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(0,0,0,0.86)] px-8">
          <div className="max-w-xl text-center">
            <p className="text-[17px] leading-[1.7] text-texte">{failure}</p>
            <BackLink />
          </div>
        </div>
      )}

      <PlayerChrome
        visible={controlsVisible || paused}
        title={data.media?.title ?? 'Lecture'}
        subtitle={data.media?.subtitle ?? null}
        paused={paused}
        muted={muted}
        volume={volume}
        currentTime={currentTime}
        duration={duration}
        buffered={buffered}
        subtitles={data.subtitles}
        activeSubtitleId={activeSubtitleId}
        next={data.next}
        fullscreen={fullscreen}
        onBack={escape}
        onToggle={toggle}
        onSeek={seek}
        onSeekBy={seekBy}
        onVolume={changeVolume}
        onMute={toggleMute}
        onFullscreen={toggleFullscreen}
        onSubtitle={setActiveSubtitleId}
        onNext={goNext}
      />
    </div>
  );
}

/** Indicateur discret : un anneau qui tourne, rien de plus. */
function Spinner() {
  return (
    <div
      role="status"
      aria-label="Chargement"
      className="h-11 w-11 animate-spin rounded-full border-2 border-[rgba(249,249,249,0.25)] border-t-texte motion-reduce:animate-none"
    />
  );
}
