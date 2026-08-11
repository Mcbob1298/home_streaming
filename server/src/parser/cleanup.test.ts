/**
 * Tests des règles de nettoyage : marques de sites et titres collés.
 * Les exemples sont ceux relevés dans la bibliothèque réelle.
 */
import { describe, expect, it } from 'vitest';

import { parseMovie } from './movie.js';
import { looksGlued, segmentGluedWords } from './glued.js';
import { stripReleaseSites } from './sites.js';

const OPTIONS = { maxYear: 2030 };

describe('règle 1 — marques de sites de téléchargement', () => {
  it('retire un préfixe « site com-identifiant- »', () => {
    expect(stripReleaseSites('darkino com-1141515-Star Wars 1')).toBe('Star Wars 1');
    expect(stripReleaseSites('darkino com-126791-Les Trois Mousquetaires D Artagnan')).toBe(
      'Les Trois Mousquetaires D Artagnan',
    );
    expect(stripReleaseSites('darkino com-1767560-Sonic the Hedgehog')).toBe('Sonic the Hedgehog');
  });

  it('retire la marque en fin de nom', () => {
    expect(stripReleaseSites('UTTLatourmontparnasseinfernale1080p darkino com')).toBe(
      'UTTLatourmontparnasseinfernale1080p',
    );
  });

  it('retire un domaine complet avec sous-domaine', () => {
    expect(stripReleaseSites('Severance.2022.S01E01.MULTi-FRATERNiTY-www2.tirexo.art')).toBe(
      'Severance.2022.S01E01.MULTi-FRATERNiTY',
    );
  });

  it('fonctionne pour un site inconnu quand l’identifiant numérique est là', () => {
    // C'est tout l'intérêt de la règle générique : pas besoin de connaître le site.
    expect(stripReleaseSites('unsiteinconnu net-99887-Le Grand Bleu')).toBe('Le Grand Bleu');
  });

  it('ne touche pas à un titre qui se termine par un mot ressemblant à un domaine', () => {
    // « art », « co », « me » sont des extensions de domaine : une règle
    // générique amputerait ces titres. Seuls les sites connus sont retirés.
    expect(stripReleaseSites('Le Grand Art')).toBe('Le Grand Art');
    expect(stripReleaseSites('La Vie en Rose')).toBe('La Vie en Rose');
    expect(stripReleaseSites('Call Me By Your Name')).toBe('Call Me By Your Name');
  });

  it('laisse intact un nom sans marque de site', () => {
    expect(stripReleaseSites('Titre.2019.1080p.BluRay.x264-GROUPE')).toBe('Titre.2019.1080p.BluRay.x264-GROUPE');
  });
});

describe('règle 2 — titres écrits d’un seul tenant', () => {
  it('reconnaît un fragment collé', () => {
    expect(looksGlued('TheLordoftheRingsTheTwoTowers')).toBe(true);
    expect(looksGlued('Amelie')).toBe(false);
    expect(looksGlued('Interstellar')).toBe(false); // long, mais sans majuscule interne
    expect(looksGlued('Le Roi Lion')).toBe(false); // contient déjà des espaces
  });

  it('segmente en gérant les mots-outils collés', () => {
    expect(segmentGluedWords('TheLordoftheRingsTheFellowshipoftheRing')).toBe(
      'The Lord of the Rings The Fellowship of the Ring',
    );
    expect(segmentGluedWords('TheLordoftheRingsTheReturnoftheKing')).toBe(
      'The Lord of the Rings The Return of the King',
    );
    expect(segmentGluedWords('TheLordoftheRingsTheTwoTowers')).toBe('The Lord of the Rings The Two Towers');
  });

  it('sépare aussi les chiffres collés aux lettres', () => {
    expect(segmentGluedWords('GlassOnionAKnivesOutMystery2022MULTi')).toContain('Glass Onion A Knives Out Mystery 2022');
  });

  it('ne segmente jamais un nom qui a déjà des séparateurs', () => {
    expect(segmentGluedWords('Titre.2019.1080p.BluRay.x264-GROUPE')).toBe('Titre 2019 1080p BluRay x264-GROUPE');
    expect(segmentGluedWords('Le Roi Lion (1994)')).toBe('Le Roi Lion (1994)');
    expect(segmentGluedWords('Spider-Man Far From Home')).toBe('Spider-Man Far From Home');
  });

  it('n’ampute pas un mot qui finit par un mot-outil', () => {
    // « Grand » se termine par « and », « Island » aussi : trop courts pour
    // être découpés, la règle les laisse tranquilles.
    expect(segmentGluedWords('Grand')).toBe('Grand');
    expect(segmentGluedWords('Island')).toBe('Island');
  });

  it('ne touche pas à un titre à la graphie stylisée', () => {
    // « BlacKkKlansman » ressemble à un titre soudé, mais le découper donne
    // « Blac Kk Klansman » : « Kk » n'est pas un mot. On renonce.
    expect(segmentGluedWords('BlacKkKlansman')).toBe('BlacKkKlansman');
  });

  it('ne décolle pas une fin de mot de deux lettres', () => {
    // « Klansman » se termine par « an », qui est un article anglais.
    expect(segmentGluedWords('AnotherKlansman')).toContain('Klansman');
  });

  it('accepte les sigles et chiffres romains', () => {
    expect(segmentGluedWords('StarWarsEpisodeIX')).toBe('Star Wars Episode IX');
  });

  it('renonce quand le décollage ne segmente rien', () => {
    // Titre entièrement en minuscules : aucune majuscule pour le découper.
    // Grignoter « le » puis « a » à la fin donnerait
    // « Latourmontparnasseinfern a le », pire que de ne rien faire.
    expect(segmentGluedWords('UTTLatourmontparnasseinfernale1080p')).toBe(
      'UTT Latourmontparnasseinfernale 1080p',
    );
  });
});

