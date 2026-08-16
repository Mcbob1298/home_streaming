/**
 * Le garde-fou refuse-t-il le prélude déjà posé, et que produirait-on à la place ?
 *
 * Ne fabrique RIEN. Il construit le même `SessionInput` que `preludeCli`, calcule
 * l'empreinte attendue, la compare à celle du manifeste sur le disque, et affiche
 * les arguments ffmpeg que la session emploierait. C'est la vérification qui doit
 * précéder la régénération : un « refusé » constaté APRÈS coup ne prouve rien.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const D = '/app/server/dist';
const { DATA_DIR, loadConfig, loadEnvFile, PRELUDE_DIR, resolveDatabasePath } = await import(`${D}/config.js`);
const { openDatabase } = await import(`${D}/db/index.js`);
const { findMedia, resolvePlayback } = await import(`${D}/playback/resolve.js`);
const { detectCapabilities } = await import(`${D}/transcode/capabilities.js`);
const { supportedBackend, buildTranscodeArgs, outputGeometry } = await import(`${D}/transcode/encode.js`);
const { PRELUDE_SECONDS, planPrelude, preludeDirOf, preludeSignature, readManifest, usablePrelude } =
  await import(`${D}/transcode/prelude.js`);
const { hdrPassthroughFor } = await import(`${D}/transcode/passthrough.js`);

loadEnvFile();
const fileId = Number(process.argv[2] ?? 365);
const config = loadConfig();
const db = openDatabase(resolveDatabasePath(config));
const media = findMedia(db, fileId);

const capabilities = await detectCapabilities({ dataDir: DATA_DIR });
const backend = supportedBackend(capabilities.hardware);

const resolved = await resolvePlayback(
  db,
  capabilities.binary,
  media,
  { file: `/api/stream/${media.id}`, hls: `/api/hls/${media.id}/index.m3u8` },
  { transcodeAvailable: true },
);

const mode = resolved.decision.mode === 'transcode' ? 'transcode' : 'remux';
const hdrPassthrough = hdrPassthroughFor(config, { mediaFileId: media.id, source: resolved.source, mode });

const input = {
  mediaFileId: media.id,
  inputPath: media.rawPath ?? media.path,
  sizeBytes: media.sizeBytes,
  mtimeMs: media.mtimeMs,
  plan: resolved.plan,
  mode,
  source: resolved.source,
  ...(hdrPassthrough ? { hdrPassthrough: true } : {}),
  muxedAudio: resolved.muxedAudio,
  audioPlan: resolved.audioPlan,
  audioRenditions: resolved.audioRenditions,
};

const options = {
  ffmpegBinary: capabilities.binary,
  workDir: PRELUDE_DIR,
  hardware: backend.backend,
  device: capabilities.device ?? '/dev/dri/renderD128',
  toneMap: capabilities.toneMap,
  // DOIT suivre la config comme le serveur : sans lui, l'empreinte attendue
  // serait calculée pour un plafond de 1080p et ce rapport mentirait.
  hdrMaxHeight: config.transcode.hdrMaxHeight,
  onLog: () => {},
};

const dir = preludeDirOf(PRELUDE_DIR, media.id, media.sizeBytes, media.mtimeMs);
const stocke = readManifest(dir);
const attendue = preludeSignature(input, options);
const utilisable = usablePrelude(PRELUDE_DIR, input, options, media.sizeBytes, media.mtimeMs);
const plan = planPrelude(input);

const ligne = '─'.repeat(78);
console.log(ligne);
console.log(`FICHIER #${media.id} — ${path.basename(media.path)}`);
console.log(ligne);
console.log(`  source            : ${resolved.source?.width}x${resolved.source?.height} ${resolved.source?.codec} HDR=${resolved.source?.hdr}`);
console.log(`  décision          : ${resolved.decision.mode}  →  mode session « ${mode} »`);
console.log(`  transport HDR     : ${hdrPassthrough ? 'OUI (intact)' : 'non (tone mapping ou SDR)'}`);
console.log(`  accélération      : ${backend.backend ?? 'logiciel'} · tone mapping ${capabilities.toneMap ?? 'aucun'}`);
const geo = outputGeometry({
  sourceWidth: resolved.source?.width ?? null,
  sourceHeight: resolved.source?.height ?? null,
  hardware: backend.backend,
  mode,
  hdrPassthrough,
  hdrMaxHeight: config.transcode.hdrMaxHeight,
});
console.log(
  `  sortie            : ${geo.width}x${geo.height} à ${(geo.bitrate / 1e6).toFixed(1)} Mbps` +
    `   (plafond HDR ${config.transcode.hdrMaxHeight})`,
);
console.log('');
console.log(ligne);
console.log('LE GARDE-FOU');
console.log(ligne);
console.log(`  répertoire        : ${dir}`);
console.log(`  empreinte stockée : ${stocke === null ? '(aucun prélude)' : stocke.signature}`);
console.log(`  empreinte attendue: ${attendue}`);
console.log(`  bâti le           : ${stocke?.builtAt ?? '—'}   ${stocke ? (stocke.bytes / 1048576).toFixed(1) + ' Mo' : ''}`);
console.log('');
console.log(`  VERDICT           : ${utilisable === null ? '>>> REFUSÉ — la lecture démarrera comme avant <<<' : '>>> ACCEPTÉ — servi tel quel <<<'}`);
if (stocke !== null && utilisable === null) {
  const raisons = [];
  if (stocke.format !== 1) raisons.push(`format ${stocke.format} ≠ 1`);
  if (stocke.signature !== attendue) raisons.push('empreinte différente');
  console.log(`  motif             : ${raisons.join(', ')}`);
}
console.log('');
console.log(ligne);
console.log('CE QUI SERAIT PRODUIT');
console.log(ligne);
console.log(`  visé              : ${PRELUDE_SECONDS} s`);
console.log(`  vidéo             : ${plan.videoSegments} segments → ${plan.videoEnd} s`);
console.log(`  audio             : ${plan.audioSegments} segments × ${plan.streams.length} piste(s) → ${plan.audioEnd} s`);
console.log(`  pistes            : ${plan.streams.join(', ')}`);
console.log('');

const args = buildTranscodeArgs({
  input: input.inputPath,
  startTime: 0,
  startNumber: 0,
  segmentDuration: resolved.plan[0]?.duration ?? 4,
  endTime: plan.videoEnd,
  outputDir: '/app/data/transcode/exemple',
  audio: input.muxedAudio,
  sourceWidth: resolved.source?.width ?? null,
  sourceHeight: resolved.source?.height ?? null,
  frameRate: resolved.source?.frameRate ?? null,
  hdr: resolved.source?.hdr ?? null,
  hardware: options.hardware,
  device: options.device,
  toneMap: options.toneMap,
  hdrPassthrough: input.hdrPassthrough === true,
  hdrMaxHeight: config.transcode.hdrMaxHeight,
});

console.log('  ARGUMENTS FFMPEG DE LA VIDÉO (premier run) :');
console.log(`    ${capabilities.binary} \\`);
let ligneCourante = '     ';
for (const a of args) {
  if (ligneCourante.length + a.length > 76) {
    console.log(`${ligneCourante} \\`);
    ligneCourante = '     ';
  }
  ligneCourante += ` ${a}`;
}
console.log(ligneCourante);
console.log('');

db.close();
