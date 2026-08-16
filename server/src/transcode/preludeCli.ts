/**
 * `npm run prelude -- --file 365` — fabrique le prélude d'un fichier.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IL PASSE PAR LA MÊME MACHINE QUE LA LECTURE. C'EST TOUT L'ENJEU.
 *
 * Le prélude et la suite doivent avoir exactement les mêmes paramètres
 * d'encodage — résolution, profil, débit, images par seconde, tone mapping,
 * réglages audio, grille de segments. Une liste d'arguments recopiée ici
 * divergerait à la première modification de l'encodeur, et la jonction
 * décrocherait sans que rien ne le signale.
 *
 * On construit donc le MÊME `SessionInput` que la route de lecture, via
 * `resolvePlayback`, on le donne à une vraie `TranscodeSession`, et on lui
 * réclame ses premiers segments. Les arguments ffmpeg ne sont écrits nulle part
 * ici : ils viennent de `videoArgs()` et `buildAudioArgs()`, les mêmes qui
 * serviront la suite.
 *
 * La seule différence avec une lecture : le répertoire de sortie est durable, et
 * on s'arrête à la fin du préfixe.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { DATA_DIR, loadConfig, loadEnvFile, PRELUDE_DIR, resolveDatabasePath } from '../config.js';
import { openDatabase } from '../db/index.js';
import { detectCapabilities } from './capabilities.js';
import { supportedBackend } from './encode.js';
import { fabriquerPrelude, lireIntention } from './fabriquePrelude.js';

function octets(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} Go`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
  return `${Math.round(n / 1024)} Ko`;
}

async function main(): Promise<void> {
  loadEnvFile();

  /*
   * Les trois intentions viennent d'une SEULE lecture des arguments, partagée
   * avec la commande au pluriel. C'est `--dry` qui se perdait ici : reconnu dans
   * la documentation, jamais transporté jusqu'à la fabrique.
   */
  const intention = lireIntention(process.argv.slice(2));
  if (intention.fileId === null) {
    console.error('Usage : npm run prelude -- --file <mediaFileId> [--sdr] [--dry]');
    process.exit(1);
  }

  const config = loadConfig();
  const db = openDatabase(resolveDatabasePath(config));
  const capabilities = await detectCapabilities({ dataDir: DATA_DIR });
  const backend = supportedBackend(capabilities.hardware);

  const resultat = await fabriquerPrelude({
    db,
    id: intention.fileId,
    config,
    capabilities,
    backend,
    preludeRoot: PRELUDE_DIR,
    pourClientSdr: intention.pourClientSdr,
    simulation: intention.simulation,
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log('\n──────────────────────────────────────────────');
  if (resultat.etat === 'deja-valable') {
    console.log(`Déjà valable       : ${resultat.nom}`);
  } else if (resultat.etat === 'fabrique') {
    console.log(`Prélude publié     : ${resultat.dir}`);
    console.log(`Taille sur disque  : ${octets(resultat.bytes)}`);
    console.log(`Temps de génération: ${(resultat.ms / 1000).toFixed(1)} s`);
    console.log(`Empreinte          : ${resultat.signature}`);
  }

  db.close();
}
void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
