/**
 * Commande `npm run migrate-paths` — réécriture des chemins d'une racine à l'autre.
 *
 * Sert au passage de Windows au NAS : la base contient des chemins UNC qui
 * n'existent pas sous Linux. Un rescan les régénérerait, mais perdrait les 62
 * appariements TMDB validés à la main et les entrées ignorées — ces décisions
 * ne sont pas reproductibles.
 *
 * SIMULATION PAR DÉFAUT. Rien n'est écrit sans `--apply`, et l'existence des
 * fichiers est vérifiée dans les DEUX modes : on sait donc si la migration va
 * marcher AVANT de la lancer.
 *
 * Options :
 *   --map=<source>=><destination>   correspondance de racine, répétable
 *   --apply                         écrit réellement (défaut : simulation)
 *   --no-verify                     saute la vérification sur disque
 *   --limit=<n>                     n'examine que n fichiers (mise au point)
 *
 * Pour revenir en arrière : restaurer la sauvegarde annoncée par la commande,
 * ou rejouer la migration avec les correspondances inversées.
 */
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { loadConfig, resolveDatabasePath } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { pathKey } from '../util/text.js';
import { migratePath, parseMapping, toPosix, validateMapping, type RootMapping } from './paths.js';

interface Options {
  mappings: RootMapping[];
  apply: boolean;
  verify: boolean;
  limit: number;
}

function parseArguments(argv: string[]): Options {
  const options: Options = { mappings: [], apply: false, verify: true, limit: Number.POSITIVE_INFINITY };

  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--no-verify') options.verify = false;
    else if (argument.startsWith('--limit=')) {
      const value = Number(argument.slice('--limit='.length));
      if (Number.isFinite(value) && value > 0) options.limit = Math.floor(value);
    } else if (argument.startsWith('--map=')) {
      const mapping = parseMapping(argument.slice('--map='.length));
      if (mapping === null) {
        throw new Error(
          `Correspondance illisible : « ${argument} ».\n` +
            'Attendu : --map=<source>=><destination>, par exemple\n' +
            '  --map="\\\\NAS\\Plex S1\\Vidéos\\films=>/mnt/@usb/sdb1/Vidéos/films"',
        );
      }
      options.mappings.push(mapping);
    }
  }

  return options;
}

function line(character = '─', width = 78): string {
  return character.repeat(width);
}

interface Row {
  id: number;
  path: string;
  rawPath?: string | null;
  relativePath?: string | null;
}

interface TableReport {
  table: string;
  total: number;
  migrated: number;
  untouched: { id: number; path: string }[];
}

/**
 * Sauvegarde de la base.
 *
 * `VACUUM INTO` produit un fichier SQLite complet et cohérent, journal compris.
 * Une simple copie du .db laisserait de côté le -wal et pourrait rendre une
 * base tronquée.
 */
