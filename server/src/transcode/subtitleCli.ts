/**
 * `npm run subtitles` — la passe de préparation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * L'ASSET EXISTE AVANT LE TITRE.
 *
 * Une extraction traverse le fichier entier : mesuré à 965 s sur un remux de
 * 94 Go, soit exactement le débit du disque. Faite pendant que personne ne
 * regarde, elle ne coûte rien ; faite au moment du clic sur « Lire », elle est
 * un défaut. Cette passe la fait une fois pour toute la bibliothèque.
 *
 * Compter environ seize heures pour 5,13 Tio. C'est un coût unique, à lancer une
 * nuit. Elle est reprenable : Ctrl-C et relance repartent là où on s'est arrêté.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   npm run subtitles                  reprend là où on en était
 *   npm run subtitles -- --full        tout refaire, cache compris
 *   npm run subtitles -- --retry-failed
 *   npm run subtitles -- --limit 50
 */
import path from 'node:path';

import { DATA_DIR, loadConfig, loadEnvFile, resolveDatabasePath, SUBTITLE_CACHE_DIR } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { detectCapabilities } from './capabilities.js';
import { markPending } from './readiness.js';
import { CONVERTER_VERSION } from '../playback/vtt.js';
import {
  SubtitlePreparation,
  applyConverterVersion,
  enqueueFiles,
  filesToPrepare,
  requeueMissing,
  subtitleQueue,
} from './subtitleQueue.js';

interface Options {
  full: boolean;
  retryFailed: boolean;
  limit: number | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { full: false, retryFailed: false, limit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--full') options.full = true;
    else if (arg === '--retry-failed') options.retryFailed = true;
    else if (arg === '--limit') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) options.limit = value;
      index += 1;
    }
  }
  return options;
}

/** « 3 h 12 min 04 s », pour une passe qui dure des heures. */
export function duree(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

export function octets(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} Tio`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${Math.round(bytes / 1024)} Ko`;
}

/** Taille du cache produit, parcourue une fois à la fin. */
async function tailleDuCache(dir: string): Promise<number> {
  const { readdir, stat } = await import('node:fs/promises');
  let total = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      total += entry.isDirectory() ? await tailleDuCache(full) : (await stat(full)).size;
    }
  } catch {
    // Cache absent : zéro.
  }
  return total;
}

/** `--full` : tout refaire, donc tout remettre en préparation. */
function reinitialiser(db: Db): void {
  db.prepare('UPDATE media_file SET subtitles_fingerprint = NULL WHERE present = 1').run();
}

