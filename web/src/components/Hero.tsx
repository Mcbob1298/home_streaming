import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { computeContentLayout, computeSlideLayout } from './heroLayout';
import { formatRuntime } from './MediaTile';

/**
 * Carrousel du hero.
 *
 * Le détail qui fait « Disney+ » est le dépassement des diapositives voisines
 * DES DEUX CÔTÉS. Dans la maquette : conteneur 1440, diapositive 1240, gap 16,
 * décalage −1156 pour la deuxième. Vérification :
 *
 *   −1 × (1240 + 16) + (1440 − 1240) / 2 = −1256 + 100 = −1156  ✓
 *
 * Le terme (conteneur − diapositive) / 2 est le dépassement, identique à
 * gauche et à droite. L'oublier ne se voit que d'un côté, et c'est justement
 * l'erreur facile à commettre.
 *
 * Le conteneur étant fluide, on le mesure plutôt que de figer 1440.
 */

const GAP = 16;

/**
 * Durée unique du changement de diapositive ET du point indicateur.
 *
 * Elles différaient auparavant — 500 ms pour la diapositive, 300 ms pour le
 * point — et pendant les 200 ms d'écart le point désignait déjà la diapositive
 * suivante alors que l'image glissait encore vers elle. À l'œil, et sur une
 * capture, les deux paraissaient désynchronisés. 400 ms est aussi le plafond
 * fixé pour toute animation de l'interface.
 */
const SLIDE_MS = 400;

const AUTOPLAY_MS = 8000;

export interface HeroItem {
  id: number;
  kind: 'movie' | 'show';
  title: string;
  logoUrl: string | null;
  logoSrcSet: string | null;
  backdropUrl: string | null;
  backdropSrcSet: string | null;
  year: number | null;
  genres: string[];
  runtimeMinutes: number | null;
  overview: string | null;
  isNew: boolean;
}