function backup(db: Db, databasePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${databasePath}.avant-migration-${stamp}`;

  try {
    db.prepare('VACUUM INTO ?').run(target);
  } catch {
    // Un VACUUM INTO refusé (SQLite ancien) ne doit pas empêcher la sauvegarde.
    copyFileSync(databasePath, target);
  }

  return target;
}

/** Réécrit une colonne de chemins, et rend ce qui n'a pas été reconnu. */
function migrateTable(
  db: Db,
  options: Options,
  spec: {
    table: string;
    select: string;
    update: (row: Row, migrated: string) => void;
  },
): TableReport {
  const rows = db.prepare(spec.select).all() as Row[];
  const report: TableReport = { table: spec.table, total: rows.length, migrated: 0, untouched: [] };

  for (const row of rows) {
    const migrated = migratePath(row.path, options.mappings);

    if (migrated === null) {
      // Un chemin déjà migré n'est pas un problème : la commande est rejouable.
      if (row.path.startsWith('/')) continue;
      report.untouched.push({ id: row.id, path: row.path });
      continue;
    }

    report.migrated += 1;
    if (options.apply) spec.update(row, migrated);
  }

  return report;
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));

  if (options.mappings.length === 0) {
    throw new Error(
      'Aucune correspondance donnée.\n\n' +
        'Exemple pour ce déploiement :\n' +
        '  npm run migrate-paths -- \\\n' +
        '    --map="\\\\NASSSITO\\Plex S1\\Vidéos\\films=>/mnt/@usb/sdb1/Vidéos/films" \\\n' +
        '    --map="\\\\NASSSITO\\Plex S1\\Vidéos\\séries=>/mnt/@usb/sdb1/Vidéos/séries" \\\n' +
        '    --map="\\\\NASSSITO\\plex\\Media\\Films=>/volume1/plex/Media/Films" \\\n' +
        '    --map="\\\\NASSSITO\\plex\\Media\\Séries=>/volume1/plex/Media/Séries"',
    );
  }

  for (const mapping of options.mappings) {
    const problem = validateMapping(mapping);
    if (problem !== null) throw new Error(`Correspondance « ${mapping.from} » : ${problem}.`);
  }

  const databasePath = resolveDatabasePath(loadConfig());
  const db = openDatabase(databasePath);

  console.log(line('═'));
  console.log(`MIGRATION DES CHEMINS — ${options.apply ? 'APPLICATION' : 'SIMULATION'}`);
  console.log(line('═'));
  console.log(`  base : ${databasePath}`);
  console.log('');
  console.log('  correspondances :');
  for (const mapping of options.mappings) console.log(`    ${mapping.from}\n      -> ${mapping.to}`);
  console.log('');

  let backupPath: string | null = null;
  if (options.apply) {
    backupPath = backup(db, databasePath);
    console.log(`  sauvegarde : ${backupPath}`);
    console.log('');
  }

  // --- Réécriture ---------------------------------------------------------
  const updateRoot = db.prepare('UPDATE library_root SET path = ?, path_key = ? WHERE id = ?');
  const updateFile = db.prepare(
    'UPDATE media_file SET path = ?, path_key = ?, raw_path = ?, relative_path = ? WHERE id = ?',
  );
  const updateSubtitle = db.prepare('UPDATE subtitle SET path = ?, path_key = ?, raw_path = ? WHERE id = ?');

  const reports: TableReport[] = [];

  const run = db.transaction(() => {
    reports.push(
      migrateTable(db, options, {
        table: 'library_root',
        select: 'SELECT id, path FROM library_root',
        update: (row, migrated) => updateRoot.run(migrated, pathKey(migrated), row.id),
      }),
    );

    reports.push(
      migrateTable(db, options, {
        table: 'media_file',
        select: 'SELECT id, path, raw_path AS rawPath, relative_path AS relativePath FROM media_file',
        update: (row, migrated) => {
          /*
           * `raw_path` est le chemin EXACT rendu par readdir. Sous Windows il
           * pouvait différer de `path` par sa forme de normalisation ; ici on
           * migre les deux séparément pour ne pas perdre cette distinction, et
           * on retombe sur le chemin migré quand il était vide.
           */
          const rawMigrated =
            row.rawPath === null || row.rawPath === undefined
              ? migrated
              : (migratePath(row.rawPath, options.mappings) ?? migrated);

          updateFile.run(
            migrated,
            pathKey(migrated),
            rawMigrated,
            toPosix(row.relativePath ?? ''),
            row.id,
          );
        },
      }),
    );

    reports.push(
      migrateTable(db, options, {
        table: 'subtitle',
        select: 'SELECT id, path, raw_path AS rawPath FROM subtitle',
        update: (row, migrated) => {
          const rawMigrated =
            row.rawPath === null || row.rawPath === undefined
              ? migrated
              : (migratePath(row.rawPath, options.mappings) ?? migrated);
          updateSubtitle.run(migrated, pathKey(migrated), rawMigrated, row.id);
        },
      }),
    );
  });

  run();

  console.log(line());
  console.log('LIGNES RÉÉCRITES');
  console.log(line());
  for (const report of reports) {
    console.log(`  ${report.table.padEnd(16)} ${String(report.migrated).padStart(5)} / ${report.total}`);
  }

  /*
   * Répartition par racine.
   *
   * Les chemins sont recalculés plutôt que relus : en simulation la base
   * contient encore les anciens, et un comptage sur les nouveaux rendrait zéro
   * partout — le rapport n'apprendrait rien avant application.
   */
  const filePaths = (db.prepare('SELECT path FROM media_file').all() as { path: string }[]).map((row) =>
    row.path.startsWith('/') ? row.path : (migratePath(row.path, options.mappings) ?? row.path),
  );

  console.log('');
  console.log('  par racine :');
  for (const mapping of options.mappings) {
    const target = toPosix(mapping.to);
    const count = filePaths.filter((value) => value === target || value.startsWith(`${target}/`)).length;
    console.log(`    ${target.padEnd(34)} ${String(count).padStart(5)} fichier(s)`);
  }

  const unmatched = reports.flatMap((report) => report.untouched);
  if (unmatched.length > 0) {
    console.log('');
    console.log(`  ${unmatched.length} chemin(s) sans correspondance :`);
    for (const row of unmatched.slice(0, 10)) console.log(`    ${row.path}`);
    if (unmatched.length > 10) console.log(`    … et ${unmatched.length - 10} de plus`);
  }

  // --- Vérification sur disque --------------------------------------------
  if (options.verify) {
    console.log('');
    console.log(line());
    console.log(options.apply ? 'VÉRIFICATION SUR DISQUE' : 'VÉRIFICATION SUR DISQUE (chemins simulés)');
    console.log(line());

    const files = db
      .prepare('SELECT id, path, raw_path AS rawPath FROM media_file WHERE present = 1')
      .all() as Row[];

    const missing: string[] = [];
    let checked = 0;

    for (const row of files.slice(0, options.limit)) {
      /*
       * En simulation la base contient encore les anciens chemins : on vérifie
       * donc ce que la migration PRODUIRAIT. C'est tout l'intérêt — savoir que
       * ça marchera avant d'écrire quoi que ce soit.
       */
      const candidate = options.apply
        ? (row.rawPath ?? row.path)
        : (migratePath(row.rawPath ?? row.path, options.mappings) ?? row.rawPath ?? row.path);

      checked += 1;
      if (!existsSync(candidate)) missing.push(candidate);
    }

    console.log(`  fichiers vérifiés        ${checked}`);
    console.log(`  introuvables sur disque  ${missing.length}`);

    if (missing.length > 0) {
      console.log('');
      for (const file of missing.slice(0, 15)) console.log(`    ${file}`);
      if (missing.length > 15) console.log(`    … et ${missing.length - 15} de plus`);
      console.log('');
      console.log('  Un compte non nul signale une correspondance fausse, un partage non');
      console.log('  monté, ou une différence de casse. NE PAS appliquer tant qu’il n’est');
      console.log('  pas nul — ou restaurer la sauvegarde si c’est déjà fait.');
    }
  }

  // --- Contrôle d'intégrité ------------------------------------------------
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM movie)   AS films,
         (SELECT COUNT(*) FROM show)    AS series,
         (SELECT COUNT(*) FROM episode) AS episodes,
         (SELECT COUNT(*) FROM tmdb_match WHERE status = 'applied')      AS appariees,
         (SELECT COUNT(*) FROM tmdb_match WHERE manually_matched = 1)    AS manuelles,
         (SELECT COUNT(*) FROM tmdb_match WHERE status = 'ignored')      AS ignorees`,
    )
    .get() as Record<string, number>;

  console.log('');
  console.log(line());
  console.log('LA BASE APRÈS MIGRATION');
  console.log(line());
  console.log(`  films                    ${counts.films}`);
  console.log(`  séries                   ${counts.series}`);
  console.log(`  épisodes                 ${counts.episodes}`);
  console.log(`  œuvres appariées         ${counts.appariees}`);
  console.log(`  décisions manuelles      ${counts.manuelles}`);
  console.log(`  entrées ignorées         ${counts.ignorees}`);

  console.log('');
  console.log(line('═'));
  if (options.apply) {
    console.log(`Migration appliquée. Sauvegarde : ${path.basename(backupPath as string)}`);
  } else {
    console.log('Simulation. Relancer avec --apply pour écrire.');
  }
  console.log(line('═'));

  db.close();
}

try {
  main();
} catch (error) {
  console.error(`\n${(error as Error).message}`);
  process.exitCode = 1;
}
