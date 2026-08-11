import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Rangée de pastilles de filtre, centrée et défilante.
 *
 * L'état actif est une inversion complète — fond clair, texte sombre — et non
 * une simple teinte : sur une rangée de dix pastilles, une nuance ne se repère
 * pas d'un coup d'œil.
 */

export interface PillOption {
  key: string;
  label: string;
}

interface FilterPillsProps {
  options: PillOption[];
  active: string;
  onChange: (key: string) => void;
}

export function FilterPills({ options, active, onChange }: FilterPillsProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState(false);

  const measure = useCallback(() => {
    const node = scroller.current;
    if (node === null) return;
    setCanScroll(node.scrollLeft + node.clientWidth < node.scrollWidth - 8);
  }, []);

  useEffect(() => {
    measure();
    const node = scroller.current;
    if (node === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, options]);

  return (
    <div className="relative">
      <div
        ref={scroller}
        onScroll={measure}
        // `justify-center` centre tant que ça rentre, et laisse défiler sinon.
        className="row-scroll flex justify-center gap-3 overflow-x-auto px-16 py-1"
      >
        {options.map((option) => {
          const isActive = option.key === active;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onChange(option.key)}
              aria-pressed={isActive}
              className={`h-10 shrink-0 rounded-[20px] px-5 text-[14px] font-semibold transition-colors ${
                isActive
                  ? 'bg-texte text-fond'
                  : 'border border-[rgba(249,249,249,0.3)] text-texte hover:border-[rgba(249,249,249,0.6)]'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {canScroll && (
        <button
          type="button"
          onClick={() => scroller.current?.scrollBy({ left: 320, behavior: 'smooth' })}
          aria-label="Voir plus de genres"
          className="absolute top-0 right-4 bottom-0 flex w-10 items-center justify-center bg-[linear-gradient(to_right,rgba(15,17,23,0),rgba(15,17,23,0.95)_40%)] text-texte"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      )}
    </div>
  );
}
