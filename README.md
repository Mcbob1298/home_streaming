# Serveur média personnel

Indexe des films et des séries à partir de fichiers sur disque (ici un NAS en SMB)
et les présente dans une page web. Tout part des noms de fichiers : aucune API
externe, aucune donnée provenant de Plex.

**Cette première itération s'arrête à la consultation** : lister, chercher,
filtrer. Pas de lecture vidéo, pas d'authentification, pas d'appel à ffmpeg.

---

## Installation

Il faut Node.js 20 ou plus récent (testé sur Node 24).

```bash
npm install          # installe aussi /server et /web (script postinstall)
cp config.example.json config.json
# éditez config.json : les chemins de vos racines
npm run scan         # première indexation, peut être longue
npm run dev          # API sur :3000 + interface sur :5173
```

Puis ouvrez http://localhost:5173.

---

## Commandes

| Commande        | Effet                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `npm run dev`   | Lance l'API (port 3000) et Vite (port 5173) en parallèle, en rechargement |
| `npm run scan`  | Parcourt les racines et met à jour l'index. **À lancer à la main**        |
| `npm run probe` | Sonde les fichiers avec ffprobe (codecs, définition, durée, pistes)       |
| `npm run metadata` | Apparie avec TMDB et télécharge les affiches                          |
| `npm run cleanup` | Supprime les œuvres sans fichier et les images inutilisées             |
| `npm test`      | Tests unitaires du parser                                                |
| `npm run build` | Compile le serveur (`server/dist`) et l'interface (`web/dist`)           |
| `npm start`     | Lance le serveur compilé, qui sert aussi l'interface si elle est buildée  |

Options du scan :

```bash
npm run scan -- --full              # re-parse tout, même les fichiers inchangés
npm run scan -- --library=films     # une seule bibliothèque
npm run scan -- --concurrency=4     # NAS particulièrement lent
```

Options du sondage :

```bash
npm run probe -- --full             # re-sonde tout, même les fichiers déjà traités
npm run probe -- --retry-failed     # rejoue uniquement les fichiers en échec
npm run probe -- --concurrency=3    # NAS particulièrement lent
npm run probe -- --timeout=60       # délai maximum par fichier, en secondes
```

Options des métadonnées :

```bash
npm run metadata -- --full           # réapparie tout, y compris ce qui est fait
npm run metadata -- --retry-failed   # rejoue uniquement les entrées en échec
npm run metadata -- --refresh        # ignore le cache disque et réinterroge TMDB
npm run metadata -- --shows-only     # ou --movies-only
```

> Aucune de ces passes n'est **jamais** déclenchée par une requête HTTP.
> Ce sont des opérations longues qui écrivent en base et sollicitent lourdement
> le NAS ou l'API ; elles se lancent explicitement, jamais par accident au
> chargement d'une page.

> Le `--` final dans les scripts de la racine n'est pas décoratif : sans lui,
> `npm run scan -- --full` verrait npm avaler `--full` comme une de ses propres
> options au lieu de la transmettre au script.

---

## Organisation des dossiers

```
config.json            votre configuration (ignorée par git)
config.example.json    modèle à recopier
data/                  base SQLite + dernier rapport de scan (ignoré par git)

server/                API et scanner — Node + TypeScript
  src/
    config.ts            lecture et validation de config.json
    util/
      text.ts            normalisation Unicode (NFC), clés de comparaison
      concurrency.ts     limitation du nombre d'accès disque simultanés
    parser/              ★ analyse des noms de fichiers — PUR, testé
      noise.ts             mots « techniques » à écarter (1080p, x264, VOSTFR…)
      common.ts            extraction titre + année
      movie.ts             conventions films
      episode.ts           conventions séries
      subtitle.ts          langue d'un sous-titre externe
      parser.test.ts       tests unitaires (47 cas)
    db/
      schema.ts            schéma SQLite complet
      index.ts             ouverture de la base, synchronisation des racines
    scan/                le scanner
      filters.ts           ce qu'on garde, ce qu'on ignore
      walk.ts              parcours récursif, concurrence limitée
      subtitles.ts         rattachement des sous-titres aux vidéos
      indexer.ts           écriture en base, logique incrémentale
      report.ts            rapport de fin de scan
      cli.ts               point d'entrée de `npm run scan`
    api/
      routes.ts            les cinq routes
      pagination.ts        pagination, tri, recherche
    index.ts             démarrage du serveur HTTP

web/                   interface — React + Vite + Tailwind
  src/
    api.ts               tous les appels réseau et leurs types
    App.tsx              les routes de navigation
    components/          Poster, MediaCard, Toolbar, Pagination, States
    pages/               Home, LibraryPage, MoviePage, ShowPage
```

