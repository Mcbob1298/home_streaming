/**
 * LE GARDE-FOU D'EMPREINTE REFUSE-T-IL CE QU'IL DOIT REFUSER ?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IL NE FABRIQUE RIEN. IL DIT CE QUI SERAIT SERVI, ET POURQUOI.
 *
 * À lancer AVANT toute régénération : un « refusé » constaté après coup ne
 * prouve rien, puisqu'on ne sait plus ce qui l'a causé.
 *
 * CET INSTRUMENT A MENTI, ET C'EST POURQUOI IL EST TESTÉ. Il appelait
 * `hdrPassthroughFor(config, contexte)` — l'ancienne signature à deux
 * arguments. La nouvelle n'en prend qu'un : `config` passait donc pour le
 * contexte, `context.clientDecodesHevc` valait `undefined`, et la fonction
 * rendait `false` sans lever quoi que ce soit. L'instrument concluait « pas de
 * transport HDR » sur un fichier qui en bénéficie, et rien ne le signalait.
 *
 * Un instrument qui conclut faux est pire qu'un instrument cassé.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TANT QU'IL N'A RIEN REFUSÉ, ON NE SAIT PAS QU'IL SAIT REFUSER.
 *
 * `--essai` fabrique une copie du prélude visé dans un répertoire jetable, en
 * corrompt délibérément l'empreinte, et vérifie que le garde-fou la rejette —
 * puis que l'originale, elle, est acceptée. Deux cas dont on connaît la réponse.
 *
 * La copie est indispensable : corrompre le vrai prélude coûterait vingt
 * secondes d'encodage à le refaire, et l'instrument doit pouvoir tourner sur une
 * bibliothèque en service.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Il s'exécute DANS le conteneur, dont il importe le JavaScript compilé :
 *
 *   docker cp scripts/mesure-navigateur/garde-fou.mjs home-streaming:/tmp/gf.mjs
 *   docker exec home-streaming node /tmp/gf.mjs 365
 *   docker exec home-streaming node /tmp/gf.mjs 365 --essai
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const D = '/app/server/dist';
const { DATA_DIR, loadConfig, loadEnvFile, PRELUDE_DIR, resolveDatabasePath } = await import(`${D}/config.js`);
const { openDatabase } = await import(`${D}/db/index.js`);
const { findMedia, resolvePlayback } = await import(`${D}/playback/resolve.js`);
const { detectCapabilities } = await import(`${D}/transcode/capabilities.js`);
const { supportedBackend, outputGeometry } = await import(`${D}/transcode/encode.js`);
const { PRELUDE_SECONDS, planPrelude, preludeDirOf, preludeSignature, readManifest, usablePrelude } =
  await import(`${D}/transcode/prelude.js`);
const { hdrPassthroughFor } = await import(`${D}/transcode/passthrough.js`);

loadEnvFile();
const argv = process.argv.slice(2);
const fileId = Number(argv.find((a) => /^\d+$/.test(a)) ?? 365);
const essai = argv.includes('--essai');
/** Le client supposé. Le prélude d'un fichier HDR10 est celui du client capable. */
const clientDecodesHevc = !argv.includes('--sdr');

const config = loadConfig();
const db = openDatabase(resolveDatabasePath(config));
const media = findMedia(db, fileId);
if (media === undefined) {
  console.error(`Aucun fichier présent avec l’identifiant ${fileId}.`);
  process.exit(1);
}

const capabilities = await detectCapabilities({ dataDir: DATA_DIR });
const backend = supportedBackend(capabilities.hardware);

const resolved = await resolvePlayback(
  db,
  capabilities.binary,
  media,
  { file: `/api/stream/${media.id}`, hls: `/api/hls/${media.id}/index.m3u8` },
  // La MÊME forme que les routes : un objet de capacités, passé en bloc.
  { transcodeAvailable: true, capacites: { hevc: clientDecodesHevc } },
);

const mode = resolved.decision.mode === 'transcode' ? 'transcode' : 'remux';

/*
 * La signature à UN argument. C'est ici que l'instrument mentait : avec deux, le
 * premier passait pour le contexte et la capacité valait `undefined`.
 */
const hdrPassthrough = hdrPassthroughFor({ clientDecodesHevc, source: resolved.source, mode });

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
  hdrMaxHeight: config.transcode.hdrMaxHeight,
  onLog: () => {},
};

const ligne = '─'.repeat(78);
const geo = outputGeometry({
  sourceWidth: resolved.source?.width ?? null,
  sourceHeight: resolved.source?.height ?? null,
  hardware: backend.backend,
  mode,
  hdrPassthrough,
  hdrMaxHeight: config.transcode.hdrMaxHeight,
});

