import { describe, expect, it } from 'vitest';

import { pickLogo, type TmdbLogo } from './logo.js';

const logo = (file_path: string, iso_639_1: string | null, vote_average = 5): TmdbLogo => ({
  file_path,
  iso_639_1,
  vote_average,
});

describe('pickLogo', () => {
  it('préfère le français', () => {
    expect(
      pickLogo([logo('/en.png', 'en', 9), logo('/fr.png', 'fr', 1), logo('/none.png', null, 9)]),
    ).toBe('/fr.png');
  });

  it('se rabat sur l’anglais faute de français', () => {
    expect(pickLogo([logo('/none.png', null, 9), logo('/en.png', 'en', 1)])).toBe('/en.png');
  });

  it('accepte un logo sans langue en dernier recours', () => {
    expect(pickLogo([logo('/none.png', null)])).toBe('/none.png');
  });

  it('préfère le PNG au SVG à langue égale', () => {
    expect(pickLogo([logo('/a.svg', 'fr', 9), logo('/b.png', 'fr', 1)])).toBe('/b.png');
  });

  it('accepte un SVG s’il n’y a que ça', () => {
    expect(pickLogo([logo('/a.svg', 'fr')])).toBe('/a.svg');
  });

  it('départage par la note à langue et format égaux', () => {
    expect(pickLogo([logo('/faible.png', 'fr', 2), logo('/forte.png', 'fr', 8)])).toBe('/forte.png');
  });

  it('rend null sans logo exploitable', () => {
    expect(pickLogo([])).toBeNull();
    expect(pickLogo(undefined)).toBeNull();
    expect(pickLogo([{ iso_639_1: 'fr' }])).toBeNull();
  });

  it('n’écarte pas une langue inattendue, elle passe seulement en dernier', () => {
    expect(pickLogo([logo('/ja.png', 'ja')])).toBe('/ja.png');
    expect(pickLogo([logo('/ja.png', 'ja', 9), logo('/en.png', 'en', 1)])).toBe('/en.png');
  });
});
