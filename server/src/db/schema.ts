/**
 * Schéma de la base SQLite.
 *
 * Le DDL est une constante TypeScript plutôt qu'un fichier .sql à côté : comme
 * ça `npm run build` n'a rien à copier, le schéma part avec le code compilé.
 *
 * Deux conventions valables partout :
 *
 * - `*_key`  : version normalisée d'une chaîne, destinée aux comparaisons.
 *   `path_key` = NFC + minuscules (Windows ignore la casse).
 *   `title_key` = NFC + minuscules + sans accents + sans ponctuation, c'est la
 *   clé qui regroupe un même film trouvé sur les deux racines.
 * - Les dates sont des chaînes ISO 8601 en UTC. Simple à lire, simple à trier.
 *
 * Les colonnes marquées « phase suivante » sont créées dès maintenant et
 * laissées à NULL : elles seront remplies plus tard par ffprobe ou par un
 * fournisseur de métadonnées. Les créer tout de suite évite une migration.
 */

/**
 * 1 — index initial (phase 1)
 * 2 — enrichissement (phase 2) : file de jobs, pistes audio, sous-titres
 *     embarqués, chemin brut des fichiers.
 * 3 — métadonnées TMDB : genres, appariements et leurs candidats, colonnes
 *     descriptives sur les œuvres.
 * 4 — appariements validés à la main, que les passes automatiques ne doivent
 *     jamais défaire.
 * 5 — logos de titres (title treatments), incrustés sur les vignettes.
 * 6 — personnes et crédits : réalisation, création, distribution.
 * 7 — lecture : chemin brut des sous-titres, pour l'accès disque.
 * 8 — index des images clés, pour un découpage HLS fidèle à la source.
 * 9 — profil Dolby Vision, qui décide si le tone mapping est possible.
 * 10 — reprise de lecture : durée totale et dernier fichier employé.
 *
 * Les évolutions sont additives et toutes les instructions sont en
 * `IF NOT EXISTS` : rouvrir une base v1 la complète sans rien perdre.
 */
export const SCHEMA_VERSION = 10;

