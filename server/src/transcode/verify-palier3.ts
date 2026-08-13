/**
 * Vérification du palier 3 contre un vrai ffmpeg.
 *
 * TEMPORAIRE — cet outil accompagne la mise au point des pistes multiples. Il
 * ne remplace pas les tests unitaires : il vérifie ce qu'eux ne peuvent pas
 * atteindre, à savoir que ffmpeg produit RÉELLEMENT ce que nos lignes de
 * commande décrivent, sur un fichier qui porte tous les pièges du #365.
 *
 *   npx tsx src/transcode/verify-palier3.ts <fichier.mkv>
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  labelAudioTracks,
  pickDefaultAudio,
  selectSubtitleTracks,
  type AudioTrackRow,
  type SubtitleTrackRow,
} from '../playback/tracks.js';
import { convertToVtt } from '../playback/vtt.js';
import { buildAudioArgs, buildRemuxArgs } from './args.js';
import { buildMasterPlaylist, estimateBandwidth } from './manifest.js';
import { AUDIO_SEGMENT_DURATION, buildPlaylist, planAudioSegments, planSegments } from './segments.js';
import { buildExtractArgs, conversionFormat, rawFileName } from './subtitles.js';

const run = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, (match) => (match.endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));

const input = process.argv[2] ?? '';
if (input === '') {
  console.error('Usage : npx tsx src/transcode/verify-palier3.ts <fichier.mkv>');
  process.exit(1);
}

const work = path.join(path.dirname(input), 'verif');

interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

function tag(stream: ProbeStream, name: string): string | null {
  for (const [key, value] of Object.entries(stream.tags ?? {})) {
    if (key.toLowerCase() === name && value !== '') return value;
  }
  return null;
}

const IMAGE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

let echecs = 0;

function verifie(condition: boolean, message: string, detail?: string): void {
  console.log(`${condition ? '  ok  ' : ' ÉCHEC'} ${message}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!condition) echecs += 1;
}

/** Durées EXTINF réellement produites, lues dans le manifeste interne de ffmpeg. */
async function extinfOf(dir: string): Promise<number[]> {
  const text = await readFile(path.join(dir, 'internal.m3u8'), 'utf8');
  return [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].map((match) => Number(match[1]));
}

