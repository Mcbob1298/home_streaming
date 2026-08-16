/**
 * Routes HLS : manifeste maître, playlists de rendus, segments, sous-titres.
 *
 * Le manifeste est publié COMPLET dès la première requête, calculé à partir de
 * la durée déjà en base. Le lecteur peut donc viser n'importe quelle position,
 * y compris une qui n'est pas encore produite : c'est alors au serveur de
 * relancer ffmpeg là-bas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * L'ARBORESCENCE DES URL, ET POURQUOI ELLE EST RELATIVE.
 *
 *   index.m3u8            manifeste maître (ou playlist de média, voir plus bas)
 *   video.m3u8            playlist de la vidéo
 *   init.mp4              en-tête fMP4 de la vidéo
 *   seg-00042.m4s         segment vidéo
 *   audio-1.m3u8          playlist du rendu audio du flux 1
 *   a-1/init.mp4          en-tête fMP4 de ce rendu
 *   a-1/seg-00042.m4s     segment de ce rendu
 *   sub-8.m3u8            playlist du sous-titre du flux 8
 *   sub-8.vtt             le WebVTT lui-même
 *
 * Toutes les références internes sont RELATIVES : un manifeste servi derrière
 * un proxy qui réécrit le préfixe reste valide sans que rien ne le sache.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';

import type { FastifyInstance, FastifyReply } from 'fastify';

import { AUDIO_DIR, loadConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { staticInit, staticSegment, usableAudio } from '../transcode/audioStore.js';
import { clientDecodesHevc } from '../playback/capacites.js';
import { findMedia, resolvePlayback, type MediaRow, type ResolvedPlayback } from '../playback/resolve.js';
import { outputGeometry } from '../transcode/encode.js';
import { buildMasterPlaylist, estimateBandwidth, needsMaster } from '../transcode/manifest.js';
import type { SessionManager } from '../transcode/manager.js';
import { hdrPassthroughFor } from '../transcode/passthrough.js';
import { buildPlaylist, buildSubtitlePlaylist, segmentFileName, type PlannedSegment } from '../transcode/segments.js';
import { lireTimescale, rendreAbsolu, TETE_OCTETS } from '../transcode/tfdt.js';
import { AUDIO_BITRATE_BPS, readSubtitleTrack } from '../transcode/subtitles.js';
import { streamUrlOf } from './stream.js';

/**
 * Résout une lecture pour les routes HLS.
 *
 * La décision, le plan et les paramètres de session viennent tous de la même
 * fonction que la route de playability : deux résolutions divergentes
 * produiraient un manifeste que la session ne sait pas honorer.
 */
async function resolve(
  db: Db,
  manager: SessionManager,
  media: MediaRow,
  hevc: boolean,
): Promise<ResolvedPlayback> {
  return resolvePlayback(
    db,
    manager.ffmpegBinary,
    media,
    { file: streamUrlOf(media.id), hls: hlsUrlOf(media.id) },
    { transcodeAvailable: true, clientDecodesHevc: hevc },
  );
}

