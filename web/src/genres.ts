import type { Genre } from './api';

/**
 * Le filtre actif vit dans l'URL sous forme de mot lisible — `?genre=comedie`
 * plutôt que `?genre=35`. Un lien partagé reste compréhensible, et il survit à
 * une reconstruction de la base où les identifiants TMDB pourraient changer.
 */
export function slugifyGenre(name: string): string {
  return (
    name
      .normalize('NFD')
      // Les diacritiques sont désignés par leur code plutôt qu'écrits en clair :
      // en clair ils sont invisibles dans l'éditeur, et le premier outil qui
      // recompose le fichier en NFC casse silencieusement la classe.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  );
}

export function findGenreBySlug(genres: Genre[], slug: string | null): Genre | null {
  if (slug === null || slug === '') return null;
  return genres.find((genre) => slugifyGenre(genre.name) === slug) ?? null;
}

/** Une œuvre ajoutée dans les 30 derniers jours porte la mention « Nouveau ». */
const NEW_WINDOW_MS = 30 * 24 * 3600 * 1000;

export function isNew(addedAt: string, now: number = Date.now()): boolean {
  const added = new Date(addedAt).getTime();
  // Une date illisible ne doit pas décorer toute la bibliothèque de « Nouveau ».
  if (Number.isNaN(added)) return false;
  return now - added < NEW_WINDOW_MS;
}
