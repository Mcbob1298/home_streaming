import { useQuery } from '@tanstack/react-query';

import { api, type MovieSummary } from '../api';
import { MediaTile } from '../components/MediaTile';
import { ErrorMessage, Loading } from '../components/States';

/**
 * Page de démonstration de la vignette, isolée du reste de l'interface.
 *
 * Elle sert à juger le composant sur de vraies données avant de construire la
 * page d'accueil : les trois états côte à côte, et une rangée défilante pour
 * vérifier qu'un survol au bord n'est pas rogné.
 *
 * À retirer une fois la page d'accueil validée.
 */
export function TileDemoPage() {
  const movies = useQuery({
    queryKey: ['demo-movies'],
    queryFn: () => api.movies({ sort: 'added' }),
  });

  if (movies.isPending) return <Loading />;
  if (movies.error !== null) return <ErrorMessage error={movies.error} />;

  const items = movies.data.items;
  const avecLogo = items.filter((movie) => movie.logoPath !== null);
  const sansLogo = items.filter((movie) => movie.logoPath === null);

  return (
    <div className="space-y-16 pb-24">
      <header>
        <h1 className="text-[19px] font-semibold">Vignette — démonstration</h1>
        <p className="mt-2 max-w-2xl text-[14px] text-faible">
          288 × 162, bordure de 3px transparente au repos, agrandissement à 1,08 en 180 ms.
          Survolez, puis parcourez au clavier avec Tab : le focus produit le même état.
        </p>
      </header>

      <Section
        titre="Au repos et au survol"
        note="Les voisines ne bougent pas. Les métadonnées occupent une hauteur réservée, vide au repos."
      >
        {avecLogo.slice(0, 6).map((movie) => (
          <Tile key={movie.id} movie={movie} />
        ))}
      </Section>

      <Section
        titre={`Repli sans logo — ${sansLogo.length} sur cette page`}
        note="TMDB ne fournit pas de logo pour 9 œuvres sur 481. Le titre est alors composé typographiquement."
      >
        {sansLogo.length === 0 ? (
          <p className="text-[14px] text-faible">
            Aucune œuvre sans logo sur cette page. Exemple forcé ci-dessous.
          </p>
        ) : (
          sansLogo.slice(0, 6).map((movie) => <Tile key={movie.id} movie={movie} />)
        )}
      </Section>

      <Section
        titre="Repli forcé, pour comparaison"
        note="La même œuvre avec et sans logo, et une sans backdrop : l'affiche verticale est recadrée en 16:9."
      >
        {avecLogo.slice(0, 2).map((movie) => (
          <MediaTile
            key={`force-${movie.id}`}
            to={`/movie/${movie.id}`}
            title={movie.title}
            logoUrl={null}
            backdropUrl={movie.backdropPath}
      backdropSrcSet={movie.backdropSrcSet}
            posterUrl={movie.posterPath}
      posterSrcSet={movie.posterSrcSet}
            tagline={movie.tagline}
            year={movie.year}
            genres={[]}
            runtimeMinutes={movie.runtime ?? null}
          />
        ))}
        {avecLogo.slice(2, 4).map((movie) => (
          <MediaTile
            key={`poster-${movie.id}`}
            to={`/movie/${movie.id}`}
            title={movie.title}
            logoUrl={movie.logoPath}
      logoSrcSet={movie.logoSrcSet}
            backdropUrl={null}
            posterUrl={movie.posterPath}
      posterSrcSet={movie.posterSrcSet}
            tagline={movie.tagline}
            year={movie.year}
            genres={[]}
            runtimeMinutes={movie.runtime ?? null}
          />
        ))}
      </Section>

      <Section
        titre="Rangée défilante"
        note="Le rembourrage vertical du conteneur évite que l'agrandissement soit rogné par le débordement horizontal."
        scrollable
      >
        {items.map((movie) => (
          <Tile key={`row-${movie.id}`} movie={movie} />
        ))}
      </Section>
    </div>
  );
}

function Tile({ movie }: { movie: MovieSummary }) {
  return (
    <MediaTile
      to={`/movie/${movie.id}`}
      title={movie.title}
      logoUrl={movie.logoPath}
      logoSrcSet={movie.logoSrcSet}
      backdropUrl={movie.backdropPath}
      backdropSrcSet={movie.backdropSrcSet}
      posterUrl={movie.posterPath}
      posterSrcSet={movie.posterSrcSet}
      tagline={movie.tagline}
      year={movie.year}
      genres={[]}
      runtimeMinutes={movie.runtime ?? null}
    />
  );
}

interface SectionProps {
  titre: string;
  note: string;
  scrollable?: boolean;
  children: React.ReactNode;
}

function Section({ titre, note, scrollable = false, children }: SectionProps) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold">{titre}</h2>
      <p className="mt-1 mb-4 max-w-3xl text-[13px] text-faible">{note}</p>
      {/*
        py-6 : l'agrandissement à 1,08 fait déborder la vignette d'environ 7px
        en haut et en bas. Sans ce rembourrage, un conteneur à débordement
        horizontal la rognerait — l'ombre portée avec.
      */}
      <div className={`flex gap-[14px] py-6 ${scrollable ? 'row-scroll -mx-6 overflow-x-auto px-6' : 'flex-wrap'}`}>
        {children}
      </div>
    </section>
  );
}
