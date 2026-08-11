/**
 * Calcul des dimensions du hero.
 *
 * Isolé du composant et sans dépendance au DOM, pour deux raisons : ces règles
 * sont testables, et elles sont la seule source de vérité sur ce qui rentre ou
 * non dans la diapositive.
 *
 * Principe directeur : **tout se déduit des dimensions de la DIAPOSITIVE**, pas
 * de celles de la fenêtre. En mode large la diapositive ne fait que 86 % du
 * conteneur ; des paliers réglés sur la fenêtre laissaient donc le bloc de
 * contenu réclamer plus de place qu'il n'y en avait. À 860 px de fenêtre, la
 * diapositive tombe à 740 × 300 alors que le bloc exigeait encore ses 374 px de
 * haut : le logo sortait par le haut et le synopsis se posait sur l'image.
 */

/** 1240 / 1440 = 86 %, le rapport de la maquette. */
export const SLIDE_SHARE = 0.86;

/** En dessous, plus de dépassement : la diapositive prend toute la largeur. */
export const PEEK_BREAKPOINT = 768;

/** 1240 / 470, le rapport de la maquette sur écran large. */
const WIDE_RATIO = 1240 / 470;
/** Plus haut sur écran étroit : le bloc de contenu a besoin de hauteur. */
const NARROW_RATIO = 16 / 9;

const MIN_HEIGHT = 300;
const MAX_VIEWPORT_SHARE = 0.68;

/** Largeur de diapositive de référence, celle de la maquette. */
const REFERENCE_SLIDE = 1240;

export interface SlideLayout {
  /** Largeur de la diapositive active. */
  slide: number;
  /** Dépassement visible de chaque voisine. Zéro en mode compact. */
  peek: number;
  height: number;
  compact: boolean;
}

export function computeSlideLayout(containerWidth: number, viewportHeight: number): SlideLayout {
  const compact = containerWidth < PEEK_BREAKPOINT;
  const slide = compact ? containerWidth : Math.round(containerWidth * SLIDE_SHARE);
  const peek = Math.round((containerWidth - slide) / 2);

  const ratio = compact ? NARROW_RATIO : WIDE_RATIO;
  const height = Math.max(
    MIN_HEIGHT,
    Math.min(Math.round(slide / ratio), Math.round(viewportHeight * MAX_VIEWPORT_SHARE)),
  );

  return { slide, peek, height, compact };
}

export interface ContentLayout {
  padX: number;
  padY: number;
  /** Hauteur maximale du logo, en pixels. */
  logoMax: number;
  /** Corps du titre de repli, quand l'œuvre n'a pas de logo. */
  titleSize: number;
  /** Largeur du bloc, jamais plus de la moitié de la diapositive. */
  width: number;
  metaSize: number;
  buttonHeight: number;
  buttonText: number;
  showSynopsis: boolean;
  badgeGap: number;
  ruleTop: number;
  ruleBottom: number;
  buttonsTop: number;
  /** Hauteur totale estimée du bloc, pour vérification. */
  estimatedHeight: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Dimensions du bloc de contenu, déduites de celles de la diapositive.
 *
 * Le synopsis est le seul élément facultatif : il disparaît quand le reste ne
 * tient plus, et non à un seuil de fenêtre arbitraire. C'est ce qui garantit
 * qu'aucun élément ne sort du cadre, quelle que soit la largeur.
 */
export function computeContentLayout(
  slide: number,
  height: number,
  options: { compact: boolean; hasBadge: boolean },
): ContentLayout {
  const scale = clamp(slide / REFERENCE_SLIDE, 0.5, 1);

  const padX = Math.max(options.compact ? 20 : 28, Math.round(64 * scale));
  const padY = Math.max(20, Math.round(56 * scale));

  /*
   * La hauteur du logo est une PART de celle de la diapositive, plafonnée à
   * 120 px. Une valeur en pixels ne peut pas convenir à la fois à une
   * diapositive de 612 px et à une de 300 px.
   */
  const logoMax = Math.min(120, Math.round(height * 0.26));

  const titleSize = Math.max(24, Math.round(62 * scale));
  const metaSize = scale > 0.75 ? 14 : 12;
  const buttonHeight = scale > 0.75 ? 46 : 40;
  const buttonText = scale > 0.75 ? 15 : 14;

  // Jamais plus de la moitié de la diapositive : au-delà, le texte déborde du
  // dégradé et devient illisible sur l'image.
  const width = options.compact
    ? Math.max(160, slide - padX * 2)
    : Math.max(220, Math.min(560, Math.round(slide * 0.5)));

  const badgeGap = Math.round(22 * scale);
  const ruleTop = Math.round(18 * scale);
  const ruleBottom = Math.round(16 * scale);
  const buttonsTop = Math.round(26 * scale);

  const withoutSynopsis =
    (options.hasBadge ? 24 + badgeGap : 0) +
    logoMax +
    ruleTop +
    2 +
    ruleBottom +
    (metaSize + 6) +
    buttonsTop +
    buttonHeight;

  // Trois lignes d'interligne 1,55, plus la marge haute.
  const synopsisHeight = Math.round(metaSize * 1.55 * 3) + Math.round(14 * scale);

  /*
   * Place réellement disponible : la hauteur de la diapositive, moins le
   * rembourrage bas où le bloc est ancré, moins une marge haute équivalente
   * pour que rien ne vienne coller au bord supérieur.
   */
  const available = height - padY - Math.round(padY * 0.6);
  const showSynopsis = withoutSynopsis + synopsisHeight <= available;

  return {
    padX,
    padY,
    logoMax,
    titleSize,
    width,
    metaSize,
    buttonHeight,
    buttonText,
    showSynopsis,
    badgeGap,
    ruleTop,
    ruleBottom,
    buttonsTop,
    estimatedHeight: withoutSynopsis + (showSynopsis ? synopsisHeight : 0),
  };
}
