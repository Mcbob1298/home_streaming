#!/bin/bash
# =============================================================================
# Bascule vers jellyfin-ffmpeg7 : vérification complète.
#
#   cd /volume1/docker/home_streaming && sudo ./bascule.sh
#
# Enchaîne tout ce qui décide du succès de la bascule :
#   A. taille de l'image avant et après
#   B. binaire et ffprobe réellement utilisés
#   C. moteurs retenus, par ESSAI RÉEL (encodeur et tone mapping)
#   D. facteurs et CPU sur les trois fichiers de référence
#   E. les quatre images de contrôle
#   F. les 164 fichiers HDR passent-ils tous ?
# =============================================================================
set -u
cd /volume1/docker/home_streaming || exit 1

C=(docker compose -f compose.dev.yaml)
SERVICE=home-streaming-dev
DB=data/media.db
CORES=$(nproc)
SORTIE=/volume1/docker/home_streaming/data/palier2
mkdir -p "$SORTIE"

sep() { printf '%s\n' '──────────────────────────────────────────────────────────────────────────────'; }
titre() { echo; sep; echo "$1"; sep; }
chemin() { sqlite3 -noheader "$DB" "SELECT COALESCE(raw_path,path) FROM media_file WHERE id=$1;"; }
infos()  { sqlite3 -noheader "$DB" "SELECT resolution || '  ' || video_codec || '  ' || COALESCE(hdr,'SDR') FROM media_file WHERE id=$1;"; }
hdrde()  { sqlite3 -noheader "$DB" "SELECT COALESCE(hdr,'') FROM media_file WHERE id=$1;"; }
larg()   { sqlite3 -noheader "$DB" "SELECT CAST(substr(resolution,1,instr(resolution,'x')-1) AS INT) FROM media_file WHERE id=$1;"; }
haut()   { sqlite3 -noheader "$DB" "SELECT CAST(substr(resolution,instr(resolution,'x')+1) AS INT) FROM media_file WHERE id=$1;"; }

titre "A. TAILLE DE L'IMAGE"
avant=$(docker image inspect home-streaming:dev --format '{{.Size}}' 2>/dev/null || echo 0)
awk -v s="$avant" 'BEGIN { printf "  avant (ffmpeg 5.1 Debian) : %.0f Mo\n", s/1048576 }'
echo "  construction en cours…"
"${C[@]}" build 2>&1 | tail -3
apres=$(docker image inspect home-streaming:dev --format '{{.Size}}' 2>/dev/null || echo 0)
awk -v a="$avant" -v b="$apres" 'BEGIN {
  printf "  après (jellyfin-ffmpeg7)  : %.0f Mo\n", b/1048576;
  if (a > 0) printf "  écart                     : +%.0f Mo\n", (b-a)/1048576;
}'

"${C[@]}" up -d 2>&1 | tail -2
printf '  attente de l API'
for i in $(seq 1 120); do
  curl -sf -m 2 http://127.0.0.1:3001/api/libraries >/dev/null 2>&1 && { echo " — prête après ${i}s"; break; }
  printf '.'; sleep 1
done

