#!/bin/bash
# =============================================================================
# Points 3 et 4 : d'où vient la régression, et combien de sessions tiennent.
#
#   cd /volume1/docker/home_streaming && sudo ./bissection.sh
#
# PARTIE A — bissection. On part EXACTEMENT de la commande du palier 1, qui
# donnait x7.56, et on ajoute une seule chose à la fois. La ligne où le facteur
# s'effondre désigne le coupable, sans avoir à le deviner.
#
# PARTIE B — montée en charge, sur des fichiers qui aboutissent tous. Le test
# précédent ne mesurait que deux sessions, Avatar échouant sur le tone mapping.
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

# Une seule fonction de mesure, avec le controle du code de sortie AVANT tout
# chiffre — la lecon des deux tours precedents.
mesure() {
  local nom="$1" journal="$2"; shift 2
  local debut fin code ms sp u s
  debut=$(date +%s%N)
  "${C[@]}" exec -T $SERVICE "$@" > "$journal" 2>&1
  code=$?
  fin=$(date +%s%N)
  ms=$(( (fin - debut) / 1000000 ))

  if [ "$code" -ne 0 ]; then
    printf '  %-42s ÉCHEC (%s)\n' "$nom" "$code"
    grep -iE 'error|invalid|failed' "$journal" | head -2 | sed 's/^/      /'
    return 1
  fi
  sp=$(grep -o 'speed=[ ]*[0-9.]*x' "$journal" | tail -1 | grep -o '[0-9.]*')
  u=$(grep -o 'utime=[0-9.]*' "$journal" | tail -1 | cut -d= -f2)
  s=$(grep -o 'stime=[0-9.]*' "$journal" | tail -1 | cut -d= -f2)
  [ -z "${sp:-}" ] && { printf '  %-42s abouti, sans mesure\n' "$nom"; return 1; }

  awk -v n="$nom" -v ms="$ms" -v sp="$sp" -v u="${u:-0}" -v st="${s:-0}" -v c="$CORES" 'BEGIN {
    cpu=u+st;
    printf "  %-42s x%-7s %5.1f s  CPU %5.1f s = %3.0f %% cœur\n", n, sp, ms/1000, cpu, 100*cpu/(ms/1000);
  }'
}