function readId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Index de flux : entier positif ou nul — le flux 0 est la vidéo. */
function readStreamIndex(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** URL du manifeste d'un fichier. Point d'entrée du lecteur. */
export function hlsUrlOf(mediaFileId: number): string {
  return `/api/hls/${mediaFileId}/index.m3u8`;
}

/** Les URL internes du manifeste, toutes relatives à `index.m3u8`. */
const URLS = {
  video: 'video.m3u8',
  audio: (streamIndex: number) => `audio-${streamIndex}.m3u8`,
  subtitle: (streamIndex: number) => `sub-${streamIndex}.m3u8`,
};

/**
 * Sert un fichier du répertoire de travail.
 *
 * Ces fichiers sont éphémères et propres à une session : le navigateur ne doit
 * surtout pas les garder en cache, il rejouerait un segment d'une session morte
 * après une relance de ffmpeg à une autre position.
 */
async function sendWorkFile(reply: FastifyReply, file: string, contentType: string): Promise<unknown> {
  const stats = await stat(file);
  void reply.header('Content-Type', contentType);
  void reply.header('Content-Length', stats.size);
  void reply.header('Cache-Control', 'no-store');
  return reply.send(createReadStream(file));
}

/**
 * Cadence des pistes, par en-tête, invalidée par la date du fichier.
 *
 * Un en-tête pèse un kilo-octet et ne change qu'à la relance d'une exécution ;
 * le relire à chaque segment serait un accès disque pour rien.
 */
const CADENCES = new Map<string, { mtimeMs: number; timescale: number | null }>();

async function timescaleDe(initPath: string): Promise<number | null> {
  try {
    const stats = await stat(initPath);
    const connue = CADENCES.get(initPath);
    if (connue !== undefined && connue.mtimeMs === stats.mtimeMs) return connue.timescale;

    const timescale = lireTimescale(await readFile(initPath));
    CADENCES.set(initPath, { mtimeMs: stats.mtimeMs, timescale });
    return timescale;
  } catch {
    return null;
  }
}

/**
 * Sert un fragment en GARANTISSANT que son horodatage est absolu.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * L'invariant est posé ici, au plus près du réseau, parce que c'est le seul
 * endroit qui voie passer TOUS les fragments : ceux d'une exécution vivante,
 * ceux d'un prélude, ceux du magasin audio pré-généré. Le détail du pourquoi est
 * dans `tfdt.ts`.
 *
 * Seuls les premiers kilo-octets sont lus et réécrits — le `moof` est en tête de
 * fragment. Le reste est diffusé sans jamais passer en mémoire : un segment
 * vidéo pèse trois mégaoctets et il en part un toutes les quatre secondes de
 * lecture.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function sendFragment(
  reply: FastifyReply,
  file: string,
  initPath: string,
  plan: PlannedSegment[],
  debutDeclare: number,
): Promise<unknown> {
  const timescale = await timescaleDe(initPath);
  // Sans cadence, on ne sait pas interpréter `tfdt` : servir tel quel vaut mieux
  // que réécrire au hasard.
  if (timescale === null) return sendWorkFile(reply, file, 'video/iso.segment');

  const stats = await stat(file);
  const handle = await open(file, 'r');

  try {
    const longueur = Math.min(TETE_OCTETS, stats.size);
    const tete = Buffer.alloc(longueur);
    await handle.read(tete, 0, longueur, 0);
    rendreAbsolu(tete, timescale, debutDeclare, plan);

    void reply.header('Content-Type', 'video/iso.segment');
    // La correction se fait en place : la taille ne bouge pas.
    void reply.header('Content-Length', stats.size);
    void reply.header('Cache-Control', 'no-store');

    const reste = handle.createReadStream({ start: longueur, autoClose: true });
    const sortie = new PassThrough();
    sortie.write(tete);
    reste.pipe(sortie);
    // Un lecteur qui abandonne en cours de route ne doit pas laisser le fichier
    // ouvert derrière lui.
    sortie.on('close', () => reste.destroy());
    reste.on('error', (error) => sortie.destroy(error));

    return reply.send(sortie);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function sendPlaylist(reply: FastifyReply, body: string): string {
  void reply.header('Content-Type', 'application/vnd.apple.mpegurl');
  void reply.header('Cache-Control', 'no-store');
  return body;
}

export function registerHlsRoutes(app: FastifyInstance, db: Db, sessions: () => SessionManager | null): void {
  /** Le manifeste et les segments n'existent que si ffmpeg a été trouvé. */
  function requireManager(reply: FastifyReply): SessionManager | null {
    const manager = sessions();
    if (manager === null) {
      void reply.code(503).send({
        error:
          'ffmpeg est introuvable sur le serveur : aucun remux n’est possible. ' +
          'Renseigner FFMPEG_PATH dans .env, puis relancer le serveur.',
      });
      return null;
    }
    return manager;
  }

  /**
   * Préambule commun : le manager, le fichier, la résolution.
   *
   * Toutes les routes en ont besoin, et aucune ne doit s'en passer — c'est la
   * résolution qui garantit que le manifeste et la session parlent des mêmes
   * segments.
   */
  async function context(
    request: { params: unknown; headers: Record<string, unknown> },
    reply: FastifyReply,
  ): Promise<{
    manager: SessionManager;
    media: MediaRow;
    resolved: ResolvedPlayback;
    id: number;
    hevc: boolean;
  } | null> {
    const manager = requireManager(reply);
    if (manager === null) return null;

    const id = readId((request.params as { id: string }).id);
    if (id === null) {
      void reply.code(400).send({ error: 'Identifiant de fichier invalide.' });
      return null;
    }

    const media = findMedia(db, id);
    if (media === undefined) {
      void reply.code(404).send({ error: 'Ce fichier n’est pas dans l’index, ou il n’est plus sur le disque.' });
      return null;
    }

    /*
     * La capacité est lue sur CHAQUE requête, pas seulement sur le manifeste.
     * Une seule route qui l'oublierait recréerait la session dans l'autre codec
     * au milieu d'une lecture, et le lecteur recevrait des segments que son
     * en-tête ne décrit pas.
     */
    const hevc = clientDecodesHevc(request.headers);

    return { manager, media, resolved: await resolve(db, manager, media, hevc), id, hevc };
  }

  /** La session du fichier, créée au besoin avec tout ce qu'il faut produire. */
  async function acquire(manager: SessionManager, media: MediaRow, resolved: ResolvedPlayback, hevc: boolean) {
    // La règle vit dans `passthrough.ts`, partagée avec la fabrication des
    // préludes : deux définitions divergeraient au premier changement.
    const hdrPassthrough = hdrPassthroughFor({
      clientDecodesHevc: hevc,
      source: resolved.source,
      mode: resolved.decision.mode === 'transcode' ? 'transcode' : 'remux',
    });

    return manager.acquire({
      mediaFileId: media.id,
      inputPath: media.rawPath ?? media.path,
      sizeBytes: media.sizeBytes,
      mtimeMs: media.mtimeMs,
      plan: resolved.plan,
      mode: resolved.decision.mode === 'transcode' ? 'transcode' : 'remux',
      source: resolved.source,
      ...(hdrPassthrough ? { hdrPassthrough: true } : {}),
      muxedAudio: resolved.muxedAudio,
      audioPlan: resolved.audioPlan,
      audioRenditions: resolved.audioRenditions,
    });
  }

  /** Message unique quand la découpe est impossible. */
  function planFailure(resolved: ResolvedPlayback): string {
    return resolved.decision.mode === 'unsupported'
      ? resolved.decision.reason
      : 'Le découpage de ce fichier est impossible : sa durée est inconnue, ou ffprobe n’y a ' +
          'trouvé aucune image clé. Lancer « npm run probe » puis réessayer.';
  }

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/index.m3u8 — maître, ou playlist de média
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/index.m3u8', async (request, reply) => {
    const found = await context(request, reply);
    if (found === null) return reply;
    const { manager, media, resolved, id } = found;

    if (resolved.plan.length === 0) return reply.code(409).send({ error: planFailure(resolved) });

    /*
     * La session démarre DÈS la demande du manifeste, sans attendre la première
     * requête de segment : ffmpeg a ainsi une longueur d'avance sur le lecteur,
     * qui met de toute façon quelques dizaines de millisecondes à analyser le
     * manifeste avant de réclamer le segment zéro.
     */
    const session = await acquire(manager, media, resolved, found.hevc);
    if (session.status.state === 'idle') void session.startAt(0);

    /*
     * Un fichier à une seule piste audio et sans sous-titre exposable n'a rien
     * à déclarer : on lui sert directement sa playlist de média, comme avant.
     * La couche supplémentaire ne lui coûterait qu'un aller-retour HTTP.
     */
    if (!needsMaster(resolved.tracks.audio.length, 0)) {
      return sendPlaylist(reply, videoPlaylist(id, resolved));
    }

    /*
     * ─────────────────────────────────────────────────────────────────────────
     * LE MANIFESTE NE DÉCLARE AUCUN SOUS-TITRE. C'EST VOULU.
     *
     * Un rendu EXT-X-MEDIA doit exister au moment où le manifeste est publié.
     * Or une extraction traverse le fichier entier — plus de cinq minutes sur un
     * remux 4K — et les pistes deviennent disponibles une par une, PENDANT la
     * lecture. Les déclarer d'avance ferait attendre le lecteur sur un fichier
     * qui n'arrive pas ; les déclarer au fur et à mesure imposerait de republier
     * le manifeste, donc d'interrompre la lecture.
     *
     * Les sous-titres passent donc par des éléments « track », que le lecteur
     * attache et détache quand il veut sans rien recharger. Même chemin pour la
     * lecture directe et pour HLS, un seul mécanisme à comprendre.
     *
     * C'est un revirement assumé de la décision du palier 3, dicté par le coût
     * réel de l'extraction, qui n'était alors pas mesuré.
     * ─────────────────────────────────────────────────────────────────────────
     */
    /*
     * Les dimensions et le débit ANNONCÉS sont ceux que l'encodeur PRODUIT.
     *
     * Ils étaient calculés ici indépendamment, et ils avaient divergé : le
     * manifeste d'Avatar annonçait 6,2 Mbps pour un flux à 20, et la résolution
     * de la SOURCE plutôt que celle de la sortie — donc fausse aussi sur le
     * chemin tone-mappé, qui réduit à 1080p sans le dire. `outputGeometry` est
     * désormais l'unique autorité, partagée avec `buildTranscodeArgs`.
     */
    const mode = resolved.decision.mode === 'transcode' ? 'transcode' : 'remux';
    const sortie = outputGeometry({
      sourceWidth: resolved.source.width,
      sourceHeight: resolved.source.height,
      hardware: manager.hardware,
      hdrMaxHeight: manager.hdrMaxHeight,
      mode,
      sourceBitrate: media.bitrate,
      hdrPassthrough: hdrPassthroughFor({ clientDecodesHevc: found.hevc, source: resolved.source, mode }),
    });

    return sendPlaylist(
      reply,
      buildMasterPlaylist(URLS, {
        audio: resolved.audioRenditions.length === 0 ? [] : resolved.tracks.audio,
        defaultAudio: resolved.tracks.defaultAudio,
        subtitles: [],
        bandwidth: estimateBandwidth(sortie.bitrate, AUDIO_BITRATE_BPS),
        width: sortie.width,
        height: sortie.height,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/video.m3u8 — la playlist de la vidéo
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/video.m3u8', async (request, reply) => {
    const found = await context(request, reply);
    if (found === null) return reply;
    const { manager, media, resolved, id } = found;

    if (resolved.plan.length === 0) return reply.code(409).send({ error: planFailure(resolved) });

    const session = await acquire(manager, media, resolved, found.hevc);
    if (session.status.state === 'idle') void session.startAt(0);

    return sendPlaylist(reply, videoPlaylist(id, resolved));
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/audio-:stream.m3u8 — la playlist d'un rendu audio
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/audio-:stream.m3u8', async (request, reply) => {
    const found = await context(request, reply);
    if (found === null) return reply;
    const { resolved, id } = found;

    const stream = readStreamIndex((request.params as { stream: string }).stream);
    if (stream === null) return reply.code(400).send({ error: 'Index de piste audio invalide.' });

    // Une piste absente du manifeste n'a pas de playlist : mieux vaut un 404
    // franc qu'un manifeste vide que le lecteur attendrait.
    if (!resolved.audioRenditions.some((track) => track.streamIndex === stream)) {
      return reply.code(404).send({ error: `Aucun rendu audio pour le flux ${stream}.` });
    }

    return sendPlaylist(
      reply,
      buildPlaylist(resolved.audioPlan, {
        init: `a-${stream}/init.mp4`,
        segment: (index) => `a-${stream}/${segmentFileName(index)}`,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/sub-:stream.m3u8 — la playlist d'un sous-titre
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/sub-:stream.m3u8', async (request, reply) => {
    const found = await context(request, reply);
    if (found === null) return reply;
    const { media, resolved } = found;

    const stream = readStreamIndex((request.params as { stream: string }).stream);
    if (stream === null) return reply.code(400).send({ error: 'Index de sous-titre invalide.' });

    if (!resolved.tracks.subtitles.some((track) => track.streamIndex === stream)) {
      return reply.code(404).send({ error: `Aucun sous-titre exposé pour le flux ${stream}.` });
    }

    return sendPlaylist(reply, buildSubtitlePlaylist(media.durationSeconds ?? 0, `sub-${stream}.vtt`));
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/sub-:stream.vtt — le sous-titre, extrait et converti
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/sub-:stream.vtt', async (request, reply) => {
    const manager = requireManager(reply);
    if (manager === null) return reply;

    const parameters = request.params as { id: string; stream: string };
    const id = readId(parameters.id);
    const stream = readStreamIndex(parameters.stream);
    if (id === null || stream === null) {
      return reply.code(400).send({ error: 'Identifiant de fichier ou de piste invalide.' });
    }

    const media = findMedia(db, id);
    if (media === undefined) return reply.code(404).send({ error: 'Fichier inconnu.' });

    const result = await readSubtitleTrack(db, manager.subtitleCacheDir, media, stream);
    if (result.kind === 'unknown') {
      return reply.code(404).send({ error: `Aucun sous-titre texte pour le flux ${stream}.` });
    }
    if (result.kind === 'failed') {
      return reply.code(503).send({ error: result.reason });
    }
    if (result.kind === 'absent') {
      /*
       * Ne devrait pas arriver : un titre non préparé n'est pas proposé. Si on
       * y arrive quand même — cache effacé à la main, fichier remplacé entre
       * l'affichage et le clic — on le dit franchement plutôt que de lancer une
       * extraction de seize minutes dans une requête HTTP.
       */
      /*
       * Le message désigne la PAGE, pas la commande. Renvoyer vers un terminal
       * quand un bouton existe fait ouvrir un terminal pour rien — et la page
       * dit en plus où en est la préparation, ce que la commande ne montre
       * qu'une fois relancée.
       */
      return reply.code(409).send({
        error:
          'Les sous-titres de ce fichier ne sont pas encore préparés. La page « Préparation » ' +
          'montre l’avancement et permet de relancer ce qui manque.',
      });
    }

    void reply.header('Content-Type', 'text/vtt; charset=utf-8');
    /*
     * Un sous-titre préparé ne change plus jamais : il est produit une fois pour
     * une version du fichier, et une nouvelle version produit une nouvelle
     * préparation. Le navigateur peut donc le garder longtemps.
     */
    void reply.header('Cache-Control', 'private, max-age=86400');
    return result.vtt;
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/init.mp4 — en-tête fMP4 de la vidéo
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/init.mp4', async (request, reply) => {
    const found = await context(request, reply);
    if (found === null) return reply;
    const { manager, media, resolved } = found;

    const session = await acquire(manager, media, resolved, found.hevc);
    const file = await session.ensureInit();
    if (file === null) {
      return reply.code(503).send({ error: session.status.error ?? 'ffmpeg n’a pas produit l’en-tête.' });
    }

    return sendWorkFile(reply, file, 'video/mp4');
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/seg-NNNNN.m4s — un segment vidéo, produit à la demande
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/seg-:index.m4s', async (request, reply) => {
    const found = await context(request, reply);
    if (found === null) return reply;
    const { manager, media, resolved } = found;

    const index = Number((request.params as { index: string }).index);
    if (!Number.isSafeInteger(index) || index < 0) {
      return reply.code(400).send({ error: 'Numéro de segment invalide.' });
    }
    if (index >= resolved.plan.length) return reply.code(404).send({ error: 'Segment hors du fichier.' });

    const session = await acquire(manager, media, resolved, found.hevc);
    const file = await session.ensureSegment(index);
    if (file === null) {
      return reply.code(503).send({
        error: session.status.error ?? `Le segment ${index} n’a pas pu être produit à temps.`,
      });
    }

    return sendFragment(
      reply,
      file,
      session.videoInitPath(),
      resolved.plan,
      (resolved.plan[index] as { start: number }).start,
    );
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/a-:stream/init.mp4 — en-tête d'un rendu audio
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/a-:stream/init.mp4', async (request, reply) => {
    const found = await context(request, reply);
    if (found === null) return reply;
    const { manager, media, resolved } = found;

    const stream = readStreamIndex((request.params as { stream: string }).stream);
    if (stream === null) return reply.code(400).send({ error: 'Index de piste audio invalide.' });

    /*
     * Les pistes PRÉ-GÉNÉRÉES d'abord. Quand elles existent, aucune session
     * audio n'est créée : plus rien à relancer au déplacement, donc plus de
     * chemin fragile. Absentes, on retombe sur la production à la demande.
     */
    const preGenere = usableAudio(
      AUDIO_DIR, media.id, media.sizeBytes, media.mtimeMs, resolved.audioPlan, resolved.audioRenditions,
    );
    if (preGenere !== null) {
      const statique = staticInit(preGenere, stream);
      if (statique !== null) return sendWorkFile(reply, statique, 'video/mp4');
    }

    const session = await acquire(manager, media, resolved, found.hevc);
    const file = await session.ensureAudioInit(stream);
    if (file === null) {
      return reply.code(503).send({
        error: session.audioError(stream) ?? `Le rendu audio du flux ${stream} n’a pas produit d’en-tête.`,
      });
    }

    return sendWorkFile(reply, file, 'video/mp4');
  });

  // -------------------------------------------------------------------------
  // GET /api/hls/:id/a-:stream/seg-NNNNN.m4s — un segment audio
  // -------------------------------------------------------------------------
  app.get('/api/hls/:id/a-:stream/seg-:index.m4s', async (request, reply) => {
    const found = await context(request, reply);
    if (found === null) return reply;
    const { manager, media, resolved } = found;

    const parameters = request.params as { stream: string; index: string };
    const stream = readStreamIndex(parameters.stream);
    const index = Number(parameters.index);

    if (stream === null) return reply.code(400).send({ error: 'Index de piste audio invalide.' });
    if (!Number.isSafeInteger(index) || index < 0) {
      return reply.code(400).send({ error: 'Numéro de segment invalide.' });
    }
    if (index >= resolved.audioPlan.length) return reply.code(404).send({ error: 'Segment hors du fichier.' });

    const preGenere = usableAudio(
      AUDIO_DIR, media.id, media.sizeBytes, media.mtimeMs, resolved.audioPlan, resolved.audioRenditions,
    );
    const debut = (resolved.audioPlan[index] as { start: number }).start;

    /*
     * Les pistes pré-générées passent par LE MÊME chemin que les autres.
     *
     * Elles sont déjà absolues — une seule exécution depuis zéro — et la
     * correction le constate sans rien réécrire. C'est précisément ce que
     * l'idempotence achète : pas de branche particulière à maintenir, donc pas
     * de branche où l'invariant puisse être oublié.
     */
    if (preGenere !== null) {
      const statique = staticSegment(preGenere, stream, index);
      const enTete = staticInit(preGenere, stream);
      if (statique !== null && enTete !== null) {
        return sendFragment(reply, statique, enTete, resolved.audioPlan, debut);
      }
    }

    const session = await acquire(manager, media, resolved, found.hevc);
    const file = await session.ensureAudioSegment(stream, index);
    if (file === null) {
      return reply.code(503).send({
        error: session.audioError(stream) ?? `Le segment audio ${index} n’a pas pu être produit à temps.`,
      });
    }

    return sendFragment(reply, file, session.audioInitPath(stream), resolved.audioPlan, debut);
  });

  // -------------------------------------------------------------------------
  // DELETE /api/hls/:id/session — le lecteur prévient qu'il s'en va
  // -------------------------------------------------------------------------
  // Premier des trois filets contre le ffmpeg orphelin : c'est le plus rapide,
  // les deux autres (balayage, arrêt du serveur) rattrapent ce qu'il rate.
  app.delete('/api/hls/:id/session', async (request, reply) => {
    const manager = sessions();
    const id = readId((request.params as { id: string }).id);
    if (manager !== null && id !== null) await manager.release(id, 'le lecteur a quitté la page');
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // GET /api/transcode/sessions — état, pour la mise au point
  // -------------------------------------------------------------------------
  app.get('/api/transcode/sessions', () => {
    const manager = sessions();
    return manager === null ? { available: false, sessions: [] } : { available: true, sessions: manager.list() };
  });
}

/**
 * Playlist de la vidéo.
 *
 * Les URL de segments restent à la RACINE du fichier — `seg-00042.m4s` et non
 * `v/seg-00042.m4s` — pour que les liens déjà publiés continuent de résoudre.
 * Le répertoire `v/` est un détail d'implémentation de la session.
 */
function videoPlaylist(mediaFileId: number, resolved: ResolvedPlayback): string {
  return buildPlaylist(resolved.plan, {
    init: 'init.mp4',
    segment: (index) => segmentFileName(index),
  });
}