async function main(): Promise<void> {
  loadEnvFile();
  const options = parseOptions(process.argv.slice(2));

  const config = loadConfig();
  const db = openDatabase(resolveDatabasePath(config));
  const cacheDir = SUBTITLE_CACHE_DIR;

  const capabilities = await detectCapabilities({ dataDir: DATA_DIR });
  console.log(`ffmpeg : ${capabilities.version}`);
  console.log(`Cache  : ${cacheDir}\n`);

  /*
   * La commande emploie la MÊME machine que le serveur : même ordre, même
   * marquage, même comptabilité. Écrire deux fois la boucle de traitement, c'est
   * garantir qu'elles divergeront.
   */
  const passe = new SubtitlePreparation(db, {
    ffmpegBinary: capabilities.binary,
    cacheDir,
    onLog: (message, details) => {
      const id = details?.mediaFileId;
      if (message === 'sous-titres préparés') {
        const etat = passe.status();
        const reste = etat.remainingSeconds === null ? '—' : duree(etat.remainingSeconds * 1000);
        console.log(
          `  [${etat.filesDone}/${etat.filesTotal}] #${String(id)} — ${String(details?.pistes)} piste(s) ` +
            `en ${String(details?.secondes)} s · ${octets(etat.bytesDone)} / ${octets(etat.bytesTotal)} · ` +
            `reste ~${reste}`,
        );
      } else if (message === 'préparation en échec') {
        console.log(`  #${String(id)} — ÉCHEC : ${String(details?.error)}`);
      }
    },
  });

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * LE VERROU AVANT LA PREMIÈRE ÉCRITURE, PAS AVANT LA PREMIÈRE EXTRACTION.
   *
   * Le prendre juste avant la boucle ne suffisait pas : « --full », le
   * rattrapage et l'inscription remettent des travaux en attente. Lancée pendant
   * que le serveur draine, cette commande repassait donc en 'pending' le travail
   * que le serveur avait en cours — exactement l'interférence que le verrou doit
   * empêcher. Constaté en production : 2 243 fichiers remis en file avant que le
   * refus ne s'affiche.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const prise = passe.acquireDrain();
  if (!prise.acquired) {
    const { pid, sinceSeconds } = prise.heldBy as { pid: number; sinceSeconds: number };
    console.error(
      [
        `Une préparation tourne déjà dans ce conteneur (PID ${pid}, depuis ${sinceSeconds} s).`,
        `  C'est le serveur : il draine la file en continu, il n'y a rien à lancer ici.`,
        `  Pour reprendre la main : arrêter le serveur, ou piloter la passe depuis la page « Préparation ».`,
      ].join('\n'),
    );
    db.close();
    process.exit(1);
  }

  const queue = subtitleQueue(db);
  if (options.full) {
    reinitialiser(db);
    console.log(`  ${queue.requeueAll()} travaux remis en attente (--full)`);
  }
  if (options.retryFailed) console.log(`  ${queue.requeueFailed()} travaux en échec relancés`);

  /*
   * Le disque a le dernier mot : un travail `done` dont le cache a disparu se
   * déclarerait à jour indéfiniment. La vérification coûte un `readdir` par
   * fichier — négligeable devant la passe qu'elle précède.
   */
  const converti = applyConverterVersion(db, cacheDir);
  if (converti.invalidated > 0) {
    console.log(
      `  ${converti.invalidated} fichiers a refaire : le convertisseur a change ` +
        `(version ${converti.from ?? '1'} -> ${CONVERTER_VERSION})`,
    );
  }

  const rattrapes = requeueMissing(db, cacheDir);

  const cibles = filesToPrepare(db);
  const inscrits = enqueueFiles(db, cibles);
  const octetsTotal = cibles.reduce((sum, { file }) => sum + file.sizeBytes, 0);

  console.log(`${cibles.length} fichiers présents, ${octets(octetsTotal)} au total.`);
  console.log(
    `  ${inscrits.added} nouveaux, ${inscrits.reactivated} modifiés depuis la dernière passe, ` +
      `${inscrits.unchanged} déjà à jour`,
  );
  if (rattrapes.missing > 0) {
    console.log(`  ${rattrapes.missing} sans WebVTT sur le disque, remis en file (${octets(rattrapes.bytes)})`);
  }
  console.log();

  const debut = Date.now();
  let traites = 0;

  // Ctrl-C rend le disque proprement : la passe s'arrête, la file garde sa place.
  process.on('SIGINT', () => {
    console.log('\nInterruption — la passe reprendra où elle en est au prochain lancement.');
    passe.pause();
    setTimeout(() => process.exit(0), 500);
  });

  for (;;) {
    if (options.limit !== null && traites >= options.limit) break;
    const avant = passe.status().filesDone;
    await passe.runOnce();
    const apres = passe.status().filesDone;
    if (apres === avant) break;
    traites += apres - avant;
  }

  const total = Date.now() - debut;
  const taille = await tailleDuCache(cacheDir);
  const counts = queue.counts();
  const etat = passe.status();

  console.log('\n──────────────────────────────────────────────');
  console.log(`Fichiers traités   : ${traites}`);
  console.log(`Durée totale       : ${duree(total)}`);
  console.log(`Volume lu          : ${octets(etat.bytesDone)}`);
  if (etat.throughput !== null) console.log(`Débit observé      : ${octets(etat.throughput)}/s`);
  console.log(`Volume du cache    : ${octets(taille)}`);
  console.log(`Reste en attente   : ${counts.pending}`);
  if (counts.failed > 0) {
    console.log(`\n${counts.failed} en échec — « npm run subtitles -- --retry-failed » pour réessayer.`);
    for (const echec of etat.failures) console.log(`  ${echec.fileName} — ${echec.error}`);
  }

  db.close();
}

void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});

export { markPending };