# Le binaire A MESURER est celui du serveur, pas « ffmpeg » nu : celui-ci est le
# Debian 5.1 de repli. Meme defaut que bascule.sh, meme correctif.
FF=$("${C[@]}" exec -T $SERVICE printenv FFMPEG_PATH 2>/dev/null | tr -d "
")
[ -z "$FF" ] && FF=ffmpeg
echo "  binaire mesure : $FF"

SRC=$(chemin 1961)
BASE=(-hide_banner -loglevel info -nostdin -stats -benchmark
      -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi
      -i "$SRC" -t 30 -map 0:v:0 -map "0:a:0?")
FIN=(-c:a aac -b:a 192k -ac 2 -f null -)

titre "A. BISSECTION DE LA RÉGRESSION — #1961, référence palier 1 : x7.56"
echo "  Chaque ligne ajoute UNE chose à la précédente."
echo

mesure "1. palier 1 à l'identique" "$SORTIE/b1.log" "$FF" \
  "${BASE[@]}" -vf "scale_vaapi=w=1920:h=-2:format=nv12" -c:v h264_vaapi -b:v 6M "${FIN[@]}"

mesure "2. + scale sans dimensions" "$SORTIE/b2.log" "$FF" \
  "${BASE[@]}" -vf "scale_vaapi=format=nv12" -c:v h264_vaapi -b:v 6M "${FIN[@]}"

mesure "3. + probesize/analyzeduration" "$SORTIE/b3.log" "$FF" \
  -probesize 5M -analyzeduration 2M "${BASE[@]}" -vf "scale_vaapi=format=nv12" \
  -c:v h264_vaapi -b:v 6M "${FIN[@]}"

mesure "4. + profile main" "$SORTIE/b4.log" "$FF" \
  -probesize 5M -analyzeduration 2M "${BASE[@]}" -vf "scale_vaapi=format=nv12" \
  -c:v h264_vaapi -profile:v main -b:v 6M "${FIN[@]}"

mesure "5. + maxrate et bufsize" "$SORTIE/b5.log" "$FF" \
  -probesize 5M -analyzeduration 2M "${BASE[@]}" -vf "scale_vaapi=format=nv12" \
  -c:v h264_vaapi -profile:v main -b:v 6M -maxrate 9M -bufsize 12M "${FIN[@]}"

mesure "6. + force_key_frames" "$SORTIE/b6.log" "$FF" \
  -probesize 5M -analyzeduration 2M "${BASE[@]}" -vf "scale_vaapi=format=nv12" \
  -c:v h264_vaapi -profile:v main -b:v 6M -maxrate 9M -bufsize 12M \
  -force_key_frames "expr:gte(t,n_forced*4)" "${FIN[@]}"

mesure "7. + downmix explicite" "$SORTIE/b7.log" "$FF" \
  -probesize 5M -analyzeduration 2M "${BASE[@]}" -sn -dn -map_chapters -1 \
  -vf "scale_vaapi=format=nv12" \
  -c:v h264_vaapi -profile:v main -b:v 6M -maxrate 9M -bufsize 12M \
  -force_key_frames "expr:gte(t,n_forced*4)" \
  -c:a aac -b:a 192k -ac 2 \
  -af "pan=stereo|FL=0.5*FL+0.8*FC+0.3*LFE+0.5*BL|FR=0.5*FR+0.8*FC+0.3*LFE+0.5*BR,aresample=async=1:first_pts=0" \
  -f null -

echo
echo "  La ligne où le facteur s'effondre désigne le coupable."

# -----------------------------------------------------------------------------
titre "B. MONTÉE EN CHARGE — combien de sessions tiennent ?"
echo "  Trois épisodes HEVC 1080p SDR, tous transcodables : aucun n'échoue."
echo

# La commande de production, sans tone mapping (ces sources sont SDR).
prod() {
  CMD=("$FF" -hide_banner -loglevel info -nostdin -stats -benchmark
       -probesize 5M -analyzeduration 2M
       -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi
       -i "$1" -t 30 -map 0:v:0 -map "0:a:0?" -sn -dn -map_chapters -1
       -vf "scale_vaapi=format=nv12"
       -c:v h264_vaapi -profile:v main -b:v 6M -maxrate 9M -bufsize 12M
       -force_key_frames "expr:gte(t,n_forced*4)"
       -c:a aac -b:a 192k -ac 2
       -af "pan=stereo|FL=0.5*FL+0.8*FC+0.3*LFE+0.5*BL|FR=0.5*FR+0.8*FC+0.3*LFE+0.5*BR,aresample=async=1:first_pts=0"
       -f null -)
}

FICHIERS=(1961 1956 1954 1959)
declare -A SEUL

for n in 1 2 3 4; do
  ids=("${FICHIERS[@]:0:$n}")
  echo "  --- $n session(s) en parallèle ---"
  debut=$(date +%s%N)
  for id in "${ids[@]}"; do
    prod "$(chemin "$id")"
    ( "${C[@]}" exec -T $SERVICE "${CMD[@]}" > "$SORTIE/n$n-$id.log" 2>&1; echo $? > "$SORTIE/n$n-$id.code" ) &
  done
  wait
  fin=$(date +%s%N)

  total=0; ok=0
  for id in "${ids[@]}"; do
    code=$(cat "$SORTIE/n$n-$id.code" 2>/dev/null || echo 1)
    if [ "$code" -ne 0 ]; then printf '    #%-6s ÉCHEC\n' "$id"; continue; fi
    sp=$(grep -o 'speed=[ ]*[0-9.]*x' "$SORTIE/n$n-$id.log" | tail -1 | grep -o '[0-9.]*')
    [ -z "${sp:-}" ] && { printf '    #%-6s sans mesure\n' "$id"; continue; }
    [ "$n" -eq 1 ] && SEUL[$id]=$sp
    ok=$((ok+1))
    total=$(awk -v t="$total" -v s="$sp" 'BEGIN{print t+s}')
    ref=${SEUL[$id]:-0}
    awk -v id="$id" -v sp="$sp" -v ref="$ref" 'BEGIN {
      if (ref > 0 && ref != sp) printf "    #%-6s x%-7s  (seul x%-7s → %.0f %% du solo)\n", id, sp, ref, 100*sp/ref;
      else printf "    #%-6s x%-7s\n", id, sp;
    }'
  done
  awk -v n="$n" -v ok="$ok" -v t="$total" -v ms="$(( (fin-debut)/1000000 ))" 'BEGIN {
    if (ok > 0) printf "    → %d/%d abouties · débit cumulé x%.2f · moyenne x%.2f · %.1f s\n", ok, n, t, t/ok, ms/1000;
  }'
  echo
done

titre "C. CHARGE PENDANT LA MONTÉE"
"${C[@]}" exec -T $SERVICE sh -c 'ps -eo comm | grep -c ffmpeg' 2>/dev/null | sed 's/^/  ffmpeg restants : /'
echo
echo "  Une session est soutenable tant que son facteur reste au-dessus de x1."
echo "  Journaux complets dans $SORTIE/"
