/**
 * Manifeste maître HLS : pistes audio et sous-titres comme rendus alternatifs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN MANIFESTE MAÎTRE, ET PAS PLUSIEURS VARIANTES.
 *
 * Exposer chaque piste audio comme une VARIANTE (`EXT-X-STREAM-INF`) obligerait
 * à réencoder la vidéo autant de fois qu'il y a de langues, et changer de piste
 * reviendrait à changer de variante — donc à recharger la source et à repartir
 * du début. Avec des RENDUS (`EXT-X-MEDIA` porteur d'un `URI`), la vidéo est
 * produite une seule fois et le lecteur ne remplace que le flux audio : la
 * lecture continue, la position est conservée.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Module PUR : le manifeste se relit ligne à ligne dans un test, sans lancer
 * ffmpeg ni ouvrir de fichier.
 */
import { languageTag, type LabelledAudioTrack, type LabelledSubtitleTrack } from '../playback/tracks.js';

export const AUDIO_GROUP = 'audio';
export const SUBTITLE_GROUP = 'subs';

export interface MasterUrls {
  /** Playlist de la piste vidéo — audio compris quand elle n'est pas séparée. */
  video: string;
  audio: (streamIndex: number) => string;
  subtitle: (streamIndex: number) => string;
}

export interface MasterOptions {
  /**
   * Pistes audio exposées comme rendus séparés.
   *
   * Vide quand le fichier n'a qu'une piste : elle reste alors muxée dans la
   * vidéo, ce qui évite un second processus ffmpeg lisant le même fichier.
   */
  audio: LabelledAudioTrack[];
  /** Index de flux de la piste audio par défaut. */
  defaultAudio: number | null;
  subtitles: LabelledSubtitleTrack[];
  /** Débit annoncé, en bits par seconde. Obligatoire sur EXT-X-STREAM-INF. */
  bandwidth: number;
  width: number | null;
  height: number | null;
}

/**
 * Échappe une valeur de chaîne d'attribut.
 *
 * Les libellés viennent de métadonnées de fichiers : « Na'vi parts only » passe
 * sans dommage, mais un guillemet droit couperait l'attribut en deux et rendrait
 * la ligne illisible pour le lecteur. Les sauts de ligne aussi.
 */
function quote(value: string): string {
  return `"${value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'")}"`;
}

function attributes(pairs: (readonly [string, string | null])[]): string {
  return pairs
    .filter((pair): pair is readonly [string, string] => pair[1] !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

/**
 * Manifeste maître.
 *
 * L'ordre des lignes suit la RFC 8216 : les rendus d'abord, la variante
 * ensuite. Un lecteur qui lit `EXT-X-STREAM-INF` avant les `EXT-X-MEDIA`
 * auxquels il fait référence ne saurait pas à quoi rattacher les groupes.
 */
export function buildMasterPlaylist(urls: MasterUrls, options: MasterOptions): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];

  for (const track of options.audio) {
    const isDefault = track.streamIndex === options.defaultAudio;
    lines.push(
      `#EXT-X-MEDIA:${attributes([
        ['TYPE', 'AUDIO'],
        ['GROUP-ID', quote(AUDIO_GROUP)],
        ['NAME', quote(track.label)],
        ['LANGUAGE', quote(languageTag(track.language))],
        ['DEFAULT', isDefault ? 'YES' : 'NO'],
        // La RFC impose AUTOSELECT=YES dès lors que DEFAULT=YES.
        ['AUTOSELECT', isDefault ? 'YES' : 'NO'],
        ['CHANNELS', track.channels === null ? null : quote(String(track.channels))],
        ['URI', quote(urls.audio(track.streamIndex))],
      ])}`,
    );
  }

  for (const track of options.subtitles) {
    /*
     * FORCED=YES dit au lecteur que la piste porte les passages indispensables
     * à la compréhension — ce qu'est exactement un sous-titre forcé. Mais
     * AUTOSELECT reste NON : la consigne est qu'un forcé ne soit jamais un
     * choix par défaut, et c'est AUTOSELECT qui déclenche la sélection
     * automatique quand la langue audio ne correspond pas.
     */
    const forced = track.kind === 'forced';
    lines.push(
      `#EXT-X-MEDIA:${attributes([
        ['TYPE', 'SUBTITLES'],
        ['GROUP-ID', quote(SUBTITLE_GROUP)],
        ['NAME', quote(track.label)],
        ['LANGUAGE', quote(languageTag(track.language))],
        ['DEFAULT', 'NO'],
        ['AUTOSELECT', forced ? 'NO' : 'YES'],
        ['FORCED', forced ? 'YES' : 'NO'],
        ['CHARACTERISTICS', track.kind === 'sdh' ? quote('public.accessibility.describes-music-and-sound') : null],
        ['URI', quote(urls.subtitle(track.streamIndex))],
      ])}`,
    );
  }

  /*
   * CODECS est délibérément ABSENT.
   *
   * L'attribut est facultatif, et l'annoncer faux est bien pire que de se
   * taire : un lecteur qui lit « avc1.640028 » sur un flux réellement encodé en
   * Main refuse d'ouvrir la source. Le profil dépend ici de la décision de
   * lecture — copie de flux ou réencodage — et de la source. hls.js déduit de
   * toute façon les codecs du segment d'initialisation.
   */
  const resolution =
    options.width !== null && options.height !== null ? `${options.width}x${options.height}` : null;

  lines.push(
    `#EXT-X-STREAM-INF:${attributes([
      ['BANDWIDTH', String(Math.max(1, Math.round(options.bandwidth)))],
      ['RESOLUTION', resolution],
      ['AUDIO', options.audio.length > 0 ? quote(AUDIO_GROUP) : null],
      ['SUBTITLES', options.subtitles.length > 0 ? quote(SUBTITLE_GROUP) : null],
    ])}`,
  );
  lines.push(urls.video);

  return `${lines.join('\n')}\n`;
}

/**
 * Faut-il un manifeste maître ?
 *
 * Un fichier à une seule piste audio et sans sous-titre exposable n'a rien à
 * déclarer : on lui sert directement sa playlist de média, comme au palier 1.
 * Une couche de plus ne lui apporterait qu'un aller-retour HTTP.
 */
export function needsMaster(audioCount: number, subtitleCount: number): boolean {
  return audioCount > 1 || subtitleCount > 0;
}

/**
 * L'audio doit-il être produit à part de la vidéo ?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEULEMENT À PARTIR DE DEUX PISTES.
 *
 * Séparer coûte un second processus ffmpeg qui relit le MÊME fichier : sur un
 * partage SMB, c'est deux fois la lecture disque d'un film de 30 Go. Ce prix
 * n'est justifié que par ce qu'il achète — pouvoir changer de langue sans
 * relancer la vidéo. Sur un fichier monopiste, il n'achète rien.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function needsSeparateAudio(audioCount: number): boolean {
  return audioCount > 1;
}

/**
 * Débit annoncé sur la variante.
 *
 * Une estimation suffit : l'attribut est obligatoire mais ne sert au lecteur
 * qu'à choisir entre plusieurs variantes, et il n'y en a qu'une. On additionne
 * donc le débit vidéo visé et celui de l'audio.
 */
export function estimateBandwidth(videoBitrate: number, audioBitrate: number): number {
  return Math.max(1, Math.round(videoBitrate + audioBitrate));
}
