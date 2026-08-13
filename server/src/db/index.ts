/**
 * Ouverture de la base SQLite et création du schéma.
 *
 * La base vit toujours en local (jamais sur le NAS) : SQLite en écriture sur un
 * partage SMB est une source connue de corruption, parce que le verrouillage de
 * fichiers réseau n'offre pas les mêmes garanties qu'un disque local.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { AppConfig } from '../config.js';
import { pathKey } from '../util/text.js';
import { COLUMN_ADDITIONS, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type Db = Database.Database;

export const DEFAULT_USER_NAME = 'default';

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Ouvre (et crée si besoin) la base, applique le schéma et garantit
 * l'existence de l'utilisateur "default".
 */
export function openDatabase(databasePath: string, options: { readonly?: boolean } = {}): Db {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath, { readonly: options.readonly === true });

  // WAL : les lectures de l'API ne sont pas bloquées par les écritures du scan.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (options.readonly !== true) {
    db.exec(SCHEMA_SQL);
    backfill(db, addMissingColumns(db));
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
    db.prepare('INSERT OR IGNORE INTO user (name, created_at) VALUES (?, ?)').run(
      DEFAULT_USER_NAME,
      nowIso(),
    );
  }

  return db;
}

/**
 * Applique les ajouts de colonnes du schéma sur une base existante.
 * SQLite n'a pas d'`ADD COLUMN IF NOT EXISTS` : on inspecte avant d'ajouter.
 */
/** Rend les colonnes réellement ajoutées, pour les reprises de données qui suivent. */
function addMissingColumns(db: Db): string[] {
  const added: string[] = [];

  for (const addition of COLUMN_ADDITIONS) {
    const columns = db.prepare(`PRAGMA table_info(${addition.table})`).all() as { name: string }[];
    if (columns.some((column) => column.name === addition.column)) continue;
    db.exec(`ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`);
    added.push(`${addition.table}.${addition.column}`);
  }

  return added;
}

/**
 * Reprises de données jouées UNE FOIS, au moment où leur colonne apparaît.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA BIBLIOTHÈQUE EXISTANTE EST DÉCLARÉE PRÊTE.
 *
 * Un titre dont les sous-titres ne sont pas préparés disparaît des surfaces de
 * parcours : c'est le principe, et il vaut pour ce qu'on AJOUTE. Appliqué
 * rétroactivement, il viderait l'interface pendant les seize heures de la
 * première passe — une bibliothèque qui fonctionne depuis des semaines
 * deviendrait vide au redémarrage suivant.
 *
 * Les fichiers déjà indexés sont donc marqués prêts d'office. Ils le sont au
 * sens où ils l'ont toujours été : sans sous-titres embarqués servis, ce qu'ils
 * n'ont jamais eu. « npm run subtitles » les enrichira sans jamais les cacher.
 * Le verrou ne s'applique qu'aux fichiers vus pour la première fois APRÈS cette
 * migration.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function backfill(db: Db, _addedColumns: string[]): void {
  const gate = db.prepare("SELECT value FROM meta WHERE key = 'subtitles_gate_since'").get() as
    | { value: string }
    | undefined;

  /*
   * Le verrou est posé UNE FOIS, à la première ouverture qui n'en trouve pas.
   *
   * PAS conditionné à l'ajout de la colonne : sur une base où celle-ci existait
   * déjà — cas de toute installation ayant tourné avec la première version — le
   * verrou n'aurait jamais été écrit, et `visibleSql` serait retombé sur son
   * repli « tout est visible ». Le rendre inopérant en silence est exactement ce
   * qu'on cherche à éviter.
   *
   * Tout ce qui est déjà indexé lui est antérieur, donc reste visible ; tout ce
   * qui sera vu ensuite devra être préparé pour apparaître.
   */
  if (gate === undefined) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('subtitles_gate_since', ?)").run(nowIso());
  }

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * RÉPARATION — une première version de cette reprise mentait.
   *
   * Elle marquait les fichiers existants comme PRÊTS pour les préserver du
   * verrou. Mais « prêt » veut dire « ses WebVTT sont écrits », et ils ne
   * l'étaient pas : 2 306 fichiers annonçaient des pistes que le serveur
   * renvoyait en 409. La visibilité passe désormais par la date du verrou, et
   * l'empreinte redevient ce qu'elle prétend être.
   *
   * On ne remet à NULL que ce qui n'a PAS été réellement préparé : la file sait
   * lesquels, et les extractions déjà faites ne doivent pas être refaites.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const repaired = db.prepare("SELECT value FROM meta WHERE key = 'subtitles_ready_repaired'").get();
  if (repaired === undefined) {
    db.prepare(
      `UPDATE media_file
       SET subtitles_fingerprint = NULL
       WHERE subtitles_fingerprint IS NOT NULL
         AND EXISTS (SELECT 1 FROM embedded_subtitle s
                     WHERE s.media_file_id = media_file.id AND s.is_image_based = 0 AND s.codec IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM job j
                         WHERE j.queue = 'subtitles' AND j.target_type = 'media_file'
                           AND j.target_id = media_file.id AND j.status = 'done')`,
    ).run();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('subtitles_ready_repaired', ?)").run(nowIso());
  }
}

export interface LibraryRootRow {
  id: number;
  library_id: string;
  path: string;
  path_key: string;
}

/**
 * Aligne les tables `library` / `library_root` sur config.json.
 *
 * Une racine retirée de la config voit ses lignes supprimées (donc ses fichiers
 * aussi, par cascade). C'est voulu : elle ne fait plus partie de la
 * bibliothèque. En revanche un fichier simplement absent du disque est marqué
 * `present = 0`, il n'est jamais supprimé.
 */
export function syncLibrariesFromConfig(db: Db, config: AppConfig): Map<string, LibraryRootRow[]> {
  const upsertLibrary = db.prepare(
    `INSERT INTO library (id, label, type) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, type = excluded.type`,
  );
  const upsertRoot = db.prepare(
    `INSERT INTO library_root (library_id, path, path_key) VALUES (?, ?, ?)
     ON CONFLICT(library_id, path_key) DO UPDATE SET path = excluded.path`,
  );
  const selectRoots = db.prepare(
    'SELECT id, library_id, path, path_key FROM library_root WHERE library_id = ?',
  );
  const deleteRoot = db.prepare('DELETE FROM library_root WHERE id = ?');
  const deleteMissingLibraries = db.prepare(
    `DELETE FROM library WHERE id NOT IN (SELECT value FROM json_each(?))`,
  );

  const rootsByLibrary = new Map<string, LibraryRootRow[]>();

  const run = db.transaction(() => {
    for (const library of config.libraries) {
      upsertLibrary.run(library.id, library.label, library.type);

      const wanted = new Map(library.paths.map((value) => [pathKey(value), value]));
      for (const [key, value] of wanted) upsertRoot.run(library.id, value, key);

      const rows = selectRoots.all(library.id) as LibraryRootRow[];
      const kept: LibraryRootRow[] = [];
      for (const row of rows) {
        if (wanted.has(row.path_key)) kept.push(row);
        else deleteRoot.run(row.id);
      }
      rootsByLibrary.set(library.id, kept);
    }

    deleteMissingLibraries.run(JSON.stringify(config.libraries.map((library) => library.id)));
  });

  run();
  return rootsByLibrary;
}
