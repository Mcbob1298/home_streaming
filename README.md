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
| `npm run playable` | **Temporaire** — liste les fichiers lisibles sans transcodage          |
| `npm run keyframes` | Indexe les images clés, nécessaire au découpage HLS du remux          |
| `npm run migrate-paths` | Réécrit les chemins d'une racine à l'autre (Windows → NAS)        |
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
| `GET /api/stream/:mediaFileId`                                | le fichier, en flux, avec plages d'octets   |
| `GET /api/stream/:mediaFileId/playability`                    | décision de lecture et contexte du lecteur  |
| `GET /api/subtitles/:subtitleId`                              | sous-titre converti en WebVTT               |

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

- **Lecteur** (`/watch/:mediaFileId`) : plein écran, fond noir, contrôles
  personnalisés. Raccourcis : espace ou K lecture/pause, ←/→ et J/L ±10 s, ↑/↓
  volume, M couper le son, F plein écran, Échap quitter, 0-9 pour aller au
  pourcentage correspondant.

Genre, tri, page et terme de recherche vivent **dans l'URL**, pas dans un état
React : un lien se partage, et le bouton « précédent » refait la vue attendue.
La recherche **remplace** son entrée d'historique plutôt que de l'empiler, sinon
« précédent » rejouerait la requête lettre par lettre.

---

## Lecture

**Cette étape ne lit que ce qui part tel quel dans un navigateur** : conteneur
MP4/M4V, vidéo H.264, audio AAC. Cela fait **143 fichiers sur 2796**. Le remux et
le transcodage viendront ensuite ; d'ici là, ouvrir un fichier non lisible
affiche pourquoi il ne l'est pas, avec ses codecs.

Le rapport ffprobe en annonce 144 : il ne regarde que l'extension, alors que la
décision de lecture regarde aussi le conteneur réel vu par ffprobe. Un fichier
de la bibliothèque est un flux de transport MPEG renommé `.mp4` — l'extension
dit MP4, le contenu dit autre chose, et aucun navigateur ne sait le lire.

### Une source n'est pas un fichier

`/api/stream/:id/playability` décrit une **source**, jamais un chemin, et cette
source porte toujours son type explicite :

```json
{ "mode": "direct", "source": { "url": "/api/stream/1004", "type": "file" } }
```

Rien dans le code ne déduit la nature d'une source de son extension. C'est ce
qui permettra, à terme, de démarrer la lecture sur une amorce pré-transcodée de
quelques secondes pendant que ffmpeg produit la suite : `type` vaudra `hls`, et
le seul endroit à changer sera `attachSource` dans
[`VideoSurface.tsx`](web/src/components/player/VideoSurface.tsx) — pas la barre
de contrôle, pas les raccourcis, pas les états de chargement.

### Requêtes de plage

`/api/stream/:id` implémente `Range` (RFC 7233) : c'est ce qui permet de se
déplacer dans une vidéo sans la télécharger en entier. Plages fermées, ouvertes
et suffixes donnent un **206**, une plage hors du fichier un **416** avec la
taille réelle, et un en-tête illisible est **ignoré** — la RFC l'impose — donc
un 200 avec le fichier entier. `ETag` (taille + date) et `Last-Modified`
permettent un **304**.

Le flux est détruit dès que le client se déconnecte. Sans cela, chaque
déplacement du curseur — le navigateur abandonne sa plage et en demande une
autre — laisserait un descripteur ouvert sur le partage SMB.

### Remux HLS — la vidéo est copiée, jamais réencodée

