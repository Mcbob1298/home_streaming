import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, type ContinueEntry } from '../api';
import { MediaRow } from './MediaRow';
import { MediaTile } from './MediaTile';

/**
 * « Continuer à regarder », en tête de l'accueil.
 *
 * Deux partis pris :
 *
 * 1. **Vide, la rangée n'existe pas.** Pas de titre, pas de message : une
 *    bibliothèque qu'on vient d'installer n'a rien à reprendre, et l'annoncer
 *    ne rendrait service à personne.
 *
 * 2. **Le clic reprend la lecture**, il n'ouvre pas la fiche. C'est tout
 *    l'intérêt de la rangée ; la fiche reste accessible par le menu.
 *
 * Le cache est volontairement court : on revient sur l'accueil juste après
 * avoir regardé, et la rangée doit refléter ce qu'on vient de faire.
 */
export function ContinueRow() {
  const { data } = useQuery({
    queryKey: ['progress', 'continue'],
    queryFn: api.continueWatching,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  if (data === undefined || data.length === 0) return null;

  return (
    <MediaRow title="Continuer à regarder">
      {data.map((entry) => (
        <ContinueTile key={`${entry.mediaType}-${entry.mediaId}`} entry={entry} />
      ))}
    </MediaRow>
  );
}

function ContinueTile({ entry }: { entry: ContinueEntry }) {
  const queryClient = useQueryClient();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['progress'] });
  };

  const markWatched = useMutation({
    mutationFn: () => api.setWatched(entry.mediaType, entry.mediaId, true),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: () => api.forgetProgress(entry.mediaType, entry.mediaId),
    onSuccess: refresh,
  });

  return (
    <MediaTile
      to={`/watch/${entry.mediaFileId}`}
      title={entry.title}
      logoUrl={entry.logoPath}
      logoSrcSet={entry.logoSrcSet}
      backdropUrl={entry.backdropPath}
      backdropSrcSet={entry.backdropSrcSet}
      posterUrl={entry.posterPath}
      posterSrcSet={entry.posterSrcSet}
      tagline={entry.subtitle}
      year={entry.year}
      /*
       * Pour une série, l'épisode remplace les genres dans la ligne de
       * métadonnées : savoir qu'on reprend à S01:E04 est autrement plus utile
       * que « Aventure, Comédie », déjà lisible sur la fiche.
       */
      genres={entry.subtitle === null ? entry.genres : [entry.subtitle]}
      runtimeMinutes={null}
      badge={null}
      progress={entry.ratio}
      progressLabel={entry.label}
      actions={
        <TileMenu
          label={entry.title}
          detailTo={entry.kind === 'movie' ? `/movie/${entry.workId}` : `/show/${entry.workId}`}
          onWatched={() => markWatched.mutate()}
          onRemove={() => remove.mutate()}
        />
      }
    />
  );
}

/**
 * Menu contextuel de la vignette.
 *
 * Il vit à l'intérieur d'un lien : chaque clic doit donc être arrêté net, sinon
 * ouvrir le menu partirait en lecture. `preventDefault` sur le bouton lui-même
 * ne suffit pas, la navigation part du lien parent au relâchement.
 */
function TileMenu({
  label,
  detailTo,
  onWatched,
  onRemove,
}: {
  label: string;
  detailTo: string;
  onWatched: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /** Arrête l'événement avant qu'il n'atteigne le lien de la vignette. */
  const swallow = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Options de ${label}`}
        onClick={(event) => {
          swallow(event);
          setOpen((value) => !value);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-[rgba(15,17,23,0.82)] text-texte outline-none ring-1 ring-[rgba(249,249,249,0.35)] transition-colors hover:bg-[rgba(15,17,23,0.95)] focus-visible:ring-texte"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-8 right-0 z-[6] w-48 overflow-hidden rounded border border-[rgba(249,249,249,0.16)] bg-[rgba(20,22,30,0.98)] py-1 text-left shadow-[0_12px_30px_rgba(0,0,0,0.6)]"
        >
          <MenuItem
            onClick={(event) => {
              swallow(event);
              setOpen(false);
              onWatched();
            }}
          >
            Marquer comme vu
          </MenuItem>
          <MenuItem
            onClick={(event) => {
              swallow(event);
              setOpen(false);
              onRemove();
            }}
          >
            Retirer de la liste
          </MenuItem>

          {/* Le clic sur la vignette lit ; la fiche reste à un geste. */}
          <Link
            to={detailTo}
            role="menuitem"
            onClick={(event) => event.stopPropagation()}
            className="block px-3 py-2 text-[13px] text-faible outline-none hover:bg-[rgba(249,249,249,0.08)] hover:text-texte focus-visible:bg-[rgba(249,249,249,0.08)]"
          >
            Voir la fiche
          </Link>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
}: {
  onClick: (event: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-2 text-left text-[13px] text-faible outline-none hover:bg-[rgba(249,249,249,0.08)] hover:text-texte focus-visible:bg-[rgba(249,249,249,0.08)]"
    >
      {children}
    </button>
  );
}