export const SCHEMA_SQL = `
-- ---------------------------------------------------------------------------
-- Bibliothèques et racines
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS library (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('movie', 'show'))
);

-- Une bibliothèque = plusieurs racines. On garde la racine d'origine de chaque
-- fichier pour pouvoir dire « ce film est présent sur les deux partages ».
CREATE TABLE IF NOT EXISTS library_root (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id  TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  path_key    TEXT NOT NULL,
  UNIQUE (library_id, path_key)
);

-- ---------------------------------------------------------------------------
-- Œuvres
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS movie (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id    TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  title_key     TEXT NOT NULL,
  year          INTEGER,
  sort_title    TEXT NOT NULL,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- phase suivante : métadonnées
  poster_path   TEXT,
  backdrop_path TEXT,
  overview      TEXT,
  tmdb_id       INTEGER
);

-- IFNULL(year, -1) parce qu'en SQLite deux NULL sont considérés comme
-- différents dans un index unique : sans ça, deux films sans année portant le
-- même titre créeraient deux fiches.
CREATE UNIQUE INDEX IF NOT EXISTS movie_identity
  ON movie (library_id, title_key, IFNULL(year, -1));
CREATE INDEX IF NOT EXISTS movie_sort ON movie (library_id, sort_title);

CREATE TABLE IF NOT EXISTS show (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id    TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  title_key     TEXT NOT NULL,
  year          INTEGER,
  sort_title    TEXT NOT NULL,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- phase suivante : métadonnées
  poster_path   TEXT,
  backdrop_path TEXT,
  overview      TEXT,
  tmdb_id       INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS show_identity
  ON show (library_id, title_key, IFNULL(year, -1));
CREATE INDEX IF NOT EXISTS show_title_key ON show (library_id, title_key);
CREATE INDEX IF NOT EXISTS show_sort ON show (library_id, sort_title);

CREATE TABLE IF NOT EXISTS season (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id        INTEGER NOT NULL REFERENCES show(id) ON DELETE CASCADE,
  season_number  INTEGER NOT NULL,
  title          TEXT,
  added_at       TEXT NOT NULL,
  -- phase suivante : métadonnées
  poster_path    TEXT,
  overview       TEXT,
  UNIQUE (show_id, season_number)
);

CREATE TABLE IF NOT EXISTS episode (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id             INTEGER NOT NULL REFERENCES show(id) ON DELETE CASCADE,
  season_id           INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  season_number       INTEGER NOT NULL,
  episode_number      INTEGER NOT NULL,
  -- renseigné pour les épisodes doubles (S01E01-E02), NULL sinon
  episode_number_end  INTEGER,
  title               TEXT,
  added_at            TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  -- phase suivante : métadonnées
  poster_path         TEXT,
  backdrop_path       TEXT,
  overview            TEXT,
  tmdb_id             INTEGER,
  UNIQUE (show_id, season_number, episode_number)
);

CREATE INDEX IF NOT EXISTS episode_by_season ON episode (season_id, episode_number);

-- ---------------------------------------------------------------------------
-- Fichiers
-- ---------------------------------------------------------------------------

-- Un film ou un épisode peut avoir PLUSIEURS fichiers : version longue et
-- version cinéma, ou le même fichier présent sur les deux racines. La relation
-- porte donc du côté du fichier (movie_id / episode_id), jamais l'inverse.
CREATE TABLE IF NOT EXISTS media_file (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id       TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  library_root_id  INTEGER NOT NULL REFERENCES library_root(id) ON DELETE CASCADE,

  path             TEXT NOT NULL,
  path_key         TEXT NOT NULL UNIQUE,
  relative_path    TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  extension        TEXT NOT NULL,

  -- taille et date de modification : c'est ce qui rend le scan incrémental.
  size_bytes       INTEGER NOT NULL,
  mtime_ms         INTEGER NOT NULL,

  -- un fichier disparu est marqué absent, jamais supprimé.
  present          INTEGER NOT NULL DEFAULT 1,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,

  movie_id         INTEGER REFERENCES movie(id) ON DELETE SET NULL,
  episode_id       INTEGER REFERENCES episode(id) ON DELETE SET NULL,

  parse_status     TEXT NOT NULL DEFAULT 'unparsed' CHECK (parse_status IN ('ok', 'unparsed')),
  parse_reason     TEXT,

  -- phase suivante : renseignées par ffprobe
  container        TEXT,
  video_codec      TEXT,
  audio_codec      TEXT,
  resolution       TEXT,
  duration_seconds REAL,
  bitrate          INTEGER,
  hdr              TEXT
);

CREATE INDEX IF NOT EXISTS media_file_by_movie ON media_file (movie_id) WHERE movie_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_file_by_episode ON media_file (episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_file_by_library ON media_file (library_id, present);

CREATE TABLE IF NOT EXISTS subtitle (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id     INTEGER NOT NULL REFERENCES media_file(id) ON DELETE CASCADE,
  path              TEXT NOT NULL,
  path_key          TEXT NOT NULL UNIQUE,
  file_name         TEXT NOT NULL,
  format            TEXT NOT NULL,
  language          TEXT,
  forced            INTEGER NOT NULL DEFAULT 0,
  hearing_impaired  INTEGER NOT NULL DEFAULT 0,
  size_bytes        INTEGER,
  mtime_ms          INTEGER,
  present           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS subtitle_by_file ON subtitle (media_file_id);

-- ---------------------------------------------------------------------------
-- Phase suivante : utilisateurs, reprise de lecture, pré-transcodage
-- Créées maintenant, remplies plus tard. Aucun code ne les utilise encore,
-- à l'exception de l'utilisateur "default" créé au premier lancement.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playback_progress (
  user_id          INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- media_id pointe sur movie.id ou episode.id selon media_type. Pas de clé
  -- étrangère possible sur deux tables : c'est le code qui garantit la cohérence.
  media_id         INTEGER NOT NULL,
  media_type       TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
  position_seconds REAL NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  watched          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, media_id, media_type)
);

-- Variantes HLS/CMAF pré-générées, une ligne par définition proposée.
CREATE TABLE IF NOT EXISTS rendition (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id  INTEGER NOT NULL REFERENCES media_file(id) ON DELETE CASCADE,
  height         INTEGER NOT NULL,
  bitrate        INTEGER,
  path           TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (media_file_id, height)
);

-- ---------------------------------------------------------------------------
-- Divers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Phase 2 — file de travaux
-- ---------------------------------------------------------------------------

-- Une ligne = un travail à faire sur une cible. La file est persistée pour
-- qu'une passe interrompue reprenne où elle en était, sans tout refaire.
--
-- « fingerprint » est l'empreinte de la cible au moment du traitement (pour les
-- fichiers : taille et date de modification). Si elle change, le travail est
-- automatiquement remis en attente ; sinon il est laissé tel quel.
CREATE TABLE IF NOT EXISTS job (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  queue        TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  fingerprint  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (queue, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS job_by_queue_status ON job (queue, status);

-- ---------------------------------------------------------------------------
-- Phase 2 — pistes détectées par ffprobe
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audio_track (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id  INTEGER NOT NULL REFERENCES media_file(id) ON DELETE CASCADE,
  stream_index   INTEGER NOT NULL,
  codec          TEXT,
  channels       INTEGER,
  language       TEXT,
  title          TEXT,
  is_default     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (media_file_id, stream_index)
);

CREATE INDEX IF NOT EXISTS audio_track_by_file ON audio_track (media_file_id);

-- « is_image_based » distingue les sous-titres bitmap (PGS, VOBSUB, DVB) des
-- sous-titres texte (SubRip, ASS, MOV_TEXT). Les premiers sont des images : ils
-- ne peuvent pas être convertis en WebVTT et imposeront soit une incrustation,
-- soit un rendu côté client. C'est un critère dimensionnant pour la suite.
CREATE TABLE IF NOT EXISTS embedded_subtitle (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id   INTEGER NOT NULL REFERENCES media_file(id) ON DELETE CASCADE,
  stream_index    INTEGER NOT NULL,
  codec           TEXT,
  language        TEXT,
  title           TEXT,
  is_forced       INTEGER NOT NULL DEFAULT 0,
  is_default      INTEGER NOT NULL DEFAULT 0,
  is_image_based  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (media_file_id, stream_index)
);

CREATE INDEX IF NOT EXISTS embedded_subtitle_by_file ON embedded_subtitle (media_file_id);

-- ---------------------------------------------------------------------------
-- Phase 3 — métadonnées TMDB
-- ---------------------------------------------------------------------------

-- L'identifiant est celui de TMDB : deux œuvres partageant un genre pointent
-- sur la même ligne, et le libellé se met à jour tout seul d'une passe à l'autre.
CREATE TABLE IF NOT EXISTS genre (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movie_genre (
  movie_id  INTEGER NOT NULL REFERENCES movie(id) ON DELETE CASCADE,
  genre_id  INTEGER NOT NULL REFERENCES genre(id) ON DELETE CASCADE,
  PRIMARY KEY (movie_id, genre_id)
);

CREATE TABLE IF NOT EXISTS show_genre (
  show_id   INTEGER NOT NULL REFERENCES show(id) ON DELETE CASCADE,
  genre_id  INTEGER NOT NULL REFERENCES genre(id) ON DELETE CASCADE,
  PRIMARY KEY (show_id, genre_id)
);

-- Trace de l'appariement avec TMDB, y compris quand il a échoué.
--
-- « status » vaut :
--   applied      — correspondance sûre, les métadonnées ont été écrites ;
--   needs_review — correspondance douteuse, RIEN n'a été écrit, à trancher
--                  à la main dans l'écran de review ;
--   ignored      — l'utilisateur a décidé de ne pas apparier cette œuvre ;
--   not_found    — TMDB ne renvoie aucun candidat.
--
-- « candidates_json » conserve les cinq premiers résultats de la recherche
-- pour alimenter l'écran de review sans réinterroger TMDB.
CREATE TABLE IF NOT EXISTS tmdb_match (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type      TEXT NOT NULL CHECK (target_type IN ('movie', 'show')),
  target_id        INTEGER NOT NULL,
  status           TEXT NOT NULL
                   CHECK (status IN ('applied', 'needs_review', 'ignored', 'not_found')),
  tmdb_id          INTEGER,
  confidence       REAL,
  reason           TEXT,
  candidates_json  TEXT,
  searched_title   TEXT,
  searched_year    INTEGER,
  updated_at       TEXT NOT NULL,
  UNIQUE (target_type, target_id)
);

CREATE INDEX IF NOT EXISTS tmdb_match_by_status ON tmdb_match (status);

-- ---------------------------------------------------------------------------
-- Phase 6 — personnes et crédits
-- ---------------------------------------------------------------------------

-- La clé primaire est l'identifiant TMDB : la même personne rencontrée sur
-- vingt films n'occupe qu'une ligne, et son nom se corrige d'une passe à
-- l'autre. « profile_path » est le chemin TMDB brut, conservé pour plus tard —
-- les photos ne sont pas téléchargées pour l'instant.
CREATE TABLE IF NOT EXISTS person (
  tmdb_id       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  profile_path  TEXT
);

-- Un crédit relie une personne à une œuvre.
--
-- « work_id » désigne movie.id ou show.id selon « work_type ». Comme pour
-- playback_progress, aucune clé étrangère n'est possible sur deux tables : la
-- cohérence est tenue par le code, qui réécrit tous les crédits d'une œuvre en
-- bloc à chaque enrichissement.
--
-- « role » dit ce que la fiche affiche — « Réalisation », « Création »,
-- « Distribution » — quand « department » garde la valeur TMDB d'origine.
-- La colonne de rang s'appelle « credit_order » et non « order » : ce dernier
-- est un mot réservé SQL qu'il faudrait échapper dans chaque requête.
CREATE TABLE IF NOT EXISTS credit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id       INTEGER NOT NULL,
  work_type     TEXT NOT NULL CHECK (work_type IN ('movie', 'show')),
  person_id     INTEGER NOT NULL REFERENCES person(tmdb_id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('cast', 'director', 'creator')),
  character     TEXT,
  department    TEXT,
  credit_order  INTEGER,
  UNIQUE (work_type, work_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS credit_by_work ON credit (work_type, work_id);
CREATE INDEX IF NOT EXISTS credit_by_person ON credit (person_id);

-- ---------------------------------------------------------------------------
-- Phase 8 — index des images clés, pour le découpage HLS
-- ---------------------------------------------------------------------------

-- En remux la vidéo est copiée : ffmpeg ne peut couper qu'aux images clés
-- existantes, dont l'espacement va de 1 à 12 secondes selon les fichiers et
-- varie à l'intérieur d'un même fichier. Le manifeste doit donc décrire la
-- découpe RÉELLE, ce qui suppose de connaître ces positions.
--
-- Les énumérer coûte ~2 s par film — ffprobe lit l'index du conteneur sans
-- rien décoder — mais autant ne le faire qu'une fois.
--
-- « fingerprint » est taille + date de modification : si le fichier change,
-- l'index est refait plutôt que de servir une découpe qui ne correspond plus.
CREATE TABLE IF NOT EXISTS keyframe_index (
  media_file_id  INTEGER PRIMARY KEY REFERENCES media_file(id) ON DELETE CASCADE,
  fingerprint    TEXT NOT NULL,
  -- Tableau JSON de secondes. ~1000 entrées pour un film de deux heures.
  times_json     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
`;

