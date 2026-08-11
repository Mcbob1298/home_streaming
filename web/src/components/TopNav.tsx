import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';

/**
 * Barre de navigation fixe, reprise de TopNav.dc.html.
 *
 * Le fond est translucide avec flou d'arrière-plan et s'opacifie au défilement :
 * transparent en haut de page pour laisser respirer le hero, opaque dès qu'on
 * descend pour rester lisible sur les vignettes claires.
 */

const NAV = [
  { to: '/', label: 'Accueil', icon: 'home' },
  { to: '/library/films', label: 'Films', icon: 'film' },
  { to: '/library/series', label: 'Séries', icon: 'tv' },
  { to: '/genres', label: 'Genres', icon: 'grid' },
] as const;

type IconName = (typeof NAV)[number]['icon'];

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="opacity-95"
      aria-hidden="true"
    >
      {name === 'home' && <path d="M3 9.2 10 3.8l7 5.4V16a1 1 0 0 1-1 1h-3.5v-4.6h-5V17H4a1 1 0 0 1-1-1z" />}
      {name === 'film' && (
        <>
          <rect x="2.8" y="4.6" width="14.4" height="10.8" rx="1.4" />
          <path d="M6.6 4.6v10.8M13.4 4.6v10.8" />
        </>
      )}
      {name === 'tv' && (
        <>
          <rect x="2.8" y="4.2" width="14.4" height="9.6" rx="1.4" />
          <path d="M7 16.8h6" />
        </>
      )}
      {name === 'grid' && (
        <>
          <rect x="3" y="3" width="6" height="6" rx="1.2" />
          <rect x="11" y="3" width="6" height="6" rx="1.2" />
          <rect x="3" y="11" width="6" height="6" rx="1.2" />
          <rect x="11" y="11" width="6" height="6" rx="1.2" />
        </>
      )}
    </svg>
  );
}

export function TopNav({ profileName = 'Mathias' }: { profileName?: string }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-20 flex h-[68px] items-center justify-between px-10 backdrop-blur-[16px] transition-colors duration-300 ${
        scrolled ? 'bg-[rgba(15,17,23,0.94)]' : 'bg-[rgba(15,17,23,0.72)]'
      } border-b border-[rgba(249,249,249,0.06)]`}
    >
      <div className="flex items-center gap-3">
        <div className="accent-gradient flex h-[34px] w-[34px] items-center justify-center rounded-full text-[14px] font-bold text-texte">
          {profileName.slice(0, 1).toUpperCase()}
        </div>
        <div className="text-[14px] font-semibold text-texte">{profileName}</div>
      </div>

      <nav className="flex items-center gap-[34px]">
        {NAV.map((entry) => (
          <NavLink key={entry.to} to={entry.to} end={entry.to === '/'} className="flex flex-col items-center gap-[7px]">
            {({ isActive }) => (
              <>
                <span
                  className={`flex items-center gap-2 text-[14px] font-semibold ${
                    isActive ? 'text-texte' : 'text-faible'
                  }`}
                >
                  <Icon name={entry.icon} />
                  {entry.label}
                </span>
                {/* Le trait n'existe que sous l'entrée active. */}
                {isActive && <span className="h-[2px] w-full rounded-[2px] bg-texte" />}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/*
        La loupe MÈNE à la recherche, elle ne déplie plus de champ ici : une
        page dédiée a la place d'afficher des rangées à parcourir tant que rien
        n'est saisi, ce qu'un champ de 256px dans la barre ne pouvait pas faire.
      */}
      <div className="flex items-center gap-[18px] text-texte">
        <NavLink to="/search" aria-label="Rechercher" className="p-1 text-faible hover:text-texte" title="Rechercher">
          {({ isActive }) => (
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              className={isActive ? 'text-texte' : undefined}
            >
              <circle cx="9" cy="9" r="5.4" />
              <path d="M13.2 13.2 17 17" />
            </svg>
          )}
        </NavLink>
      </div>
    </header>
  );
}