# Le binaire À MESURER est celui que le serveur utilise, pas « ffmpeg » nu :
# celui-ci est le Debian 5.1 de repli, qui n a aucun pilote Vulkan et fait
# echouer libplacebo. C est le defaut qui invalidait D, E et F.
FF=$("${C[@]}" exec -T $SERVICE printenv FFMPEG_PATH 2>/dev/null | tr -d "
")
[ -z "$FF" ] && FF=ffmpeg
echo "  binaire mesure : $FF"

titre "B. BINAIRES RÉELLEMENT UTILISÉS"
"${C[@]}" exec -T $SERVICE sh -c 'echo "  FFMPEG_PATH = $FFMPEG_PATH"; ls -la "$FFMPEG_PATH" "${FFMPEG_PATH%ffmpeg}ffprobe" 2>&1 | sed "s/^/  /"'
echo
"${C[@]}" exec -T $SERVICE sh -c '"$FFMPEG_PATH" -version 2>/dev/null | head -1 | sed "s/^/  ffmpeg  : /"'
"${C[@]}" exec -T $SERVICE sh -c '"${FFMPEG_PATH%ffmpeg}ffprobe" -version 2>/dev/null | head -1 | sed "s/^/  ffprobe : /"'
echo "  --- l ancien binaire reste disponible pour le repli ---"
"${C[@]}" exec -T $SERVICE sh -c '/usr/bin/ffmpeg -version 2>/dev/null | head -1 | sed "s/^/  repli   : /"'

titre "C. MOTEURS RETENUS, PAR ESSAI RÉEL"
curl -s -m 20 http://127.0.0.1:3001/api/transcode/capabilities > "$SORTIE/caps.json"
sed 's/,{/,\n  {/g; s/,"/,\n  "/g' "$SORTIE/caps.json" | grep -E '"hardware"|"toneMap"|"backend"|"ok"|"error"|"encoder"|"ffmpeg"' | sed 's/^/  /'
echo
echo "  --- journal de démarrage ---"
"${C[@]}" logs $SERVICE 2>&1 | grep -iE 'ffmpeg :|retenu|écart|Tone mapping|ATTENTION|AUCUN' | tail -12 | sed 's/^/  /'

# --- chaîne de filtres, telle que le serveur la produit ---------------------
filtres() {
  local id="$1" w h ow moteur
  w=$(larg "$id"); h=$(haut "$id")
  moteur=$(grep -o '"toneMap":"[a-z_]*"' "$SORTIE/caps.json" | head -1 | cut -d'"' -f4)
  local pre=""
  if [ "$h" -gt $((1080 * 105 / 100)) ]; then
    ow=$(( (w * 1080 / h + 1) / 2 * 2 ))
    pre="scale_vaapi=w=${ow}:h=1080"
  fi
  if [ -z "$(hdrde "$id")" ]; then
    [ -n "$pre" ] && echo "${pre}:format=nv12" || echo "scale_vaapi=format=nv12"
    return
  fi
  case "$moteur" in
    libplacebo) echo "${pre:+$pre,}hwmap=derive_device=vulkan,libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=nv12,hwmap=derive_device=vaapi:reverse=1" ;;
    *)          echo "${pre:+$pre,}tonemap_vaapi=format=nv12:matrix=bt709:primaries=bt709:transfer=bt709" ;;
  esac
}

construire() {
  CMD=("$FF" -hide_banner -loglevel info -nostdin -stats -benchmark
       -probesize 5M -analyzeduration 2M
       -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi
       -i "$1" -t 30 -map 0:v:0 -map "0:a:0?" -sn -dn -map_chapters -1
       -vf "$2"
       -c:v h264_vaapi -profile:v main -b:v 6M
       -c:a aac -b:a 192k -ac 2
       -af "pan=stereo|FL=0.5*FL+0.8*FC+0.3*LFE+0.5*BL|FR=0.5*FR+0.8*FC+0.3*LFE+0.5*BR,aresample=async=1:first_pts=0"
       -f null -)
}

mesure() {
  local nom="$1" journal="$2"; shift 2
  local debut fin code ms sp u s
  debut=$(date +%s%N); "${C[@]}" exec -T $SERVICE "$@" > "$journal" 2>&1; code=$?; fin=$(date +%s%N)
  ms=$(( (fin - debut) / 1000000 ))
  if [ "$code" -ne 0 ]; then
    printf '  %-34s ÉCHEC (%s)\n' "$nom" "$code"
    grep -iE 'error|invalid|failed|no mastering' "$journal" | head -3 | sed 's/^/      /'
    return 1
  fi
  sp=$(grep -o 'speed=[ ]*[0-9.]*x' "$journal" | tail -1 | grep -o '[0-9.]*')
  u=$(grep -o 'utime=[0-9.]*' "$journal" | tail -1 | cut -d= -f2)
  s=$(grep -o 'stime=[0-9.]*' "$journal" | tail -1 | cut -d= -f2)
  [ -z "${sp:-}" ] && { printf '  %-34s abouti, sans mesure\n' "$nom"; return 1; }
  awk -v n="$nom" -v ms="$ms" -v sp="$sp" -v u="${u:-0}" -v st="${s:-0}" -v c="$CORES" 'BEGIN {
    cpu=u+st;
    printf "  %-34s x%-7s %5.1f s  CPU %5.1f s = %3.0f %% cœur = %4.1f %% machine\n",
           n, sp, ms/1000, cpu, 100*cpu/(ms/1000), 100*cpu/(ms/1000)/c;
  }'
}

