/**
 * Extraction des sous-titres embarqués, et leur cache.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI UN CACHE — ET CE N'EST PAS UNE QUESTION DE STOCKAGE.
 *
 * L'argument évident serait « les sous-titres sont légers, autant les garder ».
 * Il est vrai mais accessoire : 2 796 fichiers × 3 pistes × 40 ko font 340 Mo,
 * ce qui ne se discute pas.
 *
 * Ce qui décide, c'est le COÛT D'UNE EXTRACTION. Les paquets de sous-titres
 * sont entrelacés d'un bout à l'autre du conteneur : pour les collecter,
 * ffmpeg doit démultiplexer le fichier ENTIER. Sur un remux de 30 Go lu en SMB
 * à 168 Mo/s, c'est trois minutes de lecture disque — pour produire 40 ko. À
 * chaque changement de piste, ce serait intenable ; une fois par fichier, c'est
 * sans conséquence.
 *
 * Et le corollaire, qui change la conception : puisque le coût est celui de la
 * LECTURE et non celui du décodage des sous-titres, extraire une piste ou les
 * douze du fichier #365 coûte exactement la même chose. On les extrait donc
 * TOUTES en une seule passe, dès la première demande — extraire à la demande,
 * piste par piste, aurait coûté douze traversées du fichier au lieu d'une.
 *
 * Le seul argument contraire examiné : un fichier modifié après extraction
 * servirait des sous-titres périmés. Il est traité par l'empreinte taille +
 * date de modification dans le nom du répertoire, qui invalide le cache sans
 * qu'aucun code n'ait à y penser.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Db } from '../db/index.js';
import { isExtractable, type SubtitleTrackRow } from '../playback/tracks.js';
import { convertToVtt } from '../playback/vtt.js';
import { ANALYZE_DURATION, PROBE_SIZE } from './args.js';

/** Le débit AAC produit, en bits par seconde. Pour l'attribut BANDWIDTH. */
export const AUDIO_BITRATE_BPS = 192_000;

/**
 * Garde-fou d'une extraction, désormais généreux.
 *
 * Il ne borne plus une requête HTTP mais un travail de fond : une extraction
 * qui dure vingt minutes ne gêne personne, alors qu'une qui ne finit jamais
 * bloquerait la file. Mesuré à plus de cinq minutes sur un remux 4K en SMB.
 */
const EXTRACTION_TIMEOUT_MS = 1_800_000;

/** Message d'une interruption volontaire, reconnu par la file pour ne pas la compter en échec. */
export const INTERRUPTED = 'extraction interrompue';

/**
 * Comment sortir chaque codec, et sous quelle forme le relire.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON EXTRAIT EN FORMAT NATIF, PUIS ON CONVERTIT SOI-MÊME.
 *
 * ffmpeg sait écrire directement du WebVTT (`-c:s webvtt`). On ne s'en sert
 * pas : sa conversion ASS→WebVTT n'est ni testable sans machine, ni pilotable.
 * En extrayant l'ASS tel quel puis en le convertissant dans `ass.ts`, chaque
 * dégradation — ce qu'on garde de l'italique, ce qu'on jette du positionnement
 * — est une décision écrite et vérifiée par un test.
 *
 * `mov_text` fait exception : il n'existe pas de fichier texte qui le porte,
 * ffmpeg le convertit donc en SRT à la sortie.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const EXTRACTION: Record<string, { codec: string; format: string; extension: string }> = {
  subrip: { codec: 'copy', format: 'srt', extension: 'srt' },
  srt: { codec: 'copy', format: 'srt', extension: 'srt' },
  ass: { codec: 'copy', format: 'ass', extension: 'ass' },
  ssa: { codec: 'copy', format: 'ass', extension: 'ass' },
  webvtt: { codec: 'copy', format: 'webvtt', extension: 'vtt' },
  mov_text: { codec: 'srt', format: 'srt', extension: 'srt' },
  text: { codec: 'srt', format: 'srt', extension: 'srt' },
  subviewer: { codec: 'srt', format: 'srt', extension: 'srt' },
  subviewer1: { codec: 'srt', format: 'srt', extension: 'srt' },
};

export interface ExtractableTrack {
  streamIndex: number;
  codec: string;
}

/**
 * Empreinte du fichier source, portée par le nom du répertoire de cache.
 *
 * Taille et date de modification : le même couple que celui qui rend le scan
 * incrémental. Un fichier réencodé sur place change forcément l'un des deux, et
 * son cache devient inatteignable — sans qu'aucune purge ait à être écrite.
 */
