import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Rangée horizontale défilante.
 *
 * Le point délicat est le rembourrage. Une vignette survolée grandit à 1,08 —
 * soit environ 6,5 px de débordement de chaque côté — et projette une ombre
 * `0 16px 38px`, qui s'étend de 22 px vers le haut et de 54 px vers le bas.
 * Or `overflow-x: auto` impose un rognage vertical : sans place réservée, le
 * survol serait coupé net.
 *
 * D'où le rembourrage asymétrique du conteneur défilant, annulé par des marges
 * négatives de même valeur pour que l'espace visible entre les rangées reste
 * celui de la maquette. Idem latéralement : 48 px suffisent largement aux
 * 6,5 px de débordement de la première et de la dernière vignette.
 */

const PAD_TOP = 30;
const PAD_BOTTOM = 62;

interface MediaRowProps {
  title: string;
  /** Lien optionnel du titre de rangée, vers la bibliothèque filtrée. */
  to?: string;
  children: React.ReactNode;
}

export function MediaRow({ title, to, children }: MediaRowProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const measure = useCallback(() => {
    const node = scroller.current;
    if (node === null) return;
    setCanLeft(node.scrollLeft > 8);
    setCanRight(node.scrollLeft + node.clientWidth < node.scrollWidth - 8);
  }, []);

  useEffect(() => {
    measure();
    const node = scroller.current;
    if (node === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, children]);

  function scrollBy(direction: -1 | 1) {
    const node = scroller.current;
    if (node === null) return;
    // On avance d'un écran moins une vignette, pour garder un repère visuel.
    node.scrollBy({ left: direction * (node.clientWidth - 302), behavior: 'smooth' });
  }

  return (
    <section className="group/row relative">
      <h2 className="mb-[14px] px-12 text-[19px] font-semibold">
        {to === undefined ? (
          title
        ) : (
          // Link et non <a> : un href rechargerait toute l'application.
          <Link to={to} className="outline-none hover:text-texte focus-visible:underline">
            {title}
          </Link>
        )}
      </h2>

      <div className="relative">
        <div
          ref={scroller}
          onScroll={measure}
          className="row-scroll flex gap-[14px] overflow-x-auto px-12"
          style={{
            paddingTop: PAD_TOP,
            paddingBottom: PAD_BOTTOM,
            marginTop: -PAD_TOP,
            marginBottom: -PAD_BOTTOM,
          }}
        >
          {children}
        </div>

        {canLeft && <Arrow direction="left" onClick={() => scrollBy(-1)} />}
        {canRight && <Arrow direction="right" onClick={() => scrollBy(1)} />}
      </div>
    </section>
  );
}

/** Les flèches n'apparaissent qu'au survol de la rangée, et seulement s'il reste du contenu. */
function Arrow({ direction, onClick }: { direction: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === 'left' ? 'Défiler vers la gauche' : 'Défiler vers la droite'}
      className={[
        'absolute top-0 bottom-0 z-[5] flex w-12 items-center justify-center',
        direction === 'left' ? 'left-0' : 'right-0',
        'bg-[rgba(15,17,23,0.75)] text-texte opacity-0 transition-opacity duration-200',
        'group-hover/row:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none',
      ].join(' ')}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {direction === 'left' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
      </svg>
    </button>
  );
}
