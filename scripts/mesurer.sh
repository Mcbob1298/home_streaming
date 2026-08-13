#!/bin/bash
# =============================================================================
# Transcodage HEVC réel : VAAPI contre logiciel.
#
#   cd /volume1/docker/home_streaming && sudo ./mesurer.sh
#
# Ce qui a cassé la version précédente, et qui est corrigé ici :
#   • TIMEFORMAT n'était pas défini : « time » sortait son format par défaut
#     sur trois lignes, découpé en jetons non numériques -> 0.0 s et xinf.
#     La durée est maintenant mesurée avec date +%s%N, sans rien à analyser.
#   • la réussite était devinée en cherchant des mots dans stderr. C'est le
#     CODE DE SORTIE qui décide, et rien n'est calculé avant de l'avoir vu.
#   • aucune sortie brute n'était montrée. Tout est affiché.
#
# La mesure de référence est le « speed=Nx » que ffmpeg publie lui-même.
# =============================================================================
set -u
cd /volume1/docker/home_streaming || exit 1

C="docker compose -f compose.dev.yaml"
SERVICE=home-streaming-dev
CONTENEUR=home-streaming-dev
DB=data/media.db
ID=${1:-1961}

sep() { printf '%s\n' '──────────────────────────────────────────────────────────────────────────────'; }

SRC=$(sqlite3 -noheader "$DB" "SELECT COALESCE(raw_path,path) FROM media_file WHERE id=$ID;")
if [ -z "$SRC" ]; then echo "media_file #$ID introuvable en base."; exit 1; fi

sep; echo "FICHIER D'ESSAI"; sep
echo "  $(basename "$SRC")"
sqlite3 -noheader "$DB" "SELECT '  ' || resolution || '   ' || video_codec || ' / ' || audio_codec ||
  '   ' || (size_bytes/1048576) || ' Mo   ' || CAST(duration_seconds/60 AS INT) || ' min   HDR: ' ||
  COALESCE(hdr,'non') FROM media_file WHERE id=$ID;"
echo "  cœurs de la machine : $(nproc)"
echo

# Le conteneur voit-il le fichier ? Une commande qui échoue parce que le montage
# manque produirait exactement le genre de chiffres absurdes qu'on corrige.
if ! $C exec -T $SERVICE test -f "$SRC" 2>/dev/null; then
  echo "ARRÊT : le conteneur ne voit pas $SRC"
  echo "        vérifier les montages de compose.dev.yaml"
  exit 1
fi
echo "  le conteneur voit bien le fichier."
echo

# -----------------------------------------------------------------------------
# essai <titre> <fichier-de-sortie> <arguments ffmpeg...>
# -----------------------------------------------------------------------------
essai() {
  local titre="$1" journal="$2"; shift 2

  sep; echo "$titre"; sep

  local debut fin code
  debut=$(date +%s%N)
  $C exec -T $SERVICE "$@" > "$journal" 2>&1
  code=$?
  fin=$(date +%s%N)

  local ms=$(( (fin - debut) / 1000000 ))

  echo "  --- sortie complète de ffmpeg ---"
  sed 's/^/  | /' "$journal"
  echo "  --- code de sortie : $code   durée mesurée : ${ms} ms ---"
  echo

  # RIEN n'est calculé tant que la commande n'a pas réussi.
  if [ "$code" -ne 0 ]; then
    echo "  ÉCHEC — aucune mesure n'est produite pour un transcodage qui n'a pas abouti."
    echo
    return 1
  fi

  # Mesures de référence : celles que ffmpeg publie lui-même.
  #   speed=Nx                              -> vitesse
  #   bench: utime=Xs stime=Ys rtime=Zs     -> temps processeur du processus
  local speed frames utime stime rtime
  speed=$(grep -o 'speed=[ ]*[0-9.]*x' "$journal" | tail -1 | grep -o '[0-9.]*')
  frames=$(grep -o 'frame=[ ]*[0-9]*' "$journal" | tail -1 | grep -o '[0-9]*')
  utime=$(grep -o 'utime=[0-9.]*' "$journal" | tail -1 | cut -d= -f2)
  stime=$(grep -o 'stime=[0-9.]*' "$journal" | tail -1 | cut -d= -f2)
  rtime=$(grep -o 'rtime=[0-9.]*' "$journal" | tail -1 | cut -d= -f2)

  awk -v ms="$ms" -v sp="${speed:-0}" -v f="${frames:-0}" \
      -v u="${utime:-0}" -v s="${stime:-0}" -v r="${rtime:-0}" -v c="$(nproc)" 'BEGIN {
    cpu = u + s;
    printf "  speed annoncé par ffmpeg   x%-8s  <- mesure de référence\n", sp;
    printf "  images encodées            %d\n", f;
    printf "  durée écoulée              %.2f s   (rtime ffmpeg : %.2f s)\n", ms/1000, r;
    if (ms > 0) printf "  30 s de vidéo / durée      x%.2f      <- recoupe le speed\n", 30000/ms;
    printf "  CPU (utime %.2f + stime %.2f) = %.2f s\n", u, s, cpu;
    if (ms > 0) printf "  charge                     %.0f %% d un cœur  =  %.1f %% de la machine\n",
                       100*cpu/(ms/1000), 100*cpu/(ms/1000)/c;
  }'
  echo
}