export function cacheKey(mediaFileId: number, sizeBytes: number, mtimeMs: number): string {
  return `${mediaFileId}-${sizeBytes}-${Math.round(mtimeMs)}`;
}

/**
 * Ligne de commande d'extraction : une passe, toutes les pistes.
 *
 * `-map 0:N` désigne le flux par son index ABSOLU dans le fichier, celui que
 * porte `embedded_subtitle.stream_index`. Chaque sortie est un fichier à part —
 * ffmpeg accepte autant de sorties qu'on veut sur une seule entrée, et ne lit
 * le fichier qu'une fois.
 */
export function buildExtractArgs(input: string, tracks: ExtractableTrack[], outputDir: string): string[] {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-probesize',
    PROBE_SIZE,
    '-analyzeduration',
    ANALYZE_DURATION,
    '-i',
    input,
  ];

  for (const track of tracks) {
    const rule = EXTRACTION[track.codec.toLowerCase()];
    if (rule === undefined) continue;
    args.push('-map', `0:${track.streamIndex}`, '-c:s', rule.codec, '-f', rule.format);
    args.push(path.join(outputDir, `${track.streamIndex}.${rule.extension}`));
  }

  return args;
}

/** Nom du fichier brut produit pour une piste, avant conversion. */
export function rawFileName(track: ExtractableTrack): string | null {
  const rule = EXTRACTION[track.codec.toLowerCase()];
  return rule === undefined ? null : `${track.streamIndex}.${rule.extension}`;
}

/** Format à passer au convertisseur pour une piste donnée. */
export function conversionFormat(codec: string): string | null {
  return EXTRACTION[codec.toLowerCase()]?.format ?? null;
}

export type SubtitleResult =
  | { kind: 'ok'; vtt: string }
  /** La piste n'existe pas, ou n'est pas du texte extractible. */
  | { kind: 'unknown' }
  /**
   * Le fichier n'a pas été préparé.
   *
   * Ne devrait pas arriver : un titre non préparé n'est pas proposé à la
   * lecture. Si ça arrive quand même — cache effacé à la main, fichier remplacé
   * entre l'affichage et le clic — on le DIT au lieu de faire attendre.
   */
  | { kind: 'absent' }
  | { kind: 'failed'; reason: string };

/**
 * Extractions en cours DANS CE PROCESSUS.
 *
 * Deux demandes simultanées sur le même fichier partagent la même passe : sans
 * ce partage, ouvrir un fichier à douze pistes en lancerait douze, chacune
 * traversant les 30 Go.
 *
 * La file persistée joue le même rôle entre deux processus — le serveur et
 * `npm run subtitles` — mais elle ne suffit pas ici : deux requêtes HTTP
 * arrivent avant que la première n'ait eu le temps d'écrire son travail.
 */
const running = new Map<string, Promise<void>>();

export interface SubtitleSource {
  id: number;
  path: string;
  rawPath: string | null;
  sizeBytes: number;
  mtimeMs: number;
}

/** Répertoire de cache d'un fichier, dans sa version courante. */
export function cacheDirOf(cacheRoot: string, media: SubtitleSource): string {
  return path.join(cacheRoot, cacheKey(media.id, media.sizeBytes, media.mtimeMs));
}

/** Index de flux dont le WebVTT est prêt à servir. */
export function readyStreams(cacheRoot: string, media: SubtitleSource): Set<number> {
  const dir = cacheDirOf(cacheRoot, media);
  const ready = new Set<number>();
  try {
    for (const name of readdirSync(dir)) {
      const match = /^(\d+)\.vtt$/.exec(name);
      if (match !== null) ready.add(Number(match[1]));
    }
  } catch {
    // Répertoire absent : rien n'est encore prêt, ce n'est pas une erreur.
  }
  return ready;
}