---

## Configuration

```json
{
  "databasePath": "./data/media.db",
  "libraries": [
    {
      "id": "films",
      "label": "Films",
      "type": "movie",
      "paths": [
        "\\\\NASSSITO\\Plex S1\\Vidéos\\films",
        "\\\\NASSSITO\\plex\\Media\\Films"
      ]
    }
  ]
}
```

- `id` : identifiant stable, utilisé dans les URL (`/library/films`).
- `type` : `movie` ou `show`. C'est lui qui décide quel parser s'applique.
- `paths` : **une bibliothèque peut avoir plusieurs racines.** Elles sont
  fusionnées en une seule liste, et le même film trouvé dans les deux ne compte
  qu'une fois (voir « Regroupement » plus bas).

Les chemins relatifs sont résolus depuis la racine du dépôt, jamais depuis le
dossier courant : `npm run scan` donne le même résultat où qu'on le lance.

> **La base SQLite reste toujours en local.** Écrire une base SQLite sur un
> partage SMB est une source connue de corruption : le verrouillage de fichiers
> réseau n'offre pas les garanties dont SQLite a besoin. `databasePath` doit
> donc pointer sur un disque local.

---

## Le scanner

### Ce qu'il retient

- Extensions vidéo : `.mkv .mp4 .avi .m4v .mov .wmv .ts .m2ts`
- Fichiers d'au moins 50 Mo
- Sous-titres adjacents : `.srt .ass .sub .vtt`

### Ce qu'il ignore

- Les dossiers techniques : `@eaDir` (Synology), `#recycle`, `.grab`,
  `Plex Versions`, `$RECYCLE.BIN`, `System Volume Information`, `lost+found`
- Les noms contenant, en mot entier, `sample`, `extras`, `featurettes`,
  `behind the scenes`, `trailer`
- `.DS_Store`, `Thumbs.db`, `desktop.ini`
- Les fichiers et dossiers cachés — détectés au point initial du nom. Windows
  utilise en réalité un attribut du système de fichiers que Node n'expose pas ;
  le point couvre les cas qui nous intéressent (`.DS_Store`, `.grab`).
- Les liens symboliques et jonctions : sur un NAS ils pointent souvent vers un
  dossier déjà parcouru, parfois en boucle.

Le mot entier plutôt que la sous-chaîne, c'est volontaire : un film qui
s'appellerait « Extraordinaire » ne doit pas disparaître à cause de « extra ».

### Les conventions de nommage comprises

**Films**, du plus fiable au moins fiable :

| Exemple                                        | Résultat                        |
| ---------------------------------------------- | ------------------------------- |
| `Titre (2019)/Titre (2019).mkv`                 | Titre · 2019 (depuis le dossier) |
| `Titre (2019)/CD1.mkv`                          | Titre · 2019 (le dossier gagne)  |
| `Titre.2019.1080p.BluRay.x264-GROUPE.mkv`       | Titre · 2019                    |
| `Action/Titre.2019.1080p.mkv`                   | Titre · 2019 (dossier ignoré)   |
| `Titre.mkv`                                     | Titre · année inconnue          |

Le dossier parent ne l'emporte que **s'il porte lui-même une année**. Sinon
c'est probablement un dossier de rangement (`Action/`, `À voir/`), pas le
dossier du film.

**Séries** :