59,3 % de la bibliothèque est **déjà en H.264** : seul le conteneur, et parfois
l'audio, empêchent la lecture. Ces fichiers passent par un **remux** — `-c:v
copy`, audio réencodé en AAC — servi en HLS avec des segments fMP4. Mesuré à
**×24 à ×39 le temps réel** pour **66 à 85 % d'un cœur**. Direct + remux =
**1803 fichiers sur 2796, soit 64,5 %**.

Ne jamais réencoder une vidéo déjà en H.264 : c'est la différence entre quelques
secondes et plusieurs minutes par fichier.

### Le découpage suit les images clés, pas une horloge

**Le piège de cette étape.** En copie de flux, ffmpeg ne peut couper qu'aux
images clés existantes. Sur cette bibliothèque leur espacement va de 1 à 12
secondes, et varie **à l'intérieur d'un même fichier** — 10 s, puis 2,2 s, puis
4,7 s sur un même film. Un manifeste annonçant des segments de 4 secondes
décrirait donc une découpe que ffmpeg ne produira jamais : le lecteur réclame un
segment 14 qui n'existera pas, et attend jusqu'à expiration.

Le manifeste est donc calqué sur les images clés **réelles**, énumérées par
ffprobe et mises en cache dans `keyframe_index`. `planFromKeyframes` reproduit
exactement la règle du muxer HLS : nouveau segment à la première image clé
atteignant « début courant + hls_time ». Toute modification de cette fonction
doit être vérifiée contre la sortie réelle de ffmpeg.

Deux conséquences pratiques :

- Les « trois premiers segments de 2 secondes » sont une **intention**. Sur un
  fichier dont les images clés sont espacées de 10 s, le premier segment en fera
  10. Ce sera exact au palier suivant, où la vidéo est réencodée et où les images
  clés se placent où l'on veut.
- L'énumération lit le fichier en entier une fois. Elle coûte **2,3 s** sur un
  film de 1 h 56 déjà en cache système, contre 193 s si l'on passe par les
  images décodées plutôt que par les paquets — d'où `packet=pts_time,flags`.
  D'où aussi `npm run keyframes`, qui fait le travail hors ligne.

### Sessions ffmpeg

Un processus par fichier, trois au maximum (`transcode.maxSessions`), les
demandes au-delà attendent leur tour. Le déplacement au-delà de ce qui est
produit **relance ffmpeg à la position visée** plutôt que d'attendre : mesuré à
**400 à 640 ms** pour sauter n'importe où dans un film de deux heures.

**Un ffmpeg orphelin est le pire défaut possible ici**, d'où trois filets :
le lecteur prévient qu'il quitte la page, un balayage tue les sessions inactives
(`transcode.idleSeconds`), et l'arrêt du serveur tue le reste et vide le
répertoire de travail. Vérifié : zéro processus survivant après fermeture.

`transcode.workDir` est effaçable en totalité — en production ce sera un tmpfs.

### Transcodage vidéo — les 35,5 % restants

Les 993 fichiers dont la vidéo n'est pas en H.264 — 956 HEVC, 35 MPEG-4, 2 AV1 —
sont **réencodés** en accélération matérielle. Avec les deux modes précédents,
la bibliothèque est intégralement lisible :

| Mode | Fichiers | Part | Coût |
| --- | --- | --- | --- |
| `direct` | 143 | 5,1 % | aucun |
| `remux` | 1660 | 59,4 % | vidéo copiée, audio réencodé |
| `transcode` | 993 | 35,5 % | vidéo réencodée sur le GPU |
| `unsupported` | 0 | 0 % | — |

La liste des codecs réencodables est **fermée** : un codec inconnu est refusé en
le nommant, plutôt que lancé dans un transcodage qui échouerait après trente
secondes d'attente.

### Trois chaînes de filtres, et pourquoi

`tonemap_vaapi` ne fait **que** la conversion de plage dynamique. Ses seules
options, relevées par `ffmpeg -h filter=tonemap_vaapi` sur la machine cible,
sont `format`, `matrix`, `primaries` et `transfer` — **aucune dimension**. Lui
en passer fait échouer l'initialisation du filtre.

| Source | Chaîne |
| --- | --- |
| SDR | `scale_vaapi=format=nv12` |
| HDR10 / HLG | `scale_vaapi=w=W:h=H,tonemap_vaapi=format=nv12:matrix=bt709:primaries=bt709:transfer=bt709` |
| Dolby Vision profil 8 | identique au HDR10 |

Trois décisions à ne pas défaire :

- **Le redimensionnement précède le tone mapping.** Tone-mapper en 4K puis
  réduire ferait travailler le moteur sur quatre fois plus de pixels.
- **Le `scale_vaapi` qui précède un tone mapping n'impose pas `format`.** Réduire
  en nv12 8 bits avant de convertir écrêterait les hautes lumières — exactement
  ce que le tone mapping doit éviter.
- **Aucun filtre logiciel dans la chaîne.** Un seul `format=` ou `scale=` mal
  placé force un aller-retour vers la mémoire centrale. Un test vérifie que
  chaque filtre se termine par `_vaapi`.

Les dimensions sont **calculées**, jamais déléguées à `-2` : la résolution
source est connue, et la prise en charge de cette convention par `scale_vaapi`
n'est pas documentée dans ffmpeg 5.1. Une tolérance de 5 % évite de réduire un
1920×1088 en 1906×1080 — le bourrage en macroblocs du H.264 n'est pas du 1440p.

### Dolby Vision : le profil décide

Un profil 7 ou 8 porte une couche de base rétro-compatible, qu'on tone-mappe
comme n'importe quel HDR10. Un profil 5 n'a **aucun repli** : le traiter
pareillement produit une image verdâtre. Sondé sur la bibliothèque :

```
profil 8 — compat 1     93 fichiers    couche de base HDR10, traitable
profil 5 — compat 0      1 fichier     refusé, avec son profil dans le message
```

Le profil est sondé à la demande — quelques centaines de millisecondes de
lecture d'en-tête, pour les 94 fichiers concernés — et mémorisé dans
`media_file.dv_profile`.

### Les images clés deviennent exactes

En transcodage la vidéo est réencodée, donc les images clés se placent où l'on
veut : `-force_key_frames expr:gte(t,n_forced*N)`. La découpe **2/2/2/4 suit
exactement le manifeste**, sans énumération préalable. C'est ce que le remux ne
peut pas garantir, puisqu'il ne coupe qu'aux images clés existantes.

### Deux pièges d'encodage

- **H.264 10 bits.** Une source 10 bits produit du `High 10 / yuv420p10le`
  qu'aucun navigateur ne décode. Le format est imposé — `format=nv12` côté
  VAAPI, `format=yuv420p` plus `-pix_fmt yuv420p` côté logiciel — jamais hérité.
- **Downmix audio.** Le comportement par défaut de ffmpeg enterre le canal
  central, donc les dialogues, sous la musique. Une matrice explicite remonte la
  voix à 0,8 quand les surrounds descendent à 0,5.

### Sélection des flux

Avatar contient 27 flux : 1 vidéo, 6 audio, 16 sous-titres, 2 polices TrueType
et 2 images de couverture. Sans sélection explicite, ffmpeg tente d'en faire
quelque chose et échoue sur les polices. D'où `-map 0:v:0 -map 0:a:0?` suivi de
`-sn -dn -map_chapters -1`.

### Repérage temporaire

Les 143 fichiers lisibles sont éparpillés dans la bibliothèque, ce qui rend les
essais pénibles. Trois aides, **toutes temporaires** et marquées comme telles
dans le code : le filtre `?playable=direct` sur `/api/movies` et `/api/shows`,
une pastille « Lisible » sur les vignettes concernées, et `npm run playable`.
Elles disparaîtront ensemble quand le transcodage rendra tout lisible.

---

## Sous-titres : préparés en amont, jamais pendant la lecture

Les sous-titres embarqués sont extraits **une fois pour toutes** en WebVTT,
stockés durablement, et servis comme des fichiers statiques. Un titre dont la
préparation n'est pas finie n'apparaît pas dans les rangées de l'accueil ni dans
les grilles.

Ce choix vient d'une mesure : **une extraction traverse le fichier entier**.
Relevé sur Avatar — 94,2 Go — 964,9 s, soit 97,6 Mo/s, exactement le débit du
disque. Le coût est linéaire en taille et ne dépend pas du nombre de pistes :
douze coûtent le même prix que deux. Deux voies ont été instruites et écartées,
mesures à l'appui : `mkvextract` est **plus lent** que ffmpeg (×11 sur 2,8 Go),
et `-ss` avant `-i` sur un flux de sous-titres produit des fichiers vides.

Il n'y a donc pas d'extraction rapide. La seule réponse est de la faire avant.

### Pourquoi la bibliothèque existante reste visible

Sans précaution, le verrou s'appliquerait rétroactivement : les 2 796 fichiers
passeraient d'un coup en préparation, et **l'interface serait vide pendant les
seize heures** de la première passe. Une bibliothèque qui fonctionne depuis des
semaines deviendrait blanche au redémarrage suivant, pour une fonctionnalité
censée l'améliorer.

**« Ne pas cacher » et « les sous-titres sont extraits » sont deux choses.** Les
confondre a produit un vrai défaut : une première version marquait les fichiers
existants comme **prêts**, si bien que 2 306 d'entre eux annonçaient des pistes
qui n'existaient sur aucun disque — la lecture répondait 409 sur chacune.

La distinction est désormais portée par deux mécanismes séparés :

| | Ce que ça dit | Où |
|---|---|---|
| `media_file.subtitles_fingerprint` | les WebVTT de cette version du fichier **sont écrits** | `readiness.ts` |
| `meta.subtitles_gate_since` | instant à partir duquel le verrou s'applique | `readiness.ts`, `db/index.ts` |

Un fichier vu pour la première fois **avant** cet instant reste visible même s'il
n'est pas préparé : il l'a toujours été, sans sous-titres embarqués servis — ce
qu'il n'a jamais eu. Un fichier vu **après** n'apparaît que complet, ce qui est
exactement le cas que le verrou est censé couvrir : un film ajouté ce soir
n'apparaît que quand il est prêt.

Le verrou est posé à la première ouverture de base qui n'en trouve pas — pas au
moment où la colonne est ajoutée. La nuance a compté : sur le NAS la colonne
existait déjà, le verrou n'était jamais écrit, et `COALESCE(..., '9999')` rendait
tout visible en permanence sans que rien ne le signale.

Pour l'interprétation stricte — tout cacher jusqu'à la fin de la première
passe — il suffit de supprimer la ligne `subtitles_gate_since` de `meta`.

### « Rechercher ce qui manque » regarde le disque

Le bouton de la page d'administration fait **deux** passes, parce que « manquant »
a deux sens :

- `enqueueFiles` inscrit ce que la **base** ignore : fichier jamais vu, ou modifié
  depuis. Il compare des empreintes.
- `requeueMissing` inscrit ce que le **disque** dément : les fichiers dont il
  manque au moins un WebVTT.

La seconde est indispensable. Un travail `done` dont le cache a disparu — volume
recréé, `data/` effacé, extraction à moitié écrite — garde la bonne empreinte : la
première passe le déclare « déjà à jour ». Sur le NAS, le bouton répondait
`0 nouveaux, 0 modifiés` là où **1 859 fichiers** (5,32 To) n'avaient aucun
sous-titre sur le disque.

Deux gardes vont avec :

- une extraction qui sort **sans erreur** mais n'écrit pas tous ses `.vtt` est un
  **échec**, pas une réussite. Sinon on recrée le défaut d'origine ;
- le rattrapage **écarte les échecs connus**. Un fichier dont une piste ne
  produira jamais rien manquera toujours quelque chose : sans cette garde, chaque
  clic relirait ses 94 Go pour échouer pareil. On les relance depuis la liste des
  échecs, délibérément.

Les échecs sont lus dans la file, jamais en mémoire : une passe de vingt heures
redémarre, et la page affichait « aucun échec » pendant que la base en portait
six. Ces six-là venaient d'ailleurs d'un redémarrage compté comme échec définitif
— une interruption qui arrive **pendant** le lancement de ffmpeg passe par
`child.on('error')`, pas par `exit`, et ce chemin ne la reconnaissait pas.

### Ce que la préparation garantit, et ce qu'elle coûte

| | |
|---|---|
| Délai à la lecture | celui d'un fichier statique |
| Passe complète | ~16 h pour 5,13 Tio, à lancer une nuit |
| Reprise | à tout moment : Ctrl-C, redémarrage du conteneur, pause |
| Ordre | ajouts récents d'abord, puis les plus petits |
| Invalidation | empreinte taille + mtime, comme le cache des images clés |
| Concurrence | un seul processus draine, verrou dans `meta` |

La pause **tue** le ffmpeg en cours plutôt que d'attendre sa fin : sur le plus
gros fichier, attendre voudrait dire seize minutes, alors que la pause existe
précisément pour rendre le disque tout de suite. Le travail interrompu retourne
en attente, il n'est jamais compté en échec.

#### L'ordre est calculé au moment de CHOISIR

`ORDER BY job.id` n'est pas un ordre, c'est un ordre d'arrivée. Il coïncide avec
l'ordre voulu tant que tout est inscrit d'un seul coup, et devient faux dès qu'un
travail arrive plus tard : le nouveau venu reçoit le plus grand identifiant et
passe donc en **dernier** — mesuré à 1 449 travaux d'attente, près de sept
heures, pour un film ajouté le soir même. C'est l'inverse exact de la règle.

`ClaimOrder` porte donc l'ordre par file, appliqué à chaque sélection. Vérifié en
production sur le pire cas : Avatar, 101,2 Go, rang **2280 sur 2280** par la
règle de taille ; déclaré ajouté ce soir, rang **1**.

Le `LEFT JOIN` n'est pas une précaution de style : avec une jointure stricte, un
travail dont la cible a disparu de `media_file` sortirait de la sélection et ne
serait plus jamais pris — une file qui se bloque sans rien dire.

#### Un seul processus draine à la fois

`requeueStale()` remet en attente **tous** les travaux `running` au démarrage.
C'est juste avec un seul processus, faux avec deux : `npm run subtitles` lancé
pendant que le serveur tourne arrachait au serveur son extraction en cours, et
les deux ffmpeg se partageaient le disque.

Le verrou vit dans `meta.subtitles_drain_lock` et porte le **PID** de son
détenteur. Un processus mort ne bloque donc rien, et la passe repart treize
secondes après un redémarrage de conteneur sans attendre l'expiration d'un délai.
Le rafraîchissement tourne toutes les 30 s, indépendamment des extractions : une
extraction de seize minutes ne fait pas expirer son propre verrou.

Il est pris **avant la première écriture**, pas avant la première extraction. Le
prendre juste avant la boucle ne suffisait pas — `--full`, le rattrapage et
l'inscription remettent des travaux en attente, et la commande avait déjà remis
2 243 fichiers en file avant d'afficher son refus.

#### Corriger le convertisseur ne corrige pas la bibliothèque

Un WebVTT est écrit une fois puis servi comme un fichier statique : changer la
conversion ne change rien à ce qui existe déjà, et l'empreinte du fichier source
n'a pas bougé — rien ne peut le détecter.

`CONVERTER_VERSION`, dans `playback/vtt.ts`, est comparé au démarrage. S'il a
changé, les fichiers préparés repassent en préparation **et leur cache est
effacé** — sans l'effacement, `extractSubtitles` constaterait que les `.vtt`
attendus existent et ne referait rien. L'empreinte est remise à NULL en même
temps, sans quoi on recréerait le défaut du fichier qui se déclare prêt et
répond 409.

Coût constaté au passage en version 2 : 999 fichiers à refaire, soit 0,75 Tio
relus. **À incrémenter dès que la conversion change ce qu'elle produit.**

### Où l'absence ne s'applique pas

Trois exceptions, et ce ne sont pas des concessions :

- **la recherche** renvoie tout et marque l'état. On sait ce qu'on a ajouté hier
  soir : ne pas le trouver par son nom se lirait comme un bug de scan, pas comme
  une attente ;
- **l'accès direct** à une fiche répond toujours, avec « Lire » désactivé. Un 404
  sur une œuvre qui existe serait faux ;
- **une série n'est jamais masquée** pour un épisode. Elle apparaît dès qu'un
  épisode est prêt, et c'est l'épisode que la grille marque.

---

## Déploiement

Le serveur tourne **sur le NAS**, en conteneur. L'interface, elle, peut rester
sur le poste de développement et proxier vers lui.

La raison est mesurable : le poste est en Wi-Fi et lit le NAS à **11 Mo/s**.
Toute mesure de transcodage faite depuis le poste mesure le réseau, pas le
matériel. Et l'accélération QuickSync n'existe que sur le NAS.

### Prérequis sur le NAS

- Docker, avec `sudo` (l'utilisateur n'est pas dans le groupe `docker`).
- `/dev/dri/renderD128` présent.
- Le Node 18 du système n'est **pas** utilisé : il n'a pas npm et n'est plus
  maintenu. Tout passe par le conteneur.

L'utilisateur SSH est `Mathias Cassonnet` — **le nom contient un espace**. Il
doit être protégé par des guillemets dans chaque commande :

```bash
ssh -i ~/.ssh/nas_home_streaming "Mathias Cassonnet@192.168.1.15"
```

Deux pièges au transfert, tous deux silencieux ou trompeurs :

- **la clé doit être nommée.** Sans `-i ~/.ssh/nas_home_streaming`, ssh demande un
  mot de passe et finit par `Permission denied (publickey,password)` ;
- **`scp` a besoin de `-O` ET du nom de fichier de destination.** Le mode SFTP
  par défaut échoue ici sur `dest open … : No such file or directory` alors que le
  répertoire existe, et la forme `répertoire/` échoue même avec `-O` :

```bash
# marche
scp -O -i ~/.ssh/nas_home_streaming server/src/index.ts \
  "Mathias Cassonnet@192.168.1.15:/volume1/docker/home_streaming/server/src/index.ts"

