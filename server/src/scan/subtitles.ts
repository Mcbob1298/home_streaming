/**
 * Rattachement des sous-titres externes au bon fichier vidéo.
 * Pur : on ne travaille que sur les listes produites par le parcours.
 */
import { splitExtension } from '../parser/index.js';
import { pathKey } from '../util/text.js';
import type { WalkedFile } from './walk.js';

export interface SubtitleMatch {
  subtitle: WalkedFile;
  video: WalkedFile;
}

export interface SubtitleMatchResult {
  matches: SubtitleMatch[];
  /** Sous-titres dont on n'a pas su trouver la vidéo : signalés dans le rapport. */
  orphans: WalkedFile[];
}

/**
 * Deux règles, dans cet ordre :
 *
 * 1. Le nom du sous-titre commence par celui de la vidéo :
 *    « film.mkv » + « film.fr.srt ». En cas d'ambiguïté (« film.mkv » et
 *    « film 2.mkv » dans le même dossier), le préfixe le plus long gagne.
 * 2. Sinon, si le dossier ne contient qu'une seule vidéo, le sous-titre lui
 *    revient — c'est le cas courant de « Titre (2019)/sous-titres.srt ».
 *
 * Un sous-titre n'est jamais rattaché à une vidéo d'un autre dossier.
 */
export function matchSubtitles(videos: WalkedFile[], subtitles: WalkedFile[]): SubtitleMatchResult {
  const videosByDirectory = new Map<string, WalkedFile[]>();
  for (const video of videos) {
    const list = videosByDirectory.get(video.directoryKey);
    if (list === undefined) videosByDirectory.set(video.directoryKey, [video]);
    else list.push(video);
  }

  const matches: SubtitleMatch[] = [];
  const orphans: WalkedFile[] = [];

  for (const subtitle of subtitles) {
    const siblings = videosByDirectory.get(subtitle.directoryKey);
    if (siblings === undefined || siblings.length === 0) {
      orphans.push(subtitle);
      continue;
    }

    const subtitleBaseKey = pathKey(splitExtension(subtitle.fileName).base);

    let best: WalkedFile | null = null;
    let bestLength = 0;
    for (const video of siblings) {
      const videoBaseKey = pathKey(splitExtension(video.fileName).base);
      if (subtitleBaseKey.startsWith(videoBaseKey) && videoBaseKey.length > bestLength) {
        best = video;
        bestLength = videoBaseKey.length;
      }
    }

    if (best === null && siblings.length === 1) best = siblings[0] ?? null;

    if (best === null) orphans.push(subtitle);
    else matches.push({ subtitle, video: best });
  }

  return { matches, orphans };
}
