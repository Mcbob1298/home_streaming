/**
 * Routes de l'écran de review.
 *
 * Ce sont les seules routes qui écrivent en base et qui appellent TMDB. Elles
 * n'enfreignent pas la règle « aucun scan par HTTP » : elles enrichissent UNE
 * œuvre désignée à la main, pas la bibliothèque entière.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { Db } from '../db/index.js';
import { applyTmdbId, ignoreWork, type EnrichContext } from '../metadata/enrich.js';
import { defaultImagePath } from '../metadata/images.js';
import type { ScoredCandidate } from '../metadata/match.js';
import {
  fetchById,
  nextInQueue,
  parseReviewKey,
  reviewEntry,
  reviewQueue,
  reviewQueueKeys,
  searchTmdb,
  type ReviewEntry,
} from '../metadata/review.js';
import { TmdbTokenMissingError } from '../metadata/tmdb.js';
import type { TargetType } from '../metadata/store.js';

/**
 * Le contexte d'enrichissement n'est construit qu'à la demande, et peut lever.
 *
 * Sans jeton TMDB, le serveur doit démarrer quand même : seules ces routes
 * deviennent indisponibles, et elles le disent clairement.
 */
export type EnrichContextFactory = () => EnrichContext;

/**
 * Les affiches des candidats viennent directement de TMDB.
 *
 * C'est la seule exception à la règle « pas d'image distante à l'affichage » :
 * ces candidats n'ont pas été retenus, donc rien n'a été téléchargé. Les
 * rapatrier tous reviendrait à télécharger cinq affiches par entrée pour n'en
 * garder qu'une.
 */
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w185';

function decorateCandidate(candidate: ScoredCandidate, type: TargetType): unknown {
  const kind = type === 'movie' ? 'movie' : 'tv';
  return {
    ...candidate,
    posterUrl: candidate.posterPath === null ? null : `${TMDB_POSTER_BASE}${candidate.posterPath}`,
    tmdbUrl: `https://www.themoviedb.org/${kind}/${candidate.tmdbId}`,
  };
}

function decorateEntry(entry: ReviewEntry, position: number, total: number): unknown {
  return {
    ...entry,
    position,
    total,
    candidates: entry.candidates.map((candidate) => decorateCandidate(candidate, entry.type)),
    currentPosterUrl:
      entry.currentPosterPath === null ? null : defaultImagePath(entry.currentPosterPath, 'poster'),
  };
}

export function registerReviewRoutes(app: FastifyInstance, db: Db, enrichContext: EnrichContextFactory): void {
  /** Position d'une entrée dans la file, pour le compteur « 12 / 62 ». */
  function positionOf(key: string): { position: number; total: number } {
    const keys = reviewQueueKeys(db);
    const index = keys.indexOf(key);
    return { position: index === -1 ? 0 : index + 1, total: keys.length };
  }

  function describe(entry: ReviewEntry): unknown {
    const { position, total } = positionOf(entry.key);
    return decorateEntry(entry, position, total);
  }

  /** Récupère le contexte TMDB, ou répond 503 avec un message actionnable. */
  function contextOrFail(reply: FastifyReply): EnrichContext | null {
    try {
      return enrichContext();
    } catch (error) {
      if (error instanceof TmdbTokenMissingError) {
        reply.code(503).send({ error: error.message });
        return null;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/review — la file complète
  // -------------------------------------------------------------------------
  app.get('/api/review', () => {
    const queue = reviewQueue(db);
    return {
      total: queue.length,
      items: queue.map((entry, index) => decorateEntry(entry, index + 1, queue.length)),
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/review/:id — une entrée, qu'elle soit dans la file ou non
  // -------------------------------------------------------------------------
  app.get('/api/review/:id', (request, reply) => {
    const key = parseReviewKey((request.params as { id: string }).id);
    if (key === null) return reply.code(400).send({ error: 'Identifiant attendu : movie-123 ou show-45' });

    const entry = reviewEntry(db, key);
    if (entry === null) return reply.code(404).send({ error: 'Œuvre introuvable' });
    return describe(entry);
  });

  // -------------------------------------------------------------------------
  // POST /api/review/:id/search — recherche manuelle, fr-FR + en-US
  // -------------------------------------------------------------------------
  app.post('/api/review/:id/search', async (request, reply) => {
    const key = parseReviewKey((request.params as { id: string }).id);
    if (key === null) return reply.code(400).send({ error: 'Identifiant invalide' });

    const context = contextOrFail(reply);
    if (context === null) return reply;

    const body = (request.body ?? {}) as { title?: string; year?: number | string | null; tmdbId?: number | string };

    // Un identifiant collé depuis le site : on ne cherche pas, on va droit à la
    // fiche. C'est le chemin le plus court pour les titres numérotés, que la
    // recherche par titre ne sait pas départager.
    const rawId = body.tmdbId;
    if (rawId !== undefined && String(rawId).trim() !== '') {
      const tmdbId = Number(rawId);
      if (!Number.isFinite(tmdbId)) return reply.code(400).send({ error: 'Identifiant TMDB invalide' });

      const candidate = await fetchById(context.client, key.type, tmdbId);
      if (candidate === null) return reply.code(404).send({ error: `Aucune œuvre TMDB ${tmdbId}` });
      return { candidates: [decorateCandidate(candidate, key.type)] };
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title === '') return reply.code(400).send({ error: 'Titre requis' });

    const rawYear = body.year;
    const year =
      rawYear === null || rawYear === undefined || rawYear === '' || !Number.isFinite(Number(rawYear))
        ? null
        : Number(rawYear);

    const candidates = await searchTmdb(context.client, key.type, title, year);
    return { candidates: candidates.map((candidate) => decorateCandidate(candidate, key.type)) };
  });

  // -------------------------------------------------------------------------
  // POST /api/review/:id/apply — applique un choix, puis enchaîne
  // -------------------------------------------------------------------------
  app.post('/api/review/:id/apply', async (request, reply) => {
    const key = parseReviewKey((request.params as { id: string }).id);
    if (key === null) return reply.code(400).send({ error: 'Identifiant invalide' });

    const tmdbId = Number((request.body as { tmdbId?: number | string } | undefined)?.tmdbId);
    if (!Number.isFinite(tmdbId)) return reply.code(400).send({ error: 'tmdbId requis' });

    const context = contextOrFail(reply);
    if (context === null) return reply;

    // Enrichissement complet de cette seule œuvre : métadonnées, genres,
    // épisodes le cas échéant, et téléchargement des images.
    await applyTmdbId(context, key.type, key.id, tmdbId);

    const next = nextInQueue(db, key);
    return {
      applied: true,
      next: next === null ? null : describe(next),
      remaining: reviewQueueKeys(db).length,
    };
  });

  // -------------------------------------------------------------------------
  // POST /api/review/:id/ignore — volontairement sans métadonnées
  // -------------------------------------------------------------------------
  app.post('/api/review/:id/ignore', (request, reply) => {
    const key = parseReviewKey((request.params as { id: string }).id);
    if (key === null) return reply.code(400).send({ error: 'Identifiant invalide' });

    ignoreWork(db, key.type, key.id);

    const next = nextInQueue(db, key);
    return {
      ignored: true,
      next: next === null ? null : describe(next),
      remaining: reviewQueueKeys(db).length,
    };
  });
}
