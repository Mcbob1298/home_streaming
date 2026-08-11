/**
 * Détection de ffmpeg et de son accélération matérielle, au démarrage.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VOIR UN ENCODEUR DANS LA LISTE NE PROUVE RIEN.
 *
 * `ffmpeg -encoders` annonce ce qui a été COMPILÉ, pas ce qui FONCTIONNE. Sur
 * ce NAS, `h264_qsv` figure dans la liste et échoue à l'exécution :
 *
 *     Error initializing an internal MFX session: unsupported (-3)
 *
 * La cause n'est pas une erreur de configuration : ffmpeg 5.1 de Debian 12
 * s'appuie sur l'ancienne libmfx, quand l'Alder Lake du Pentium Gold 8505 exige
 * oneVPL, apparu avec ffmpeg 6. Aucun réglage ne rattrape ça.
 *
 * On ESSAIE donc réellement chaque candidat sur une mire de quelques images, et
 * on retient le premier qui aboutit. C'est la différence entre un serveur qui
 * annonce « accélération matérielle : qsv » et retombe silencieusement en
 * logiciel, et un serveur qui sait ce qu'il sait faire.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class FfmpegMissingError extends Error {}

export type HardwareAcceleration = 'qsv' | 'vaapi' | 'nvenc' | 'amf' | 'videotoolbox';

/** Périphérique de rendu par défaut sous Linux. */
export const DEFAULT_RENDER_NODE = '/dev/dri/renderD128';

/** Un essai d'encodage, tel qu'il s'est réellement passé. */
export interface EncoderProbe {
  name: HardwareAcceleration | 'software';
  encoder: string;
  ok: boolean;
  /** Ce que ffmpeg a répondu quand l'essai a échoué. */
  error: string | null;
  ms: number;
}

export interface FfmpegCapabilities {
  binary: string;
  version: string;
  /** Noms d'encodeurs annoncés — ce qui est compilé, pas ce qui marche. */
  encoders: Set<string>;
  /** Accélération RETENUE, après essai réel. Null si tout a échoué. */
  hardware: HardwareAcceleration | null;
  /** Périphérique de rendu utilisé, ou null. */
  device: string | null;
  /** Chaque candidat, dans l'ordre où il a été essayé. */
  probes: EncoderProbe[];
  /** Vrai quand la décision vient du cache plutôt que d'essais refaits. */
  cached: boolean;
}

/**
 * Ordre de préférence.
 *
 * QuickSync d'abord quand il marche : il décharge davantage le processeur que
 * VAAPI sur du matériel Intel. VAAPI ensuite, qui est le repli universel sur
 * Intel sous Linux. Les autres n'existent que sur la machine de développement.
 */
const CANDIDATES: { name: HardwareAcceleration; encoder: string }[] = [
  { name: 'qsv', encoder: 'h264_qsv' },
  { name: 'vaapi', encoder: 'h264_vaapi' },
  { name: 'nvenc', encoder: 'h264_nvenc' },
  { name: 'amf', encoder: 'h264_amf' },
  { name: 'videotoolbox', encoder: 'h264_videotoolbox' },
];

/** Mire minuscule : l'essai doit être concluant, pas représentatif. */
const TEST_SOURCE = 'testsrc=size=320x240:rate=25:duration=0.4';

/** Un essai qui traîne est un essai raté : le matériel répond, ou il ne répond pas. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * Arguments d'un essai d'encodage.
 *
 * Module pur, pour que le contenu de chaque ligne de commande soit vérifiable
 * sans lancer un seul processus.
 */
export function probeArgs(name: HardwareAcceleration | 'software', device: string): string[] {
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const source = ['-f', 'lavfi', '-i', TEST_SOURCE];
  const sink = ['-f', 'null', '-'];

  switch (name) {
    case 'qsv':
      return [
        ...common,
        '-init_hw_device',
        `qsv=hw:${device}`,
        '-filter_hw_device',
        'hw',
        ...source,
        '-vf',
        'format=nv12,hwupload=extra_hw_frames=16',
        '-c:v',
        'h264_qsv',
        ...sink,
      ];

    case 'vaapi':
      return [
        ...common,
        '-vaapi_device',
        device,
        ...source,
        '-vf',
        'format=nv12,hwupload',
        '-c:v',
        'h264_vaapi',
        ...sink,
      ];

    case 'nvenc':
      return [...common, ...source, '-c:v', 'h264_nvenc', ...sink];

    case 'amf':
      return [...common, ...source, '-c:v', 'h264_amf', ...sink];

    case 'videotoolbox':
      return [...common, ...source, '-c:v', 'h264_videotoolbox', ...sink];

    case 'software':
      return [...common, ...source, '-c:v', 'libx264', '-preset', 'ultrafast', ...sink];
  }
}

