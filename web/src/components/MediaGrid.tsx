/**
 * Grille de vignettes 16:9.
 *
 * Le rembourrage n'est pas décoratif : au survol la vignette grandit à 1,08 —
 * environ 11 px de plus de chaque côté — et projette une ombre qui s'étend de
 * 22 px vers le haut et 54 px vers le bas. Sans place réservée aux quatre
 * bords, la première rangée serait rognée en haut, la dernière en bas, et les
 * colonnes extrêmes viendraient buter contre le bord de la fenêtre.
 */
export function MediaGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-16 pt-8 pb-16">
      <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {children}
      </div>
    </div>
  );
}