# échoue — répertoire en destination
scp -O -i ~/.ssh/nas_home_streaming server/src/index.ts \
  "Mathias Cassonnet@192.168.1.15:/volume1/docker/home_streaming/server/src/"
```

Le code vit sous `/volume1/docker/home_streaming`, **pas** dans le home de
l'utilisateur : son chemin contient l'espace, et chaque script devrait le
protéger.

### Deux modes

|  | Production | Développement |
| --- | --- | --- |
| Fichier | `compose.yaml` | `compose.dev.yaml` |
| Cible d'image | `runtime` | `dev` |
| Source | copiée et compilée dans l'image | **montée en volume**, `tsx watch` |
| Interface | servie par Fastify | servie par Vite sur le poste |
| Port | 3000 | 3001 |
| Après un changement de code | reconstruire l'image | le serveur redémarre seul |
| Après un changement de `package.json` | reconstruire | reconstruire |

**Si une modification ne prend pas effet**, redémarrer le conteneur :

```bash
sudo docker compose -f compose.dev.yaml restart
```

Les événements inotify d'un montage bind ne traversent pas toujours la
frontière du conteneur — constaté ici, le serveur continuait à servir l'ancien
code sans le moindre signe, et l'erreur corrigée réapparaissait à l'identique.
`CHOKIDAR_USEPOLLING` fait scruter le surveillant plutôt qu'écouter, ce qui
règle le cas ; le redémarrage reste le recours certain.

```bash
# production
sudo docker compose up -d --build