export function Hero({ items }: { items: HeroItem[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [layout, setLayout] = useState({ slide: 0, peek: 0, height: 0, compact: false });
  const container = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const node = container.current;
    if (node === null) return;
    setLayout(computeSlideLayout(node.clientWidth, window.innerHeight));
  }, []);

  useLayoutEffect(() => {
    measure();
    const node = container.current;
    if (node === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    if (paused || items.length < 2) return;
    const timer = setInterval(() => setIndex((current) => (current + 1) % items.length), AUTOPLAY_MS);
    return () => clearInterval(timer);
  }, [paused, items.length]);

  // Si la liste raccourcit, l'index pourrait désigner une diapositive disparue.
  useEffect(() => {
    setIndex((current) => (current >= items.length ? 0 : current));
  }, [items.length]);

  if (items.length === 0 || layout.slide === 0) {
    // Hauteur réservée dès le premier rendu : la page ne saute pas quand les
    // mesures arrivent.
    return <div ref={container} className="h-[470px] w-full" />;
  }

  // Le dépassement vaut zéro en mode compact : la formule reste la même.
  const offset = -index * (layout.slide + GAP) + layout.peek;
  const { height, compact } = layout;

  return (
    <div
      ref={container}
      className="w-full overflow-hidden"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="group/hero relative">
        <div
          className="flex transition-transform ease-out motion-reduce:transition-none"
          style={{ gap: GAP, transform: `translateX(${offset}px)`, transitionDuration: `${SLIDE_MS}ms` }}
        >
          {items.map((item, position) => (
            <Slide
              key={`${item.kind}-${item.id}`}
              item={item}
              width={layout.slide}
              height={height}
              compact={compact}
              // Les diapositives hors champ ne doivent pas capter le clavier.
              inert={position !== index}
            />
          ))}
        </div>

        {items.length > 1 && (
          <>
            <HeroArrow
              direction="left"
              disabled={index === 0}
              onClick={() => setIndex((current) => Math.max(0, current - 1))}
            />
            <HeroArrow
              direction="right"
              disabled={index === items.length - 1}
              onClick={() => setIndex((current) => Math.min(items.length - 1, current + 1))}
            />
          </>
        )}
      </div>

      {/* Points indicateurs : l'actif s'allonge, il ne change pas que de couleur. */}
      <div className="mt-5 flex justify-center gap-2">
        {items.map((item, position) => (
          <button
            key={`dot-${item.kind}-${item.id}`}
            type="button"
            onClick={() => setIndex(position)}
            aria-label={`Diapositive ${position + 1}`}
            aria-current={position === index}
            style={{ transitionDuration: `${SLIDE_MS}ms` }}
            className={`h-[7px] rounded-[4px] transition-all ease-out motion-reduce:transition-none ${
              position === index ? 'w-[22px] bg-texte' : 'w-[7px] rounded-full bg-[rgba(249,249,249,0.3)]'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function Slide({
  item,
  width,
  height,
  compact,
  inert,
}: {
  item: HeroItem;
  width: number;
  height: number;
  compact: boolean;
  inert: boolean;
}) {
  const meta = [
    item.year === null ? null : String(item.year),
    item.genres.slice(0, 2).join(', ') || null,
    formatRuntime(item.runtimeMinutes),
  ].filter((part): part is string => part !== null && part !== '');

  const detailPath = `/${item.kind === 'movie' ? 'movie' : 'show'}/${item.id}`;

  // Le bloc de contenu se dimensionne sur la DIAPOSITIVE, pas sur la fenêtre.
  const content = computeContentLayout(width, height, { compact, hasBadge: item.isNew });

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-lg bg-surface"
      style={{ width, height }}
      // `inert` retire tout le sous-arbre du parcours clavier et du pointeur.
      {...(inert ? { inert: '' } : {})}
    >
      {item.backdropUrl !== null && (
        <img
          src={item.backdropUrl}
          srcSet={item.backdropSrcSet ?? undefined}
          // La diapositive occupe 86 % de la largeur de fenêtre, 100 % en compact.
          sizes="(max-width: 768px) 100vw, 86vw"
          alt=""
          width={1240}
          height={470}
          loading="eager"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {/* Deux dégradés superposés : vers la droite pour le texte, vers le haut pour l'assise. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(to_right,rgba(15,17,23,0.94)_0%,rgba(15,17,23,0.72)_34%,rgba(15,17,23,0.1)_62%,rgba(15,17,23,0)_100%)]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(to_top,rgba(15,17,23,0.7)_0%,rgba(15,17,23,0)_55%)]"
      />

      {/*
        Toutes les dimensions du bloc viennent de `content`, calculé à partir de
        la diapositive et non de la fenêtre. C'est ce qui garantit qu'il reste
        dans le cadre — en haut, en bas et à droite — à toutes les largeurs.
      */}
      <div
        className="absolute"
        style={{ left: content.padX, bottom: content.padY, width: content.width }}
      >
        {item.isNew && (
          <div
            className="accent-gradient inline-flex h-6 items-center rounded px-[11px] text-[10px] font-bold tracking-[0.16em] uppercase"
            style={{ marginBottom: content.badgeGap }}
          >
            Nouveau
          </div>
        )}

        {item.logoUrl !== null ? (
          <img
            src={item.logoUrl}
            srcSet={item.logoSrcSet ?? undefined}
            sizes={`${content.width}px`}
            alt={item.title}
            // `max-w-full` en plus de la hauteur : un logo très large ne doit
            // pas non plus sortir du bloc sur les côtés.
            className="max-w-full object-contain object-left drop-shadow-[0_4px_30px_rgba(0,0,0,0.6)]"
            style={{ maxHeight: content.logoMax }}
          />
        ) : (
          <h2
            className="leading-[0.95] font-bold tracking-[0.06em] uppercase [text-shadow:0_4px_30px_rgba(0,0,0,0.6)]"
            style={{ fontSize: content.titleSize }}
          >
            {item.title}
          </h2>
        )}

        <div
          className="h-[2px] w-24 bg-texte opacity-85"
          style={{ marginTop: content.ruleTop, marginBottom: content.ruleBottom }}
        />

        <div
          className="flex flex-wrap items-center gap-[10px] text-texte opacity-90"
          style={{ fontSize: content.metaSize }}
        >
          {meta.map((part, position) => (
            <span key={part} className="flex items-center gap-[10px]">
              {position > 0 && <span className="opacity-40">·</span>}
              {part}
            </span>
          ))}
        </div>

        {/*
          Le synopsis disparaît quand le reste du bloc ne laisse plus la place
          de l'afficher en entier — pas à un seuil de fenêtre choisi à la main.
        */}
        {item.overview !== null && content.showSynopsis && (
          <p
            className="line-clamp-3 leading-[1.55] text-faible"
            style={{ marginTop: Math.round(content.ruleBottom * 0.9), fontSize: content.metaSize }}
          >
            {item.overview}
          </p>
        )}

        <div className="flex flex-wrap gap-[14px]" style={{ marginTop: content.buttonsTop }}>
          <button
            type="button"
            disabled
            title="Disponible prochainement"
            className="accent-gradient flex cursor-not-allowed items-center gap-[10px] rounded font-semibold opacity-60 shadow-[0_8px_24px_rgba(0,99,229,0.35)]"
            style={{
              height: content.buttonHeight,
              paddingInline: Math.round(content.buttonHeight * 0.74),
              fontSize: content.buttonText,
            }}
          >
            <svg width="13" height="15" viewBox="0 0 13 15" fill="currentColor" aria-hidden="true">
              <path d="M0 0l13 7.5L0 15z" />
            </svg>
            Lire
          </button>
          <Link
            to={detailPath}
            className="flex items-center rounded border border-[rgba(249,249,249,0.55)] font-semibold tracking-[0.18em] uppercase text-texte transition-colors hover:bg-[rgba(249,249,249,0.1)]"
            style={{
              height: content.buttonHeight,
              paddingInline: Math.round(content.buttonHeight * 0.56),
              fontSize: content.buttonText - 3,
            }}
          >
            Plus d’infos
          </Link>
        </div>
      </div>
    </div>
  );
}

function HeroArrow({
  direction,
  disabled,
  onClick,
}: {
  direction: 'left' | 'right';
  disabled: boolean;
  onClick: () => void;
}) {
  if (disabled) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === 'left' ? 'Diapositive précédente' : 'Diapositive suivante'}
      className={[
        'absolute top-0 bottom-0 z-[5] flex w-16 items-center justify-center',
        direction === 'left' ? 'left-0' : 'right-0',
        'text-texte opacity-0 transition-opacity duration-200',
        'group-hover/hero:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none',
      ].join(' ')}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {direction === 'left' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
      </svg>
    </button>
  );
}
