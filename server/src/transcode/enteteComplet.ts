/**
 * UN EN-TÊTE fMP4 EST-IL COMPLET ? — la question dont dépend l'instantané.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LE GARDE-FOU PRÉCÉDENT ATTENDAIT UN SIGNAL INDIRECT, ET IL A CESSÉ DE GARDER.
 *
 * `ensureInit` attendait l'apparition du PREMIER SEGMENT avant de photographier
 * `init.mp4`. Le raisonnement tenait tant que ffmpeg produisait les deux dans
 * l'ordre : un segment présent voulait dire un en-tête déjà écrit.
 *
 * Le prélude a supprimé ce lien. Ses segments sont posés dans le répertoire
 * AVANT que ffmpeg ne démarre : `seg-00000` est là d'emblée, l'attente retourne
 * immédiatement, et la copie part pendant que ffmpeg écrit encore `init.mp4` —
 * qu'il écrit DIRECTEMENT, sans fichier temporaire. Résultat mesuré :
 * `init-stable.mp4` à zéro octet, servi en HTTP 200, sur un fichier dont la
 * lecture ne pouvait donc pas démarrer.
 *
 * On ne remplace pas ce signal par un autre signal indirect — ni une taille
 * minimale, ni un délai. Les deux sont des paris sur le comportement de ffmpeg.
 * On vérifie CE DONT L'INSTANTANÉ DÉPEND : que `ftyp` et `moov` soient là et
 * entiers, d'après la longueur que les boîtes déclarent elles-mêmes.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE FORMAT DES BOÎTES ISO-BMFF, EN TROIS LIGNES.
 *
 * Chaque boîte commence par sa taille sur quatre octets, puis son type sur
 * quatre octets ASCII. Une taille de 1 signifie que la vraie taille suit sur
 * huit octets — les fichiers de plus de 4 Go. Une taille de 0 signifie « jusqu'à
 * la fin du fichier », ce qu'un en-tête en cours d'écriture peut très bien
 * porter : on le traite comme INCOMPLET, faute de pouvoir en juger autrement.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Ce qu'un en-tête fMP4 doit contenir pour être servi. */
const REQUISES = ['ftyp', 'moov'] as const;

export interface EtatEntete {
  complet: boolean;
  /** Les boîtes de tête reconnues, dans l'ordre. Pour dire POURQUOI c'est non. */
  boites: string[];
  /** Renseigné quand une boîte est annoncée plus longue que ce qui est présent. */
  tronquee: string | null;
}

/**
 * Analyse les boîtes de tête d'un tampon.
 *
 * Rend l'état plutôt qu'un booléen : quand un en-tête est refusé, le journal
 * doit pouvoir dire s'il était vide, s'il manquait `moov`, ou si `moov` était
 * annoncé plus long que ce qui avait été écrit.
 */
export function analyserEntete(donnees: Buffer): EtatEntete {
  const boites: string[] = [];
  let tronquee: string | null = null;
  let position = 0;

  while (position + 8 <= donnees.length) {
    const annoncee = donnees.readUInt32BE(position);
    const type = donnees.toString('latin1', position + 4, position + 8);

    // Un type non ASCII imprimable : on n'est plus dans des boîtes.
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;

    let taille = annoncee;
    let entete = 8;

    if (annoncee === 1) {
      // Taille sur 64 bits, juste après le type.
      if (position + 16 > donnees.length) {
        tronquee = type;
        break;
      }
      taille = Number(donnees.readBigUInt64BE(position + 8));
      entete = 16;
    } else if (annoncee === 0) {
      /*
       * « Jusqu'à la fin du fichier ». Un en-tête en cours d'écriture peut
       * porter cela, et rien ne permet alors de dire s'il est fini. On le
       * déclare incomplet : refuser un en-tête valable coûte une attente,
       * l'accepter tronqué coûte une lecture qui ne démarre pas.
       */
      tronquee = type;
      break;
    }

    if (taille < entete) break;

    if (position + taille > donnees.length) {
      tronquee = type;
      break;
    }

    boites.push(type);
    position += taille;
  }

  const complet = REQUISES.every((requise) => boites.includes(requise));
  return { complet, boites, tronquee };
}

/** Version courte, pour les appelants qui n'ont pas besoin du détail. */
export function enteteComplet(donnees: Buffer): boolean {
  return analyserEntete(donnees).complet;
}

/** Ce qui manque, en une phrase servable dans une réponse HTTP. */
export function pourquoiIncomplet(etat: EtatEntete): string {
  if (etat.boites.length === 0) {
    return 'l’en-tête est vide ou illisible : ffmpeg ne l’a pas encore écrit.';
  }
  if (etat.tronquee !== null) {
    return `la boîte « ${etat.tronquee} » est annoncée plus longue que ce qui est écrit : en-tête en cours d’écriture.`;
  }
  const manquantes = REQUISES.filter((r) => !etat.boites.includes(r));
  return `l’en-tête ne porte pas ${manquantes.map((m) => `« ${m} »`).join(' ni ')} (présentes : ${etat.boites.join(', ')}).`;
}