/**
 * Ajouts de colonnes sur des tables existantes.
 *
 * SQLite ne connaît pas `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` : on regarde
 * donc les colonnes en place avant d'ajouter. Chaque entrée est jouée au plus
 * une fois, et rejouer la migration sur une base à jour ne fait rien.
 */
export const COLUMN_ADDITIONS: { table: string; column: string; definition: string }[] = [
  /*
   * Chemin EXACT du fichier tel que readdir l'a renvoyé, sans normalisation.
   *
   * `path` est en NFC : c'est la forme qu'on compare et qu'on affiche. Mais
   * NTFS et SMB comparent les noms octet à octet, donc un chemin recomposé peut
   * ne pas exister sur le disque. Tout accès disque (ffprobe, et plus tard la
   * lecture) doit passer par `raw_path`.
   */
  { table: 'media_file', column: 'raw_path', definition: 'TEXT' },

  // --- Phase 3 : descriptif venu de TMDB -----------------------------------
  // `poster_path` et `backdrop_path` existent depuis la phase 1 et contiennent
  // le chemin TMDB brut (« /abc.jpg »). L'API le transforme en URL locale ;
  // l'image elle-même est téléchargée sous data/images.
  { table: 'movie', column: 'release_date', definition: 'TEXT' },
  { table: 'movie', column: 'runtime', definition: 'INTEGER' },
  { table: 'movie', column: 'vote_average', definition: 'REAL' },
  { table: 'movie', column: 'original_title', definition: 'TEXT' },
  { table: 'movie', column: 'tagline', definition: 'TEXT' },

  { table: 'show', column: 'first_air_date', definition: 'TEXT' },
  { table: 'show', column: 'status', definition: 'TEXT' },
  { table: 'show', column: 'number_of_seasons', definition: 'INTEGER' },
  { table: 'show', column: 'vote_average', definition: 'REAL' },
  { table: 'show', column: 'original_title', definition: 'TEXT' },

  { table: 'season', column: 'tmdb_id', definition: 'INTEGER' },
  { table: 'season', column: 'air_date', definition: 'TEXT' },

  { table: 'episode', column: 'still_path', definition: 'TEXT' },
  { table: 'episode', column: 'air_date', definition: 'TEXT' },
  { table: 'episode', column: 'vote_average', definition: 'REAL' },
  { table: 'episode', column: 'runtime', definition: 'INTEGER' },

  /*
   * --- Phase 4 : décisions humaines ---------------------------------------
   *
   * Un appariement validé à la main fait autorité. Les passes automatiques ne
   * le remettent jamais en cause, même en trouvant mieux noté : l'utilisateur
   * a vu le fichier, le catalogue non.
   *
   * Ces colonnes vivent sur `tmdb_match`, indexé par (target_type, target_id).
   * Comme une œuvre n'est jamais supprimée par un scan — seuls ses fichiers
   * passent à `present = 0` — la décision survit à la disparition puis au
   * retour d'un fichier.
   */
  { table: 'tmdb_match', column: 'manually_matched', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'tmdb_match', column: 'decided_at', definition: 'TEXT' },

  /*
   * --- Phase 5 : logos de titres ------------------------------------------
   *
   * Le « title treatment » est le logo graphique du film ou de la série, sur
   * fond transparent. C'est lui que Disney+ et Netflix incrustent sur les
   * vignettes à la place du titre en texte, et c'est ce qui donne son identité
   * visuelle à l'interface.
   *
   * NULL quand TMDB n'en propose aucun : l'interface doit alors afficher le
   * titre en texte, ce repli est prévu partout.
   */
  { table: 'movie', column: 'logo_path', definition: 'TEXT' },
  { table: 'show', column: 'logo_path', definition: 'TEXT' },

  /*
   * --- Phase 6 : classification par âge ------------------------------------
   *
   * « Tous publics », « 12 », « TV-MA »… L'onglet Détails l'affiche à côté de
   * la durée et du genre. TMDB la range hors du détail de l'œuvre, dans
   * `release_dates` pour les films et `content_ratings` pour les séries.
   */
  { table: 'movie', column: 'certification', definition: 'TEXT' },
  { table: 'show', column: 'certification', definition: 'TEXT' },

  /*
   * --- Phase 7 : lecture ---------------------------------------------------
   *
   * Même raison que pour `media_file.raw_path` : la route qui sert un
   * sous-titre le lit sur le disque, et le disque veut le chemin EXACT rendu
   * par readdir, pas sa forme NFC. La colonne est renseignée au scan suivant ;
   * elle reste à NULL entre-temps, et la lecture retombe alors sur `path`.
   */
  { table: 'subtitle', column: 'raw_path', definition: 'TEXT' },

  /*
   * --- Phase 9 : Dolby Vision ----------------------------------------------
   *
   * Le PROFIL décide de tout. Un profil 8 porte une couche de base
   * rétro-compatible qu'on traite comme du HDR10 ordinaire ; un profil 5 n'a
   * aucun repli, et le traiter de la même façon produit une image verdâtre.
   *
   * Sondé à la demande, une seule fois par fichier : sur cette bibliothèque,
   * 93 des 94 fichiers Dolby Vision sont en profil 8 compatibilité 1, et un
   * seul en profil 5.
   *
   * NULL signifie « pas encore sondé », 0 « sondé, aucune configuration
   * Dolby Vision trouvée » — la distinction évite de resonder indéfiniment un
   * fichier qui n'a rien à déclarer.
   */
  { table: 'media_file', column: 'dv_profile', definition: 'INTEGER' },
  { table: 'media_file', column: 'dv_bl_compat', definition: 'INTEGER' },

  /*
   * --- Phase 10 : reprise de lecture ---------------------------------------
   *
   * La durée TOTALE au moment de l'enregistrement, telle que le lecteur la
   * connaît. Sans elle, impossible de calculer un pourcentage : la durée d'une
   * œuvre n'est pas celle d'un fichier — un film en deux versions en a deux, et
   * la progression est portée par l'œuvre.
   *
   * Null quand le lecteur ne la connaissait pas encore. Les seuils de 5 % et
   * 90 % ne s'appliquent alors pas, et l'entrée n'apparaît pas dans la rangée.
   */
  { table: 'playback_progress', column: 'duration_seconds', definition: 'REAL' },

  /*
   * Dernier fichier employé. Sert à rouvrir la lecture au bon endroit quand
   * une œuvre a plusieurs fichiers — mais la POSITION, elle, reste celle de
   * l'œuvre : reprendre une version reprend l'autre au même instant.
   */
  { table: 'playback_progress', column: 'media_file_id', definition: 'INTEGER' },
];

