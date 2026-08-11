import { Fragment } from 'react';
import { Link } from 'react-router-dom';

/**
 * La vignette. C'est elle qui porte toute l'impression de l'interface.
 *
 * Quatre points de conception, tous repris des maquettes :
 *
 * 1. **La bordure de 3px existe déjà au repos**, en transparent. Au survol elle
 *    change seulement de couleur. Si on l'ajoutait au survol, la vignette
 *    grandirait de 6px d'un coup, en plus de l'agrandissement — un sursaut.
 *
 * 2. **Le conteneur de métadonnées fait 40px en permanence**, vide au repos.
 *    Les afficher au survol sans réserver la place ferait sauter toute la
 *    rangée à chaque passage de souris.
 *
 * 3. **Seule la couche intérieure s'agrandit**, pas l'élément de flux. Les
 *    voisines ne bougent donc pas : le survol passe au-dessus.
 *
 * 4. Le groupe est porté par le conteneur extérieur, pas par le lien : les
 *    métadonnées vivent en dehors du lien et doivent réagir au même survol.
 */

export interface MediaTileProps {
  to: string;
  title: string;
  /** Logo du titre. Absent pour 9 œuvres sur 481 : le repli typographique prend le relais. */
  logoUrl: string | null;
  logoSrcSet?: string | null;
  backdropUrl: string | null;
  backdropSrcSet?: string | null;
  /** Repli quand l'œuvre n'a pas de backdrop : l'affiche verticale, recadrée. */
  posterUrl: string | null;
  posterSrcSet?: string | null;
  /** Sur-titre du repli typographique. Omis s'il n'existe pas. */
  tagline?: string | null;
  year: number | null;
  genres: string[];
  runtimeMinutes: number | null;
  /** Mention posée en haut à gauche : « Nouveau », « Terminée ». */
  badge?: string | null;
  /** Occupe toute la largeur disponible au lieu des 288 px fixes (grilles). */
  fluid?: boolean;
  /** Déclenché au survol et au focus : précharge le détail avant le clic. */
  onPrefetch?: () => void;
}

/** Mention posée sur la vignette, discrète mais lisible. */
export function TileBadge({ label }: { label: string }) {
  return (
    <span className="absolute top-2 left-2 z-[1] rounded bg-[rgba(249,249,249,0.92)] px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-fond uppercase">
      {label}
    </span>
  );
}

/** 128 → « 2 h 08 ». */
export function formatRuntime(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return `${hours} h ${String(rest).padStart(2, '0')}`;
}

/**
 * Le survol et le focus clavier produisent exactement le même état.
 *
 * `focus-visible` et non `focus-within` : le premier ne s'active qu'au clavier.
 * Avec `focus-within`, un clic à la souris laissait la vignette agrandie une
 * fois le pointeur parti, puisque le lien gardait le focus. La navigation au
 * D-pad d'Android TV émet des événements clavier, le comportement télévision
 * est donc préservé.
 */
export const RAISED = [
  'group-hover:z-[4] group-hover:scale-[1.08] group-hover:border-texte',
  'group-hover:shadow-[0_16px_38px_rgba(0,0,0,0.7)]',
  'group-focus-visible:z-[4] group-focus-visible:scale-[1.08] group-focus-visible:border-texte',
  'group-focus-visible:shadow-[0_16px_38px_rgba(0,0,0,0.7)]',
].join(' ');

