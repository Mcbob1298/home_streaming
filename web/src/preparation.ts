/**
 * Suivi de la préparation des sous-titres.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ON INTERROGE, MAIS SEULEMENT QUAND ÇA SERT.
 *
 * Pas de notification serveur : la cadence des événements est d'environ un
 * fichier toutes les quinze secondes, et une connexion persistante apporterait
 * une seconde de latence là où cinq suffisent — contre le coût d'un second canal
 * d'état à garder cohérent avec le cache de TanStack Query.
 *
 * Ce qui rend l'interrogation acceptable, c'est qu'elle ne porte QUE sur une
 * route minuscule qui lit des compteurs, et qu'elle S'ARRÊTE d'elle-même dès
 * qu'aucune passe ne tourne. Au repos, zéro requête.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

export interface PreparationStatus {
  available: boolean;
  running: boolean;
  paused: boolean;
  current: { mediaFileId: number; fileName: string; sizeBytes: number } | null;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Octets par seconde, moyennés sur les derniers fichiers. */
  throughput: number | null;
  remainingSeconds: number | null;
  failures: { mediaFileId: number; fileName: string; error: string }[];
}

/** Ce que « Rechercher ce qui manque » a trouvé. */
export interface EnqueueResult {
  /** Fichiers que la base ne connaissait pas encore. */
  added: number;
  /** Fichiers modifiés depuis leur préparation. */
  reactivated: number;
  unchanged: number;
  /** Fichiers dont il manque des WebVTT SUR LE DISQUE — la vraie vérification. */
  missing: number;
  missingBytes: number;
}

/**
 * La phrase que le bouton renvoie. Elle doit dire ce qui a été fait.
 *
 * Un bouton qui ne répond rien laisse croire qu'il n'a rien fait — c'est
 * exactement ce qui s'est passé quand il répondait « 0 nouveaux » sur une
 * bibliothèque entière restée sans sous-titres.
 */
export function resumeRecherche(result: EnqueueResult, formatOctets: (bytes: number) => string): string {
  const parts: string[] = [];
  if (result.added > 0) parts.push(`${result.added} nouveau(x)`);
  if (result.reactivated > 0) parts.push(`${result.reactivated} modifié(s) depuis leur préparation`);
  if (result.missing > 0) {
    parts.push(`${result.missing} sans sous-titres sur le disque (${formatOctets(result.missingBytes)} à relire)`);
  }

  if (parts.length === 0) return 'Rien à rattraper : chaque fichier présent a ses sous-titres.';
  return `Remis en file : ${parts.join(', ')}.`;
}

/** Cadence d'interrogation pendant une passe. Cinq secondes suffisent amplement. */
const POLL_MS = 5000;

async function fetchStatus(): Promise<PreparationStatus> {
  const response = await fetch('/api/preparation/status');
  if (!response.ok) throw new Error(`${response.status} — ${response.statusText}`);
  return (await response.json()) as PreparationStatus;
}

/** Une passe est-elle en train de travailler ? Pause comprise : elle reprendra. */
function active(status: PreparationStatus | undefined): boolean {
  if (status === undefined) return false;
  return status.filesTotal > status.filesDone;
}

/**
 * L'état de la passe, interrogé tant qu'elle avance.
 *
 * `refetchInterval` accepte une fonction : elle rend `false` quand il n'y a plus
 * rien à préparer, et l'interrogation cesse sans qu'on ait à la démonter.
 */
export function usePreparationStatus(): PreparationStatus | undefined {
  const { data } = useQuery({
    queryKey: ['preparation', 'status'],
    queryFn: fetchStatus,
    refetchInterval: (query) => (active(query.state.data) ? POLL_MS : false),
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  return data;
}

/**
 * Rafraîchit les listes quand des titres deviennent prêts.
 *
 * L'invalidation ne part QUE sur un changement réel du compteur : sans cette
 * garde, chaque interrogation relancerait toutes les requêtes de la page, et on
 * aurait remplacé une interrogation légère par un rechargement complet toutes
 * les cinq secondes.
 */
export function useLibraryRefresh(status: PreparationStatus | undefined): void {
  const queryClient = useQueryClient();
  const dernier = useRef<number | null>(null);

  useEffect(() => {
    if (status === undefined) return;

    if (dernier.current !== null && status.filesDone !== dernier.current) {
      void queryClient.invalidateQueries({ queryKey: ['movies'] });
      void queryClient.invalidateQueries({ queryKey: ['shows'] });
      void queryClient.invalidateQueries({ queryKey: ['libraries'] });
    }
    dernier.current = status.filesDone;
  }, [status, queryClient]);
}

// ---------------------------------------------------------------------------
// L'apparition ne doit pas faire sauter la page
// ---------------------------------------------------------------------------

/**
 * Conserve l'ordre courant et AJOUTE EN FIN ce qui vient d'arriver.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI PAS SIMPLEMENT AFFICHER LA NOUVELLE LISTE.
 *
 * « Ajouts récents » est trié par date décroissante : un titre qui devient prêt
 * s'insérerait EN TÊTE, poussant toute la rangée sous le curseur. C'est le pire
 * cas possible pendant qu'on parcourt.
 *
 * On garde donc les éléments déjà affichés dans leur ordre, et les nouveaux
 * viennent à la suite. L'ordre correct revient au prochain chargement de page :
 * l'incohérence est momentanée et invisible, un saut ne l'est pas.
 *
 * Le hook n'est actif que pendant une passe. Sinon il rend la liste telle
 * quelle, sans rien mémoriser.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function useStableOrder<T extends { id: number }>(items: T[], freeze: boolean): T[] {
  const ordre = useRef<number[]>([]);

  if (!freeze) {
    ordre.current = items.map((item) => item.id);
    return items;
  }

  const parId = new Map(items.map((item) => [item.id, item]));

  // Ceux qu'on affichait déjà, dans leur ordre — moins ceux qui ont disparu.
  const connus = ordre.current
    .map((id) => parId.get(id))
    .filter((item): item is T => item !== undefined);

  const dejaVus = new Set(connus.map((item) => item.id));
  const nouveaux = items.filter((item) => !dejaVus.has(item.id));

  const resultat = [...connus, ...nouveaux];
  ordre.current = resultat.map((item) => item.id);

  return resultat;
}

/** Identifiants apparus depuis le rendu précédent, pour l'animation d'entrée. */
export function useJustAdded<T extends { id: number }>(items: T[]): Set<number> {
  const connus = useRef<Set<number> | null>(null);
  const nouveaux = useRef<Set<number>>(new Set());

  const ids = new Set(items.map((item) => item.id));

  if (connus.current === null) {
    // Premier rendu : rien n'est « nouveau », tout est simplement là.
    connus.current = ids;
    nouveaux.current = new Set();
  } else {
    const apparus = [...ids].filter((id) => !(connus.current as Set<number>).has(id));
    if (apparus.length > 0) nouveaux.current = new Set(apparus);
    connus.current = ids;
  }

  return nouveaux.current;
}