# développement
sudo docker compose -f compose.dev.yaml up -d --build
sudo docker compose -f compose.dev.yaml logs -f
```

Le groupe du nœud de rendu doit être ajusté dans les deux fichiers :

```bash
stat -c '%g' /dev/dri/renderD128   # reporter cette valeur dans group_add
```

### Interface depuis le poste

Créer `web/.env.local` contenant une ligne :

```
VITE_API_TARGET=http://192.168.1.15:3001
```

puis `npm --prefix web run dev`. Vite annonce sa cible au démarrage — c'est la
ligne à lire pour savoir à qui l'on parle :

```
  API et images  →  http://192.168.1.15:3001
```

Sans le fichier, Vite vise `127.0.0.1:3000` et l'annonce : « (défaut : serveur
local) ». Utile quand le serveur tourne aussi sur le poste.

> **`echo … > web/.env.local` NE MARCHE PAS sous PowerShell.**
>
> La redirection `>` y écrit en **UTF-16**, et `dotenv` lit en UTF-8 : le fichier
> paraît juste dans un éditeur, et la variable n'est jamais lue. Constaté ici —
> `ff fe 56 00 49 00 54 00` au lieu de `56 49 54 45`. Sous PowerShell :
>
> ```powershell
> Set-Content web/.env.local 'VITE_API_TARGET=http://192.168.1.15:3001' -Encoding utf8
> ```
>
> Le symptôme est trompeur : l'interface s'affiche normalement, et les chiffres
> viennent simplement d'un autre serveur.

Deux pièges se cumulaient ici, et le premier masquait le second :
`vite.config.ts` lisait `process.env.VITE_API_TARGET`, or ce fichier s'exécute
**avant** que Vite ne charge les `.env` — lesquels alimentent `import.meta.env`
côté client, pas `process.env` dans la configuration. C'est `loadEnv` qui est
fait pour cela, avec le répertoire de la configuration et non `process.cwd()` :
la commande est lancée depuis la racine avec `--prefix web`.

### Deux configurations qui coexistent

`config.json` porte les chemins Windows, `config.production.json` les chemins
Linux. C'est `HOME_STREAMING_CONFIG` qui désigne le bon, et le conteneur le
pointe sur le second. Aucun des deux n'écrase l'autre au transfert.

### Correspondance des chemins

| En base (Windows) | Sur le NAS |
| --- | --- |
| `\\NASSSITO\Plex S1\Vidéos\films` | `/mnt/@usb/sdb1/Vidéos/films` |
| `\\NASSSITO\Plex S1\Vidéos\séries` | `/mnt/@usb/sdb1/Vidéos/séries` |
| `\\NASSSITO\plex\Media\Films` | `/volume1/plex/Media/Films` |
| `\\NASSSITO\plex\Media\Séries` | `/volume1/plex/Media/Séries` |

Les montages du conteneur reprennent **les mêmes chemins des deux côtés** :
la base migrée y désigne donc les fichiers sans traduction supplémentaire.

### Migration des chemins

**Ne pas rescanner.** Un scan complet reconstruirait l'index mais perdrait les
62 appariements TMDB validés à la main et les entrées ignorées : ces décisions
vivent dans `tmdb_match`, rattachées à des œuvres dont les identifiants
changeraient. Elles ne sont pas reproductibles.

La commande est **en simulation par défaut**, et vérifie l'existence des
fichiers dans les deux modes — on sait donc si la migration va marcher avant
d'écrire quoi que ce soit.

```bash
# 1. simulation, depuis le conteneur (le NAS voit les fichiers, pas le poste)
sudo docker compose -f compose.dev.yaml exec home-streaming-dev \
  npm run migrate-paths -- \
    "--map=\\\\NASSSITO\\Plex S1\\Vidéos\\films=>/mnt/@usb/sdb1/Vidéos/films" \
    "--map=\\\\NASSSITO\\Plex S1\\Vidéos\\séries=>/mnt/@usb/sdb1/Vidéos/séries" \
    "--map=\\\\NASSSITO\\plex\\Media\\Films=>/volume1/plex/Media/Films" \
    "--map=\\\\NASSSITO\\plex\\Media\\Séries=>/volume1/plex/Media/Séries"