| Exemple                                                      | Résultat            |
| ------------------------------------------------------------ | ------------------- |
| `Série (2015)/Season 01/Série - S01E02 - Titre épisode.mkv`   | S01E02 « Titre épisode » |
| `Série (2015)/Saison 1/Série - 1x02.mkv`                      | S01E02              |
| `Série/S01/Episode 02 - Titre.mkv`                            | S01E02              |
| `Série/Saison 1/01 - Titre.mkv`                               | S01E01              |
| `Série - Season 1 Episode 2.mkv`                              | S01E02              |
| `Show.S01E01-E02.mkv`, `S01E01E02`, `S01E01-02`, `1x02-03`    | épisode double      |
| `Série/Specials/...`                                          | saison 0            |

Le titre de la série vient du dossier quand il y en a un (plus fiable), du
début du nom de fichier sinon.

### Comment le bruit est retiré

Plutôt que de supprimer les mots techniques un par un — ce qui laisse des
morceaux de titre recollés bizarrement — le parser cherche **la première
occurrence de bruit et coupe tout à partir de là**. Les noms sont toujours
construits « titre d'abord, technique ensuite » :

```
Titre.2019.1080p.BluRay.x264-GROUPE
             ↑ on coupe ici
```

Deux listes de marqueurs, dans `parser/noise.ts` :

- **fort** : ne peut pas être un mot de titre (`1080p`, `x264`, `HEVC`, `DTS`,
  `VOSTFR`, `WEB-DL`…). Coupe même en première position.
- **faible** : pourrait être un vrai mot (`Web`, `French`, `Opus`, `Extended`).
  Ne coupe que s'il y a déjà du texte avant. C'est ce qui permet à
  « French Kiss » et « Web Therapy » de survivre.

Ajouter une convention se fait en ajoutant un motif dans la bonne liste.

