import type { Credits, FileSummary } from '../api';
import { FileBox, formatBytes, formatMinutes } from './DetailChrome';

/**
 * Onglet Détails, commun aux films et aux séries.
 *
 * La page est ÉDITORIALE avant d'être technique : le synopsis complet en prose,
 * puis deux colonnes de métadonnées lisibles. Les codecs et les résolutions
 * n'ont pas disparu, ils sont relégués dans une section « Fichier » plus
 * discrète — c'est de l'information utile, ce n'est pas le sujet de la page.
 */

export interface Fact {
  label: string;
  value: string | null;
}

/**
 * Une entrée de métadonnée : libellé en gris clair, valeur en gras dessous.
 *
 * Les entrées sans valeur sont retirées en amont plutôt qu'affichées avec un
 * tiret : une colonne de tirets n'apprend rien et allonge la page.
 */
function FactEntry({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-[26px]">
      <div className="mb-[6px] text-[13px] text-faible">{label} :</div>
      <div className="text-[15px] leading-[1.5] font-semibold">{value}</div>
    </div>
  );
}

function FactColumn({ facts }: { facts: Fact[] }) {
  const kept = facts.filter((fact): fact is { label: string; value: string } => fact.value !== null);
  if (kept.length === 0) return null;

  return (
    <div>
      {kept.map((fact) => (
        <FactEntry key={fact.label} label={fact.label} value={fact.value} />
      ))}
    </div>
  );
}

/** Liste de noms, coupée par des virgules. */
export function namesOf(people: { name: string }[]): string | null {
  if (people.length === 0) return null;
  return people.map((person) => person.name).join(', ');
}

/** « Réalisation » pour un film, « Création » pour une série. */
export function authorshipOf(credits: Credits): Fact {
  return credits.creators.length > 0
    ? { label: 'Création', value: namesOf(credits.creators) }
    : { label: 'Réalisation', value: namesOf(credits.directors) };
}

export function DetailsPanel({
  title,
  overview,
  left,
  credits,
  fileSummary,
  reviewKey,
}: {
  title: string;
  overview: string | null;
  /** Colonne gauche : durée, date, genre, classification. */
  left: Fact[];
  credits: Credits;
  fileSummary: FileSummary;
  reviewKey: string;
}) {
  const right: Fact[] = [authorshipOf(credits), { label: 'Distribution', value: namesOf(credits.cast) }];

  return (
    <section className="px-16 pt-10 pb-24">
      <h2 className="text-[26px] leading-[1.2] font-bold">{title}</h2>

      {overview !== null && (
        // Largeur de lecture limitée : une ligne qui traverse un écran de
        // 2560px se relit mal, quelle que soit la taille du corps.
        <p className="mt-5 max-w-[680px] text-[16px] leading-[1.75] text-[rgba(249,249,249,0.82)]">{overview}</p>
      )}

      <div className="mt-11 grid max-w-[900px] grid-cols-1 gap-x-20 sm:grid-cols-2">
        <FactColumn facts={left} />
        <FactColumn facts={right} />
      </div>

      <FileSection summary={fileSummary} reviewKey={reviewKey} />
    </section>
  );
}

/** Valeurs multiples séparées par des virgules, ou null quand il n'y en a aucune. */
function listed(values: string[]): string | null {
  return values.length === 0 ? null : values.join(', ');
}

/** « 1920x1080 » → « 1080p ». */
export function resolutionLabel(resolution: string): string {
  const height = Number(resolution.split('x')[1]);
  if (!Number.isFinite(height)) return resolution;
  if (height >= 2000) return '4K';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  return 'SD';
}

/** « 7 320 » secondes → « 2 h 02 ». */
function formatSeconds(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  return formatMinutes(Math.round(seconds / 60));
}

/**
 * Section technique, volontairement discrète : titre en petites capitales
 * grises, lignes serrées, en bas de page.
 */
function FileSection({ summary, reviewKey }: { summary: FileSummary; reviewKey: string }) {
  if (summary.fileCount === 0) {
    return (
      <div className="mt-14 border-t border-[rgba(249,249,249,0.09)] pt-8">
        <SectionTitle />
        <p className="mt-4 text-[14px] text-faible">
          Aucun fichier présent sur le disque. Relancer <code className="font-mono">npm run scan</code> si les
          fichiers sont revenus.
        </p>
      </div>
    );
  }

  const plural = summary.fileCount > 1;
  const subtitles = [
    summary.subtitles.text > 0 ? `${summary.subtitles.text} texte` : null,
    summary.subtitles.image > 0 ? `${summary.subtitles.image} image` : null,
    summary.subtitles.external > 0 ? `${summary.subtitles.external} externe` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const rows: Fact[] = [
    {
      label: plural ? 'Fichiers' : 'Fichier',
      value: `${summary.fileCount}${
        summary.probedCount < summary.fileCount ? ` — ${summary.probedCount} sondé(s)` : ''
      }`,
    },
    { label: 'Taille cumulée', value: formatBytes(summary.totalBytes) },
    {
      label: 'Définition',
      value: listed(summary.resolutions.map((resolution) => `${resolutionLabel(resolution)} (${resolution})`)),
    },
    { label: 'Codec vidéo', value: listed(summary.videoCodecs) },
    { label: 'Codec audio', value: listed(summary.audioCodecs) },
    { label: 'Langues audio', value: listed(summary.audioLanguages) },
    { label: 'Sous-titres', value: subtitles === '' ? 'aucun' : subtitles },
    { label: 'Conteneur', value: listed(summary.containers) },
    { label: 'HDR', value: listed(summary.hdr) },
    {
      label: plural ? 'Débit vidéo moyen' : 'Débit vidéo',
      value: summary.bitrate === null ? null : `${Math.round(summary.bitrate / 1_000_000)} Mb/s`,
    },
    { label: plural ? 'Durée cumulée' : 'Durée', value: formatSeconds(summary.durationSeconds) },
    {
      label: 'Ajouté le',
      value:
        summary.addedAt === null
          ? null
          : new Date(summary.addedAt).toLocaleDateString('fr-FR', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            }),
    },
  ];

  const kept = rows.filter((row): row is { label: string; value: string } => row.value !== null);

  return (
    <div className="mt-14 border-t border-[rgba(249,249,249,0.09)] pt-8">
      <SectionTitle />

      <div className="mt-2 grid max-w-[900px] grid-cols-1 gap-x-20 lg:grid-cols-2">
        {kept.map((row) => (
          <div
            key={row.label}
            className="flex justify-between gap-6 border-b border-[rgba(249,249,249,0.06)] py-[10px]"
          >
            <span className="text-[13px] text-faible">{row.label}</span>
            <span className="text-right text-[13px] font-semibold text-[rgba(249,249,249,0.78)]">{row.value}</span>
          </div>
        ))}
      </div>

      <FileBox paths={summary.locations} reviewKey={reviewKey} />
    </div>
  );
}

function SectionTitle() {
  return <h3 className="text-[12px] font-semibold tracking-[0.22em] text-faible uppercase">Fichier</h3>;
}
