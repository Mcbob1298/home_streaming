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
    addMissingColumns(db);
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
function addMissingColumns(db: Db): void {
  for (const addition of COLUMN_ADDITIONS) {
    const columns = db.prepare(`PRAGMA table_info(${addition.table})`).all() as { name: string }[];
    if (columns.some((column) => column.name === addition.column)) continue;
    db.exec(`ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`);
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
