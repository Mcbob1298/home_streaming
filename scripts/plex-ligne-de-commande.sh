#!/bin/bash
# =============================================================================
# CE QUE PLEX FAIT VRAIMENT DE CE FICHIER — sa ligne de commande, relevée vivante.
#
#   cd /volume1/docker/home_streaming && ./scripts/plex-ligne-de-commande.sh [secondes]
#
# ─────────────────────────────────────────────────────────────────────────────
# POURQUOI GUETTER LE PROCESSUS PLUTÔT QUE LIRE LES JOURNAUX.
#
# Le journal de Plex tourne, et celui de cette machine ne portait plus aucune
# trace de transcodage — 2 Ko, aucune ligne « Transcoder ». Un choix d'encodage
# qu'on ne peut pas relire n'est pas une référence de comparaison, c'est un
# souvenir.
#
# `/proc/<pid>/cmdline` ne ment pas et n'a pas de rotation : il porte les
# arguments RÉELS du transcodeur, y compris ceux que Plex ne journalise jamais.
# C'est la même méthode qui a démasqué le mauvais binaire ffmpeg — voir l'erreur
# 5 du README des mesures navigateur.
# ─────────────────────────────────────────────────────────────────────────────
#
# À lancer AVANT de démarrer la lecture dans Plex. Le script guette, attrape la
# première commande de transcodage qui apparaît, et s'arrête.
# =============================================================================
set -u

SECONDES=${1:-120}
SORTIE=data/mesure/plex-cmdline.txt
mkdir -p data/mesure

echo "Guet du transcodeur Plex pendant ${SECONDES} s."
echo "→ Démarrer MAINTENANT la lecture d'Avatar dans Plex, sur le même navigateur."
echo

fin=$(( $(date +%s) + SECONDES ))
while [ "$(date +%s)" -lt "$fin" ]; do
  # Le transcodeur de Plex s'appelle « Plex Transcoder », pas « ffmpeg ».
  pid=$(sudo -n docker exec plex sh -c 'ps -eo pid,comm | grep -i "Plex Transcoder" | head -1 | awk "{print \$1}"' 2>/dev/null | tr -d '\r')

  if [ -n "${pid:-}" ]; then
    echo "── transcodeur Plex trouvé : PID $pid"
    echo

    # Les arguments sont séparés par des octets nuls : tr les rend lisibles.
    sudo -n docker exec plex sh -c "tr '\0' '\n' < /proc/$pid/cmdline" > "$SORTIE" 2>/dev/null

    echo "COMMANDE COMPLÈTE"
    echo "─────────────────────────────────────────────────────────────────────"
    cat "$SORTIE"
    echo
    echo "CE QUI DÉCIDE DE L'IMAGE"
    echo "─────────────────────────────────────────────────────────────────────"
    grep -E "^-(vf|filter_complex|c:v|codec:v|profile:v|b:v|maxrate|bufsize|pix_fmt|hls_time|segment_time|force_key_frames)$" -A 1 "$SORTIE" \
      | paste - - -d ' ' | grep -v '^--$'
    echo
    echo "TONE MAPPING PRÉSENT ?"
    if grep -qiE "tonemap|libplacebo" "$SORTIE"; then
      echo "  OUI — Plex convertit. Notre transport intact n'est PAS sa méthode."
      grep -iE "tonemap|libplacebo" "$SORTIE"
    else
      echo "  NON — aucun filtre de tone mapping dans la commande."
    fi
    echo
    echo "Relevé écrit dans $SORTIE"
    exit 0
  fi
  sleep 2
done

echo "Aucun transcodage Plex vu en ${SECONDES} s."
echo "Si la lecture a bien démarré, c'est que Plex sert le fichier EN DIRECT"
echo "(pas de transcodeur = pas de réencodage), ce qui est en soi le résultat :"
echo "la comparaison porterait alors sur un flux source non modifié."
exit 1