Les mentions d'édition (`EXTENDED`, `Director's Cut`, `Version Longue`) sont
traitées comme du bruit **exprès** : les deux versions d'un film se regroupent
alors sur une seule fiche, avec deux fichiers rattachés.

### Regroupement et doublons

Chaque titre reçoit une **clé normalisée** : minuscules, sans accents, sans
ponctuation, `&` devient `and`. C'est elle qui rapproche les deux racines.

```
"Amélie"           →  amelie
"AMELIE"           →  amelie
"Ocean's Eleven"   →  oceans eleven
"Fast & Furious"   →  fast and furious
```

**Films et séries suivent la même règle** : le regroupement se fait sur (clé du
titre, année), strictement. « Dune » 1984 et « Dune » 2021 sont deux films ;
« One Piece » 1999 (l'animé) et « One Piece » 2023 (la série Netflix) sont deux
séries.

Une œuvre **sans année** ne rejoint jamais automatiquement une homonyme **avec
année** : ce serait deviner. Les deux fiches coexistent, et le rapport de scan
les signale dans une section « séries homonymes à vérifier » — à vous de
trancher en renommant sur le NAS.

Corollaire important pour les séries : **le titre et l'année viennent de la même
source.** Quand le dossier de la série donne le titre, c'est aussi lui qui donne
l'année — même s'il n'en a pas. Sinon un dossier `Clem/` dont certaines saisons
contiennent `Clem.S01E01.avi` et d'autres `Clem.2010.S10E01.mkv` se scinderait en
deux fiches, une sans année et une de 2010, pour une seule et même série.

Un film ou un épisode peut donc avoir **plusieurs fichiers** : versions
différentes, ou présence sur les deux racines. Le rapport de scan liste les
doublons entre racines.

### Windows, SMB et Unicode

Trois précautions, appliquées partout :

1. **NFC pour comparer et stocker — jamais pour rouvrir un chemin.** « é »
   s'encode de deux façons en Unicode : un caractère unique (forme composée,
   NFC) ou « e » + accent combinant (forme décomposée, NFD). Les deux
   s'affichent pareil, mais `"é" === "é"` est faux. SMB et macOS renvoient
   volontiers la forme décomposée. Toute chaîne venue du système de fichiers
   passe donc par `normalize('NFC')` avant stockage ou comparaison — sans ça, le
   même film sur deux racines apparaîtrait en double.

   **Mais** NTFS et SMB, eux, comparent les noms octet à octet (à la casse
   près) sans appliquer de normalisation. Un dossier stocké en forme décomposée
   devient donc introuvable si on le normalise avant de rouvrir le chemin. Le
   scanner garde les deux formes : `absolutePath`, construit avec le nom exact
   renvoyé par `readdir`, est le seul donné à `readdir` et `stat` ; `storedPath`
   et `relativePath`, en NFC, servent à la base, aux comparaisons et au parser.
   Confondre les deux produit des `ENOENT` intermittents difficiles à
   diagnostiquer.
2. **Comparaisons insensibles à la casse.** Chaque chemin est stocké deux fois :
   tel quel (`path`) et en clé de comparaison (`path_key`, NFC + minuscules).
3. **Chemins UNC.** `\\serveur\partage\...` fonctionne nativement ; les espaces
   et accents sont gérés. Pour des arborescences très profondes, activez la
   prise en charge des chemins longs de Windows.

### Concurrence

Le NAS est lent et se dégrade si on lui envoie des centaines de requêtes en
parallèle. Le scanner plafonne à **8 opérations disque simultanées** par défaut
(`--concurrency=` pour ajuster), en deux temps : d'abord lister les dossiers,
ensuite mesurer taille et date des fichiers retenus. Une ligne de progression
s'affiche pendant le parcours.

### Scan incrémental

La taille et la date de modification de chaque fichier sont stockées. Au scan
suivant, un fichier inchangé n'est pas re-parsé. Deux exceptions volontaires :

- un fichier resté **non interprété** est retenté à chaque scan — le parser
  évolue, et le re-tenter ne coûte aucun accès disque ;
- `--full` force le re-parsing complet.

**Rien n'est jamais supprimé.** Un fichier absent du disque passe à
`present = 0` ; il disparaît de l'interface mais son historique reste. S'il
revient, il est réactivé.

Garde-fou important : si une racine est **injoignable** (NAS éteint, partage non
monté), la bibliothèque entière est ignorée pour ce scan. Sans ça, un NAS
éteint marquerait toute la bibliothèque comme disparue.

### Le rapport

Affiché en fin de scan et écrit dans `data/scan-report.txt` :

- dossiers parcourus, fichiers retenus, raisons des exclusions ;
- films détectés, ou séries / saisons / épisodes détectés ;
- **la liste complète des séries**, avec pour chacune son année, son nombre de
  saisons et son nombre d'épisodes ;
- **les séries homonymes à vérifier** : même titre, années différentes ;
- les doublons entre racines ;
- **la liste complète des fichiers non interprétés** — c'est elle qui dit quelle
  convention ajouter au parser, ou quel fichier renommer sur le NAS ;
- **la liste complète des chemins inaccessibles**, avec l'opération (`readdir`
  ou `stat`) et le message du système. Un chemin illisible n'interrompt jamais
  le scan, mais son contenu n'est pas indexé : il doit donc rester visible.

Un second fichier, `data/movies-list.txt`, reçoit l'inventaire des films : un
titre par ligne avec son année, trié alphabétiquement, sans en-tête ni
décoration. Ce format se compare ligne à ligne avec un autre inventaire (`diff`,
`Compare-Object`) pour retrouver un écart.

---

## Modèle de données

```
library ──< library_root ──< media_file >── movie
                                   │      >── episode ──> season ──> show
                                   └──< subtitle
                                   └──< rendition        (phase suivante)

