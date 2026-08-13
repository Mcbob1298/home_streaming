#!/bin/bash
# =============================================================================
# Palier 2 — verifications du transcodage en acceleration materielle.
#
#   cd /volume1/docker/home_streaming && sudo ./palier2.sh
#
# CE QUI A CASSE LA VERSION PRECEDENTE, ET QUI EST CORRIGE ICI :
#
#   1. Les commandes etaient construites par $(fonction) NON QUOTE, donc
#      decoupees sur les espaces. Les chemins « The big bang theory » et
#      « Mercredi/Season 1 » eclataient en plusieurs arguments ; seul Avatar,
#      dont le chemin n'a aucun espace, passait. Tout passe par des TABLEAUX.
#
#   2. -loglevel error supprimait la ligne « bench: utime=... » de -benchmark,
#      d'ou un CPU releve a 0,0 s. C'est du niveau info.
#
#   3. Les sections paralleles et les captures n'examinaient AUCUN code de
#      sortie et imprimaient des zeros. Rien n'est affiche sans reussite.
# =============================================================================
set -u
cd /volume1/docker/home_streaming || exit 1

C=(docker compose -f compose.dev.yaml)
SERVICE=home-streaming-dev
DB=data/media.db
CORES=$(nproc)
SORTIE=/volume1/docker/home_streaming/data/palier2
mkdir -p "$SORTIE"; rm -f "$SORTIE"/*.log

sep() { printf '%s\n' '──────────────────────────────────────────────────────────────────────────────'; }
titre() { echo; sep; echo "$1"; sep; }

chemin() { sqlite3 -noheader "$DB" "SELECT COALESCE(raw_path,path) FROM media_file WHERE id=$1;"; }
larg()   { sqlite3 -noheader "$DB" "SELECT CAST(substr(resolution,1,instr(resolution,'x')-1) AS INT) FROM media_file WHERE id=$1;"; }
haut()   { sqlite3 -noheader "$DB" "SELECT CAST(substr(resolution,instr(resolution,'x')+1) AS INT) FROM media_file WHERE id=$1;"; }
infos()  { sqlite3 -noheader "$DB" "SELECT resolution || '  ' || video_codec || '/' || audio_codec || '  ' || COALESCE(hdr,'SDR') FROM media_file WHERE id=$1;"; }
hdrde()  { sqlite3 -noheader "$DB" "SELECT COALESCE(hdr,'') FROM media_file WHERE id=$1;"; }

# --- La chaine de filtres, exactement celle que le serveur produit -----------
filtres() {
  local id="$1" tm="$2" w h ow
  w=$(larg "$id"); h=$(haut "$id")
  # Meme regle que le code : pas de redimensionnement sous 5 % d'ecart.
  if [ "$h" -gt $((1080 * 105 / 100)) ]; then
    ow=$(( (w * 1080 / h + 1) / 2 * 2 ))
    if [ "$tm" = "oui" ]; then
      echo "scale_vaapi=w=${ow}:h=1080,tonemap_vaapi=format=nv12:matrix=bt709:primaries=bt709:transfer=bt709"
    else
      echo "scale_vaapi=w=${ow}:h=1080:format=nv12"
    fi
  else
    if [ "$tm" = "oui" ]; then
      echo "tonemap_vaapi=format=nv12:matrix=bt709:primaries=bt709:transfer=bt709"
    else
      echo "scale_vaapi=format=nv12"
    fi
  fi
}

# --- Construction de la commande, dans un TABLEAU ---------------------------
# C'est la correction du bug principal : plus aucune chaine a re-decouper.
construire() {
  local src="$1" vf="$2"
  CMD=(ffmpeg -hide_banner -loglevel info -nostdin -stats -benchmark
       -probesize 5M -analyzeduration 2M
       -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi
       -i "$src" -t 30 -map 0:v:0 -map "0:a:0?" -sn -dn -map_chapters -1
       -vf "$vf"
       -c:v h264_vaapi -profile:v main -b:v 6M -maxrate 9M -bufsize 12M
       -force_key_frames "expr:gte(t,n_forced*4)"
       -colorspace bt709 -color_primaries bt709 -color_trc bt709
       -c:a aac -b:a 192k -ac 2
       -af "pan=stereo|FL=0.5*FL+0.8*FC+0.3*LFE+0.5*BL|FR=0.5*FR+0.8*FC+0.3*LFE+0.5*BR,aresample=async=1:first_pts=0"
       -f null -)
}

# --- Mesure : rien n'est calcule avant d'avoir vu le code de sortie ----------
mesure() {
  local nom="$1" journal="$2"; shift 2
  local debut fin code ms
  debut=$(date +%s%N)
  "${C[@]}" exec -T $SERVICE "$@" > "$journal" 2>&1
  code=$?
  fin=$(date +%s%N)
  ms=$(( (fin - debut) / 1000000 ))

  if [ "$code" -ne 0 ]; then
    printf '  %-32s ÉCHEC (code %s, %s ms)\n' "$nom" "$code" "$ms"
    grep -iE 'error|invalid|failed|unsupported|not found' "$journal" | head -3 | sed 's/^/      /'
    return 1
  fi

  local sp u s
  sp=$(grep -o 'speed=[ ]*[0-9.]*x' "$journal" | tail -1 | grep -o '[0-9.]*')
  u=$(grep -o 'utime=[0-9.]*' "$journal" | tail -1 | cut -d= -f2)
  s=$(grep -o 'stime=[0-9.]*' "$journal" | tail -1 | cut -d= -f2)

  if [ -z "${sp:-}" ]; then
    printf '  %-32s ABOUTI mais sans mesure exploitable (speed absent)\n' "$nom"
    tail -3 "$journal" | sed 's/^/      /'
    return 1
  fi

  awk -v n="$nom" -v ms="$ms" -v sp="$sp" -v u="${u:-0}" -v st="${s:-0}" -v c="$CORES" 'BEGIN {
    cpu = u + st;
    printf "  %-32s x%-6s  %5.1f s  CPU %5.1f s = %3.0f %% cœur = %4.1f %% machine\n",
           n, sp, ms/1000, cpu, 100*cpu/(ms/1000), 100*cpu/(ms/1000)/c;
  }'
}

titre "0. IMAGE ET ACCÉLÉRATION"
"${C[@]}" build 2>&1 | tail -3
"${C[@]}" up -d 2>&1 | tail -2
printf '  attente de l API'
for i in $(seq 1 90); do
  curl -sf -m 2 http://127.0.0.1:3001/api/libraries >/dev/null 2>&1 && { echo " — prête après ${i}s"; break; }
  printf '.'; sleep 1
done
curl -s -m 10 http://127.0.0.1:3001/api/transcode/capabilities \
  | tr ',' '\n' | grep -E '"hardware"|"device"' | sed 's/^/  /'

titre "1. LES CHAÎNES DE FILTRES RETENUES"
for id in 1961 365 2390; do
  printf '  #%-6s %-30s\n' "$id" "$(infos "$id")"
  printf '      avec tone mapping : %s\n' "$(filtres "$id" oui)"
  printf '      sans (témoin)     : %s\n' "$(filtres "$id" non)"
done

titre "2. FACTEUR TEMPS RÉEL AVEC TONE MAPPING"
echo "  référence palier 1, sans tone mapping : #1961 x7.56 · #2390 x4.88 · #365 x5.32"
echo
for id in 1961 365 2390; do
  src=$(chemin "$id")
  echo "  #$id  $(infos "$id")"
  if [ -n "$(hdrde "$id")" ]; then
    construire "$src" "$(filtres "$id" oui)"; mesure "    avec tone mapping" "$SORTIE/tm-$id.log" "${CMD[@]}"
    construire "$src" "$(filtres "$id" non)"; mesure "    sans (témoin)" "$SORTIE/notm-$id.log" "${CMD[@]}"
  else
    # Une source SDR ne reçoit AUCUN filtre de tone mapping : une seule mesure.
    construire "$src" "$(filtres "$id" non)"; mesure "    SDR, sans tone mapping" "$SORTIE/tm-$id.log" "${CMD[@]}"
  fi
  echo
done

titre "3. TROIS SESSIONS SIMULTANÉES"
declare -A PID
debut=$(date +%s%N)
for id in 1961 365 2390; do
  tm=non; [ -n "$(hdrde "$id")" ] && tm=oui
  construire "$(chemin "$id")" "$(filtres "$id" "$tm")"
  ( "${C[@]}" exec -T $SERVICE "${CMD[@]}" > "$SORTIE/par-$id.log" 2>&1; echo $? > "$SORTIE/par-$id.code" ) &
  PID[$id]=$!
done
for id in 1961 365 2390; do wait "${PID[$id]}"; done
fin=$(date +%s%N)
echo "  durée totale des trois : $(( (fin-debut)/1000000 )) ms"
echo
for id in 1961 365 2390; do
  code=$(cat "$SORTIE/par-$id.code" 2>/dev/null || echo 1)
  if [ "$code" -ne 0 ]; then
    printf '  #%-6s ÉCHEC (code %s)\n' "$id" "$code"
    grep -iE 'error|invalid|failed' "$SORTIE/par-$id.log" | head -2 | sed 's/^/      /'
    continue
  fi
  sp=$(grep -o 'speed=[ ]*[0-9.]*x' "$SORTIE/par-$id.log" | tail -1 | grep -o '[0-9.]*')
  seul=$(grep -o 'speed=[ ]*[0-9.]*x' "$SORTIE/tm-$id.log" 2>/dev/null | tail -1 | grep -o '[0-9.]*')
  [ -z "${sp:-}" ] && { printf '  #%-6s pas de mesure exploitable\n' "$id"; continue; }
  awk -v id="$id" -v sp="$sp" -v seul="${seul:-0}" 'BEGIN {
    if (seul > 0) printf "  #%-6s en parallèle x%-6s   seul x%-6s   perte %.0f %%\n", id, sp, seul, 100*(1-sp/seul);
    else          printf "  #%-6s en parallèle x%-6s   (pas de référence seule)\n", id, sp;
  }'
done

titre "4. CONTRÔLE VISUEL DU TONE MAPPING"
echo "  même instant, avec et sans. À comparer à l'œil."
for id in 365 2390; do
  src=$(chemin "$id")
  for tm in avec sans; do
    q=non; [ "$tm" = avec ] && q=oui
    # hwdownload ramène l'image en mémoire centrale : indispensable pour ÉCRIRE
    # un PNG, et sans conséquence puisqu'on ne produit qu'une seule image.
    "${C[@]}" exec -T $SERVICE ffmpeg -hide_banner -loglevel error -nostdin -y \
      -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi \
      -ss 600 -i "$src" -frames:v 1 \
      -vf "$(filtres "$id" "$q"),hwdownload,format=nv12" \
      "/app/data/palier2/image-$id-$tm.png" > "$SORTIE/png-$id-$tm.log" 2>&1
    code=$?
    taille=$(stat -c%s "$SORTIE/image-$id-$tm.png" 2>/dev/null || echo 0)
    if [ "$code" -ne 0 ] || [ "$taille" -lt 1000 ]; then
      printf '  image-%s-%-5s ÉCHEC (code %s, %s octets)\n' "$id" "$tm" "$code" "$taille"
      head -3 "$SORTIE/png-$id-$tm.log" | sed 's/^/      /'
    else
      awk -v id="$id" -v tm="$tm" -v t="$taille" 'BEGIN { printf "  image-%s-%-5s %6.0f Ko\n", id, tm, t/1024 }'
    fi
  done
done

titre "5. AUCUN PROCESSUS ORPHELIN"
"${C[@]}" exec -T $SERVICE sh -c 'ps -eo comm | grep -c ffmpeg' 2>/dev/null | sed 's/^/  ffmpeg dans le conteneur : /'
curl -s -m 5 http://127.0.0.1:3001/api/transcode/sessions | sed 's/^/  /'

echo
sep
echo "Images dans $SORTIE — journaux ffmpeg complets dans $SORTIE/*.log"
sep
