# Mesurer la lecture DANS LE NAVIGATEUR

> **La règle : tout ce qui concerne la lecture se mesure ici, pas par assemblage
> de fichiers.**

## Pourquoi ces scripts existent

Assembler `init.mp4` + des segments et lire les horodatages avec `ffprobe` a
produit **trois diagnostics entièrement faux** sur ce projet :

1. « les trois premiers segments portent le contenu de 6→12 s » — faux ;
2. « le serveur sert la même piste audio pour deux rendus » — faux, les huit
   premières secondes de l'épisode étaient identiques dans la source ;
3. « la jonction du prélude est cassée » — faux, le trou existait sans lui.

La cause est toujours la même : **la liste d'édition de l'en-tête écrase la
valeur lue**. Le même segment donne 0,041 s ou 6,000 s selon l'en-tête qu'on lui
accole, et deux segments différents donnent la même valeur avec le même en-tête.
Après un déplacement, tous les segments annoncent zéro quelle que soit leur
position réelle.

Le navigateur ne fait pas ça. hls.js empile des fragments dans des `SourceBuffer`
distincts, et c'est le moteur média qui décide où chacun atterrit. **Seule cette
mesure-là dit la vérité.**

## Ce dont ils ont besoin

Chrome installé (chemin en tête de `cdp.mjs`), et Node 22 ou plus récent pour le
`WebSocket` natif. Aucune dépendance à installer.

```bash
cd scripts/mesure-navigateur
AVEC_FENETRE=1 node sync-audio-video.mjs 365 600,1200,1800,2400
```

`AVEC_FENETRE=1` est **nécessaire pour tout ce qui concerne la lecture** : en
mode sans affichage, Chrome n'exécute pas le pipeline média et `currentTime`
n'avance pas. Les mesures de démarrage y sont muettes, celles de synchronisation
fausses.

## Les instruments

| Script | Ce qu'il mesure |
|---|---|
| `couv.mjs` | **la présence de chaque flux À la position lue**, après chaque déplacement |
| `continu.mjs` | lecture linéaire sans aucun saut : retard, images perdues, événements |
| `blocage.mjs` | **pourquoi** la lecture se fige : visibilité, erreur du décodeur, tampon |
| `piste-audio.mjs` | délai d'un changement de piste, et bonne place de la nouvelle |
| `piste-audio-phase.mjs` | ce délai **contre la phase dans le segment audio** (`t mod 8`) |
| `sync-audio-video.mjs` | l'écart entre tampon **audio** et tampon **vidéo**, après chaque déplacement |
| `demarrage.mjs` | délai clic → première image, puis → premier son |
| `demarrage-detail.mjs` | **où passe** ce délai : chaque requête, sa taille, son débit |
| `jonction.mjs` | trous, sauts, images perdues au passage d'une frontière |
| `codecs.mjs` | ce que `MediaSource.isTypeSupported` accepte, et si l'écran est HDR |
| `decodage.mjs` | la part d'images que le décodeur ne tient pas, selon le débit |
| `cdp.mjs` | client CDP minimal, partagé |

`demarrage.mjs` donne deux nombres ; quand ils dépassent la cible, ils ne disent
pas QUI attend. `demarrage-detail.mjs` répond, et il corrige au passage un repère
faux : `demarrage.mjs` date le premier segment sur `Network.responseReceived`,
qui se déclenche à l'arrivée des **en-têtes**. Sur un segment 4K de sept
mégaoctets, l'écart avec la fin du corps est justement ce qu'on cherche —
`loadingFinished` est le bon repère, et il a montré 870 ms de transfert là où
l'autre affichait 336 ms.

`blocage.mjs` existe parce qu'un tampon plein et une position figée ont trois
causes possibles — fenêtre masquée, décodeur en erreur, restitution qui lâche —
et qu'aucune ne se distingue sans relever les trois au même instant.

`couv.mjs` est celui à préférer pour juger d'un déplacement : il pose la seule
question qui ait un sens (« ce flux est-il là où le lecteur est ? ») plutôt que
de comparer des débuts de plages, qui a déjà fabriqué un faux diagnostic — voir
l'erreur 4 plus bas.

`continu.mjs` existe pour SÉPARER deux causes que tous les autres tests
confondaient : un défaut de production et un défaut de relance. En supprimant
tout déplacement, il attribue sans ambiguïté ce qui reste.

## Comment `sync-audio-video.mjs` s'y prend

Il piège deux méthodes **avant** que la lecture ne commence :

- `MediaSource.prototype.addSourceBuffer` — pour retenir chaque tampon avec son
  type MIME ;
- `SourceBuffer.prototype.appendBuffer` — pour relever le `timestampOffset` que
  hls.js applique à chacun.

