import { describe, expect, it } from 'vitest';

import { SHORT_SYNOPSIS_LIMIT, firstSentence, shortSynopsis } from './synopsis';

describe('firstSentence', () => {
  it('coupe au premier point', () => {
    expect(firstSentence('Une première phrase bien assez longue. Une deuxième.')).toBe(
      'Une première phrase bien assez longue.',
    );
  });

  it('reconnaît le point d’exclamation et l’interrogation', () => {
    expect(firstSentence('Mais où sont passés les autres ? Personne ne sait.')).toBe(
      'Mais où sont passés les autres ?',
    );
    expect(firstSentence('Quelle aventure incroyable ils ont vécue ! Puis rien.')).toBe(
      'Quelle aventure incroyable ils ont vécue !',
    );
  });

  it('garde les points de suspension entiers', () => {
    expect(firstSentence('Un jour ils comprendront, peut-être… Ou pas.')).toBe(
      'Un jour ils comprendront, peut-être…',
    );
  });

  it('ne coupe pas sur une abréviation', () => {
    expect(firstSentence('M. Smith part à la guerre contre son gré. Il revient.')).toBe(
      'M. Smith part à la guerre contre son gré.',
    );
  });

  it('ne coupe pas sur une décimale', () => {
    expect(firstSentence('Le budget atteignait 3.5 millions de dollars. Un record.')).toBe(
      'Le budget atteignait 3.5 millions de dollars.',
    );
  });

  it('rend le texte entier quand il n’a pas de point final', () => {
    expect(firstSentence('Une phrase sans ponctuation finale')).toBe('Une phrase sans ponctuation finale');
  });

  it('ramène les espaces multiples et les retours à la ligne à un espace', () => {
    expect(firstSentence('Une phrase\n  coupée en deux lignes bien longues. Suite.')).toBe(
      'Une phrase coupée en deux lignes bien longues.',
    );
  });
});

describe('shortSynopsis', () => {
  it('rend la première phrase telle quelle si elle tient', () => {
    const text =
      'Un homme part à l’aventure dans un monde nouveau qui l’adopte et il se bat pour le protéger. ' +
      'Sur la planète Pandora, un ancien marine paralysé rejoint un programme.';
    expect(shortSynopsis(text)).toBe(
      'Un homme part à l’aventure dans un monde nouveau qui l’adopte et il se bat pour le protéger.',
    );
  });

  it('reste sous le plafond quand la première phrase est un pavé', () => {
    const text =
      'Dans un futur lointain où les ressources de la Terre sont épuisées, une expédition militaire ' +
      'et scientifique est envoyée sur une lune habitée par un peuple autochtone que la compagnie ' +
      'minière entend déloger coûte que coûte.';
    const short = shortSynopsis(text);
    expect(short).not.toBeNull();
    expect((short as string).length).toBeLessThanOrEqual(SHORT_SYNOPSIS_LIMIT + 1);
    expect(short).toMatch(/…$/);
  });

  it('ne coupe jamais au milieu d’un mot', () => {
    const text =
      'Dans un futur lointain où les ressources de la Terre sont épuisées une expédition militaire ' +
      'et scientifique est envoyée sur une lune habitée par un peuple autochtone.';
    const short = shortSynopsis(text) as string;
    const lastWord = short.replace(/…$/, '').split(' ').at(-1) as string;
    // Le dernier mot conservé doit exister tel quel dans le texte d'origine.
    expect(text.split(/\s+/)).toContain(lastWord);
  });

  it('préfère couper sur une ponctuation', () => {
    const text =
      'Pendant que la ville dort et que les rues se vident lentement de leurs derniers passants, ' +
      'un homme seul décide de tout reprendre à zéro et disparaît sans laisser la moindre adresse.';
    const short = shortSynopsis(text) as string;
    expect(short).toBe(
      'Pendant que la ville dort et que les rues se vident lentement de leurs derniers passants…',
    );
  });

  it('ne laisse pas de ponctuation collée aux points de suspension', () => {
    const short = shortSynopsis(
      'Une longue introduction qui pose le décor de cette histoire, puis vient la suite du récit ' +
        'qui déborde très largement du plafond fixé pour cette accroche.',
    ) as string;
    expect(short).not.toMatch(/[,;:]…$/);
    expect(short).not.toMatch(/ …$/);
  });

  it('rend null pour un synopsis absent ou vide', () => {
    expect(shortSynopsis(null)).toBeNull();
    expect(shortSynopsis(undefined)).toBeNull();
    expect(shortSynopsis('   ')).toBeNull();
  });

  it('respecte un plafond passé explicitement', () => {
    const short = shortSynopsis('Une phrase de longueur tout à fait raisonnable pour un test.', 30) as string;
    expect(short.length).toBeLessThanOrEqual(31);
  });
});
