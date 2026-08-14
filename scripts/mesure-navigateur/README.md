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
| `sync-audio-video.mjs` | l'écart entre tampon **audio** et tampon **vidéo**, après chaque déplacement |
| `demarrage.mjs` | délai clic → première image, puis → premier son |
| `jonction.mjs` | trous, sauts, images perdues au passage d'une frontière |
| `cdp.mjs` | client CDP minimal, partagé |

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
