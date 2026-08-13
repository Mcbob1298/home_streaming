import { useMutation, useQueryClient } from '@tanstack/react-query';

import { resumeRecherche, usePreparationStatus, type EnqueueResult, type PreparationStatus } from '../preparation';

/**
 * Page d'administration de la préparation des sous-titres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ELLE RÉPOND À UNE QUESTION : OÙ EN EST MA BIBLIOTHÈQUE ?
 *
 * L'interface normale cache ce qui n'est pas prêt — c'est le principe. Il faut
 * donc un endroit qui montre l'envers : ce qui reste, à quelle vitesse ça avance,
 * et combien de temps ça va encore prendre.
 *
 * Et un bouton pour rendre le disque. La passe dure seize heures : vouloir
 * regarder un film pendant qu'elle tourne n'est pas un cas limite, c'est le cas
 * normal.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** « 2,31 Tio », « 940 Mo ». Les octets se lisent mal en chiffres bruts. */
function octets(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} Tio`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} Mo`;
  return `${Math.round(bytes / 1024)} Ko`;
}

/** « 3 h 12 min », « 47 s ». */
function duree(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min`;
  return `${total} s`;
}

export function PreparationPage() {
  const status = usePreparationStatus();
  const queryClient = useQueryClient();

  const rafraichir = () => {
    void queryClient.invalidateQueries({ queryKey: ['preparation', 'status'] });
  };

  const pause = useMutation({
    mutationFn: () => fetch('/api/preparation/pause', { method: 'POST' }),
    onSuccess: rafraichir,
  });
  const reprendre = useMutation({
    mutationFn: () => fetch('/api/preparation/resume', { method: 'POST' }),
    onSuccess: rafraichir,
  });
  /*
   * Celle-ci lit sa réponse, contrairement aux deux autres : la pause et la
   * reprise se voient dans l'état qui suit, alors qu'une recherche qui ne trouve
   * rien et une recherche qui remet trois cents fichiers en file ont exactement
   * le même effet visible à l'instant du clic.
   */
  const inscrire = useMutation({
    mutationFn: async (): Promise<EnqueueResult> => {
      const response = await fetch('/api/preparation/enqueue', { method: 'POST' });
      if (!response.ok) throw new Error(`Le serveur a répondu ${response.status}. Vérifier ses journaux.`);
      return (await response.json()) as EnqueueResult;
    },
    onSuccess: rafraichir,
  });

  const relancer = useMutation({
    mutationFn: () => fetch('/api/preparation/retry-failed', { method: 'POST' }),
    onSuccess: rafraichir,
  });

  if (status === undefined) {
    return <p className="py-16 text-center text-faible">Chargement de l’état…</p>;
  }

  if (!status.available) {
    return (
      <>
        <Titre />
        <p className="mt-6 text-[15px] leading-[1.7] text-faible">
          Aucune préparation n’est active sur ce serveur : ffmpeg n’a pas été trouvé au démarrage.
          Renseigner <code className="text-texte">FFMPEG_PATH</code>, puis relancer le serveur.
        </p>
      </>
    );
  }

  const reste = status.filesTotal - status.filesDone;
  const termine = reste === 0;

  return (
    <>
      <Titre />

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Chiffre label="Œuvres préparées" valeur={`${status.filesDone} / ${status.filesTotal}`} />
        <Chiffre
          label="Volume traité"
          valeur={`${octets(status.bytesDone)} / ${octets(status.bytesTotal)}`}
          /*
           * Les octets AVANT les fichiers : le coût est proportionnel à la
           * taille, et « 500 sur 2306 » ne dit rien s'il reste le fichier de
           * 94 Go.
           */
          note="c’est cette ligne qui mesure l’avancement"
        />
        <Chiffre
          label="Débit observé"
          valeur={status.throughput === null ? '—' : `${octets(status.throughput)}/s`}
          note="moyenné sur les derniers fichiers"
        />
        <Chiffre
          label="Temps restant"
          valeur={
            termine ? 'terminé' : status.remainingSeconds === null ? '—' : `~${duree(status.remainingSeconds)}`
          }
          note={status.remainingSeconds === null && !termine ? 'en attente d’une première mesure' : undefined}
        />
      </div>

      <Barre done={status.bytesDone} total={status.bytesTotal} paused={status.paused} />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {status.paused ? (
          <button
            type="button"
            onClick={() => reprendre.mutate()}
            disabled={reprendre.isPending}
            className="accent-gradient flex h-11 items-center rounded px-6 text-[14px] font-semibold"
          >
            Reprendre
          </button>
        ) : (
          <button
            type="button"
            onClick={() => pause.mutate()}
            disabled={pause.isPending || termine}
            className="flex h-11 items-center rounded border border-[rgba(249,249,249,0.28)] px-6 text-[14px] font-semibold text-texte transition-colors hover:border-texte disabled:cursor-not-allowed disabled:opacity-40"
          >
            Mettre en pause
          </button>
        )}

        <button
          type="button"
          onClick={() => inscrire.mutate()}
          disabled={inscrire.isPending}
          className="flex h-11 items-center rounded border border-[rgba(249,249,249,0.16)] px-5 text-[13px] text-faible transition-colors hover:border-[rgba(249,249,249,0.4)] hover:text-texte"
        >
          {inscrire.isPending ? 'Recherche en cours…' : 'Rechercher ce qui manque'}
        </button>

        <p className="text-[13px] text-faible">
          {status.paused
            ? 'En pause — le disque est rendu, ffmpeg est arrêté.'
            : termine
              ? 'Tout est préparé.'
              : `${reste} œuvre(s) en attente.`}
        </p>
      </div>

      {/* Le résultat de la recherche, quand il y en a eu une. */}
      {inscrire.isError && (
        <p className="mt-3 text-[13px] text-[#f0797a]">{(inscrire.error as Error).message}</p>
      )}
      {inscrire.isSuccess && inscrire.data !== undefined && (
        <p className="mt-3 text-[13px] text-faible">{resumeRecherche(inscrire.data, octets)}</p>
      )}

      {/*
        Le fichier en cours, avec sa taille : c'est ce qui explique une attente
        qui paraît longue. Un fichier de 94 Go prend seize minutes, et le voir
        vaut mieux que de croire que la passe est bloquée.
      */}
      {status.current !== null && (
        <div className="mt-8 rounded bg-surface px-6 py-5">
          <div className="text-[11px] font-semibold tracking-[0.2em] text-faible uppercase">En cours</div>
          <div className="mt-2 font-mono text-[13px] break-all text-texte">{status.current.fileName}</div>
          <div className="mt-1 text-[13px] text-faible">
            {octets(status.current.sizeBytes)}
            {status.throughput !== null && status.throughput > 0 && (
              <> · environ {duree(status.current.sizeBytes / status.throughput)} de lecture</>
            )}
          </div>
        </div>
      )}

      {status.failures.length > 0 && (
        <Echecs
          failures={status.failures}
          onRetry={() => relancer.mutate()}
          retrying={relancer.isPending}
        />
      )}

      <Explication />
    </>
  );
}

function Titre() {
  return (
    <div>
      <h1 className="text-[28px] font-bold">Préparation des sous-titres</h1>
      <p className="mt-2 max-w-3xl text-[15px] leading-[1.7] text-faible">
        Les sous-titres sont extraits une fois pour toutes, avant qu’une œuvre ne soit proposée. Cette page
        montre ce que l’interface normale cache.
      </p>
    </div>
  );
}

function Chiffre({ label, valeur, note }: { label: string; valeur: string; note?: string }) {
  return (
    <div className="rounded bg-surface px-5 py-4">
      <div className="text-[11px] font-semibold tracking-[0.18em] text-faible uppercase">{label}</div>
      <div className="mt-2 text-[22px] font-semibold tabular-nums">{valeur}</div>
      {note !== undefined && <div className="mt-1 text-[12px] leading-[1.4] text-faible">{note}</div>}
    </div>
  );
}

/** La barre suit les OCTETS, comme le reste de la page. */
function Barre({ done, total, paused }: { done: number; total: number; paused: boolean }) {
  const ratio = total === 0 ? 0 : Math.min(1, done / total);

  return (
    <div className="mt-6">
      <div className="h-2 w-full overflow-hidden rounded-full bg-[rgba(249,249,249,0.14)]">
        <div
          className={`h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${
            paused ? 'bg-[rgba(249,249,249,0.45)]' : 'bg-[#00A8E1]'
          }`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <div className="mt-2 text-right text-[12px] text-faible tabular-nums">{(ratio * 100).toFixed(1)} %</div>
    </div>
  );
}

function Echecs({
  failures,
  onRetry,
  retrying,
}: {
  failures: PreparationStatus['failures'];
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="mt-8">
      <h2 className="text-[15px] font-semibold">Échecs</h2>
      {/*
        « Rechercher ce qui manque » les écarte volontairement : un fichier
        définitivement impossible ferait relire ses 94 Go à chaque clic. C'est
        donc ici, et seulement ici, qu'on les relance — et c'est délibéré.
      */}
      <p className="mt-1 max-w-3xl text-[13px] leading-[1.6] text-faible">
        Ces fichiers restent non préparés et n’apparaissent donc pas au parcours. La recherche de ce qui
        manque les laisse de côté pour ne pas les relire en boucle : c’est le bouton ci-dessous qui les
        retente.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-3 flex h-10 items-center rounded border border-[rgba(249,249,249,0.16)] px-5 text-[13px] text-faible transition-colors hover:border-[rgba(249,249,249,0.4)] hover:text-texte"
      >
        {retrying ? 'Relance…' : `Réessayer ces ${failures.length} fichier(s)`}
      </button>
      <div className="mt-4 space-y-2">
        {failures.map((echec) => (
          <div key={echec.mediaFileId} className="rounded bg-surface px-4 py-3">
            <div className="font-mono text-[12px] break-all text-texte">{echec.fileName}</div>
            <div className="mt-1 text-[12px] text-faible">{echec.error}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Explication() {
  return (
    <div className="mt-10 border-t border-[rgba(249,249,249,0.09)] pt-6 text-[13px] leading-[1.7] text-faible">
      <p>
        Une extraction traverse le fichier entier : le coût est celui de la lecture disque, proportionnel à la
        taille et indépendant du nombre de pistes. C’est pourquoi l’avancement se mesure en octets, et pourquoi
        les plus gros fichiers passent en dernier.
      </p>
      <p className="mt-3">
        L’ordre est celui-ci : les ajouts les plus récents d’abord — ce sont ceux qu’on voudra regarder — puis
        les plus petits. La passe reprend d’elle-même après un redémarrage, et la pause arrête ffmpeg
        immédiatement plutôt que d’attendre la fin du fichier en cours.
      </p>
    </div>
  );
}
