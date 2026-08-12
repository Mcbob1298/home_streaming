/**
 * Profil Dolby Vision d'un fichier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE PROFIL DÉCIDE SI LE FICHIER EST TRAITABLE.
 *
 * Un profil 7 ou 8 porte une COUCHE DE BASE rétro-compatible — du HDR10 pour
 * la compatibilité 1, du SDR pour la 2. Le tone mapping s'applique dessus
 * comme sur n'importe quel HDR10, et le résultat est correct.
 *
 * Un profil 5 n'a AUCUNE couche de repli : son image est encodée dans un
 * espace propriétaire (IPTPQc2) que seul un décodeur Dolby Vision sait
 * interpréter. Le traiter comme du HDR10 produit une image verdâtre et
 * délavée. Mieux vaut le dire que le produire.
 *
 * Relevé sur cette bibliothèque : 93 fichiers en profil 8 compatibilité 1,
 * 1 seul en profil 5.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DolbyVisionInfo {
  /** Profil Dolby Vision, ou 0 quand le fichier n'en déclare aucun. */
  profile: number;
  /** Compatibilité de la couche de base : 1 = HDR10, 2 = SDR, 0 = aucune. */
  blCompat: number;
}

/**
 * Profils dont la couche de base est exploitable.
 *
 * 4 : couche de base SDR — rien à faire, elle est déjà dans le bon espace.
 * 7 : double couche, base HDR10 (disques UHD).
 * 8 : couche unique rétro-compatible, le cas de 93 fichiers sur 94 ici.
 */
const PROFILES_WITH_FALLBACK = new Set([4, 7, 8]);

/** Le fichier peut-il être traité comme du HDR ordinaire ? */
export function hasUsableBaseLayer(info: DolbyVisionInfo | null): boolean {
  // Pas de configuration Dolby Vision : c'est du HDR10 ou du SDR ordinaire.
  if (info === null || info.profile === 0) return true;
  return PROFILES_WITH_FALLBACK.has(info.profile);
}

/** Message destiné à l'utilisateur pour un profil sans repli. */
export function unsupportedProfileReason(info: DolbyVisionInfo): string {
  return (
    `Ce fichier est en Dolby Vision profil ${info.profile}, qui ne porte aucune couche ` +
    'de repli HDR10 ou SDR. Le convertir produirait une image verdâtre et délavée. ' +
    'Sa lecture demandera une prise en charge Dolby Vision dédiée.'
  );
}

/**
 * Extrait la configuration Dolby Vision de la sortie JSON de ffprobe.
 *
 * Pur, pour se tester sans fichier : la sortie de ffprobe est du JSON dont la
 * forme est stable, mais dont le bloc `side_data_list` est optionnel.
 */
export function parseDolbyVision(json: string): DolbyVisionInfo {
  try {
    const parsed = JSON.parse(json) as {
      streams?: {
        side_data_list?: { side_data_type?: string; dv_profile?: number; dv_bl_signal_compatibility_id?: number }[];
      }[];
    };

    const sideData = parsed.streams?.[0]?.side_data_list ?? [];
    const dovi = sideData.find((entry) => entry.side_data_type === 'DOVI configuration record');

    if (dovi === undefined) return { profile: 0, blCompat: 0 };

    return {
      profile: typeof dovi.dv_profile === 'number' ? dovi.dv_profile : 0,
      blCompat: typeof dovi.dv_bl_signal_compatibility_id === 'number' ? dovi.dv_bl_signal_compatibility_id : 0,
    };
  } catch {
    // Une sortie illisible ne doit pas empêcher la lecture : on se comporte
    // comme si le fichier n'était pas Dolby Vision, et le tone mapping HDR10
    // ordinaire s'appliquera.
    return { profile: 0, blCompat: 0 };
  }
}

/**
 * Sonde un fichier. Ne lit que l'en-tête, quelques centaines de millisecondes.
 *
 * Ne lève jamais : un fichier illisible rend « aucune configuration », ce qui
 * le fait traiter comme du HDR ordinaire plutôt que d'interrompre la lecture.
 */
export async function readDolbyVision(ffprobeBinary: string, inputPath: string): Promise<DolbyVisionInfo> {
  try {
    const { stdout } = await execFileAsync(
      ffprobeBinary,
      ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', inputPath],
      { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
    );
    return parseDolbyVision(stdout);
  } catch {
    return { profile: 0, blCompat: 0 };
  }
}
