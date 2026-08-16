/**
 * Libellés et choix de pistes : ce que l'utilisateur lit dans le menu.
 *
 * Module PUR. Toutes les données viennent des tables `audio_track` et
 * `embedded_subtitle`, déjà remplies par la passe ffprobe : rien n'est re-sondé.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE TITRE D'UNE PISTE N'EST PRESQUE JAMAIS UN LIBELLÉ.
 *
 * Relevé sur les 5 298 pistes audio de la bibliothèque : 1 677 n'ont aucun
 * titre, et parmi celles qui en ont un, les plus fréquents sont « French »,
 * « JAP-AC3 », « ENG VO : AC3 5.1 », « French - AAC LC 2.0 @ 128 kb/s ». Ce
 * sont des notes d'encodage, pas des libellés. Le fichier #365 pousse le vice
 * jusqu'à « | Дублированный |* » et « VFF DTS @768 kb/s (5.1) ».
 *
 * Le libellé est donc CONSTRUIT — langue, mention, canaux — et le titre n'est
 * repris que s'il reste quelque chose d'informatif une fois retirés le codec,
 * le débit, les canaux, la langue et les mentions. « Commentaire du
 * réalisateur » passe ; « French EAC3 » ne passe pas.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Ce que la base nous donne
// ---------------------------------------------------------------------------

export interface AudioTrackRow {
  /** Index ABSOLU du flux dans le fichier, tel que ffprobe le rend. */
  streamIndex: number;
  codec: string | null;
  channels: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
}

export interface SubtitleTrackRow {
  streamIndex: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  isForced: boolean;
  isDefault: boolean;
  isImageBased: boolean;
}

export interface LabelledAudioTrack {
  streamIndex: number;
  label: string;
  /** Code ISO tel qu'en base, pour l'attribut LANGUAGE du manifeste. */
  language: string | null;
  channels: number | null;
  codec: string | null;
  isDefault: boolean;
}

/** Trois natures de sous-titres, qui ne se choisissent pas de la même façon. */
export type SubtitleKind = 'forced' | 'sdh' | 'full';

export interface LabelledSubtitleTrack {
  streamIndex: number;
  label: string;
  language: string | null;
  kind: SubtitleKind;
  codec: string | null;
}

// ---------------------------------------------------------------------------
// Langues
// ---------------------------------------------------------------------------

/**
 * Noms de langues EN FRANÇAIS.
 *
 * L'interface est en français : « Anglais » et « Japonais », pas « English » ni
 * « 日本語 ». Une langue inconnue garde son code brut plutôt que de devenir
 * « inconnue » — mieux vaut « nor » que rien.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  fre: 'Français',
  fra: 'Français',
  fr: 'Français',
  eng: 'Anglais',
  en: 'Anglais',
  jpn: 'Japonais',
  ja: 'Japonais',
  spa: 'Espagnol',
  es: 'Espagnol',
  ger: 'Allemand',
  deu: 'Allemand',
  de: 'Allemand',
  ita: 'Italien',
  it: 'Italien',
  por: 'Portugais',
  pt: 'Portugais',
  nld: 'Néerlandais',
  dut: 'Néerlandais',
  nl: 'Néerlandais',
  rus: 'Russe',
  ru: 'Russe',
  ukr: 'Ukrainien',
  chi: 'Chinois',
  zho: 'Chinois',
  zh: 'Chinois',
  kor: 'Coréen',
  ko: 'Coréen',
  ara: 'Arabe',
  ar: 'Arabe',
  pol: 'Polonais',
  swe: 'Suédois',
  dan: 'Danois',
  nor: 'Norvégien',
  fin: 'Finnois',
  tur: 'Turc',
  heb: 'Hébreu',
  hin: 'Hindi',
  tha: 'Thaï',
  vie: 'Vietnamien',
  ces: 'Tchèque',
  cze: 'Tchèque',
  hun: 'Hongrois',
  ron: 'Roumain',
  rum: 'Roumain',
  ell: 'Grec',
  gre: 'Grec',
  und: 'Non renseignée',
};

/** Codes considérés comme du français, pour le choix de la piste par défaut. */
const FRENCH_CODES = new Set(['fre', 'fra', 'fr', 'fr-fr', 'fr-ca']);