user ──< playback_progress                               (phase suivante)
```

La relation « une œuvre, plusieurs fichiers » porte du côté du fichier
(`media_file.movie_id`, `media_file.episode_id`), jamais l'inverse. Chaque
fichier garde la trace de sa racine d'origine (`library_root_id`).

### Prévu pour la suite, laissé vide

Ces colonnes et tables existent déjà pour éviter une migration plus tard. Aucun
code ne les remplit dans cette itération.

- `media_file` : `container`, `video_codec`, `audio_codec`, `resolution`,
  `duration_seconds`, `bitrate`, `hdr` — à remplir par ffprobe.
- `movie` / `show` / `episode` / `season` : `poster_path`, `backdrop_path`,
  `overview`, `tmdb_id`.
- `user` (id, name, created_at) — un utilisateur `default` est créé au premier
  lancement.
- `playback_progress` (user_id, media_id, media_type, position_seconds,
  updated_at, watched) — reprise de lecture par utilisateur.
- `rendition` (media_file_id, height, bitrate, path, status) — variantes
  HLS/CMAF pré-générées.

---

## API

Pagination : 50 éléments par page.

| Route                                                        | Réponse                                     |
| ------------------------------------------------------------ | ------------------------------------------- |
| `GET /api/libraries`                                          | bibliothèques + nombre d'éléments            |
| `GET /api/genres`                                             | genres présents + nombre de films et séries |
| `GET /api/movies?search=&library=&genre=&sort=&order=&page=`  | page de films                               |
| `GET /api/movies/:id`                                         | film, crédits, synthèse fichiers            |
| `GET /api/shows?search=&library=&genre=&sort=&order=&page=`   | page de séries                              |
| `GET /api/shows/:id`                                          | série, saisons, épisodes, crédits, synthèse |

- `sort` : `title` (défaut), `year`, `added`. `order` : `asc` / `desc` — par
  défaut croissant pour le titre, décroissant pour l'année et la date d'ajout.
- `search` : recherche par mots sur le titre normalisé, donc insensible aux
  accents et à la ponctuation. « amelie » trouve « Amélie ».
- Seules les œuvres ayant au moins un fichier présent sont listées.
- Chaque image renvoyée l'est en deux champs : `xxxPath`, l'URL de repli, et
  `xxxSrcSet`, les tailles disponibles. L'attribut `sizes` appartient au
  composant, seul à connaître sa largeur d'affichage.
- `fileSummary` agrège les fichiers de l'œuvre : définitions, codecs, langues
  audio, taille cumulée, emplacements. **Une série n'a pas de fichier** — ce
  sont ses épisodes qui en ont — d'où cette synthèse, et non une liste de
  fichiers portée par l'œuvre.

---

## Interface

- **Accueil** : carrousel de mise en avant, puis des rangées horizontales —
  ajouts récents, films, séries, genres les plus fournis.
- **Films / Séries** : titre centré, pastilles de genre, tri, grille et
  défilement infini par lots de 50.
- **Recherche** : page dédiée. Tant que rien n'est saisi — et quand un terme ne
  donne rien — la page affiche les rangées à parcourir : elle n'est jamais vide.
- **Fiche film / série** : image de fond **fixée** derrière toute la page, qui
  s'assombrit au défilement sans jamais devenir opaque. Une phrase d'accroche,
  puis des onglets — Épisodes (séries), Suggestions, Détails.
- **Détails** : le synopsis complet en prose, deux colonnes éditoriales (durée,
  date, genre, classification / réalisation, distribution), et seulement
  ensuite une section « Fichier » avec les codecs et les emplacements.

Genre, tri, page et terme de recherche vivent **dans l'URL**, pas dans un état
React : un lien se partage, et le bouton « précédent » refait la vue attendue.
La recherche **remplace** son entrée d'historique plutôt que de l'empiler, sinon
« précédent » rejouerait la requête lettre par lettre.

---

## Choix techniques, en deux mots

**better-sqlite3 plutôt qu'un driver asynchrone.** L'API est synchrone, ce qui
simplifie beaucoup le code (pas d'`await` sur chaque requête) et reste plus
rapide sur ce volume. Le mode WAL est activé : les lectures de l'API ne sont pas
bloquées par les écritures du scan.

**Le parser est un module pur.** Il prend un chemin, il rend un objet ; il ne
touche ni au disque ni à la base. C'est la partie qui va le plus évoluer, elle
doit pouvoir être testée sans NAS — d'où les 47 tests de `parser.test.ts`, qui
couvrent chaque convention listée plus haut.

**Deux `package.json`, pas de workspace npm.** `/server` et `/web` ont des
dépendances sans rapport. Un `postinstall` à la racine installe les deux ;
c'est plus simple à lire qu'une configuration de workspace.

**Les imports du serveur finissent en `.js`.** C'est la règle des modules ESM
de Node : le fichier source est un `.ts`, mais l'import doit désigner le fichier
généré. Surprenant au début, standard aujourd'hui.

**Pas de CORS.** En développement, Vite proxie `/api` vers le port 3000, donc
le navigateur ne voit qu'une seule origine. En production, le serveur sert le
front lui-même.

---

## Pièges connus

Trois comportements contre-intuitifs, qui ont chacun coûté un aller-retour.

### `npm run scan` ne re-parse RIEN après une modification du parser

C'est le piège le plus déroutant. Le scan est incrémental : il compare la taille
et la date de modification de chaque fichier à ce qu'il a en base. Si elles n'ont
pas bougé — et corriger le parser ne touche évidemment pas aux fichiers du NAS —
**aucun fichier n'est considéré comme modifié, donc aucun n'est re-parsé**. Le
scan affiche « 2364 inchangés », se termine sans erreur, et les titres restent
exactement les mêmes qu'avant votre correction.

Après toute modification du parser :

```bash
npm run scan -- --full
```

### Un `--full` peut laisser des œuvres orphelines

Une œuvre est identifiée par (titre normalisé, année). Quand le parser corrigé
donne un nouveau titre à un fichier, celui-ci rejoint une **nouvelle** fiche, et
l'ancienne se retrouve sans aucun fichier. Elle n'apparaît nulle part dans
l'interface, mais elle reste en base avec ses affiches.

Enchaînez donc :

```bash
npm run scan -- --full
npm run cleanup          # liste, demande confirmation, puis supprime
npm run metadata
```

`npm run cleanup -- --dry-run` montre sans rien toucher ; `--yes` évite la
question.

### Un dégradé « absent » du CSS compilé y est peut-être bien présent

En inspectant le CSS de production, un `linear-gradient(to top, …)` écrit dans le
code peut ne pas s'y retrouver littéralement. Le minifieur le réécrit sous une
forme algébriquement équivalente : `to top` avec l'opacité forte à 0 % devient
`to bottom` avec la même opacité à 100 %, et les positions intermédiaires sont
inversées (46 % devient 54 %).

Chercher la chaîne d'origine ne donne rien et laisse croire à une classe
Tailwind non générée. Cherchez plutôt une valeur caractéristique — ici
`#000000c7`, soit `rgba(0,0,0,0.78)` — plutôt que le dégradé entier.