# 2. si « introuvables sur disque » vaut 0, appliquer
#    (mêmes --map, plus --apply)
```

Le rapport donne les lignes réécrites par table, la répartition par racine, les
chemins sans correspondance, le nombre de fichiers introuvables, et les
comptes de la base après migration.

**Revenir en arrière** : la commande écrit d'abord une sauvegarde
`media.db.avant-migration-<horodatage>`, produite par `VACUUM INTO` — un fichier
SQLite complet et cohérent, pas une copie partielle. Il suffit de la remettre en
place. À défaut, rejouer la migration avec les correspondances inversées.

La commande est **rejouable** : un chemin déjà migré est reconnu et laissé tel
quel.

### Normalisation NFC

Le code qui distingue `path` (NFC, pour les comparaisons) de `raw_path` (exact,
pour le disque) reste en place et fonctionne des deux côtés. Linux ne recompose
pas les noms, donc les deux formes y coïncident le plus souvent — mais rien ne
le garantit sur un partage monté, et le code n'a aucune raison d'être retiré.

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

### Le changement de piste audio, et pourquoi il ne marchait pas

Deux défauts se cachaient l'un derrière l'autre, et le premier rendait le second
invisible.

**`canPlayType` ne répond pas par oui ou non.** Le lecteur choisissait la
lecture native dès que `canPlayType('application/vnd.apple.mpegurl')` rendait
autre chose que la chaîne vide. Or Chrome — mesuré sur Chrome 151, Windows —
rend **`"maybe"`**. Chrome partait donc en lecture native et hls.js n'était
jamais chargé : vérifié dans le navigateur, zéro appel à `attachMedia`. Il n'y
avait aucune instance à piloter, donc aucun changement de piste possible.

Le défaut était masqué parce que **la vidéo se lisait quand même** : Chrome sait
désormais lire du HLS tout seul. Mais il n'expose pas `audioTracks` sur
l'élément vidéo — une lecture qui marche, sans aucun moyen de changer de piste.

La décision porte maintenant sur les **Media Source Extensions**, ce dont hls.js
a réellement besoin, et le test se fait sans charger la bibliothèque : sur
iPhone, télécharger 525 Ko pour ne pas s'en servir serait un mauvais échange.

**Les rendus n'existent pas quand on croit.** Mesuré : `hls.audioTracks` reste
vide à la construction, après `attachMedia`, et même à `MANIFEST_PARSED`
(+19 ms). Elle ne se remplit qu'à `AUDIO_TRACKS_UPDATED`, une seconde et demie
plus tard. Le composant appliquait la piste une seule fois, juste après
l'attache — donc quand il n'y avait rien à choisir, et la piste mémorisée
n'était jamais appliquée à l'ouverture.

Délais mesurés entre le clic et la reprise du son, dans Chrome, sur le NAS :

| Fichier | Mode | Bascule | Son repris |
|---|---|---|---|
| Avatar 4K HDR, 6 pistes | transcode | a-1 → a-6 | 1 581 ms |
| Big Bang Theory | remux | a-4 → a-1 | 547 ms |
| Big Bang Theory HEVC | transcode | a-2 → a-1 | 1 298 ms |
| One Piece (fr/jp) | remux | a-2 → a-1 | 512 ms |

La position est conservée dans les quatre cas : la lecture continue d'avancer,
elle ne repart jamais du début.

> **Piège de vérification.** Comparer le PREMIER segment de deux pistes ne prouve
> rien : sur One Piece, les huit premières secondes des pistes française et
> japonaise sont identiques dans la source — même intro. Le comparateur en a
> conclu un défaut serveur qui n'existait pas. Comparer au-delà du générique.

### Le film perdait ses six premières secondes

Trois segments de deux secondes ouvraient la lecture, puis on passait à quatre.
Une exécution ffmpeg ne sachant pas changer de durée de segment en cours de
route, il en fallait **deux** — et c'est là que tout se jouait.

La seconde exécution part d'une position non nulle, donc porte
`-output_ts_offset`, et ffmpeg inscrit ce décalage **dans l'en-tête fMP4**.
Vérifié octet par octet sur deux `init.mp4` du même fichier :

```
cmp -l init.mp4 init-stable.mp4
  271  27   0
  272 160  51        →  6000  contre  41
