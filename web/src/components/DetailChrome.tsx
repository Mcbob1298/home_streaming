import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

import { backdropLayers, veilSpan } from './backdropVeil';

/**
 * Éléments partagés par les deux fiches, film et série : fond en backdrop,
 * boutons ronds, onglets, lignes de spécifications.
 */

/**
 * Image de fond de la fiche, FIXÉE derrière toute la page.
 *
 * Elle ne défile pas avec le contenu : elle reste en place et s'assombrit à
 * mesure qu'on descend, jusqu'à un voile qui la laisse encore devinable
 * derrière le texte. C'est le comportement de Disney+, et ce qui donne à la
 * fiche son unité.
 *
 * Deux précautions de performance :
 *
 * - Le défilement ne touche QUE l'opacité de deux calques, écrite directement
 *   sur le nœud. Passer par un état React relancerait un rendu à chaque image,
 *   et aucun dégradé n'a besoin d'être recalculé.
 * - Les mises à jour sont regroupées par requestAnimationFrame : le navigateur
 *   émet bien plus d'événements de défilement qu'il ne peint d'images.
 */
export function DetailBackdrop({ url, srcSet }: { url: string | null; srcSet?: string | null }) {
  const veil = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;

    function paint() {
      frame = 0;
      const layers = backdropLayers(window.scrollY, veilSpan(window.innerHeight));
      if (veil.current !== null) veil.current.style.opacity = String(layers.veil);
      if (hero.current !== null) hero.current.style.opacity = String(layers.hero);
    }

    function schedule() {
      if (frame === 0) frame = requestAnimationFrame(paint);
    }

    paint();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [url]);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-fond" aria-hidden="true">
      {url !== null && (
        <img
          src={url}
          srcSet={srcSet ?? undefined}
          // Pleine largeur de fenêtre : c'est le plus gros besoin de l'interface.
          sizes="100vw"
          alt=""
          className="h-full w-full object-cover object-top"
        />
      )}

      {/* Dégradés de composition : ils cadrent le titre, et n'ont de sens qu'en haut. */}
      <div ref={hero} className="absolute inset-0 will-change-[opacity]">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#0F1117_0%,rgba(15,17,23,0.86)_30%,rgba(15,17,23,0.12)_66%,rgba(15,17,23,0)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_top,#0F1117_0%,rgba(15,17,23,0.55)_22%,rgba(15,17,23,0)_58%)]" />
      </div>

      {/* Voile uniforme : il monte au défilement pour rendre le texte lisible. */}
      <div ref={veil} className="absolute inset-0 bg-fond opacity-0 will-change-[opacity]" />
    </div>
  );
}

/**
 * Bouton principal en dégradé accent.
 *
 * Il navigue vers le lecteur même quand le fichier n'est pas lisible tel quel :
 * c'est le lecteur qui explique pourquoi, avec les codecs sous les yeux. Un
 * bouton grisé sans explication en apprendrait moins.
 *
 * Il n'est vraiment désactivé que sans fichier du tout sur le disque.
 */
export function PlayButton({ mediaFileId, label = 'Lire' }: { mediaFileId: number | null; label?: string }) {
  const shape =
    'accent-gradient flex h-12 items-center gap-[10px] rounded px-10 text-[15px] font-semibold shadow-[0_8px_24px_rgba(0,99,229,0.35)]';

  const icon = (
    <svg width="13" height="15" viewBox="0 0 13 15" fill="currentColor" aria-hidden="true">
      <path d="M0 0l13 7.5L0 15z" />
    </svg>
  );

  if (mediaFileId === null) {
    return (
      <button type="button" disabled title="Aucun fichier sur le disque" className={`${shape} cursor-not-allowed opacity-50`}>
        {icon}
        {label}
      </button>
    );
  }

  return (
    <Link to={`/watch/${mediaFileId}`} className={shape}>
      {icon}
      {label}
    </Link>
  );
}

/**
 * Le duo de lecture d'une fiche : reprendre, ou repartir du début.
 *
 * Sans progression, un seul bouton — « Depuis le début » n'aurait aucun sens à
 * côté de « Lire ». Dès qu'il y a quelque chose à reprendre, le bouton principal
 * l'annonce avec la position, et le secondaire offre l'autre choix par une URL
 * explicite : `?t=0` impose le point de départ au lecteur.
 */
export function PlayButtons({
  mediaFileId,
  resumeSeconds,
  label = 'Lire',
  resumeLabel,
}: {
  mediaFileId: number | null;
  resumeSeconds: number;
  label?: string;
  /** Remplace « Reprendre à 1 h 13 » — une série y met plutôt « Reprendre S01:E04 ». */
  resumeLabel?: string;
}) {
  if (mediaFileId === null || resumeSeconds <= 0) {
    return <PlayButton mediaFileId={mediaFileId} label={label} />;
  }

  return (
    <>
      <PlayButton
        mediaFileId={mediaFileId}
        label={resumeLabel ?? `Reprendre à ${positionLabel(resumeSeconds)}`}
      />
      <Link
        to={`/watch/${mediaFileId}?t=0`}
        className="flex h-12 items-center rounded border border-[rgba(249,249,249,0.28)] px-6 text-[14px] font-semibold text-texte transition-colors hover:border-texte"
      >
        Depuis le début
      </Link>
    </>
  );
}

