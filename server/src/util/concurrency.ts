/**
 * Limitation de concurrence.
 *
 * Le NAS est lent et se dégrade vite si on lui envoie des centaines de requêtes
 * en parallèle : SMB sérialise beaucoup de choses côté serveur, et Node ne fait
 * pas de limitation tout seul. On plafonne donc explicitement le nombre
 * d'opérations disque simultanées.
 */

/** Valeur par défaut : assez pour couvrir la latence réseau, pas assez pour noyer le NAS. */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Applique `worker` à chaque élément, au plus `limit` en parallèle.
 * Les résultats sont rendus dans l'ordre des éléments d'entrée.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  async function run(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, run));
  return results;
}

/** Petite attente, utilisée par le pool de parcours quand la file est vide. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
