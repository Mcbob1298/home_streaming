# Scripts de mesure

Ces scripts s'exécutent **sur le NAS**, dans `/volume1/docker/home_streaming`. Ils
mesurent le transcodage réel : ils n'ont aucun équivalent en test unitaire, parce que ce
qu'ils vérifient — ce que le matériel fait vraiment — ne se simule pas.

## Le relais `docker`

La règle sudoers du NAS autorise `sudo -n docker`, et **rien d'autre** : lancer
`sudo ./bascule.sh` demande un mot de passe. Le relais contourne cela sans élargir la
règle, en n'élevant que les appels à `docker` :

```sh
mkdir -p .sync/bin
cp scripts/docker-sudo .sync/bin/docker
chmod +x .sync/bin/docker
export PATH="$PWD/.sync/bin:$PATH"
./bascule.sh
```

## Le piège qui a invalidé deux séries de mesures

Les scripts appelaient `ffmpeg` nu. Dans le conteneur, c'est le **ffmpeg 5.1 de Debian**,
gardé comme repli — pas le `jellyfin-ffmpeg7` que le serveur utilise, et qui seul embarque
le pilote Vulkan.

Résultat : `VK_ERROR_INCOMPATIBLE_DRIVER` partout, 0/30 fichiers HDR, quatre images de
contrôle en échec. Le diagnostic pointait libplacebo alors que la vraie cause était le
binaire.

Les scripts relèvent désormais `FFMPEG_PATH` dans le conteneur avant de mesurer :

```sh
FF=$("${C[@]}" exec -T $SERVICE printenv FFMPEG_PATH | tr -d "\r\n")
```

**Toute nouvelle mesure doit en faire autant.** Mesurer un binaire qui n'est pas celui de
la production ne dit rien de la production.

## Les scripts

| script | ce qu'il répond |
|---|---|
| `bascule.sh` | La bascule ffmpeg 7 tient-elle ? Taille d'image, binaires, moteurs par essai réel, facteurs, quatre images de contrôle, couverture des 164 fichiers HDR. |
| `bissection.sh` | D'où vient une régression, et combien de sessions tiennent en parallèle. Ajoute une option à la fois à partir de la commande de référence. |
| `mesurer.sh` | Facteurs et CPU sur les fichiers de référence. |
| `palier2.sh` | Première campagne de transcodage matériel. Conservé pour l'historique des mesures. |
