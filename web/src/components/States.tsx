/** Petits blocs réutilisés par toutes les pages : chargement, erreur, vide. */

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return <p className="py-16 text-center text-sm text-zinc-500">{label}</p>;
}

export function ErrorMessage({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="my-8 rounded-md border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">
      <p className="font-medium">L’API n’a pas répondu correctement.</p>
      <p className="mt-1 text-red-300/80">{message}</p>
      <p className="mt-2 text-xs text-red-300/60">
        Le serveur est-il démarré (<code>npm run dev</code>) et le scan a-t-il été lancé
        (<code>npm run scan</code>) ?
      </p>
    </div>
  );
}

export function Empty({ label }: { label: string }) {
  return <p className="py-16 text-center text-sm text-zinc-500">{label}</p>;
}