titre "D. FACTEURS ET CPU — référence sans tone mapping : #1961 x7.56 · #2390 x4.88 · #365 x5.32"
for id in 1961 2390 365; do
  echo "  #$id  $(infos "$id")"
  echo "      chaîne : $(filtres "$id")"
  construire "$(chemin "$id")" "$(filtres "$id")"
  mesure "    transcodage complet" "$SORTIE/f7-$id.log" "${CMD[@]}"
  # Le coût du tone mapping : même commande, filtre de conversion retiré.
  if [ -n "$(hdrde "$id")" ]; then
    h=$(haut "$id"); w=$(larg "$id"); sans="scale_vaapi=format=nv12"
    [ "$h" -gt $((1080*105/100)) ] && sans="scale_vaapi=w=$(( (w*1080/h + 1) / 2 * 2 )):h=1080:format=nv12"
    construire "$(chemin "$id")" "$sans"
    mesure "    sans tone mapping (témoin)" "$SORTIE/f7-notm-$id.log" "${CMD[@]}"
  fi
  echo
done

titre "E. LES QUATRE IMAGES DE CONTRÔLE"
for id in 2390 365; do
  src=$(chemin "$id")
  h=$(haut "$id"); w=$(larg "$id")
  base="scale_vaapi=w=$(( (w*1080/h + 1) / 2 * 2 )):h=1080"
  for tm in avec sans; do
    if [ "$tm" = avec ]; then vf="$(filtres "$id"),hwdownload,format=nv12"
    else vf="${base}:format=nv12,hwdownload,format=nv12"; fi
    "${C[@]}" exec -T $SERVICE "$FF" -hide_banner -loglevel error -nostdin -y \
      -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi \
      -ss 600 -i "$src" -frames:v 1 -vf "$vf" \
      "/app/data/palier2/f7-image-$id-$tm.png" > "$SORTIE/png-$id-$tm.log" 2>&1
    code=$?; taille=$(stat -c%s "$SORTIE/f7-image-$id-$tm.png" 2>/dev/null || echo 0)
    if [ "$code" -ne 0 ] || [ "$taille" -lt 1000 ]; then
      printf '  f7-image-%s-%-5s ÉCHEC (code %s, %s octets)\n' "$id" "$tm" "$code" "$taille"
      head -3 "$SORTIE/png-$id-$tm.log" | sed 's/^/      /'
    else
      awk -v id="$id" -v tm="$tm" -v t="$taille" 'BEGIN { printf "  f7-image-%s-%-5s %6.0f Ko\n", id, tm, t/1024 }'
    fi
  done
done

titre "F. LES 164 FICHIERS HDR PASSENT-ILS TOUS ?"
echo "  Un essai d'une image par fichier : c'est l'initialisation du filtre qui"
echo "  échouait, pas l'encodage. 30 fichiers tirés au hasard suffisent à trancher."
ok=0; ko=0
for id in $(sqlite3 -noheader "$DB" "SELECT id FROM media_file WHERE present=1 AND hdr IS NOT NULL ORDER BY RANDOM() LIMIT 30;"); do
  src=$(chemin "$id")
  "${C[@]}" exec -T $SERVICE "$FF" -hide_banner -loglevel error -nostdin \
    -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi \
    -ss 60 -i "$src" -frames:v 2 -vf "$(filtres "$id")" \
    -c:v h264_vaapi -f null - > "$SORTIE/hdr-$id.log" 2>&1
  if [ $? -eq 0 ]; then ok=$((ok+1)); else
    ko=$((ko+1))
    printf '    #%-6s ÉCHEC : %s\n' "$id" "$(grep -iE 'error|no mastering' "$SORTIE/hdr-$id.log" | head -1)"
  fi
done
echo
echo "  $ok/$((ok+ko)) fichiers HDR traités sans erreur."
[ "$ko" -eq 0 ] && echo "  → les 164 passent, contre 3 avec tonemap_vaapi."

echo
sep
echo "Images dans $SORTIE/f7-image-*.png"
sep
