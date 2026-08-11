/**
 * Logique du lecteur, sans DOM.
 *
 * Raccourcis clavier, formatage des durées, position d'un clic sur la barre :
 * tout ce qui se raisonne sans navigateur vit ici, et se teste.
 */

/** Pas de déplacement, en secondes. Celui de tous les lecteurs. */
export const SEEK_STEP = 10;

/** Pas de volume, sur une échelle de 0 à 1. */
export const VOLUME_STEP = 0.1;

/** Délai avant effacement des contrôles, en millisecondes. */
export const IDLE_MS = 3000;

export type PlayerAction =
  | { kind: 'toggle' }
  | { kind: 'seek'; delta: number }
  | { kind: 'seekRatio'; ratio: number }
  | { kind: 'volume'; delta: number }
  | { kind: 'mute' }
  | { kind: 'fullscreen' }
  | { kind: 'escape' };

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * Traduit une touche en action.
 *
 * Les combinaisons avec Ctrl, Cmd ou Alt sont laissées au navigateur : Ctrl+F
 * ouvre la recherche, Cmd+Flèche saute d'un mot. Les intercepter ferait plus
 * de mal que de bien.
 */
export function actionForKey(event: KeyEventLike): PlayerAction | null {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;

  const key = event.key;

  // Les chiffres vont au pourcentage correspondant : 0 au début, 5 au milieu.
  if (key.length === 1 && key >= '0' && key <= '9') {
    return { kind: 'seekRatio', ratio: Number(key) / 10 };
  }

  switch (key.toLowerCase()) {
    case ' ':
    case 'spacebar':
    case 'k':
      return { kind: 'toggle' };
    case 'arrowleft':
    case 'j':
      return { kind: 'seek', delta: -SEEK_STEP };
    case 'arrowright':
    case 'l':
      return { kind: 'seek', delta: SEEK_STEP };
    case 'arrowup':
      return { kind: 'volume', delta: VOLUME_STEP };
    case 'arrowdown':
      return { kind: 'volume', delta: -VOLUME_STEP };
    case 'm':
      return { kind: 'mute' };
    case 'f':
      return { kind: 'fullscreen' };
    case 'escape':
      return { kind: 'escape' };
    default:
      return null;
  }
}

/**
 * La frappe est-elle destinée au lecteur, ou à un champ de saisie ?
 *
 * Sans ce garde-fou, taper « f » dans un champ mettrait la page en plein écran
 * au lieu d'écrire la lettre.
 */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** « 83 » → « 1:23 », « 3723 » → « 1:02:03 ». */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '0:00';

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours === 0 ? `${minutes}:${pad(rest)}` : `${hours}:${pad(minutes)}:${pad(rest)}`;
}

/**
 * Temps RESTANT, préfixé du signe moins.
 *
 * C'est ce qu'affiche Disney+ : savoir combien il reste est plus utile que
 * savoir où l'on en est. La durée est inconnue tant que les métadonnées ne
 * sont pas chargées, d'où le repli.
 */
export function formatRemaining(current: number, duration: number | null | undefined): string {
  if (duration === null || duration === undefined || !Number.isFinite(duration) || duration <= 0) return '--:--';
  return `-${formatTime(Math.max(0, duration - current))}`;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Position d'un pointeur sur la barre, ramenée entre 0 et 1. */
export function ratioFromPointer(clientX: number, rect: { left: number; width: number }): number {
  if (rect.width <= 0) return 0;
  return clamp((clientX - rect.left) / rect.width, 0, 1);
}

/** Avancée de la lecture, entre 0 et 1. Zéro tant que la durée est inconnue. */
export function progressOf(current: number, duration: number | null | undefined): number {
  if (duration === null || duration === undefined || !Number.isFinite(duration) || duration <= 0) return 0;
  return clamp(current / duration, 0, 1);
}

/** Nouvelle position après un déplacement relatif, bornée au média. */
export function seekTo(current: number, delta: number, duration: number | null | undefined): number {
  const maximum = duration !== null && duration !== undefined && Number.isFinite(duration) ? duration : current + delta;
  return clamp(current + delta, 0, Math.max(0, maximum));
}

/** Nouveau volume après un pas, borné à l'échelle. Arrondi pour éviter 0.7000000000000001. */
export function volumeAfter(current: number, delta: number): number {
  return Number(clamp(current + delta, 0, 1).toFixed(2));
}