describe('règles 1 et 2 vues du parser', () => {
  it('récupère un titre derrière un préfixe de site', () => {
    expect(parseMovie('darkino com-1141515-Star Wars 1 (1999).mkv', OPTIONS)).toMatchObject({
      title: 'Star Wars 1',
      year: 1999,
    });
    expect(parseMovie('darkino com-292783-Star Wars Episode IX The Rise of Skywalker (2019).mkv', OPTIONS)).toMatchObject({
      title: 'Star Wars Episode IX The Rise of Skywalker',
      year: 2019,
    });
  });

  it('récupère un titre entièrement collé', () => {
    expect(parseMovie('TheLordoftheRingsTheFellowshipoftheRing (2001).mkv', OPTIONS)).toMatchObject({
      title: 'The Lord of the Rings The Fellowship of the Ring',
      year: 2001,
    });
  });

  it('fait apparaître l’année et le bruit d’un nom entièrement collé', () => {
    // Sans segmentation préalable, ni « 2022 » ni « MULTi » ne sont visibles :
    // le nettoyage du bruit ne peut pas s'appliquer.
    expect(
      parseMovie('GlassOnionAKnivesOutMystery2022MULTiVFi2160p10bit4KLightDVHDRWEBRipDDP5 1Atmosx265-SAKADOX.mkv', OPTIONS),
    ).toMatchObject({
      title: 'Glass Onion A Knives Out Mystery',
      year: 2022,
    });
  });

  it('combine préfixe de site et titre collé', () => {
    expect(parseMovie('UTTLatourmontparnasseinfernale1080p darkino com.mkv', OPTIONS)).not.toBeNull();
  });

  it('ne change rien aux noms déjà corrects', () => {
    expect(parseMovie('Le Roi Lion (1994)\\Le Roi Lion (1994).mkv', OPTIONS)).toMatchObject({
      title: 'Le Roi Lion',
      year: 1994,
    });
    expect(parseMovie('Titre.2019.1080p.BluRay.x264-GROUPE.mkv', OPTIONS)).toMatchObject({
      title: 'Titre',
      year: 2019,
    });
    expect(parseMovie('Spider-Man.Far.From.Home.2019.MULTi.1080p.BluRay.x264-GRP.mkv', OPTIONS)).toMatchObject({
      title: 'Spider-Man Far From Home',
      year: 2019,
    });
  });

  it('laisse les titres numérotés tels quels', () => {
    // Le numéro fait partie du titre tel qu'il est sur le disque : c'est à
    // l'écran de review de décider à quel épisode il correspond.
    expect(parseMovie('Harry Potter 3 (2004).mkv', OPTIONS)).toMatchObject({ title: 'Harry Potter 3' });
    expect(parseMovie('Les Tuche 2 (2016).mkv', OPTIONS)).toMatchObject({ title: 'Les Tuche 2' });
  });
});
