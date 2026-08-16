/**
 * `npm run preludes -- --hdr` — fabrique les préludes de toute une population.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE COMMANDE PLUTÔT QUE SOIXANTE-DIX INVOCATIONS.
 *
 * `npm run prelude -- --file <id>` en fabrique UN. Sur les soixante-dix fichiers
 * HDR10 de la bibliothèque, cela ferait soixante-dix lignes à écrire, à
 * surveiller, et à reprendre à la main là où l'une échoue.
 *
 * Surtout, une boucle de shell ne saurait pas REPRENDRE : elle refabriquerait
 * les préludes déjà valables. Ici, un prélude dont l'empreinte correspond déjà
 * est sauté — la commande peut donc être relancée après une interruption sans
 * refaire le travail, et sert aussi de rattrapage après un changement de
 * réglage qui n'invalide qu'une partie des préludes.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Chaque fichier passe par le MÊME chemin qu'une lecture — `resolvePlayback`,
 * une vraie `TranscodeSession` — via `fabriquerPrelude`, partagé avec la
 * commande unitaire. Une liste d'arguments recopiée ici divergerait.
 *
 * Usage :
 *   npm run preludes -- --hdr          les fichiers HDR10 (transport intact)
 *   npm run preludes -- --hdr --sdr    leur variante tone-mappée
 *   npm run preludes -- --files 1,2,3  une liste explicite
 *   npm run preludes -- --hdr --dry    ce qui serait fait, sans rien encoder
 */
import { DATA_DIR, loadConfig, loadEnvFile, PRELUDE_DIR, resolveDatabasePath } from '../config.js';
import { openDatabase } from '../db/index.js';
import { detectCapabilities } from './capabilities.js';
import { supportedBackend } from './encode.js';
import { fabriquerPrelude, type ResultatPrelude } from './fabriquePrelude.js';

function lireListe(argv: string[]): number[] | null {
  const index = argv.indexOf('--files');
  if (index === -1) return null;
  return (argv[index + 1] ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isSafeInteger(v) && v > 0);
}

function duree(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

function octets(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} Go` : `${(n / 1024 ** 2).toFixed(0)} Mo`;
}

async function main(): Promise<void> {
  loadEnvFile();
  const argv = process.argv.slice(2);
  const pourClientSdr = argv.includes('--sdr');
  const simulation = argv.includes('--dry');

  const config = loadConfig();
  const db = openDatabase(resolveDatabasePath(config));

  const explicites = lireListe(argv);
  let ids: number[];

  if (explicites !== null) {
    ids = explicites;
  } else if (argv.includes('--hdr')) {
    /*
     * La MÊME population que la règle de transport : HDR10, et rien d'autre. Le
     * Dolby Vision en est écarté — ses métadonnées dynamiques ne survivraient
     * pas au réencodage — et le SDR n'a rien à transporter.
     */
    ids = db
      .prepare(`SELECT id FROM media_file WHERE present = 1 AND hdr = 'HDR10' ORDER BY id`)
      .all()
      .map((r) => (r as { id: number }).id);
  } else {
    console.error('Usage : npm run preludes -- --hdr [--sdr] [--dry]');
    console.error('        npm run preludes -- --files 1,2,3');
    process.exit(1);
  }

  console.log(`${ids.length} fichier(s) à traiter — variante ${pourClientSdr ? 'tone-mappée' : 'HDR intact'}.`);
  if (simulation) console.log('SIMULATION : rien ne sera encodé.\n');
  else console.log('');

  const capabilities = await detectCapabilities({ dataDir: DATA_DIR });
  const backend = supportedBackend(capabilities.hardware);

  let faits = 0;
  let sautes = 0;
  let echecs = 0;
  let total = 0;
  const debut = Date.now();

  for (const [rang, id] of ids.entries()) {
    const tete = `[${String(rang + 1).padStart(String(ids.length).length)}/${ids.length}] #${id}`;
    let resultat: ResultatPrelude;

    try {
      resultat = await fabriquerPrelude({
        db,
        id,
        config,
        capabilities,
        backend,
        preludeRoot: PRELUDE_DIR,
        pourClientSdr,
        simulation,
      });
    } catch (error) {
      echecs += 1;
      console.log(`${tete}  ÉCHEC — ${(error as Error).message}`);
      continue;
    }

    if (resultat.etat === 'deja-valable') {
      sautes += 1;
      console.log(`${tete}  déjà valable — ${resultat.nom}`);
    } else if (resultat.etat === 'simule') {
      console.log(`${tete}  à fabriquer — ${resultat.nom}`);
    } else {
      faits += 1;
      total += resultat.bytes;
      console.log(`${tete}  ${octets(resultat.bytes).padStart(7)} en ${String(Math.round(resultat.ms / 1000)).padStart(3)} s — ${resultat.nom}`);
    }
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`fabriqués : ${faits}   déjà valables : ${sautes}   échecs : ${echecs}`);
  if (faits > 0) console.log(`disque    : ${octets(total)}`);
  console.log(`durée     : ${duree(Date.now() - debut)}`);

  db.close();
  // Un échec ne doit pas passer inaperçu dans un script d'exploitation.
  if (echecs > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