console.log(ligne);
console.log(`FICHIER #${media.id} — ${path.basename(media.path)}`);
console.log(ligne);
console.log(`  client supposé    : ${clientDecodesHevc ? 'décode le HEVC 10 bits' : 'H.264 seulement'}`);
console.log(`  décision          : ${resolved.decision.mode}  →  mode session « ${mode} »`);
console.log(`  transport HDR     : ${hdrPassthrough ? 'OUI (intact)' : 'non (tone mapping ou SDR)'}`);
console.log(`  sortie            : ${geo.width}x${geo.height} à ${(geo.bitrate / 1e6).toFixed(1)} Mbps`);
console.log('');

/** Le verdict du garde-fou pour une racine de préludes donnée. */
function verdict(racine, etiquette) {
  const dir = preludeDirOf(racine, media.id, media.sizeBytes, media.mtimeMs);
  const stocke = readManifest(dir);
  const attendue = preludeSignature(input, options);
  const utilisable = usablePrelude(racine, input, options, media.sizeBytes, media.mtimeMs);

  console.log(`  ── ${etiquette}`);
  console.log(`     empreinte stockée  : ${stocke === null ? '(aucun prélude)' : stocke.signature}`);
  console.log(`     empreinte attendue : ${attendue}`);
  console.log(`     VERDICT            : ${utilisable === null ? '>>> REFUSÉ <<<' : '>>> ACCEPTÉ <<<'}`);
  if (stocke !== null && utilisable === null) {
    const raisons = [];
    if (stocke.format !== 1) raisons.push(`format ${stocke.format} ≠ 1`);
    if (stocke.signature !== attendue) raisons.push('empreinte différente');
    console.log(`     motif              : ${raisons.join(', ')}`);
  }
  console.log('');
  return utilisable !== null;
}

console.log(ligne);
console.log('LE GARDE-FOU');
console.log(ligne);
const accepteVrai = verdict(PRELUDE_DIR, `prélude réel — ${PRELUDE_DIR}`);

if (!essai) {
  const plan = planPrelude(input);
  console.log(ligne);
  console.log('CE QUI SERAIT PRODUIT');
  console.log(ligne);
  console.log(`  visé   : ${PRELUDE_SECONDS} s`);
  console.log(`  vidéo  : ${plan.videoSegments} segments → ${plan.videoEnd} s`);
  console.log(`  audio  : ${plan.audioSegments} segments × ${plan.streams.length} piste(s) → ${plan.audioEnd} s`);
  console.log('');
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// L'ESSAI : un prélude délibérément corrompu, dans une copie jetable.
// ---------------------------------------------------------------------------
console.log(ligne);
console.log('ESSAI — LE GARDE-FOU SAIT-IL REFUSER ?');
console.log(ligne);

const source = preludeDirOf(PRELUDE_DIR, media.id, media.sizeBytes, media.mtimeMs);
const racine = await mkdtemp(path.join(tmpdir(), 'garde-fou-'));
const copie = preludeDirOf(racine, media.id, media.sizeBytes, media.mtimeMs);

let corrompuRefuse = false;
try {
  await cp(source, copie, { recursive: true });
  console.log(`  copie du prélude dans ${racine}`);

  // Témoin : la COPIE INTACTE doit être acceptée, sinon l'essai ne prouve rien.
  const copieIntacteAcceptee = verdict(racine, 'copie intacte (témoin — doit être ACCEPTÉE)');

  const manifeste = path.join(copie, 'prelude.json');
  const contenu = JSON.parse(await readFile(manifeste, 'utf8'));
  const avant = contenu.signature;
  contenu.signature = 'deadbeefdeadbeefdeadbeefdeadbeef';
  await writeFile(manifeste, JSON.stringify(contenu, null, 2), 'utf8');
  console.log(`  empreinte du manifeste falsifiée : ${avant} → ${contenu.signature}`);
  console.log('');

  corrompuRefuse = !verdict(racine, 'copie corrompue (doit être REFUSÉE)');

  console.log(ligne);
  console.log(`  témoin intact accepté : ${copieIntacteAcceptee ? 'oui' : 'NON — l’essai ne prouve rien'}`);
  console.log(`  corrompu refusé       : ${corrompuRefuse ? 'oui' : 'NON — LE GARDE-FOU NE GARDE RIEN'}`);
  console.log(
    `  → ${copieIntacteAcceptee && corrompuRefuse ? 'Le garde-fou distingue les deux. Son verdict a une valeur.' : 'ESSAI EN ÉCHEC.'}`,
  );
} finally {
  await rm(racine, { recursive: true, force: true }).catch(() => undefined);
}

console.log('');
db.close();
process.exit(accepteVrai && corrompuRefuse ? 0 : 1);