/** 4380 secondes → « 1 h 13 ». Jamais « 0 min » : une position existe ou pas. */
export function positionLabel(seconds: number): string {
  return formatMinutes(Math.max(1, Math.round(seconds / 60))) ?? '1 min';
}

/** Bouton rond d'action secondaire. */
export function RoundButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex h-12 w-12 items-center justify-center rounded-full border border-[rgba(249,249,249,0.14)] bg-surface-haute text-texte transition-colors hover:border-[rgba(249,249,249,0.4)]"
    >
      {children}
    </button>
  );
}

export const ICONS = {
  plus: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  share: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 15V3M8 7l4-4 4 4" />
    </svg>
  ),
};

export type TabKey = 'episodes' | 'suggestions' | 'details';

const TAB_LABELS: Record<TabKey, string> = {
  episodes: 'Épisodes',
  suggestions: 'Suggestions',
  details: 'Détails',
};

/**
 * Onglets posés PAR-DESSUS l'image de fond, dans le tiers inférieur.
 *
 * Ils ne sont pas sous le pli : ils font partie de la composition de la fiche,
 * et c'est ce qui indique d'emblée qu'il y a du contenu plus bas.
 */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabKey[];
  active: TabKey;
  onChange: (tab: TabKey) => void;
}) {
  return (
    <div className="flex gap-9 border-b border-[rgba(249,249,249,0.09)] px-16">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          aria-current={active === tab}
          className={`-mb-px pb-[14px] text-[13px] font-semibold tracking-[0.18em] uppercase transition-colors ${
            active === tab ? 'border-b-2 border-texte text-texte' : 'text-faible hover:text-texte'
          }`}
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  );
}

/** Une ligne de la grille de spécifications. */
export function SpecRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-6 border-b border-[rgba(249,249,249,0.07)] py-4">
      <span className="text-[13px] text-faible">{label}</span>
      <span className="text-right text-[14px] font-semibold">{value ?? '—'}</span>
    </div>
  );
}

/**
 * Encadré des emplacements sur le disque, avec ses actions.
 *
 * Un film affiche le chemin de son ou ses fichiers, une série le dossier qui
 * contient ses épisodes : lister 89 chemins n'aiderait personne.
 */
export function FileBox({ paths, reviewKey }: { paths: string[]; reviewKey: string }) {
  const action =
    'rounded border border-[rgba(249,249,249,0.2)] px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-faible transition-colors hover:border-[rgba(249,249,249,0.45)] hover:text-texte';

  return (
    <div className="mt-[34px] flex flex-wrap items-center justify-between gap-4 rounded bg-surface px-6 py-5">
      <div className="min-w-0 flex-1 space-y-1">
        {paths.length === 0 ? (
          <span className="text-[12px] text-faible">Emplacement inconnu.</span>
        ) : (
          paths.map((path) => (
            <div key={path} className="font-mono text-[12px] break-all text-faible">
              {path}
            </div>
          ))
        )}
      </div>
      <div className="flex shrink-0 gap-3">
        <button type="button" disabled title="Disponible prochainement" className={`${action} cursor-not-allowed`}>
          Réanalyser
        </button>
        <Link to={`/review?work=${reviewKey}`} className={action}>
          Corriger l’association
        </Link>
      </div>
    </div>
  );
}

/** « 118 » → « 1 h 58 ». */
export function formatMinutes(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest} min` : `${hours} h ${String(rest).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || bytes <= 0) return null;
  const gigabytes = bytes / 1024 ** 3;
  return gigabytes >= 1 ? `${gigabytes.toFixed(2)} Go` : `${Math.round(bytes / 1024 ** 2)} Mo`;
}

/** Ligne de métadonnées séparée par des points médians. */
export function MetaLine({ parts }: { parts: (string | null)[] }) {
  const kept = parts.filter((part): part is string => part !== null && part !== '');
  return (
    <div className="mt-[22px] flex flex-wrap items-center gap-[10px] text-[14px]">
      {kept.map((part, index) => (
        <span key={part} className="flex items-center gap-[10px]">
          {index > 0 && <span className="opacity-40">·</span>}
          {part}
        </span>
      ))}
    </div>
  );
}

/**
 * Accroche de la fiche : une phrase, pas un paragraphe.
 *
 * Le lien « plus » a disparu avec le pavé : le synopsis complet vit dans
 * l'onglet Détails, où il a la place de se lire.
 */
export function Synopsis({ text }: { text: string }) {
  return <p className="mt-4 max-w-[560px] text-[15px] leading-[1.6] text-faible">{text}</p>;
}
