/**
 * LES DEUX MOITIÉS VIENNENT-ELLES DU MÊME COMMIT ?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * UN SERVEUR À JOUR PEUT SERVIR UN FRONT PÉRIMÉ. C'EST ARRIVÉ.
 *
 * L'image de production construit le serveur et l'interface dans deux étages
 * distincts. Le serveur avait la négociation de capacité, le bundle non — il
 * datait d'avant la sonde. Résultat : la lecture retombait en H.264 1080p sur
 * tout appareil qui chargeait l'application depuis le NAS, sans une erreur, sans
 * une ligne de journal. Le diagnostic a coûté une session entière.
 *
 * `/api/version` seule ne l'aurait pas montré : elle disait vrai, et elle ne
 * parle que du serveur. C'est la COMPARAISON des deux qui porte l'information —
 * une valeur isolée ne peut pas révéler un désaccord.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Le commit du bundle est figé à la construction par `VITE_GIT_COMMIT` ; celui
 * du serveur est lu au démarrage du processus. Aucun des deux n'est calculé à la
 * volée : ce sont deux photos, prises au même moment si tout va bien.
 */
import { useEffect, useState } from 'react';

/**
 * Injecté par Vite au moment du `build`, jamais à l'exécution.
 *
 * Hors conteneur — `npm run dev` — la variable n'existe pas et vaut « dev ».
 * C'est correct : en développement, le bundle est celui du disque, et la
 * question du désaccord ne se pose pas.
 */
const COMMIT_BUNDLE = (import.meta.env.VITE_GIT_COMMIT as string | undefined) ?? 'dev';

interface VersionServeur {
  commit: string;
  builtAt: string;
  startedAt: string;
  uptimeSeconds: number;
}

/** Sept caractères : assez pour identifier, assez court pour se comparer d'un coup d'œil. */
function court(commit: string): string {
  return commit === 'inconnu' || commit === 'dev' ? commit : commit.slice(0, 7);
}

export function Versions({ className }: { className?: string }) {
  const [serveur, setServeur] = useState<VersionServeur | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let annule = false;
    fetch('/api/version')
      .then((r) => (r.ok ? (r.json() as Promise<VersionServeur>) : Promise.reject(new Error(String(r.status)))))
      .then((v) => {
        if (!annule) setServeur(v);
      })
      .catch((e: unknown) => {
        if (!annule) setErreur((e as Error).message);
      });
    return () => {
      annule = true;
    };
  }, []);

  const commitServeur = serveur === null ? null : serveur.commit;
  /*
   * L'accord ne se juge qu'une fois les DEUX valeurs connues. Afficher un
   * désaccord pendant le chargement ferait crier au loup à chaque ouverture.
   */
  const accord = commitServeur === null ? null : commitServeur === COMMIT_BUNDLE;

  return (
    <dl className={className} style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '0.25rem 1rem', margin: 0 }}>
      <dt>Interface</dt>
      <dd style={{ margin: 0, fontFamily: 'monospace' }}>{court(COMMIT_BUNDLE)}</dd>

      <dt>Serveur</dt>
      <dd style={{ margin: 0, fontFamily: 'monospace' }}>
        {erreur !== null ? `injoignable (${erreur})` : commitServeur === null ? '…' : court(commitServeur)}
      </dd>

      {accord !== null && (
        <>
          <dt>Accord</dt>
          <dd style={{ margin: 0, fontWeight: 600, color: accord ? undefined : 'var(--danger, #c0392b)' }}>
            {accord
              ? 'les deux moitiés viennent du même commit'
              : 'DÉSACCORD — l’interface et le serveur ne viennent pas du même code'}
          </dd>
        </>
      )}

      {serveur !== null && (
        <>
          <dt>Construite le</dt>
          <dd style={{ margin: 0 }}>{serveur.builtAt}</dd>
          <dt>Démarré depuis</dt>
          <dd style={{ margin: 0 }}>{Math.round(serveur.uptimeSeconds / 60)} min</dd>
        </>
      )}
    </dl>
  );
}