export function MediaTile({
  to,
  title,
  logoUrl,
  logoSrcSet,
  backdropUrl,
  backdropSrcSet,
  posterUrl,
  posterSrcSet,
  tagline,
  year,
  genres,
  runtimeMinutes,
  badge,
  fluid = false,
  onPrefetch,
}: MediaTileProps) {
  const imageUrl = backdropUrl ?? posterUrl;
  const imageSrcSet = backdropUrl !== null ? backdropSrcSet : posterSrcSet;
  // Sans backdrop on recadre l'affiche verticale. Le cadrage haut évite de
  // couper les visages, presque toujours dans le tiers supérieur.
  const isPosterFallback = backdropUrl === null && posterUrl !== null;

  const meta = [
    year === null ? null : String(year),
    genres.slice(0, 2).join(', ') || null,
    formatRuntime(runtimeMinutes),
  ].filter((part): part is string => part !== null && part !== '');

  return (
    // En grille la vignette prend la largeur de sa colonne et garde le 16:9 ;
    // en rangée elle conserve les 288 × 162 de la maquette.
    <div className={fluid ? 'w-full' : 'w-72 shrink-0'}>
      {/*
        `group` pour la couche intérieure, qui est un enfant du lien ;
        `peer` pour les métadonnées, qui sont un frère suivant. Les deux
        réagissent ainsi au survol et au focus clavier du même lien.
      */}
      <Link
        to={to}
        onMouseEnter={onPrefetch}
        onFocus={onPrefetch}
        aria-label={title}
        className={`group peer relative block outline-none ${fluid ? 'aspect-video' : 'h-[162px]'}`}
      >
        <div
          className={[
            'absolute inset-0 box-border overflow-hidden rounded border-[3px] border-transparent bg-surface',
            // « ease » et non « ease-out » : c'est la courbe des maquettes.
            'transition-transform duration-[180ms] ease-[ease] motion-reduce:transition-none',
            /*
             * L'agrandissement était flou : le navigateur interpolait la couche
             * déjà peinte au lieu de la redessiner. `will-change` et
             * `backface-visibility` la promeuvent sur le GPU en amont, elle est
             * alors composée à la résolution finale.
             */
            'transform-gpu will-change-transform [backface-visibility:hidden]',
            RAISED,
          ].join(' ')}
        >
          {imageUrl !== null && (
            <img
              src={imageUrl}
              srcSet={imageSrcSet ?? undefined}
              // La vignette fait 288px, mais l'agrandissement à 1,08 la porte à
              // 311px : c'est cette largeur-là qu'il faut annoncer.
              sizes="311px"
              alt=""
              loading="lazy"
              decoding="async"
              width={282}
              height={156}
              className={`h-full w-full object-cover ${isPosterFallback ? 'object-[center_25%]' : ''}`}
            />
          )}

          {/* Dégradé de lisibilité, sous le logo. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.78)_0%,rgba(0,0,0,0.16)_46%,rgba(0,0,0,0)_72%)]"
          />

          {badge !== null && badge !== undefined && <TileBadge label={badge} />}

          <div className="absolute right-[14px] bottom-[12px] left-[14px]">
            {logoUrl !== null ? (
              <img
                src={logoUrl}
                srcSet={logoSrcSet ?? undefined}
                sizes="218px"
                alt={title}
                loading="lazy"
                decoding="async"
                className="max-h-[46px] max-w-[70%] object-contain object-left-bottom drop-shadow-[0_2px_12px_rgba(0,0,0,0.75)]"
              />
            ) : (
              <>
                {tagline !== null && tagline !== undefined && tagline !== '' && (
                  <div className="mb-[3px] truncate text-[8px] font-semibold tracking-[0.34em] text-[rgba(249,249,249,0.7)] uppercase">
                    {tagline}
                  </div>
                )}
                <div className="text-[15px] leading-[1.05] font-bold tracking-[0.15em] text-texte uppercase [text-shadow:0_2px_12px_rgba(0,0,0,0.75)]">
                  {title}
                </div>
              </>
            )}
          </div>
        </div>
      </Link>

      {/*
        Hauteur fixe, occupée ou non : c'est ce qui empêche la rangée entière
        de se décaler quand la souris passe d'une vignette à l'autre.

        Les classes `peer-*` doivent être portées par le FRÈRE DIRECT du lien :
        le sélecteur généré est `.peer:hover ~ .peer-hover\:…`, qui exige une
        relation de fratrie. Les poser sur le div intérieur ne produisait
        aucune règle applicable, et les métadonnées restaient invisibles.
      */}
      <div className="h-10 pt-4 opacity-0 transition-opacity duration-[180ms] peer-hover:opacity-100 peer-focus-visible:opacity-100 motion-reduce:transition-none">
        <div className="flex justify-center gap-[7px] text-[12px] text-faible">
          {meta.map((part, index) => (
            <Fragment key={part}>
              {index > 0 && <span className="opacity-45">·</span>}
              <span className="whitespace-nowrap">{part}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