/**
 * Extrait les noms d'encodeurs de la sortie de `ffmpeg -encoders`.
 *
 * Six colonnes de drapeaux, un espace, le nom :
 *     V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 */
export function parseEncoders(output: string): Set<string> {
  const encoders = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    /*
     * Le nom doit commencer par une lettre ou un chiffre. L'en-tête de la
     * sortie contient une légende — « V..... = Video » — et une ligne de
     * séparation « ------ », qui passent toutes deux le motif de drapeaux.
     */
    const match = /^\s*[A-Z.]{6}\s+([A-Za-z0-9][\w.-]*)/.exec(line);
    if (match?.[1] !== undefined) encoders.add(match[1]);
  }

  return encoders;
}

/** Résume l'échec de ffmpeg en une ligne utile. */
export function summarizeFailure(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  /*
   * On cherche la ligne qui DIT quelque chose. ffmpeg empile souvent trois
   * messages génériques après la vraie cause — « Error initializing an internal
   * MFX session » est plus utile que « Error while filtering ».
   */
  const meaningful = lines.find((line) => /error|failed|unsupported|not supported|no such|cannot|invalid/i.test(line));
  return (meaningful ?? lines[0] ?? 'échec sans message').slice(0, 180);
}

/** Le périphérique de rendu, s'il existe et sur une plateforme qui en a. */
export function detectRenderNode(): string | null {
  if (process.platform !== 'linux') return null;
  return existsSync(DEFAULT_RENDER_NODE) ? DEFAULT_RENDER_NODE : null;
}

/** Lance un essai réel. Ne lève jamais : un échec EST le résultat. */
async function probe(
  binary: string,
  name: HardwareAcceleration | 'software',
  encoder: string,
  device: string,
): Promise<EncoderProbe> {
  const startedAt = Date.now();

  try {
    await execFileAsync(binary, probeArgs(name, device), {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { name, encoder, ok: true, error: null, ms: Date.now() - startedAt };
  } catch (error) {
    const failure = error as { stderr?: string; killed?: boolean; message?: string };
    const reason = failure.killed === true
      ? `aucune réponse en ${PROBE_TIMEOUT_MS / 1000} s`
      : summarizeFailure(failure.stderr ?? failure.message ?? '');
    return { name, encoder, ok: false, error: reason, ms: Date.now() - startedAt };
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheFile {
  ffmpegVersion: string;
  device: string | null;
  hardware: HardwareAcceleration | null;
  probes: EncoderProbe[];
  decidedAt: string;
}

const CACHE_NAME = 'hwaccel.json';

/**
 * Les essais coûtent une à deux secondes au démarrage — négligeable en soi,
 * mais inutile à refaire à chaque redémarrage d'un conteneur en `tsx watch`.
 * Le cache est invalidé dès que la version de ffmpeg ou le périphérique change,
 * c'est-à-dire dès que la réponse pourrait être différente.
 */
function readCache(dataDir: string, version: string, device: string | null): CacheFile | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dataDir, CACHE_NAME), 'utf8')) as CacheFile;
    if (raw.ffmpegVersion !== version) return null;
    if ((raw.device ?? null) !== device) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(dataDir: string, entry: CacheFile): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, CACHE_NAME), JSON.stringify(entry, null, 2), 'utf8');
  } catch {
    // Un cache non écrit fait juste refaire les essais au prochain démarrage.
  }
}

// ---------------------------------------------------------------------------
// Détection
// ---------------------------------------------------------------------------

export interface DetectOptions {
  binary?: string;
  /** Où poser le cache. Sans lui, les essais sont refaits à chaque démarrage. */
  dataDir?: string;
  /** Ignore le cache et refait tous les essais. */
  refresh?: boolean;
}

