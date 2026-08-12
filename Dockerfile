# syntax=docker/dockerfile:1

# ==============================================================================
# Serveur média personnel
#
# Cinq étages, deux cibles utiles :
#   --target runtime  (défaut) : image de production, sans outils de compilation
#   --target dev               : source montée en volume, tsx watch
#
# better-sqlite3 est un module natif : sa compilation demande python3, make et
# g++, soit ~400 Mo qui n'ont rien à faire dans l'image finale.
#
# Node 22 LTS. Le NAS a un Node 18 sans npm et en fin de vie : rien ici ne le
# touche.
# ==============================================================================

# ------------------------------------------------------------------------------
# Étage 1 — dépendances du serveur, outils de compilation compris
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Les manifestes d'abord : tant qu'ils ne changent pas, Docker réutilise la
# couche d'installation, et un simple changement de code ne réinstalle rien.
COPY package.json ./
COPY server/package.json server/package-lock.json* ./server/

RUN npm --prefix server ci

# ------------------------------------------------------------------------------
# Étage 2 — compilation TypeScript, puis élagage
# ------------------------------------------------------------------------------
FROM deps AS build

COPY server/tsconfig.json ./server/
COPY server/src ./server/src

RUN npm --prefix server run build

# Les outils de test et TypeScript ne servent plus une fois le JavaScript produit.
RUN npm --prefix server ci --omit=dev

# ------------------------------------------------------------------------------
# Étage 3 — interface
#
# Construite ICI plutôt que transférée : `web/dist` n'est pas versionné, donc il
# n'arrive pas sur le NAS, et une image qui dépendrait de sa présence échouerait
# à se construire là-bas.
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS web

WORKDIR /app

COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix web ci

COPY web/tsconfig*.json web/vite.config.ts web/index.html ./web/
COPY web/src ./web/src
COPY web/public ./web/public

RUN npm --prefix web run build

# ------------------------------------------------------------------------------
# Étage 4 — socle d'exécution : ffmpeg et l'accélération matérielle
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS ffmpeg-base

# `intel-media-va-driver-non-free` est le pilote iHD, celui qu'il faut pour les
# générations récentes — le Pentium Gold 8505 du NAS est un Alder Lake. Il vit
# dans la composante « non-free » de Debian, qu'il faut activer.
#
# `vainfo` n'est pas nécessaire au fonctionnement, mais c'est le seul moyen de
# diagnostiquer une accélération qui refuse de démarrer. Deux mégaoctets bien
# placés.
#
# Le ffmpeg de Debian est conservé : c'est le repli, atteignable en pointant
# FFMPEG_PATH sur /usr/bin/ffmpeg sans rien reconstruire.
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' \
      /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      intel-media-va-driver-non-free \
      libva-drm2 \
      libva2 \
      vainfo \
      tini \
      curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------------------
# jellyfin-ffmpeg7 — le tone mapping HDR de cette bibliothèque en dépend
#
# `tonemap_vaapi` du ffmpeg 5.1 de Debian exige les métadonnées de mastering
# HDR10 et refuse de démarrer sans elles. Sondage de la bibliothèque : 161 des
# 164 fichiers HDR n'en portent PAS. Le filtre n'a aucune option pour les
# suppléer, OpenCL n'a pas de runtime sur la machine, et le tone mapping
# logiciel tourne à ×0,47 — sous le temps réel, avec 84 % de la machine.
#
# `libplacebo`, embarqué ici, ne dépend pas de ces métadonnées. Le paquet
# apporte au passage oneVPL, qui pourrait rendre QuickSync utilisable sur
# l'Alder Lake — la détection par essai réel le retiendra d'elle-même si c'est
# le cas, rien n'est décidé ici.
# ------------------------------------------------------------------------------
ARG JELLYFIN_FFMPEG_VERSION=7.1.4-3
RUN curl -fsSL -o /tmp/jellyfin-ffmpeg.deb \
      "https://repo.jellyfin.org/files/ffmpeg/debian/latest-7.x/amd64/jellyfin-ffmpeg7_${JELLYFIN_FFMPEG_VERSION}-bookworm_amd64.deb" \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/jellyfin-ffmpeg.deb \
 && rm -f /tmp/jellyfin-ffmpeg.deb \
 && rm -rf /var/lib/apt/lists/*

# Sans cette variable, libva choisit i965, qui ne connaît pas Alder Lake.
ENV LIBVA_DRIVER_NAME=iHD

WORKDIR /app

# FFMPEG_PATH désigne le binaire à utiliser. C'est AUSSI le levier de repli :
# le passer à /usr/bin/ffmpeg dans le compose ramène au ffmpeg 5.1 de Debian,
# sans reconstruction. `ffprobe` est déduit du même dossier, jamais du PATH.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    HOME_STREAMING_CONFIG=/app/config.production.json \
    FFMPEG_PATH=/usr/lib/jellyfin-ffmpeg/ffmpeg

EXPOSE 3000

# tini récolte les processus ffmpeg terminés. Sans lui, Node est PID 1 et
# n'adopte pas les orphelins : les zombies s'accumuleraient à chaque session.
ENTRYPOINT ["/usr/bin/tini", "--"]

# ------------------------------------------------------------------------------
# Étage 5a — PRODUCTION
# ------------------------------------------------------------------------------
FROM ffmpeg-base AS runtime

COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=web /app/web/dist ./web/dist
COPY package.json ./package.json

ENV NODE_ENV=production

CMD ["node", "server/dist/index.js"]

# ------------------------------------------------------------------------------
# Étage 5b — DÉVELOPPEMENT
#
# La source est montée en volume et exécutée par tsx watch : modifier un fichier
# redémarre le serveur sans reconstruire l'image. Les dépendances, elles,
# viennent de l'image — changer package.json demande donc une reconstruction.
# ------------------------------------------------------------------------------
FROM ffmpeg-base AS dev

COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/package.json server/tsconfig.json ./server/
COPY package.json ./package.json

ENV NODE_ENV=development

CMD ["npm", "--prefix", "server", "run", "dev"]
