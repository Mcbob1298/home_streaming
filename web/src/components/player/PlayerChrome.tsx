import { useRef, useState } from 'react';

import type { SubtitleTrack } from '../../api';
import { formatRemaining, formatTime, progressOf, ratioFromPointer } from './playerControls';

/**
 * Barres du haut et du bas, reprises de Disney+.
 *
 * Elles ne connaissent pas l'élément vidéo : elles reçoivent un état et
 * appellent des fonctions. C'est ce qui permet au lecteur de changer de source
 * — fichier aujourd'hui, manifeste demain — sans que la barre en sache rien.
 */

const ACCENT = '#00A8E1';

export interface PlayerChromeProps {
  visible: boolean;
  title: string;
  subtitle: string | null;
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number | null;
  /** Fin de la plage déjà téléchargée, pour la barre de mise en tampon. */
  buffered: number;
  subtitles: SubtitleTrack[];
  activeSubtitleId: number | null;
  next: { mediaFileId: number; label: string } | null;
  fullscreen: boolean;
  onBack: () => void;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onSeekBy: (delta: number) => void;
  onVolume: (value: number) => void;
  onMute: () => void;
  onFullscreen: () => void;
  onSubtitle: (id: number | null) => void;
  onNext: () => void;
}

export function PlayerChrome(props: PlayerChromeProps) {
  const {
    visible,
    title,
    subtitle,
    paused,
    muted,
    volume,
    currentTime,
    duration,
    buffered,
    subtitles,
    activeSubtitleId,
    next,
    fullscreen,
  } = props;

  const [menuOpen, setMenuOpen] = useState(false);

  /*
   * Les contrôles restent en place quand ils s'effacent : `pointer-events-none`
   * les rend traversables, ce qui évite qu'un clic destiné à la vidéo tombe sur
   * une barre invisible.
   */
  const shell = `transition-opacity duration-300 motion-reduce:transition-none ${
    visible ? 'opacity-100' : 'pointer-events-none opacity-0'
  }`;

  return (
    <>
      <div
        className={`absolute inset-x-0 top-0 z-20 flex items-center gap-5 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.75),rgba(0,0,0,0))] px-8 pt-6 pb-16 ${shell}`}
      >
        <button
          type="button"
          onClick={props.onBack}
          aria-label="Revenir"
          className="shrink-0 rounded p-2 text-texte transition-colors hover:bg-[rgba(249,249,249,0.14)]"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
        </button>

        <div className="min-w-0">
          <div className="truncate text-[19px] font-semibold text-texte">{title}</div>
          {subtitle !== null && <div className="truncate text-[14px] text-[rgba(249,249,249,0.72)]">{subtitle}</div>}
        </div>
      </div>

      <div
        className={`absolute inset-x-0 bottom-0 z-20 bg-[linear-gradient(to_top,rgba(0,0,0,0.85),rgba(0,0,0,0))] px-8 pt-20 pb-7 ${shell}`}
      >
        <ProgressBar
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          onSeek={props.onSeek}
        />

        <div className="mt-4 flex items-center">
          <div className="flex flex-1 items-center gap-2">
            <IconButton label="Reculer de 10 secondes" onClick={() => props.onSeekBy(-10)}>
              {ICONS.back10}
            </IconButton>
            <IconButton label={paused ? 'Lire' : 'Mettre en pause'} onClick={props.onToggle} large>
              {paused ? ICONS.play : ICONS.pause}
            </IconButton>
            <IconButton label="Avancer de 10 secondes" onClick={() => props.onSeekBy(10)}>
              {ICONS.forward10}
            </IconButton>
          </div>

          <div className="flex items-center gap-2">
            <VolumeControl muted={muted} volume={volume} onMute={props.onMute} onVolume={props.onVolume} />

            {next !== null && (
              <IconButton label={`Épisode suivant — ${next.label}`} onClick={props.onNext}>
                {ICONS.next}
              </IconButton>
            )}

            <div className="relative">
              <IconButton
                label="Réglages"
                onClick={() => setMenuOpen((open) => !open)}
                pressed={menuOpen}
              >
                {ICONS.gear}
              </IconButton>
              {menuOpen && (
                <SubtitleMenu
                  subtitles={subtitles}
                  activeId={activeSubtitleId}
                  onPick={(id) => {
                    props.onSubtitle(id);
                    setMenuOpen(false);
                  }}
                />
              )}
            </div>

            <IconButton
              label={fullscreen ? 'Quitter le plein écran' : 'Plein écran'}
              onClick={props.onFullscreen}
            >
              {fullscreen ? ICONS.exitFullscreen : ICONS.fullscreen}
            </IconButton>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Barre de progression pleine largeur.
 *
 * L'infobulle suit le pointeur et annonce le temps VISÉ, pas le temps courant :
 * c'est ce qui permet de viser une scène plutôt que de tâtonner.
 */
function ProgressBar({
  currentTime,
  duration,
  buffered,
  onSeek,
}: {
  currentTime: number;
  duration: number | null;
  buffered: number;
  onSeek: (seconds: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ ratio: number; x: number } | null>(null);

  const played = progressOf(currentTime, duration);
  const loaded = progressOf(buffered, duration);

  function ratioAt(clientX: number): number {
    const node = track.current;
    if (node === null) return 0;
    return ratioFromPointer(clientX, node.getBoundingClientRect());
  }

  function seekAt(clientX: number): void {
    if (duration === null || !Number.isFinite(duration)) return;
    onSeek(ratioAt(clientX) * duration);
  }

  return (
    <div className="relative">
      {hover !== null && duration !== null && (
        <div
          className="pointer-events-none absolute bottom-8 -translate-x-1/2 rounded bg-[rgba(0,0,0,0.85)] px-2 py-1 text-[12px] font-semibold text-texte tabular-nums"
          style={{ left: hover.x }}
        >
          {formatTime(hover.ratio * duration)}
        </div>
      )}

      <div className="flex items-center gap-5">
        {/* Zone cliquable haute de 20px pour une barre visuelle de 4px : viser
            un trait de quatre pixels à la souris est pénible. */}
        <div
          ref={track}
          role="slider"
          tabIndex={-1}
          aria-label="Progression"
          aria-valuemin={0}
          aria-valuemax={duration ?? 0}
          aria-valuenow={currentTime}
          aria-valuetext={formatTime(currentTime)}
          onClick={(event) => seekAt(event.clientX)}
          onMouseMove={(event) => {
            const node = track.current;
            if (node === null) return;
            const rect = node.getBoundingClientRect();
            setHover({ ratio: ratioFromPointer(event.clientX, rect), x: event.clientX - rect.left });
          }}
          onMouseLeave={() => setHover(null)}
          className="group relative flex h-5 flex-1 cursor-pointer items-center"
        >
          <div className="relative h-[4px] w-full rounded-full bg-[rgba(249,249,249,0.3)]">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-[rgba(249,249,249,0.45)]"
              style={{ width: `${loaded * 100}%` }}
            />
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${played * 100}%`, backgroundColor: ACCENT }}
            />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              style={{ left: `${played * 100}%`, backgroundColor: ACCENT }}
            />
          </div>
        </div>

        <span className="shrink-0 text-[13px] font-semibold text-texte tabular-nums">
          {formatRemaining(currentTime, duration)}
        </span>
      </div>
    </div>
  );
}

function VolumeControl({
  muted,
  volume,
  onMute,
  onVolume,
}: {
  muted: boolean;
  volume: number;
  onMute: () => void;
  onVolume: (value: number) => void;
}) {
  return (
    // La glissière n'apparaît qu'au survol du groupe : elle encombrerait la
    // barre en permanence pour un réglage qu'on touche rarement.
    <div className="group/volume flex items-center">
      <IconButton label={muted || volume === 0 ? 'Rétablir le son' : 'Couper le son'} onClick={onMute}>
        {muted || volume === 0 ? ICONS.muted : ICONS.volume}
      </IconButton>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={(event) => onVolume(Number(event.target.value))}
        aria-label="Volume"
        className="w-0 accent-[#00A8E1] opacity-0 transition-all duration-200 group-hover/volume:mr-2 group-hover/volume:w-24 group-hover/volume:opacity-100 focus-visible:mr-2 focus-visible:w-24 focus-visible:opacity-100 motion-reduce:transition-none"
      />
    </div>
  );
}

function SubtitleMenu({
  subtitles,
  activeId,
  onPick,
}: {
  subtitles: SubtitleTrack[];
  activeId: number | null;
  onPick: (id: number | null) => void;
}) {
  return (
    <div className="absolute right-0 bottom-14 w-64 rounded bg-[rgba(15,17,23,0.96)] py-2 shadow-[0_16px_38px_rgba(0,0,0,0.7)]">
      <div className="px-4 pt-1 pb-2 text-[11px] font-semibold tracking-[0.2em] text-faible uppercase">
        Sous-titres
      </div>

      <MenuItem label="Désactivés" active={activeId === null} onClick={() => onPick(null)} />
      {subtitles.map((track) => (
        <MenuItem
          key={track.id}
          label={track.label}
          active={activeId === track.id}
          onClick={() => onPick(track.id)}
        />
      ))}

      {subtitles.length === 0 && (
        <p className="px-4 py-2 text-[13px] leading-[1.5] text-faible">
          Aucun sous-titre externe pour ce fichier. Les pistes incluses dans les MKV demandent ffmpeg et
          arriveront avec le transcodage.
        </p>
      )}
    </div>
  );
}

function MenuItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={`flex w-full items-center gap-3 px-4 py-2 text-left text-[14px] transition-colors hover:bg-[rgba(249,249,249,0.1)] ${
        active ? 'font-semibold text-texte' : 'text-faible'
      }`}
    >
      <span className="w-4 shrink-0">{active ? '✓' : ''}</span>
      {label}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
  large,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  large?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`flex items-center justify-center rounded-full text-texte transition-colors hover:bg-[rgba(249,249,249,0.16)] ${
        large === true ? 'h-14 w-14' : 'h-11 w-11'
      } ${pressed === true ? 'bg-[rgba(249,249,249,0.16)]' : ''}`}
    >
      {children}
    </button>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ICONS = {
  play: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  ),
  pause: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z" />
    </svg>
  ),
  back10: (
    <svg width="24" height="24" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M11.5 5.5 7 9l4.5 3.5" />
      <path d="M7 9h5.5a5.5 5.5 0 1 1-5.5 5.5" />
      <text x="12" y="19.5" textAnchor="middle" fontSize="7.5" fill="currentColor" stroke="none" fontWeight="700">
        10
      </text>
    </svg>
  ),
  forward10: (
    <svg width="24" height="24" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M12.5 5.5 17 9l-4.5 3.5" />
      <path d="M17 9h-5.5A5.5 5.5 0 1 0 17 14.5" />
      <text x="12" y="19.5" textAnchor="middle" fontSize="7.5" fill="currentColor" stroke="none" fontWeight="700">
        10
      </text>
    </svg>
  ),
  volume: (
    <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  ),
  muted: (
    <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </svg>
  ),
  next: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M5 5.5v13l10-6.5z" />
      <path d="M16.5 5.5h2.5v13h-2.5z" />
    </svg>
  ),
  gear: (
    <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 3.2v2.1M12 18.7v2.1M3.2 12h2.1M18.7 12h2.1M5.8 5.8l1.5 1.5M16.7 16.7l1.5 1.5M18.2 5.8l-1.5 1.5M7.3 16.7l-1.5 1.5" />
    </svg>
  ),
  fullscreen: (
    <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  ),
  exitFullscreen: (
    <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
    </svg>
  ),
};