export function isFrench(language: string | null): boolean {
  return language !== null && FRENCH_CODES.has(language.trim().toLowerCase());
}

export function languageLabel(language: string | null): string {
  if (language === null || language.trim() === '') return 'Non renseignée';
  const code = language.trim().toLowerCase();
  return LANGUAGE_NAMES[code] ?? language.trim();
}

/**
 * Code à deux lettres pour l'attribut LANGUAGE du manifeste.
 *
 * La RFC 8216 veut une étiquette RFC 5646 : « fr », pas « fre ». Un code
 * inconnu est rendu tel quel — un lecteur qui ne le comprend pas l'ignore, ce
 * qui vaut mieux que de perdre l'information.
 */
const ISO_639_1: Record<string, string> = {
  fre: 'fr',
  fra: 'fr',
  eng: 'en',
  jpn: 'ja',
  spa: 'es',
  ger: 'de',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  nld: 'nl',
  dut: 'nl',
  rus: 'ru',
  ukr: 'uk',
  chi: 'zh',
  zho: 'zh',
  kor: 'ko',
  ara: 'ar',
  pol: 'pl',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  tur: 'tr',
  heb: 'he',
  hin: 'hi',
  tha: 'th',
  vie: 'vi',
  ces: 'cs',
  cze: 'cs',
  hun: 'hu',
  ron: 'ro',
  rum: 'ro',
  ell: 'el',
  gre: 'el',
};

export function languageTag(language: string | null): string {
  if (language === null || language.trim() === '') return 'und';
  const code = language.trim().toLowerCase();
  return ISO_639_1[code] ?? code;
}

// ---------------------------------------------------------------------------
// Canaux
// ---------------------------------------------------------------------------

/**
 * Disposition des canaux, telle qu'on l'écrit dans un menu.
 *
 * Stéréo et mono ne sont PAS annoncés : ils sont le cas ordinaire, et l'écrire
 * partout alourdirait chaque ligne. Ils reviennent uniquement quand il faut
 * départager deux pistes de la même langue.
 */
export function channelLabel(channels: number | null): string | null {
  if (channels === null || channels <= 0) return null;
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stéréo';
  if (channels === 3) return '2.1';
  if (channels === 5) return '5.0';
  if (channels === 6) return '5.1';
  if (channels === 7) return '6.1';
  if (channels >= 8) return '7.1';
  return null;
}

/** Ce qui mérite d'apparaître spontanément : le multicanal, rien d'autre. */
function prominentChannelLabel(channels: number | null): string | null {
  return channels !== null && channels > 2 ? channelLabel(channels) : null;
}

// ---------------------------------------------------------------------------
// Nettoyage des titres
// ---------------------------------------------------------------------------

/**
 * Mentions qu'on sait reconnaître dans un titre, et ce qu'on en fait.
 *
 * L'ordre est celui de la recherche : « VFQ » avant « VF », sinon « VFQ » serait
 * reconnu comme du « VF » suivi d'un « Q » orphelin.
 */
const AUDIO_MARKERS: { pattern: RegExp; label: string; family: string }[] = [
  // L'audiodescription est une piste d'accessibilité : elle ne doit jamais
  // être proposée par défaut, et il faut donc pouvoir la reconnaître.
  { pattern: /\b(?:audio[- ]?description|AD)\b/i, label: 'Audiodescription', family: 'ad' },
  /*
   * Les quatre versions françaises forment une FAMILLE : « VFQ » contient
   * « VF », et sans regroupement le titre « FR VFQ : AC3 5.1 » produirait les
   * deux mentions à la fois. La première trouvée gagne, et l'ordre va donc du
   * plus précis au plus général.
   */
  { pattern: /\bVFF\b/i, label: 'VFF', family: 'vf' },
  { pattern: /\bVFQ\b/i, label: 'VFQ', family: 'vf' },
  { pattern: /\bVFI\b/i, label: 'VFI', family: 'vf' },
  { pattern: /\bVFB?\b/i, label: 'VF', family: 'vf' },
  { pattern: /\b(?:VO|VOST|original)\b/i, label: 'VO', family: 'vo' },
  { pattern: /\bcommentaires?\b|\bcommentary\b/i, label: 'Commentaires', family: 'commentary' },
];