# -----------------------------------------------------------------------------
# 1. VAAPI — décodage ET encodage matériels.
#
# -hwaccel_output_format vaapi est le drapeau qui compte : sans lui les images
# décodées redescendent en mémoire centrale et seul l'encodage est matériel.
# Avec lui, elles restent sur le GPU de bout en bout.
# -----------------------------------------------------------------------------
essai "1. VAAPI — décodage ET encodage matériels" /tmp/vaapi.log \
  ffmpeg -hide_banner -nostdin -stats -benchmark -loglevel info \
    -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi \
    -i "$SRC" -t 30 -map 0:v:0 -map "0:a:0?" \
    -vf "scale_vaapi=w=1920:h=-2:format=nv12" \
    -c:v h264_vaapi -b:v 6M -c:a aac -b:a 192k -ac 2 -f null -

# -----------------------------------------------------------------------------
# 2. Témoin logiciel. C'est l'ÉCART avec le premier qui prouve que le matériel
#    travaille : deux vitesses identiques signifieraient que VAAPI ne sert à rien.
# -----------------------------------------------------------------------------
essai "2. libx264 — tout en logiciel (témoin)" /tmp/x264.log \
  ffmpeg -hide_banner -nostdin -stats -benchmark -loglevel info \
    -i "$SRC" -t 30 -map 0:v:0 -map "0:a:0?" \
    -vf "scale=1920:-2" \
    -c:v libx264 -preset veryfast -b:v 6M -c:a aac -b:a 192k -ac 2 -f null -

# -----------------------------------------------------------------------------
sep; echo "COMPARAISON"; sep
v=$(grep -o 'speed=[ ]*[0-9.]*x' /tmp/vaapi.log 2>/dev/null | tail -1 | grep -o '[0-9.]*')
x=$(grep -o 'speed=[ ]*[0-9.]*x' /tmp/x264.log 2>/dev/null | tail -1 | grep -o '[0-9.]*')
if [ -n "${v:-}" ] && [ -n "${x:-}" ]; then
  awk -v v="$v" -v x="$x" 'BEGIN {
    printf "  VAAPI   x%s\n  libx264 x%s\n\n", v, x;
    if (x > 0) printf "  rapport : VAAPI est %.1f fois plus rapide que le logiciel.\n", v/x;
    if (x > 0 && v/x < 1.3) print "  ATTENTION : écart trop faible, le matériel ne travaille probablement pas.";
    else if (x > 0) print "  L écart confirme que l encodage matériel travaille réellement.";
  }'
else
  echo "  Comparaison impossible : au moins un des deux essais n a pas abouti."
fi
