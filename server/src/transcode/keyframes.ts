/**
 * Positions des images clés d'un fichier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI IL FAUT LES CONNAÎTRE
 *
 * En remux la vidéo est COPIÉE : ffmpeg ne peut couper qu'aux images clés
 * existantes. Un découpage « toutes les 4 secondes » est donc une intention, pas
 * un résultat — mesuré sur la bibliothèque, les écarts entre images clés vont de
 * 1 à 12 secondes, y compris à l'intérieur d'un même fichier.
 *
 * Publier un manifeste qui annonce des segments de 4 secondes reviendrait à
 * mentir : le lecteur demanderait un segment 14 que ffmpeg ne produira jamais,
 * ou en obtiendrait un dont le contenu est ailleurs dans le film.
 *
 * On énumère donc les images clés, et le manifeste décrit la découpe RÉELLE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Le coût aurait pu être rédhibitoire : en passant par les images décodées,
 * ffprobe met 193 s sur un film de 1 h 56. En lisant les PAQUETS — donc l'index
 * du conteneur, sans rien décoder — il met 2,3 s. Quatre-vingts fois moins.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Extrait les horodatages des paquets marqués « image clé ».
 *
 * Format attendu, une ligne par paquet : `pts_time,flags`. Le drapeau `K`
 * marque une image clé, `_` un paquet ordinaire, et les rejets éventuels
 * ajoutent un `D`.
 *
 *     12.345000,K__
 */
export function parseKeyframeTimes(output: string): number[] {
  const times: number[] = [];

  for (const line of output.split(/\r?\n/)) {
    const comma = line.indexOf(',');
    if (comma === -1) continue;

    const flags = line.slice(comma + 1);
    if (!flags.includes('K')) continue;

    const time = Number(line.slice(0, comma));
    // « N/A » sur un paquet sans horodatage : inexploitable, on l'ignore.
    if (!Number.isFinite(time) || time < 0) continue;
    times.push(time);
  }

  // L'ordre des paquets suit le décodage, pas toujours la présentation.
  times.sort((a, b) => a - b);

  // Une découpe commence forcément au début du fichier, même si le premier
  // paquet est horodaté un peu après zéro.
  if (times.length > 0 && (times[0] as number) > 0) times[0] = 0;

  return times;
}

/** Énumère les images clés d'un fichier. Lit l'index du conteneur, sans décoder. */
export async function readKeyframes(ffprobeBinary: string, inputPath: string): Promise<number[]> {
  const { stdout } = await execFileAsync(
    ffprobeBinary,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,flags',
      '-of',
      'csv=p=0',
      inputPath,
    ],
    // Un film de trois heures produit quelques mégaoctets de lignes.
    { maxBuffer: 256 * 1024 * 1024 },
  );

  return parseKeyframeTimes(stdout);
}

/** Binaire ffprobe, déduit de celui de ffmpeg quand il n'est pas dans le PATH. */
export function ffprobeFor(ffmpegBinary: string): string {
  if (process.env.FFPROBE_PATH !== undefined && process.env.FFPROBE_PATH !== '') return process.env.FFPROBE_PATH;
  // Les deux binaires sont livrés côte à côte : « …/bin/ffmpeg.exe » donne
  // « …/bin/ffprobe.exe », et « ffmpeg » donne « ffprobe ».
  return ffmpegBinary.replace(/ffmpeg(\.exe)?$/i, (match) => (match.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
}
