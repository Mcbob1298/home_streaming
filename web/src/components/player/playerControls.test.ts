import { describe, expect, it } from 'vitest';

import {
  SEEK_STEP,
  VOLUME_STEP,
  actionForKey,
  formatRemaining,
  formatTime,
  isTypingTarget,
  progressOf,
  ratioFromPointer,
  seekTo,
  volumeAfter,
} from './playerControls';

describe('actionForKey — lecture et pause', () => {
  it('bascule sur espace et sur K', () => {
    expect(actionForKey({ key: ' ' })).toEqual({ kind: 'toggle' });
    expect(actionForKey({ key: 'k' })).toEqual({ kind: 'toggle' });
    expect(actionForKey({ key: 'K' })).toEqual({ kind: 'toggle' });
  });
});

describe('actionForKey — déplacement', () => {
  it('recule et avance de dix secondes', () => {
    expect(actionForKey({ key: 'ArrowLeft' })).toEqual({ kind: 'seek', delta: -SEEK_STEP });
    expect(actionForKey({ key: 'ArrowRight' })).toEqual({ kind: 'seek', delta: SEEK_STEP });
  });

  it('accepte J et L, comme les lecteurs habituels', () => {
    expect(actionForKey({ key: 'j' })).toEqual({ kind: 'seek', delta: -SEEK_STEP });
    expect(actionForKey({ key: 'L' })).toEqual({ kind: 'seek', delta: SEEK_STEP });
  });

  it('envoie les chiffres au pourcentage correspondant', () => {
    expect(actionForKey({ key: '0' })).toEqual({ kind: 'seekRatio', ratio: 0 });
    expect(actionForKey({ key: '5' })).toEqual({ kind: 'seekRatio', ratio: 0.5 });
    expect(actionForKey({ key: '9' })).toEqual({ kind: 'seekRatio', ratio: 0.9 });
  });
});

describe('actionForKey — son, plein écran, sortie', () => {
  it('règle le volume avec les flèches verticales', () => {
    expect(actionForKey({ key: 'ArrowUp' })).toEqual({ kind: 'volume', delta: VOLUME_STEP });
    expect(actionForKey({ key: 'ArrowDown' })).toEqual({ kind: 'volume', delta: -VOLUME_STEP });
  });

  it('reconnaît M, F et Échap', () => {
    expect(actionForKey({ key: 'm' })).toEqual({ kind: 'mute' });
    expect(actionForKey({ key: 'f' })).toEqual({ kind: 'fullscreen' });
    expect(actionForKey({ key: 'Escape' })).toEqual({ kind: 'escape' });
  });
});

describe('actionForKey — ce qui doit passer', () => {
  it('laisse les combinaisons au navigateur', () => {
    // Ctrl+F ouvre la recherche, Cmd+Flèche saute d'un mot : on n'y touche pas.
    expect(actionForKey({ key: 'f', ctrlKey: true })).toBeNull();
    expect(actionForKey({ key: 'ArrowRight', metaKey: true })).toBeNull();
    expect(actionForKey({ key: '5', altKey: true })).toBeNull();
  });

  it('ignore les touches sans rôle', () => {
    expect(actionForKey({ key: 'a' })).toBeNull();
    expect(actionForKey({ key: 'Tab' })).toBeNull();
    expect(actionForKey({ key: 'Enter' })).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('reconnaît les champs de saisie', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('laisse passer le reste', () => {
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('formatTime', () => {
  it('écrit minutes et secondes', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(9)).toBe('0:09');
    expect(formatTime(83)).toBe('1:23');
    expect(formatTime(600)).toBe('10:00');
  });

  it('ajoute les heures au-delà de soixante minutes', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3723)).toBe('1:02:03');
    expect(formatTime(7325)).toBe('2:02:05');
  });

  it('rend 0:00 pour une durée absente ou absurde', () => {
    // video.duration vaut NaN tant que les métadonnées ne sont pas chargées.
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatTime(null)).toBe('0:00');
    expect(formatTime(-5)).toBe('0:00');
  });
});

describe('formatRemaining', () => {
  it('compte à rebours', () => {
    expect(formatRemaining(0, 3600)).toBe('-1:00:00');
    expect(formatRemaining(60, 120)).toBe('-1:00');
    expect(formatRemaining(120, 120)).toBe('-0:00');
  });

  it('ne passe pas en positif si la position dépasse la durée', () => {
    expect(formatRemaining(130, 120)).toBe('-0:00');
  });

  it('attend la durée plutôt que d’inventer', () => {
    expect(formatRemaining(10, Number.NaN)).toBe('--:--');
    expect(formatRemaining(10, null)).toBe('--:--');
    expect(formatRemaining(10, 0)).toBe('--:--');
  });
});

describe('ratioFromPointer', () => {
  const rect = { left: 100, width: 400 };

  it('mesure la position relative', () => {
    expect(ratioFromPointer(100, rect)).toBe(0);
    expect(ratioFromPointer(300, rect)).toBe(0.5);
    expect(ratioFromPointer(500, rect)).toBe(1);
  });

  it('borne un pointeur sorti de la barre', () => {
    expect(ratioFromPointer(0, rect)).toBe(0);
    expect(ratioFromPointer(9999, rect)).toBe(1);
  });

  it('rend zéro sur une barre non mesurée', () => {
    expect(ratioFromPointer(50, { left: 0, width: 0 })).toBe(0);
  });
});

describe('progressOf', () => {
  it('donne l’avancée entre 0 et 1', () => {
    expect(progressOf(0, 100)).toBe(0);
    expect(progressOf(50, 100)).toBe(0.5);
    expect(progressOf(100, 100)).toBe(1);
  });

  it('reste à zéro tant que la durée est inconnue', () => {
    expect(progressOf(30, Number.NaN)).toBe(0);
    expect(progressOf(30, null)).toBe(0);
  });
});

describe('seekTo', () => {
  it('déplace dans les bornes du média', () => {
    expect(seekTo(50, 10, 100)).toBe(60);
    expect(seekTo(50, -10, 100)).toBe(40);
  });

  it('ne recule pas avant le début ni ne dépasse la fin', () => {
    expect(seekTo(5, -10, 100)).toBe(0);
    expect(seekTo(95, 10, 100)).toBe(100);
  });

  it('reste utilisable sur un flux de durée inconnue', () => {
    expect(seekTo(50, 10, Number.NaN)).toBe(60);
    expect(seekTo(5, -10, null)).toBe(0);
  });
});

describe('volumeAfter', () => {
  it('monte et descend par pas', () => {
    expect(volumeAfter(0.5, VOLUME_STEP)).toBe(0.6);
    expect(volumeAfter(0.5, -VOLUME_STEP)).toBe(0.4);
  });

  it('reste entre 0 et 1', () => {
    expect(volumeAfter(1, VOLUME_STEP)).toBe(1);
    expect(volumeAfter(0, -VOLUME_STEP)).toBe(0);
  });

  it('évite les traînées de virgule flottante', () => {
    // 0.7 + 0.1 vaut 0.7999999999999999 en binaire.
    expect(volumeAfter(0.7, VOLUME_STEP)).toBe(0.8);
  });
});