/** Jetons purement techniques : ils ne disent rien à qui regarde un film. */
const TECHNICAL_TOKENS = [
  /\b(?:aac|ac-?3|e-?ac-?3|eac3|dts(?:[- ]?hd)?(?:[- ]?ma)?|truehd|flac|mp3|opus|vorbis|pcm|lpcm|atmos|dd\+?|ddp?)\b/gi,
  /\b(?:srt|subrip|ass|ssa|webvtt|vtt|pgs|sup|vobsub|mov_text|sub)\b/gi,
  /\b(?:lc|he|hev1|main|stereo|surround|mono|multi)\b/gi,
  /@?\s*\d+\s*(?:kb\/s|kbps|kbit\/s|k)\b/gi,
  /\b\d\.\d\b/g,
  /\b(?:\d+\s*bits?|\d+\s*ch(?:annels?)?|\d+\s*hz|\d+\s*khz)\b/gi,
];

/** Noms et codes de langue : redondants avec le libellé qu'on construit. */
const LANGUAGE_WORDS =
  /\b(?:fran[çc]ais(?:e)?|french|anglais(?:e)?|english|japonais(?:e)?|japanese|jap|espagnol(?:e)?|spanish|allemand(?:e)?|german|italien(?:ne)?|italian|russe|russian|ukrainien(?:ne)?|ukrainian|cor[ée]en(?:ne)?|korean|chinois(?:e)?|chinese|portugais(?:e)?|portuguese|n[ée]erlandais(?:e)?|dutch|arabe|arabic|fre|fra|eng|jpn|spa|ger|deu|ita|rus|ukr|kor|chi|zho|por|nld|dut|ara|und|fr|en|ja|es|de|it|ru|uk|ko|zh|pt|nl|ar)\b/gi;

/** Mentions de nature de sous-titre : traitées à part, pas dans le texte libre. */
const SUBTITLE_KIND_WORDS = /\b(?:forced|forc[ée]s?|full|complet(?:e|s)?|sdh|hi|cc|malentendants?)\b/gi;

/** Mots de liaison qui ne portent aucune information une fois seuls. */
const FILLER_WORDS = /\b(?:subs?|subtitles?|sous[- ]?titres?|piste|track|audio|version|france|vost(?:fr)?)\b/gi;

/**
 * Le titre est-il écrit dans un alphabet que l'interface sait présenter ?
 *
 * « | Дублированный |* » veut dire « doublé », mais personne ici ne le lit. Un
 * titre majoritairement non latin est écarté : la langue et les mentions
 * suffisent à construire un libellé compréhensible.
 */
function isLatinScript(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters === '') return false;
  const latin = letters.replace(/[^\p{Script=Latin}]/gu, '');
  return latin.length >= letters.length * 0.6;
}

/** Retire les décorations des titres de « release » : « | Original |* ». */
function stripDecorations(raw: string): string {
  return raw
    .replace(/[|*_~]+/g, ' ')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s\-:,.()[\]]+|[\s\-:,.()[\]]+$/g, '')
    .trim();
}

/** Longueur au-delà de laquelle un libellé déborde du menu. */
const MAX_TITLE_LENGTH = 42;

/**
 * Texte libre réellement informatif contenu dans un titre, ou null.
 *
 * On retire tout ce qu'on sait déjà dire autrement — langue, codec, débit,
 * canaux, mentions — et on regarde ce qui reste. S'il ne reste rien, le titre
 * n'apportait rien ; s'il reste quelque chose, c'est le titre NETTOYÉ qu'on
 * rend, pas le résidu : « Na'vi parts only » vaut mieux que « Na'vi parts ».
 */
