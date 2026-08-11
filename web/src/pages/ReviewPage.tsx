import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ManualSearch } from '../components/ManualSearch';
import { ErrorMessage, Loading } from '../components/States';
import { reviewApi, type ReviewCandidate, type ReviewEntry } from '../reviewApi';

/**
 * Écran de tri des associations TMDB.
 *
 * Conçu pour l'enchaînement : une entrée à l'écran, une décision, l'entrée
 * suivante arrive dans la même réponse HTTP. Pas de retour à une liste, pas de
 * modale à rouvrir — sur soixante entrées, chaque aller-retour compte.
 */
export function ReviewPage() {
  const [searchParams] = useSearchParams();
  // « ?work=movie-123 » : ouverture sur une œuvre précise, depuis le bouton
  // « Corriger l'association » d'une page détail.
  const requestedKey = searchParams.get('work');

  const [entry, setEntry] = useState<ReviewEntry | null>(null);
  const [candidates, setCandidates] = useState<ReviewCandidate[]>([]);
  const [selected, setSelected] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  /*
   * Verrou synchrone contre la double validation.
   *
   * L'état `busy` ne suffit pas : React ne l'applique qu'au rendu suivant, donc
   * deux déclenchements dans le même tick — le clic sur le bouton ET la touche
   * Entrée — liraient tous deux `false` et enverraient deux requêtes.
   */
  const inFlight = useRef(false);

  const show = useCallback((next: ReviewEntry | null) => {
    setEntry(next);
    setCandidates(next?.candidates ?? []);
    setSelected(0);
    setSearchOpen(false);
    if (next === null) setDone(true);
  }, []);

  // Chargement initial : soit l'œuvre demandée, soit la tête de file.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDone(false);

    const load = async () => {
      try {
        if (requestedKey !== null) {
          const one = await reviewApi.entry(requestedKey);
          if (!cancelled) {
            show(one);
            setRemaining(one.total);
          }
          return;
        }
        const queue = await reviewApi.queue();
        if (cancelled) return;
        setRemaining(queue.total);
        show(queue.items[0] ?? null);
      } catch (caught) {
        if (!cancelled) setError(caught);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [requestedKey, show]);

  const decide = useCallback(
    async (run: (key: string) => Promise<{ next: ReviewEntry | null; remaining: number }>) => {
      if (entry === null || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await run(entry.key);
        setRemaining(result.remaining);
        show(result.next);
      } catch (caught) {
        setError(caught);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [entry, show],
  );

  const applySelected = useCallback(async () => {
    const candidate = candidates[selected];
    if (candidate === undefined) return;
    await decide((key) => reviewApi.apply(key, candidate.tmdbId));
  }, [candidates, selected, decide]);

  const ignoreCurrent = useCallback(async () => {
    await decide((key) => reviewApi.ignore(key));
  }, [decide]);

  // --- Raccourcis clavier ---------------------------------------------------
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      // Entrée sur un bouton déclenche déjà son clic : laisser le raccourci
      // s'ajouter enverrait deux fois la même décision.
      const onControl = target?.tagName === 'BUTTON' || target?.tagName === 'A';

      // « / » ouvre la recherche même hors champ ; le reste ne s'applique pas
      // pendant la saisie, sinon « s » deviendrait impossible à taper.
      if (!typing && event.key === '/') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (typing) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((current) => Math.min(current + 1, Math.max(candidates.length - 1, 0)));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((current) => Math.max(current - 1, 0));
      } else if (event.key === 'Enter') {
        if (onControl) return;
        event.preventDefault();
        void applySelected();
      } else if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        void ignoreCurrent();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [candidates.length, applySelected, ignoreCurrent]);

  // Garde le candidat sélectionné visible quand on descend au clavier.
  useEffect(() => {
    const node = listRef.current?.querySelector(`[data-index="${selected}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (loading) return <Loading label="Chargement de la file…" />;
  if (error !== null && entry === null) return <ErrorMessage error={error} />;

  if (done || entry === null) {
    return (
      <div className="py-24 text-center">
        <p className="text-lg text-zinc-200">File vide.</p>
        <p className="mt-2 text-sm text-zinc-500">Toutes les œuvres ont été tranchées.</p>
        <Link to="/" className="mt-6 inline-block text-sm text-sky-400 hover:text-sky-300">
          Retour à l’accueil
        </Link>
      </div>
    );
  }

  return (
    <div className="pb-24">
      {/* En-tête : ce qui permet de trancher, toujours visible. */}
      <header className="sticky top-14 z-10 -mx-6 border-b border-zinc-900 bg-zinc-950/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold text-zinc-100">
            {entry.parsedTitle}{' '}
            <span className="text-zinc-500">{entry.parsedYear ?? 'année inconnue'}</span>
          </h1>
          <span className="text-sm text-zinc-500">
            {entry.type === 'movie' ? 'Film' : 'Série'} ·{' '}
            {remaining === 0 ? 'hors file' : `${entry.position} / ${remaining ?? entry.total}`}
          </span>
        </div>

        {entry.manuallyMatched && (
          <p className="mt-1 text-xs text-amber-300/80">Déjà tranchée à la main — nouveau choix possible.</p>
        )}

        {/* Le chemin est souvent le seul élément qui départage deux candidats. */}
        <div className="mt-2 space-y-0.5">
          {entry.filePaths.slice(0, 4).map((filePath) => (
            <p key={filePath} className="font-mono text-xs break-all text-zinc-500">
              {filePath}
            </p>
          ))}
          {entry.filePaths.length > 4 && (
            <p className="text-xs text-zinc-600">… et {entry.filePaths.length - 4} autres fichiers</p>
          )}
        </div>
      </header>

      {error !== null && <ErrorMessage error={error} />}

      <div className="mt-6 space-y-4">
        <ManualSearch
          entryKey={entry.key}
          initialTitle={entry.parsedTitle}
          initialYear={entry.parsedYear}
          open={searchOpen}
          onToggle={() => setSearchOpen((open) => !open)}
          onResults={(found) => {
            setCandidates(found);
            setSelected(0);
          }}
          onEscape={() => setSearchOpen(false)}
        />

        {candidates.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-4 py-8 text-center text-sm text-zinc-500">
            Aucun candidat. Utilisez la recherche manuelle, ou ignorez cette entrée avec « S ».
          </p>
        ) : (
          <div ref={listRef} className="space-y-3">
            {candidates.map((candidate, index) => (
              <CandidateCard
                key={candidate.tmdbId}
                candidate={candidate}
                index={index}
                selected={index === selected}
                busy={busy}
                onSelect={() => setSelected(index)}
                onApply={() => {
                  setSelected(index);
                  void applySelected();
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Rappel discret des raccourcis. */}
      <footer className="fixed inset-x-0 bottom-0 border-t border-zinc-900 bg-zinc-950/95 px-6 py-2 backdrop-blur">
        <p className="mx-auto max-w-7xl text-xs text-zinc-600">
          <Shortcut keys="↑ ↓" label="choisir" />
          <Shortcut keys="Entrée" label="valider et passer au suivant" />
          <Shortcut keys="S" label="ignorer" />
          <Shortcut keys="/" label="recherche manuelle" />
          <Shortcut keys="Échap" label="quitter la recherche" />
        </p>
      </footer>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="mr-5 inline-block whitespace-nowrap">
      <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-zinc-400">{keys}</kbd>
      <span className="ml-1.5">{label}</span>
    </span>
  );
}

interface CandidateCardProps {
  candidate: ReviewCandidate;
  index: number;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onApply: () => void;
}

function CandidateCard({ candidate, index, selected, busy, onSelect, onApply }: CandidateCardProps) {
  return (
    <article
      data-index={index}
      onClick={onSelect}
      className={`flex cursor-pointer gap-4 rounded-lg border p-4 transition ${
        selected ? 'border-sky-600 bg-sky-950/20' : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700'
      }`}
    >
      <div className="h-36 w-24 shrink-0 overflow-hidden rounded border border-zinc-800 bg-zinc-900">
        {candidate.posterUrl !== null && (
          <img
            src={candidate.posterUrl}
            alt=""
            loading="lazy"
            width={92}
            height={138}
            className="h-full w-full object-cover"
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-base font-medium text-zinc-100">{candidate.title}</h2>
          <span className="text-sm text-zinc-500">{candidate.year ?? '?'}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${
              candidate.confidence >= 0.8 ? 'bg-emerald-950 text-emerald-300' : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {candidate.confidence.toFixed(2)}
          </span>
        </div>

        {candidate.originalTitle !== null && candidate.originalTitle !== candidate.title && (
          <p className="mt-0.5 text-xs text-zinc-500">titre original : {candidate.originalTitle}</p>
        )}

        <p className="mt-1 text-xs text-zinc-600">{candidate.reason}</p>

        {/* Synopsis complet : sur trois homonymes, c'est le seul discriminant. */}
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          {candidate.overview ?? <span className="text-zinc-600">Pas de synopsis.</span>}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <button
            type="button"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onApply();
            }}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 transition hover:border-zinc-500 disabled:opacity-50"
          >
            Valider ce choix
          </button>
          <a
            href={candidate.tmdbUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            TMDB {candidate.tmdbId} ↗
          </a>
        </div>
      </div>
    </article>
  );
}
