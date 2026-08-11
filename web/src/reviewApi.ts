/** Appels de l'écran de review. */

export interface ReviewCandidate {
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  posterUrl: string | null;
  tmdbUrl: string;
  confidence: number;
  reason: string;
  matchedOn: string;
  matchedTitle: string | null;
}

export interface ReviewEntry {
  key: string;
  type: 'movie' | 'show';
  targetId: number;
  status: string;
  parsedTitle: string;
  parsedYear: number | null;
  filePaths: string[];
  candidates: ReviewCandidate[];
  tmdbId: number | null;
  confidence: number | null;
  reason: string | null;
  manuallyMatched: boolean;
  currentPosterUrl: string | null;
  position: number;
  total: number;
}

export interface ReviewQueue {
  total: number;
  items: ReviewEntry[];
}

export interface DecisionResult {
  next: ReviewEntry | null;
  remaining: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error !== undefined) message = body.error;
    } catch {
      // Réponse non JSON : on garde le texte de statut.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export const reviewApi = {
  queue: () => request<ReviewQueue>('/api/review'),
  entry: (key: string) => request<ReviewEntry>(`/api/review/${key}`),

  search: (key: string, body: { title?: string; year?: number | null; tmdbId?: string }) =>
    request<{ candidates: ReviewCandidate[] }>(`/api/review/${key}/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  apply: (key: string, tmdbId: number) =>
    request<DecisionResult>(`/api/review/${key}/apply`, {
      method: 'POST',
      body: JSON.stringify({ tmdbId }),
    }),

  ignore: (key: string) =>
    request<DecisionResult>(`/api/review/${key}/ignore`, { method: 'POST', body: JSON.stringify({}) }),
};