export function informativeTitle(raw: string | null): string | null {
  if (raw === null) return null;

  const clean = stripDecorations(raw);
  if (clean === '' || !isLatinScript(clean)) return null;

  let residue = clean;
  for (const marker of AUDIO_MARKERS) residue = residue.replace(marker.pattern, ' ');
  for (const token of TECHNICAL_TOKENS) residue = residue.replace(token, ' ');
  residue = residue.replace(LANGUAGE_WORDS, ' ');
  residue = residue.replace(SUBTITLE_KIND_WORDS, ' ');
  residue = residue.replace(FILLER_WORDS, ' ');
  residue = residue.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // Deux lettres ne font pas un mot : « Na'vi » compte, « FR » non.
  if (residue.replace(/[^\p{L}]/gu, '').length < 3) return null;

  return clean.length > MAX_TITLE_LENGTH ? `${clean.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : clean;
}

/** Mentions reconnues dans un titre, une seule par famille. */
export function titleMarkers(raw: string | null): string[] {
  if (raw === null) return [];
  const clean = stripDecorations(raw);
  if (clean === '') return [];

  const seen = new Set<string>();
  const found: string[] = [];
  for (const marker of AUDIO_MARKERS) {
    if (seen.has(marker.family) || !marker.pattern.test(clean)) continue;
    seen.add(marker.family);
    found.push(marker.label);
  }
  return found;
}

/** L'audiodescription ne doit jamais être choisie automatiquement. */
export function isAudioDescription(track: AudioTrackRow): boolean {
  return titleMarkers(track.title).includes('Audiodescription');
}

// ---------------------------------------------------------------------------
// Libellés audio
// ---------------------------------------------------------------------------

/**
 * Ce qui identifie une piste avant toute considération technique : sa langue,
 * sa mention, et le texte libre de son titre s'il en reste.
 */
function audioCore(track: AudioTrackRow): string {
  const parts = [languageLabel(track.language)];

  const markers = titleMarkers(track.title);
  // Une seule mention : « Français VFF Commentaires » n'aide personne.
  const marker = markers[0];
  if (marker !== undefined && marker !== 'VF') parts.push(marker === 'VO' ? '(VO)' : marker);

  const free = informativeTitle(track.title);
  if (free !== null) parts.push(`— ${free}`);

  return parts.join(' ');
}

/**
 * Libellés de toutes les pistes audio, garantis DISTINCTS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEUX PISTES DE LA MÊME LANGUE ANNONCENT TOUJOURS LEURS CANAUX.
 *
 * « Français 5.1 » et « Français » se distinguent bien assez pour un programme,
 * mais pas pour quelqu'un qui choisit : la seconde ligne ne dit pas ce qu'elle
 * est. Dès que deux pistes partagent la même identité, les deux annoncent leur
 * disposition — « Français 5.1 » et « Français Stéréo ». Une piste seule dans
 * sa langue, elle, reste courte : la stéréo est le cas ordinaire.
 *
 * Le fichier #365 va plus loin : trois pistes russes 5.1, dont deux en DTS. On
 * enrichit alors par étapes, et seulement les groupes encore ambigus.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function labelAudioTracks(tracks: AudioTrackRow[]): LabelledAudioTrack[] {
  const cores = tracks.map(audioCore);
  const shared = new Map<string, number>();
  for (const core of cores) shared.set(core, (shared.get(core) ?? 0) + 1);

  const labelled = tracks.map((track, position) => {
    const core = cores[position] as string;
    // Partagée : la disposition complète. Seule : uniquement le multicanal.
    const channels =
      (shared.get(core) ?? 0) > 1 ? channelLabel(track.channels) : prominentChannelLabel(track.channels);

    return {
      streamIndex: track.streamIndex,
      label: channels === null ? core : `${core} ${channels}`,
      language: track.language,
      channels: track.channels,
      codec: track.codec,
      isDefault: track.isDefault,
    };
  });

  // Étape suivante : le codec, en majuscules.
  disambiguate(labelled, (entry) => (entry.codec === null ? null : `(${codecLabel(entry.codec)})`));

  /*
   * Dernier recours : l'index du flux. Il ne dit rien à l'utilisateur, mais
   * deux entrées rigoureusement identiques dans un menu sont pires qu'un
   * numéro — et cet index est STABLE, contrairement à un rang qui changerait
   * avec l'ordre d'affichage.
   */
  disambiguate(labelled, (entry) => STREAM_SUFFIX(entry.streamIndex));

  return labelled;
}

/**
 * Dernier recours de départage : le numéro du flux.
 *
 * Le point médian, et non un tiret : le libellé contient déjà un tiret quand il
 * reprend un titre, et « Russe — Full Coloured — piste 10 » se lit mal.
 */
function STREAM_SUFFIX(streamIndex: number): string {
  return `· piste ${streamIndex}`;
}

/** Ajoute un complément aux seuls libellés encore en double. */
function disambiguate<T extends { label: string }>(entries: T[], suffix: (entry: T) => string | null): void {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);

  for (const entry of entries) {
    if ((counts.get(entry.label) ?? 0) < 2) continue;
    const extra = suffix(entry);
    if (extra !== null) entry.label = `${entry.label} ${extra}`;
  }
}

/** « dts » → « DTS », « eac3 » → « EAC3 », « truehd » → « TrueHD ». */
function codecLabel(codec: string): string {
  const known: Record<string, string> = {
    dts: 'DTS',
    ac3: 'AC3',
    eac3: 'EAC3',
    truehd: 'TrueHD',
    aac: 'AAC',
    flac: 'FLAC',
    mp3: 'MP3',
    opus: 'Opus',
    vorbis: 'Vorbis',
    pcm_s16le: 'PCM',
    pcm_s24le: 'PCM',
  };
  return known[codec.toLowerCase()] ?? codec.toUpperCase();
}

/**
 * Piste audio par défaut.
 *
 * Trois règles, dans cet ordre : le français d'abord, puis la piste que le
 * fichier désigne, puis la première. L'audiodescription est exclue des deux
 * premières — c'est une piste d'accessibilité, la proposer d'office à qui ne
 * l'a pas demandée rendrait le film incompréhensible.
 */
/**
 * Langues audio EXPOSÉES au lecteur.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TOUT CE QUI EST EXPOSÉ COÛTE, MÊME SI PERSONNE NE L'ÉCOUTE.
 *
 * Une piste déclarée dans le manifeste est une piste que le magasin statique
 * doit pré-générer et que le disque doit porter. Sur Avatar, six pistes — dont
 * trois russes et une ukrainienne — pesaient 1,47 Go pour deux langues
 * réellement utilisées.
 *
 * La règle est donc : français, anglais, et RIEN d'autre — sauf la piste par
 * défaut du fichier, gardée même si elle est d'une autre langue, pour ne jamais
 * produire un film qu'on ne pourrait pas écouter.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Conséquence à connaître : une piste japonaise n'est plus proposée à moins
 * d'être la piste par défaut. Sur cette bibliothèque, 471 pistes `jpn` sont
 * concernées. Élargir revient à ajouter un code ici.
 */
export const LANGUES_EXPOSEES = new Set(['fr', 'en']);

/**
 * Restreint les pistes audio aux langues exposées.
 *
 * Appliqué en UN SEUL point — `tracksOf` —, en amont de tout le reste : le
 * manifeste, les rendus, le plan audio, l'empreinte du magasin statique et
 * celle du prélude en découlent tous. Filtrer plus loin laisserait deux
 * inventaires diverger.
 */
export function filterExposedAudio(tracks: AudioTrackRow[]): AudioTrackRow[] {
  // Une piste unique reste muxée dans la vidéo : rien à filtrer, et la retirer
  // produirait un film muet.
  if (tracks.length <= 1) return tracks;

  const gardees = tracks.filter((track) => LANGUES_EXPOSEES.has(languageTag(track.language)));

  const defaut = pickDefaultAudio(tracks);
  if (defaut !== null && !gardees.some((track) => track.streamIndex === defaut)) {
    const piste = tracks.find((track) => track.streamIndex === defaut);
    if (piste !== undefined) gardees.push(piste);
  }

  if (gardees.length === 0) return tracks;
  return gardees.sort((a, b) => a.streamIndex - b.streamIndex);
}

export function pickDefaultAudio(tracks: AudioTrackRow[]): number | null {
  if (tracks.length === 0) return null;

  const ordinary = tracks.filter((track) => !isAudioDescription(track));
  const pool = ordinary.length > 0 ? ordinary : tracks;

  const french = pool.find((track) => isFrench(track.language));
  if (french !== undefined) return french.streamIndex;

  const flagged = pool.find((track) => track.isDefault);
  if (flagged !== undefined) return flagged.streamIndex;

  return (pool[0] as AudioTrackRow).streamIndex;
}

// ---------------------------------------------------------------------------
// Sous-titres
// ---------------------------------------------------------------------------

/**
 * Codecs de sous-titres TEXTE qu'on sait extraire et convertir.
 *
 * Liste blanche, jamais liste noire : `embedded_subtitle` compte 167 pistes
 * dont ffprobe n'a pas nommé le codec, et tenter l'extraction à l'aveugle
 * produirait un échec ffmpeg au moment de la lecture. Ce qu'on ne connaît pas
 * n'est pas proposé.
 */
export const EXTRACTABLE_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
  'subviewer',
  'subviewer1',
]);

export function isExtractable(codec: string | null): boolean {
  return codec !== null && EXTRACTABLE_SUBTITLE_CODECS.has(codec.toLowerCase());
}

/** Reconnaissance des sous-titres pour sourds et malentendants. */
const SDH_PATTERN = /\b(?:sdh|hi|cc|hearing[- ]impaired|malentendants?)\b/i;

/** Reconnaissance des sous-titres forcés, quand la disposition ne le dit pas. */
const FORCED_PATTERN = /\bforc[ée]s?\b|\bforced\b/i;

/**
 * Nature d'une piste de sous-titres.
 *
 * La disposition du fichier fait foi quand elle est posée ; sinon on lit le
 * titre, où « Forced », « FR Forced », « French (Forced) » et « VFF Forced »
 * sont les formes rencontrées. Le relevé donne 351 pistes intitulées « Forced »
 * tout court et 327 « SDH » : sans cette lecture, elles seraient indiscernables.
 *
 * L'ordre compte : une piste « SDH Forced » est d'abord forcée — c'est ce qui
 * décide si on peut la proposer par défaut.
 */
export function subtitleKindOf(track: SubtitleTrackRow): SubtitleKind {
  const title = track.title ?? '';
  if (track.isForced || FORCED_PATTERN.test(title)) return 'forced';
  if (SDH_PATTERN.test(title)) return 'sdh';
  return 'full';
}

const KIND_MENTIONS: Record<SubtitleKind, string | null> = {
  forced: 'forcés',
  sdh: 'sourds et malentendants',
  full: null,
};

function baseSubtitleLabel(track: SubtitleTrackRow, kind: SubtitleKind): string {
  const parts = [languageLabel(track.language)];

  const mention = KIND_MENTIONS[kind];
  if (mention !== null) parts.push(`(${mention})`);

  const free = informativeTitle(track.title);
  if (free !== null) parts.push(`— ${free}`);

  return parts.join(' ');
}

export function labelSubtitleTracks(tracks: SubtitleTrackRow[]): LabelledSubtitleTrack[] {
  const labelled = tracks.map((track) => {
    const kind = subtitleKindOf(track);
    return {
      streamIndex: track.streamIndex,
      label: baseSubtitleLabel(track, kind),
      language: track.language,
      kind,
      codec: track.codec,
    };
  });

  disambiguate(labelled, (entry) => STREAM_SUFFIX(entry.streamIndex));
  return labelled;
}

export interface SubtitleSelection {
  /** Pistes réellement exposées au lecteur. */
  tracks: LabelledSubtitleTrack[];
  /**
   * Vrai quand le fichier n'a QUE des sous-titres image.
   *
   * Le sélecteur l'annonce alors explicitement : ne rien afficher laisserait
   * croire que le fichier n'a aucun sous-titre, ce qui est faux.
   */
  imageOnly: boolean;
}

/**
 * Ce qu'on expose, et ce qu'on tait.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE TEXTE L'EMPORTE TOUJOURS SUR L'IMAGE.
 *
 * 166 fichiers portent les deux. Une piste PGS demanderait soit une
 * incrustation dans la vidéo — donc un transcodage dédié par piste — soit un
 * rendu graphique côté client. Quand une piste texte existe dans la même
 * langue, ou même dans une autre, elle rend le même service pour rien.
 *
 * 168 fichiers n'ont QUE de l'image : on n'expose rien, et on le dit.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function selectSubtitleTracks(tracks: SubtitleTrackRow[]): SubtitleSelection {
  const text = tracks.filter((track) => !track.isImageBased && isExtractable(track.codec));
  const image = tracks.filter((track) => track.isImageBased);

  return {
    tracks: labelSubtitleTracks(text),
    imageOnly: text.length === 0 && image.length > 0,
  };
}

/**
 * Sous-titre actif à l'ouverture.
 *
 * Aucun, sauf demande explicite. Un sous-titre forcé n'est JAMAIS un choix par
 * défaut : il ne contient que les passages en langue étrangère, et l'activer
 * sur un film qu'on regarde en version française laisserait l'écran vide
 * pendant deux heures avec trois lignes au milieu.
 */
export function pickDefaultSubtitle(): number | null {
  return null;
}

// ---------------------------------------------------------------------------
// Préférences mémorisées
// ---------------------------------------------------------------------------

/**
 * Ce qu'on retient d'un choix de piste.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON MÉMORISE UNE LANGUE, PAS UN NUMÉRO DE FLUX.
 *
 * Un index de flux ne veut rien dire d'un fichier à l'autre : sur l'épisode 1
 * d'une série, le japonais peut être le flux 2 ; sur l'épisode 2, le flux 1.
 * Mémoriser « japonais, sous-titres français complets » traverse en revanche
 * toute la série, et c'est exactement le besoin d'un anime regardé en version
 * originale.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface TrackPreference {
  audioLanguage: string | null;
  subtitlesEnabled: boolean;
  subtitleLanguage: string | null;
  subtitleKind: SubtitleKind | null;
}

/** Deux codes désignent-ils la même langue ? « fre » et « fra » : oui. */
function sameLanguage(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return languageTag(a) === languageTag(b);
}

/**
 * Piste audio à ouvrir, préférence comprise.
 *
 * La préférence l'emporte quand la langue existe dans ce fichier ; sinon on
 * retombe sur la règle automatique. Un épisode qui n'a pas de piste japonaise
 * s'ouvre donc en français plutôt que de rester muet.
 */
export function resolveAudioChoice(
  tracks: AudioTrackRow[],
  preference: TrackPreference | null,
): number | null {
  if (preference?.audioLanguage != null) {
    const wanted = tracks.filter(
      (track) => sameLanguage(track.language, preference.audioLanguage) && !isAudioDescription(track),
    );
    // À langue égale, la piste que le fichier désigne, sinon la première.
    const chosen = wanted.find((track) => track.isDefault) ?? wanted[0];
    if (chosen !== undefined) return chosen.streamIndex;
  }

  return pickDefaultAudio(tracks);
}

/**
 * Sous-titre à activer, préférence comprise.
 *
 * La nature demandée compte autant que la langue : quelqu'un qui a choisi
 * « Français complet » ne veut pas récupérer « Français forcés » sur l'épisode
 * suivant. À défaut de la nature exacte, on accepte une autre piste de la même
 * langue — sauf un forcé, qu'on ne substitue jamais à un complet.
 */
export function resolveSubtitleChoice(
  tracks: LabelledSubtitleTrack[],
  preference: TrackPreference | null,
): number | null {
  if (preference === null || !preference.subtitlesEnabled) return pickDefaultSubtitle();

  const sameLang = tracks.filter((track) => sameLanguage(track.language, preference.subtitleLanguage));
  if (sameLang.length === 0) return pickDefaultSubtitle();

  const exact = sameLang.find((track) => track.kind === preference.subtitleKind);
  if (exact !== undefined) return exact.streamIndex;

  /*
   * Repli : n'importe quelle piste de la même langue, SAUF un forcé. Substituer
   * un forcé à un complet donnerait un écran vide la plupart du temps, ce qui
   * ressemble à une panne plutôt qu'à un choix.
   */
  const substitute = sameLang.find((track) => track.kind !== 'forced');
  return substitute?.streamIndex ?? pickDefaultSubtitle();
}

/** Ce qu'il faut retenir d'un choix, pour le rejouer sur l'œuvre suivante. */
export function preferenceFrom(
  audio: LabelledAudioTrack | undefined,
  subtitle: LabelledSubtitleTrack | undefined,
): TrackPreference {
  return {
    audioLanguage: audio?.language ?? null,
    subtitlesEnabled: subtitle !== undefined,
    subtitleLanguage: subtitle?.language ?? null,
    subtitleKind: subtitle?.kind ?? null,
  };
}