/**
 * Le WebVTT d'une piste, lu dans le cache.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CETTE FONCTION N'EXTRAIT JAMAIS. ELLE LIT UN FICHIER, RIEN DE PLUS.
 *
 * C'est tout l'objet du modèle : la préparation a eu lieu avant que le titre ne
 * soit proposé. Servir un sous-titre coûte donc une lecture de fichier — des
 * dizaines de millisecondes — et non les seize minutes d'une traversée de
 * conteneur.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function readSubtitleTrack(
  db: Db,
  cacheRoot: string,
  media: SubtitleSource,
  streamIndex: number,
): Promise<SubtitleResult> {
  const tracks = extractableTracksOf(db, media.id);
  if (!tracks.some((track) => track.streamIndex === streamIndex)) return { kind: 'unknown' };

  const cached = path.join(cacheDirOf(cacheRoot, media), `${streamIndex}.vtt`);
  if (existsSync(cached)) return { kind: 'ok', vtt: await readFile(cached, 'utf8') };

  return { kind: 'absent' };
}

/**
 * Extrait toutes les pistes texte d'un fichier, une seule fois à la fois.
 *
 * Appelée par le travailleur de fond du serveur et par `npm run subtitles`.
 * Rend le nombre de pistes réellement produites.
 */
export async function extractSubtitles(
  db: Db,
  ffmpegBinary: string,
  cacheRoot: string,
  media: SubtitleSource,
  signal?: AbortSignal,
): Promise<number> {
  const tracks = extractableTracksOf(db, media.id);
  if (tracks.length === 0) return 0;

  const dir = cacheDirOf(cacheRoot, media);
  const already = readyStreams(cacheRoot, media);
  if (missingTracks(already, tracks).length === 0) return already.size;

  let pass = running.get(dir);
  if (pass === undefined) {
    pass = extractAll(ffmpegBinary, media, tracks, cacheRoot, dir, signal).finally(() => running.delete(dir));
    running.set(dir, pass);
  }
  await pass;

  return readyStreams(cacheRoot, media).size;
}

interface TrackRow {
  streamIndex: number;
  codec: string | null;
  isImageBased: number;
}

/**
 * Le filtre « cette piste, on sait l'extraire », écrit une seule fois.
 *
 * Deux appelants s'en servent — une piste retenue ici et pas là, et un fichier
 * serait déclaré incomplet à jamais parce qu'on attendrait un `.vtt` que la
 * passe n'écrit pas.
 */
function keepExtractable(rows: TrackRow[]): ExtractableTrack[] {
  return rows
    .filter(
      (row): row is TrackRow & { codec: string } =>
        row.isImageBased === 0 && isExtractable(row.codec) && EXTRACTION[row.codec!.toLowerCase()] !== undefined,
    )
    .map((row) => ({ streamIndex: row.streamIndex, codec: row.codec }));
}

/** Pistes texte extractibles d'un fichier, telles que la base les connaît. */
export function extractableTracksOf(db: Db, mediaFileId: number): ExtractableTrack[] {
  const rows = db
    .prepare(
      `SELECT stream_index AS streamIndex, codec, is_image_based AS isImageBased
       FROM embedded_subtitle WHERE media_file_id = ? ORDER BY stream_index`,
    )
    .all(mediaFileId) as TrackRow[];

  return keepExtractable(rows);
}

/**
 * Toutes les pistes extractibles de la bibliothèque, groupées par fichier.
 *
 * Une requête au lieu de trois mille : le rattrapage parcourt la bibliothèque
 * entière, et il le fait pendant qu'on attend une réponse HTTP.
 */
export function extractableTracksByFile(db: Db): Map<number, ExtractableTrack[]> {
  const rows = db
    .prepare(
      `SELECT media_file_id AS mediaFileId, stream_index AS streamIndex, codec,
              is_image_based AS isImageBased
       FROM embedded_subtitle ORDER BY media_file_id, stream_index`,
    )
    .all() as (TrackRow & { mediaFileId: number })[];

  const byFile = new Map<number, TrackRow[]>();
  for (const row of rows) {
    const list = byFile.get(row.mediaFileId);
    if (list === undefined) byFile.set(row.mediaFileId, [row]);
    else list.push(row);
  }

  const result = new Map<number, ExtractableTrack[]>();
  for (const [mediaFileId, list] of byFile) {
    const tracks = keepExtractable(list);
    if (tracks.length > 0) result.set(mediaFileId, tracks);
  }
  return result;
}

/**
 * Les pistes dont le WebVTT manque encore.
 *
 * Comparaison par INDEX DE FLUX, pas par nombre. Un cache où le `.vtt` de la
 * piste 3 manque mais où celui d'une piste disparue depuis traîne encore aurait
 * le bon compte et le mauvais contenu.
 */
export function missingTracks(ready: Set<number>, tracks: ExtractableTrack[]): ExtractableTrack[] {
  return tracks.filter((track) => !ready.has(track.streamIndex));
}