```

6 000 ms, c'est exactement la longueur de l'amorce. Or le lecteur ne reçoit
qu'**un** en-tête, figé depuis la première exécution : les segments de la
seconde étaient lus avec le mauvais. Le commentaire qui justifiait ce figeage
affirmait « comme la vidéo est copiée, son contenu est identique d'une exécution
à l'autre » — faux dès qu'une exécution porte un décalage, et vrai autant pour le
remux que pour le transcodage.

**Correction : une seule exécution par départ.** Un run, un en-tête, aucune
divergence possible. Le démarrage rapide est désormais tenu par le prélude, qui
sert de vrais fichiers déjà encodés — ce qui rendait l'amorce courte inutile.

Vérifié après correction, en comparant l'image réellement décodée à celle du
fichier source (distance sur une signature 8×8) :

| Fichier | à t=0 | à t=6 s |
|---|---|---|
| Avatar (transcode 4K HDR) | **0 / 64** | 64 / 64 |
| Big Bang Theory (transcode) | **0 / 64** | 35 / 64 |
| 57 Seconds (transcode) | **0 / 64** | 37 / 64 |
| 3 jours max (remux) | **0 / 64** | 1 / 64 |

Effet de bord mesuré : le trou de 16 à 22 secondes d'Avatar a disparu du même
coup — 0 plage tamponnée multiple contre 311 avant, aucun saut, aucune image
perdue.

> **PIÈGE DE VÉRIFICATION — une sonde qui mesure l'en-tête au lieu du segment.**
>
> Concaténer `init.mp4` + **un** segment et lire ses horodatages ne dit RIEN du
> segment : la liste d'édition de l'en-tête impose la valeur lue. Le même
> segment donnait 0,041 s avec un en-tête et 6,000 s avec l'autre ; et deux
> segments différents donnaient la même valeur avec le même en-tête.
>
> Cette sonde a produit deux diagnostics entièrement faux avant qu'on ne s'en
> aperçoive. **Seule la concaténation de PLUSIEURS segments consécutifs dit
> quelque chose** : on y lit alors les reculs, les trous, et le nombre d'images
> rapporté à la durée annoncée.