Il lit ensuite `sb.buffered` **par tampon**, séparément. Un fichier dont l'audio
est muxé dans la vidéo n'a qu'un seul `SourceBuffer` : il est immunisé par
construction contre tout décalage, et le script le dit.

## Le piège du piège

Le prototype doit être patché **avant** que l'application ne crée son instance,
et la navigation doit ensuite se faire **côté client** (`pushState` +
`popstate`) : un rechargement de page viderait le registre de modules et
emporterait le piège avec lui.

## Les mesures qui ont menti

Ces instruments existent parce que **huit diagnostics successifs se sont révélés
faux, et chaque fois c'est la mesure qui était fausse, pas le code**. La liste
n'est pas une confession : c'est la spécification négative de l'outil. Avant
d'accuser le serveur, vérifier qu'on n'est pas en train de refaire l'une d'elles.

1. **Concaténer `init.mp4` + UN segment pour lire ses horodatages.**
   L'en-tête fMP4 porte une *edit list* (`elst`) qui décale tout ce qui suit.
   On mesure alors l'en-tête, pas le segment — d'où un « PTS 6 s » là où le
   segment commençait à 0,041 s. Un segment isolé ne se sonde pas ; ce qui se
   sonde sans mentir, c'est le **nombre de trames**.

2. **Conclure depuis le seul `seg-00000`.**
   Sur One Piece, les huit premières secondes des deux pistes audio sont
   identiques *dans la source*. Comparer le premier segment prouvait donc
   uniquement que la source se répète. Il faut un segment situé là où les pistes
   divergent.

3. **Attribuer un symptôme au dernier changement fait.**
   Le trou de 16 à 22 s a été imputé au prélude. Il était strictement identique
   sans lui. Un symptôme ne devient une conséquence qu'après avoir été observé
   *en l'absence* de la cause supposée.

4. **Comparer les DÉBUTS de plages tamponnées au lieu de la présence à la
   position lue.** `audio.buffered.start(0)` valant 1800 alors qu'on lit à 1800
   ne laisse aucun trou, et une vidéo qui a chargé un fragment plus en arrière
   n'est pas un décalage. La comparaison des débuts a fabriqué un « trou de 4 s »
   qui n'existait pas. La seule question valable est : *à l'instant où le lecteur
   est, ce flux est-il présent ?* — c'est ce que fait `couv.mjs`.

5. **Mesurer avec un autre binaire que celui de production.**
   Dans le conteneur, `ffmpeg` en PATH est `/usr/bin/ffmpeg`, **Debian 5.1.9**.
   La production, elle, appelle `/usr/lib/jellyfin-ffmpeg/ffmpeg`, **7.1.4** —
   c'est ce que dit `hwaccel.json`, et c'est ce que confirme `/proc/<pid>/cmdline`
   d'un encodage en cours. Deux versions majeures d'écart sur le muxer HLS, le
   placement des images clés et `tonemap_vaapi`. Toute mesure lancée à la main
   doit donner le chemin complet ; le raccourci `ffmpeg` mesure autre chose que
   ce que vos spectateurs reçoivent. Le symptôme qui l'a trahi : `tonemap_vaapi`
   échouant sur « No mastering display data » alors que la production, avec les
   mêmes arguments, tournait depuis onze minutes.

6. **Mesurer pendant qu'on travaille sur la même machine.**
   Dix minutes de lecture 4K se sont figées à 62,8 s, tampon plein, jamais
   rétablies — pendant que `tsc` et 776 tests tournaient sur les quatre cœurs du
   poste. Machine au repos, la même mesure passe sans un seul blocage. Le
   navigateur qui mesure est sur la machine qui compile : **ne rien lancer
   d'autre**, et relever `visibilityState` pour que le cas se détecte tout seul.

7. **Viser une phase en décalant la CONSIGNE.** Pour échantillonner `t mod 8`,
   les six positions de saut ont été décalées d'avance. Entre le saut et le clic,
   la lecture a continué d'avancer de 3,75 à 9,24 s selon l'essai : les phases
   visées de 0,0 à 7,2 sont arrivées groupées en 1,2-3,0 et 6,9-7,3, **sans un
   point entre 3 et 6,9**. Une phase s'ATTEND (`currentTime mod 8` dans une
   tolérance), elle ne se demande pas.

8. **Extrapoler une tendance depuis un seul échantillon d'une série
   périodique.** Dix segments consécutifs montraient un écart croissant de
   +4 ms chacun ; j'en ai déduit une dérive linéaire de 600 ms après dix
   minutes. Mesurés sur vingt-cinq segments, les écarts **retombent à zéro tous
   les onze segments** : c'est une dent de scie bornée à une durée d'image, pas
   une dérive. Dix points pris à l'intérieur d'une même dent ne distinguent pas
   les deux. Une tendance ne s'affirme qu'au-delà d'au moins deux périodes
   supposées.