### Les scripts de la racine se terminent par `--`

Dans [package.json](package.json), les scripts s'écrivent
`npm --prefix server run scan --`. Ce `--` final n'est pas une coquille : sans
lui, `npm run scan -- --full` verrait npm interpréter `--full` comme une de ses
propres options (avec un avertissement « Unknown cli config ») au lieu de la
transmettre au script imbriqué. L'option serait silencieusement perdue.

## Notes et limites connues

- **Deux dossiers ne différant que par la casse.** Le NAS tourne sur un système
  de fichiers sensible à la casse : `One Piece` et `One piece` peuvent y
  coexister. Le scanner les parcourt tous les deux — deux noms différents ne
  sont pas le même contenu, et ce n'est pas à lui d'en décider. S'il s'agit bien
  de la même œuvre, elle se regroupera d'elle-même sur (titre, année) ; sinon
  vous obtenez deux fiches, ce qui est le résultat correct.
- Le serveur écoute sur `127.0.0.1` — accessible depuis cette machine
  seulement. L'accès depuis l'extérieur fait partie des phases suivantes.
- Un titre écrit avec des points comme séparateurs perd ses points :
  « S.W.A.T.2003 » devient « S W A T ». Cas rare, corrigeable en renommant.
- Le seuil de 50 Mo écarte les épisodes très courts.
- Les sous-titres ne sont rattachés qu'à une vidéo du **même dossier**.

Notez vos idées dans `IDEAS.md`.