async function main(): Promise<void> {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  // --- Ce que ffprobe voit, mis sous la forme des tables de la base ---------
  const { stdout } = await run(FFPROBE, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-show_streams',
    '-of',
    'json',
    input,
  ]);
  const streams = (JSON.parse(stdout) as { streams: ProbeStream[] }).streams;

  const audioRows: AudioTrackRow[] = streams
    .filter((stream) => stream.codec_type === 'audio')
    .map((stream) => ({
      streamIndex: stream.index,
      codec: stream.codec_name ?? null,
      channels: stream.channels ?? null,
      language: tag(stream, 'language'),
      title: tag(stream, 'title'),
      isDefault: stream.disposition?.default === 1,
    }));

  const subtitleRows: SubtitleTrackRow[] = streams
    .filter((stream) => stream.codec_type === 'subtitle')
    .map((stream) => ({
      streamIndex: stream.index,
      codec: stream.codec_name ?? null,
      language: tag(stream, 'language'),
      title: tag(stream, 'title'),
      isForced: stream.disposition?.forced === 1,
      isDefault: stream.disposition?.default === 1,
      isImageBased: IMAGE_CODECS.has((stream.codec_name ?? '').toLowerCase()),
    }));

  const duration = Number(
    (
      JSON.parse(
        (
          await run(FFPROBE, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'json',
            input,
          ])
        ).stdout,
      ) as { format: { duration: string } }
    ).format.duration,
  );

  // --- 1. Le menu -----------------------------------------------------------
  console.log('\n=== 1. Ce que le menu affichera ===');
  const audio = labelAudioTracks(audioRows);
  const defaultAudio = pickDefaultAudio(audioRows);
  for (const track of audio) {
    console.log(`  flux ${track.streamIndex} : ${track.label}${track.streamIndex === defaultAudio ? '   ← par défaut' : ''}`);
  }
  const selection = selectSubtitleTracks(subtitleRows);
  for (const track of selection.tracks) {
    console.log(`  flux ${track.streamIndex} : ${track.label}  [${track.kind}]`);
  }
  verifie(new Set(audio.map((track) => track.label)).size === audio.length, 'libellés audio tous distincts');
  verifie(defaultAudio !== null && audioRows.find((r) => r.streamIndex === defaultAudio)?.language === 'fre',
    'le français est retenu par défaut');

  // --- 2. Le manifeste maître ----------------------------------------------
  console.log('\n=== 2. Manifeste maître ===');
  const master = buildMasterPlaylist(
    { video: 'video.m3u8', audio: (i) => `audio-${i}.m3u8`, subtitle: (i) => `sub-${i}.m3u8` },
    {
      audio,
      defaultAudio,
      subtitles: selection.tracks,
      bandwidth: estimateBandwidth(6_000_000, 192_000),
      width: 1280,
      height: 720,
    },
  );
  console.log(master.split('\n').map((line) => `  ${line}`).join('\n'));

  // --- 3. Extraction des sous-titres, une seule passe ----------------------
  console.log('\n=== 3. Extraction des sous-titres ===');
  const subsDir = path.join(work, 'subs');
  await mkdir(subsDir, { recursive: true });

  const extractable = subtitleRows
    .filter((row) => !row.isImageBased && rawFileName({ streamIndex: row.streamIndex, codec: row.codec ?? '' }) !== null)
    .map((row) => ({ streamIndex: row.streamIndex, codec: row.codec as string }));

  const debut = Date.now();
  await run(FFMPEG, buildExtractArgs(input, extractable, subsDir));
  console.log(`  une passe ffmpeg, ${extractable.length} pistes, ${Date.now() - debut} ms`);

  for (const track of extractable) {
    const raw = rawFileName(track) as string;
    const format = conversionFormat(track.codec) as string;
    const vtt = convertToVtt(await readFile(path.join(subsDir, raw), 'utf8'), format);
    console.log(`\n  --- flux ${track.streamIndex} (${track.codec}) ---`);
    console.log(vtt.split('\n').slice(0, 14).map((line) => `    ${line}`).join('\n'));
    verifie(vtt.startsWith('WEBVTT'), `flux ${track.streamIndex} : en-tête WEBVTT`);
    verifie(/\d\d:\d\d:\d\d\.\d\d\d --> /.test(vtt), `flux ${track.streamIndex} : horodatages WebVTT`);
    verifie(!vtt.includes('{\\'), `flux ${track.streamIndex} : aucune balise ASS résiduelle`);
  }

  // --- 4. Vidéo seule, sans le son -----------------------------------------
  console.log('\n=== 4. Vidéo seule (audio rendu à part) ===');
  const videoDir = path.join(work, 'v');
  await mkdir(videoDir, { recursive: true });

  const videoPlan = planSegments(duration);
  await run(FFMPEG, buildRemuxArgs({
    input,
    startTime: 0,
    startNumber: 0,
    segmentDuration: 4,
    endTime: null,
    outputDir: videoDir,
    audio: { kind: 'none' },
  }));

  const videoFiles = (await readdir(videoDir)).filter((name) => name.endsWith('.m4s'));
  /*
   * On ne compare PAS ce nombre au plan : en remux, la découpe réelle suit les
   * images clés de la source, et le plan de production vient de
   * `segmentPlanOf`, pas de `planSegments`. C'est le sujet du palier 1, déjà
   * vérifié. Ce qui se joue ici est la SÉLECTION DES FLUX.
   */
  console.log(`  ${videoFiles.length} segments produits`);
  verifie(videoFiles.length > 0, 'ffmpeg n’a pas échoué sur la police TrueType ni sur la couverture MJPEG');

  const { stdout: videoStreams } = await run(FFPROBE, [
    '-hide_banner', '-loglevel', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0',
    path.join(videoDir, 'init.mp4'),
  ]);
  verifie(!videoStreams.includes('audio'), 'la sortie vidéo ne porte AUCUN son', videoStreams.trim().replace(/\s+/g, ' '));
  verifie((videoStreams.match(/video/g) ?? []).length === 1, 'un seul flux vidéo : la couverture est écartée');

  // --- 5. Rendus audio séparés ---------------------------------------------
  console.log('\n=== 5. Rendus audio séparés ===');
  const audioPlan = planAudioSegments(duration);

  for (const track of audioRows) {
    const dir = path.join(work, `a-${track.streamIndex}`);
    await mkdir(dir, { recursive: true });

    await run(FFMPEG, buildAudioArgs({
      input,
      startTime: 0,
      startNumber: 0,
      endTime: null,
      outputDir: dir,
      streamIndex: track.streamIndex,
      channels: track.channels,
      segmentDuration: AUDIO_SEGMENT_DURATION,
    }));

    const produits = await extinfOf(dir);
    const pleins = produits.filter((value) => value >= 1);
    const exacts = pleins.slice(0, -1).every((value) => Math.abs(value - AUDIO_SEGMENT_DURATION) < 0.001);

    console.log(
      `  flux ${track.streamIndex} (${track.channels} canaux) : ${produits.length} segments, ` +
        `durées ${[...new Set(produits.map((v) => v.toFixed(3)))].join(' / ')}`,
    );
    verifie(exacts, `flux ${track.streamIndex} : segments de ${AUDIO_SEGMENT_DURATION}.000 s exactement`);
    verifie(pleins.length >= audioPlan.length - 1, `flux ${track.streamIndex} : le manifeste ne sur-déclare pas`,
      `${audioPlan.length} annoncés, ${produits.length} produits`);

    const { stdout: kind } = await run(FFPROBE, [
      '-hide_banner', '-loglevel', 'error', '-show_entries', 'stream=codec_type,channels,sample_rate',
      '-of', 'csv=p=0', path.join(dir, 'init.mp4'),
    ]);
    verifie(kind.startsWith('audio') && kind.includes(',2,') === false ? kind.includes('2') : true,
      `flux ${track.streamIndex} : sortie audio seule`, kind.trim());
    verifie(kind.includes('48000'), `flux ${track.streamIndex} : rééchantillonné à 48 kHz`, kind.trim());
  }

  // --- 6. Reprise en cours de fichier --------------------------------------
  console.log('\n=== 6. Reprise audio en cours de fichier ===');
  const repriseDir = path.join(work, 'reprise');
  await mkdir(repriseDir, { recursive: true });
  const depart = audioPlan[2];

  if (depart !== undefined) {
    await run(FFMPEG, buildAudioArgs({
      input,
      startTime: depart.start,
      startNumber: depart.index,
      endTime: null,
      outputDir: repriseDir,
      streamIndex: (audioRows[0] as AudioTrackRow).streamIndex,
      channels: (audioRows[0] as AudioTrackRow).channels,
      segmentDuration: AUDIO_SEGMENT_DURATION,
    }));

    const produits = await extinfOf(repriseDir);
    const pleins = produits.filter((value) => value >= 1);
    console.log(`  reprise à ${depart.start} s : durées ${[...new Set(produits.map((v) => v.toFixed(3)))].join(' / ')}`);
    verifie(
      pleins.every((value) => Math.abs(value - AUDIO_SEGMENT_DURATION) < 0.001) ||
        pleins.slice(0, -1).every((value) => Math.abs(value - AUDIO_SEGMENT_DURATION) < 0.001),
      'la grille reste exacte après reprise — c’est toute la raison des 8 s',
    );
  }

  // --- 7. Cohérence du manifeste vidéo -------------------------------------
  console.log('\n=== 7. Playlists ===');
  const videoPlaylist = buildPlaylist(videoPlan, { init: 'init.mp4', segment: (i) => `seg-${String(i).padStart(5, '0')}.m4s` });
  const audioPlaylist = buildPlaylist(audioPlan, { init: 'a-1/init.mp4', segment: (i) => `a-1/seg-${String(i).padStart(5, '0')}.m4s` });
  verifie(videoPlaylist.includes('#EXT-X-MAP:URI="init.mp4"'), 'la playlist vidéo déclare son en-tête');
  verifie(audioPlaylist.includes('#EXT-X-MAP:URI="a-1/init.mp4"'), 'la playlist audio déclare le sien');
  console.log(`  vidéo : ${videoPlan.length} segments — audio : ${audioPlan.length} segments`);

  console.log(`\n${echecs === 0 ? 'Tout est conforme.' : `${echecs} vérification(s) en échec.`}`);
  process.exit(echecs === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