/**
 * Une passe, toutes les pistes, puis conversion.
 *
 * L'écriture se fait dans un répertoire TEMPORAIRE renommé à la fin : un cache
 * à moitié rempli, laissé par un arrêt du serveur en cours d'extraction,
 * paraîtrait complet à la lecture suivante et servirait des pistes manquantes.
 */
async function extractAll(
  ffmpegBinary: string,
  media: SubtitleSource,
  tracks: ExtractableTrack[],
  cacheRoot: string,
  dir: string,
  signal?: AbortSignal,
): Promise<void> {
  const staging = `${dir}.partiel`;
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(staging, { recursive: true });

  const input = media.rawPath ?? media.path;
  await run(ffmpegBinary, buildExtractArgs(input, tracks, staging), signal);

  for (const track of tracks) {
    const raw = rawFileName(track);
    const format = conversionFormat(track.codec);
    if (raw === null || format === null) continue;

    const rawPath = path.join(staging, raw);
    if (!existsSync(rawPath)) continue;

    const text = await readFile(rawPath, 'utf8');
    await writeFile(path.join(staging, `${track.streamIndex}.vtt`), convertToVtt(text, format), 'utf8');
    await rm(rawPath, { force: true }).catch(() => undefined);
  }

  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(path.dirname(dir), { recursive: true });
  await rename(staging, dir);

  await forgetOtherVersions(cacheRoot, media.id, path.basename(dir));
}

/**
 * Supprime les caches d'une VERSION antérieure du même fichier.
 *
 * Sans cela, un fichier réencodé trois fois laisserait trois répertoires, dont
 * deux que plus rien n'atteindra jamais.
 */
async function forgetOtherVersions(cacheRoot: string, mediaFileId: number, keep: string): Promise<void> {
  try {
    const entries = await readdir(cacheRoot);
    // Le tiret final évite que le fichier 12 n'emporte les caches du 123.
    const prefix = `${mediaFileId}-`;
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix) && entry !== keep)
        .map((entry) => rm(path.join(cacheRoot, entry), { recursive: true, force: true })),
    );
  } catch {
    // Un cache non purgé n'empêche rien : il occupe seulement de la place.
  }
}

/**
 * Lance ffmpeg, et le TUE si le signal est déclenché.
 *
 * C'est ce qui permet de rendre le disque en un clic : mettre la passe en pause
 * doit arrêter la lecture en cours, pas attendre qu'elle finisse. Node transmet
 * le signal au processus enfant, qui reçoit SIGTERM.
 */
function run(binary: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    /*
     * ─────────────────────────────────────────────────────────────────────────
     * UNE INTERRUPTION SE DIT INTERRUPTION, PAR QUELQUE CHEMIN QU'ELLE ARRIVE.
     *
     * Trois chemins mènent ici : le signal déjà levé avant le lancement, une
     * erreur PENDANT le lancement — c'est par là que passe un abort concurrent,
     * sous le message « The operation was aborted » —, et la sortie du
     * processus. Seul le dernier reconnaissait l'interruption.
     *
     * Les deux autres comptaient un redémarrage de conteneur comme un ÉCHEC
     * DÉFINITIF : six fichiers s'y étaient accumulés en production, et depuis que
     * le rattrapage écarte les échecs connus, ils n'auraient plus jamais été
     * repris.
     * ─────────────────────────────────────────────────────────────────────────
     */
    if (signal?.aborted === true) {
      reject(new Error(INTERRUPTED));
      return;
    }

    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // Le délai vient de la constante : un message qui annonce cinq minutes
      // quand le garde-fou en laisse trente envoie chercher le mauvais défaut.
      const minutes = Math.round(EXTRACTION_TIMEOUT_MS / 60_000);
      reject(new Error(`L’extraction des sous-titres a dépassé ${minutes} minutes. Le partage est-il monté ?`));
    }, EXTRACTION_TIMEOUT_MS);
    timer.unref();

    child.on('error', (error) => {
      clearTimeout(timer);
      if (signal?.aborted === true) reject(new Error(INTERRUPTED));
      else reject(new Error(`ffmpeg n’a pas pu démarrer : ${error.message}`));
    });

    child.on('exit', (code, killedBy) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (signal?.aborted === true || killedBy !== null) reject(new Error(INTERRUPTED));
      else reject(new Error(stderr.trim().split('\n').at(-1) ?? `ffmpeg a quitté avec le code ${code}`));
    });
  });
}