export async function detectCapabilities(options: DetectOptions = {}): Promise<FfmpegCapabilities> {
  const binary = options.binary ?? process.env.FFMPEG_PATH ?? 'ffmpeg';

  let versionOutput: string;
  try {
    const { stdout } = await execFileAsync(binary, ['-hide_banner', '-version'], { maxBuffer: 4 * 1024 * 1024 });
    versionOutput = stdout;
  } catch {
    throw new FfmpegMissingError(
      [
        `ffmpeg est introuvable (« ${binary} »).`,
        '',
        'Installez-le, ou désignez le binaire avec FFMPEG_PATH dans .env :',
        '    FFMPEG_PATH=C:\\chemin\\vers\\ffmpeg.exe',
        '',
        'Sans lui, seuls les fichiers déjà compatibles sont lisibles.',
      ].join('\n'),
    );
  }

  const version = (versionOutput.split(/\r?\n/)[0] ?? '').trim();

  const { stdout: encoderOutput } = await execFileAsync(binary, ['-hide_banner', '-encoders'], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const encoders = parseEncoders(encoderOutput);
  const device = detectRenderNode();

  const base = { binary, version, encoders, device };

  if (options.refresh !== true && options.dataDir !== undefined) {
    const cached = readCache(options.dataDir, version, device);
    if (cached !== null) {
      return { ...base, hardware: cached.hardware, probes: cached.probes, cached: true };
    }
  }

  const probes: EncoderProbe[] = [];
  let hardware: HardwareAcceleration | null = null;

  for (const candidate of CANDIDATES) {
    // Un encodeur absent de la compilation n'a pas besoin d'être essayé.
    if (!encoders.has(candidate.encoder)) continue;

    /*
     * VAAPI et QSV ouvrent un nœud de rendu. Sans périphérique, l'essai
     * échouerait avec un message obscur ; autant ne pas le tenter et dire
     * pourquoi.
     */
    if ((candidate.name === 'vaapi' || candidate.name === 'qsv') && device === null) {
      probes.push({
        name: candidate.name,
        encoder: candidate.encoder,
        ok: false,
        error:
          process.platform === 'linux'
            ? `aucun périphérique de rendu (${DEFAULT_RENDER_NODE} absent)`
            : `sans objet sur ${process.platform} : ces encodeurs passent par un nœud de rendu DRM`,
        ms: 0,
      });
      continue;
    }

    const result = await probe(binary, candidate.name, candidate.encoder, device ?? DEFAULT_RENDER_NODE);
    probes.push(result);

    if (result.ok) {
      hardware = candidate.name;
      break; // Le premier qui marche gagne : inutile d'essayer les suivants.
    }
  }

  // Dernier recours, essayé lui aussi : une image sans libx264 existe.
  if (hardware === null && encoders.has('libx264')) {
    probes.push(await probe(binary, 'software', 'libx264', device ?? DEFAULT_RENDER_NODE));
  }

  if (options.dataDir !== undefined) {
    writeCache(options.dataDir, {
      ffmpegVersion: version,
      device,
      hardware,
      probes,
      decidedAt: new Date().toISOString(),
    });
  }

  return { ...base, hardware, probes, cached: false };
}

/**
 * Compte rendu pour les journaux de démarrage.
 *
 * Il dit ce qui a été RETENU et pourquoi chaque autre a été écarté. Un serveur
 * qui se contente d'annoncer son choix laisse une panne d'accélération
 * invisible jusqu'au premier transcodage à 0,3× le temps réel.
 */
export function describeCapabilities(capabilities: FfmpegCapabilities): string[] {
  const lines = [`ffmpeg : ${capabilities.version}`];

  lines.push(
    capabilities.device === null
      ? 'Aucun périphérique de rendu détecté.'
      : `Périphérique de rendu : ${capabilities.device}`,
  );

  const source = capabilities.cached ? 'depuis le cache' : 'après essai réel';

  if (capabilities.hardware !== null) {
    const kept = capabilities.probes.find((entry) => entry.name === capabilities.hardware);
    lines.push(
      `Accélération matérielle retenue : ${capabilities.hardware.toUpperCase()}` +
        ` (${kept?.encoder ?? '?'}, ${source}${kept !== undefined && !capabilities.cached ? `, essai en ${kept.ms} ms` : ''})`,
    );
  } else {
    lines.push(
      `Aucune accélération matérielle utilisable (${source}) : le transcodage vidéo se fera ` +
        'en logiciel, beaucoup plus lentement. Le remux, lui, ne réencode pas la vidéo et ' +
        'n’en a pas besoin.',
    );
  }

  const rejected = capabilities.probes.filter((entry) => !entry.ok);
  if (rejected.length > 0) {
    lines.push('Candidats écartés :');
    for (const entry of rejected) {
      lines.push(`  ${entry.encoder} — ${entry.error ?? 'échec'}`);
    }
  }

  /*
   * Le piège que cette détection existe pour attraper : un encodeur présent
   * dans la liste de compilation mais qui ne s'initialise pas.
   */
  const announcedButBroken = capabilities.probes.filter(
    (entry) => !entry.ok && capabilities.encoders.has(entry.encoder),
  );
  if (announcedButBroken.length > 0 && capabilities.hardware !== null) {
    lines.push(
      `Note : ${announcedButBroken.map((entry) => entry.encoder).join(', ')} ` +
        'figure(nt) dans « ffmpeg -encoders » mais échoue(nt) à l’initialisation. ' +
        'La liste dit ce qui est compilé, pas ce qui fonctionne.',
    );
  }

  if (!capabilities.encoders.has('aac')) {
    lines.push('ATTENTION : encodeur AAC absent — le remux ne pourra pas produire son audio.');
  }

  return lines;
}
