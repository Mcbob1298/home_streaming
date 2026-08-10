/**
 * Affiche d'une œuvre.
 *
 * Il n'y a pas encore d'images : le champ `posterPath` existe déjà dans le
 * modèle de données, mais il vaut null partout. En attendant, on fabrique un
 * dégradé à partir du titre. Deux titres différents donnent deux dégradés
 * différents, et le même titre donne toujours le même — la grille reste
 * reconnaissable d'une visite à l'autre.
 *
 * Le jour où les affiches arriveront, seul ce composant changera.
 */

interface PosterProps {
  title: string;
  posterPath: string | null;
  className?: string;
}

/** Petit hachage déterministe, suffisant pour choisir une teinte. */
function hashTitle(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/** Une ou deux lettres, comme un avatar. */
function initials(title: string): string {
  const words = title.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${(words[0] ?? '')[0] ?? ''}${(words[1] ?? '')[0] ?? ''}`.toUpperCase();
}

export function Poster({ title, posterPath, className = '' }: PosterProps) {
  if (posterPath !== null) {
    return (
      <img
        src={posterPath}
        alt={title}
        loading="lazy"
        className={`h-full w-full object-cover ${className}`}
      />
    );
  }

  const hue = hashTitle(title) % 360;
  // Saturation et luminosité basses : on veut un fond sombre, pas un néon.
  const background = `linear-gradient(145deg,
    hsl(${hue} 38% 26%) 0%,
    hsl(${(hue + 35) % 360} 30% 14%) 100%)`;

  return (
    <div
      className={`flex h-full w-full items-center justify-center ${className}`}
      style={{ background }}
      aria-hidden="true"
    >
      <span className="text-3xl font-semibold tracking-wide text-white/25 select-none">
        {initials(title)}
      </span>
    </div>
  );
}
