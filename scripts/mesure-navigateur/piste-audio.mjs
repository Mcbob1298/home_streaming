/**
 * CHANGEMENT DE PISTE AUDIO EN COURS DE LECTURE : délai, et bonne place.
 *
 * Deux questions en une, parce qu'elles se répondent au même instant :
 *
 *   • COMBIEN DE TEMPS le son met-il à revenir ? hls.js vide le tampon audio et
 *     le remplit avec la nouvelle piste ; on mesure de la demande jusqu'au
 *     moment où le tampon recouvre à nouveau la position lue.
 *
 *   • REVIENT-IL AU BON ENDROIT ? Le changement de piste passe par la même route
 *     de segments que tout le reste, donc par la correction qui rend les
 *     horodatages absolus. Si l'invariant se perdait sur ce chemin, la nouvelle
 *     piste atterrirait ailleurs — exactement le défaut qu'on vient de corriger,
 *     mais déclenché par un bouton plutôt que par un saut.
 *
 * On compte les `appendBuffer` pour ne pas confondre « le tampon recouvre » avec
 * « il recouvrait déjà avant le changement ».
 *
 * Usage : node piste-audio.mjs [mediaFileId] [position]
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const POSITION = Number(process.argv[3] ?? 600);

const PIEGE = `(() => {
  window.__sb = [];
  const ajouter = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = ajouter.call(this, mime);
    sb.__mime = mime;
    sb.__appends = 0;
    window.__sb.push(sb);
    return sb;
  };
  const empiler = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (donnees) {
    this.__appends = (this.__appends ?? 0) + 1;
    return empiler.call(this, donnees);
  };
  /*
   * On ne piège PAS hls.js : il est bundlé, window.Hls n'existe pas. Et le
   * piloter par ses internes ne mesurerait pas ce que fait un spectateur. On
   * clique donc dans l'interface, comme lui.
   */
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * LA COCHE DE SÉLECTION FAIT PARTIE DU LIBELLÉ. C'ÉTAIT TOUT LE DÉFAUT.
   *
   * L'interface marque la piste ACTIVE d'un « ✓ » collé au texte : le bouton
   * s'appelle « ✓Anglais (VO) 5.1 » dès qu'elle est choisie. L'instrument
   * cherchait l'égalité exacte avec le nom du manifeste et ne trouvait rien.
   *
   * D'où une intermittence parfaitement trompeuse : le premier essai bascule sur
   * l'anglais, qui reste sélectionné, et TOUS les essais suivants échouent sur le
   * même fichier. Une heure de soupçons sur le magasin audio et le transport
   * HEVC, pour une coche.
   *
   * On compare donc sur un libellé NORMALISÉ, débarrassé du marqueur d'état.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  window.__normaliser = (texte) => (texte ?? '').replace(/^[✓✔]\s*/, '').trim();

  window.__libelles = () =>
    [...document.querySelectorAll('button')]
      .map((b) => (b.textContent ?? '').trim())
      .filter((t) => t !== '');

  /** Cette piste est-elle CELLE qui est déjà active ? */
  window.__estActive = (texte) =>
    window.__libelles().some((l) => /^[✓✔]/.test(l) && window.__normaliser(l) === texte);

  window.__trouver = (texte) => {
    const boutons = [...document.querySelectorAll('button')];
    return (
      boutons.find((b) => window.__normaliser(b.textContent) === texte)
      ?? boutons.find((b) => window.__normaliser(b.getAttribute('aria-label')) === texte)
      ?? null
    );
  };

  window.__clic = (texte) => {
    const cible = window.__trouver(texte);
    if (!cible) return false;
    cible.click();
    return true;
  };

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * ATTENDRE QUE L'ENTRÉE EXISTE, PLUTÔT QUE DE CHERCHER À UN INSTANT FIXE.
   *
   * L'instrument ouvrait le menu, patientait 300 ms, puis cherchait la piste. Il
   * a déclaré « entrée de menu introuvable » trois fois de suite sur un fichier
   * où l'utilisateur, à la main, changeait de langue sans la moindre latence.
   *
   * Le menu est peuplé par React à partir des rendus que hls.js publie, et cette
   * publication n'a pas d'horaire : elle dépend de l'état du lecteur. 300 ms
   * suffisaient souvent — le même instrument avait réussi une heure plus tôt sur
   * le même fichier — et c'est précisément ce qui rend un délai fixe pire qu'une
   * absence de contrôle : il marche assez pour qu'on lui fasse confiance.
   *
   * On attend donc que l'entrée SOIT LÀ, avec une borne. Le délai mesuré ensuite
   * ne compte qu'à partir du clic, il n'est pas faussé par cette attente.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  window.__attendre = (texte, delaiMax) =>
    new Promise((resolve) => {
      const limite = performance.now() + delaiMax;
      const voir = () => {
        if (window.__trouver(texte) !== null) return resolve(true);
        if (performance.now() > limite) return resolve(false);
        setTimeout(voir, 25);
      };
      voir();
    });
  // Les commandes se cachent seules : il faut les réveiller avant de cliquer.
  window.__reveiller = () => {
    for (const nom of ['mousemove', 'pointermove']) {
      document.dispatchEvent(new MouseEvent(nom, { bubbles: true, clientX: 400, clientY: 400 }));
    }
    return true;
  };
  return true;
})()`;

const LIRE = `(() => {
  window.history.pushState({}, '', '/watch/CIBLE_ID');
  window.dispatchEvent(new PopStateEvent('popstate'));
  const p = () => {
    const v = document.querySelector('video');
    if (!v) { setTimeout(p, 15); return; }
    window.__v = v; v.muted = true;
    const q = v.play(); if (q && typeof q.catch === 'function') q.catch(() => {});
  };
  p(); return true;
})()`;

/** État du tampon audio À la position lue, et nombre d'empilements. */
const ETAT = `(() => {
  const v = window.__v;
  if (!v) return null;
  const t = v.currentTime;
  const audio = (window.__sb ?? []).find((s) => /audio/i.test(s.__mime)) ?? null;
  let couvre = false, plages = [];
  if (audio) {
    try {
      for (let i = 0; i < audio.buffered.length; i += 1) {
        const a = audio.buffered.start(i), b = audio.buffered.end(i);
        plages.push([+a.toFixed(2), +b.toFixed(2)]);
        if (a <= t && b >= t) couvre = true;
      }
    } catch {}
  }
  return {
    t: +t.toFixed(2),
    couvre,
    plages,
    appends: audio?.__appends ?? 0,
  };
})()`;

const { chrome } = await ouvrirChrome();
try {
  await fetch(`${BASE}/api/hls/${ID}/session`, { method: 'DELETE' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));

  const onglet = await nouvelOnglet(`${BASE}/`);
  const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);
  await cdp.envoyer('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));
  await cdp.evaluer(PIEGE);
  await cdp.evaluer(LIRE.replace('CIBLE_ID', ID));
  await new Promise((r) => setTimeout(r, 10000));

  await cdp.evaluer(`window.__v.currentTime = ${POSITION}`);
  await new Promise((r) => setTimeout(r, 10000));

  // Les noms de pistes viennent du manifeste : c'est ce que l'interface affiche.
  const master = await (await fetch(`${BASE}/api/hls/${ID}/index.m3u8`)).text();
  const noms = [...master.matchAll(/TYPE=AUDIO[^\n]*?NAME="([^"]+)"/g)].map((m) => m[1]);

  const depart = await cdp.evaluer(ETAT);
  if (depart === null || noms.length < 2) {
    console.log('\nMoins de deux pistes audio séparées : rien à changer sur ce fichier.');
  } else {
    console.log(`\n#${ID} — ${noms.length} pistes, lecture à ${depart.t} s`);
    console.log(`  pistes : ${noms.join(' | ')}\n`);
    console.log('  piste demandée         délai      position   audio          verdict');

    let echecs = 0;
    for (let n = 1; n < Math.min(noms.length, 4); n += 1) {
      const avant = await cdp.evaluer(ETAT);

      /*
       * On vise une piste qui n est PAS déjà active : basculer vers celle qu on
       * écoute ne mesurerait rien — hls.js n aurait rien à changer et le tampon
       * couvrirait déjà la position. Le choix se fait à chaque tour, puisque le
       * tour précédent a changé la piste active.
       */
      /*
       * Trois attentes BORNÉES, jamais un délai fixe : les commandes doivent
       * apparaître, le menu doit s'ouvrir, puis l'entrée doit être peuplée. Un
       * échec à l'une des trois est un vrai échec, et il dit laquelle.
       *
       * UN SEUL clic sur « Réglages » : il BASCULE le menu. Un second, posé pour
       * lire les libellés avant de choisir, le refermait — et l'instrument
       * annonçait « boutons présents : ["10","10"] », c'est-à-dire un menu clos.
       */
      await cdp.evaluer('window.__reveiller()');
      if ((await cdp.evaluer('window.__attendre("Réglages", 5000)')) !== true) {
        console.log(`  ${String(n).padStart(2)} (le bouton « Réglages » n’apparaît pas)`);
        echecs += 1;
        continue;
      }

      await cdp.evaluer('window.__clic("Réglages")');

      /*
       * Le menu ouvert, on choisit une piste qui n'est PAS déjà active : basculer
       * vers celle qu'on écoute ne mesurerait rien — hls.js n'aurait rien à
       * changer et le tampon couvrirait déjà la position. Le choix se refait à
       * chaque tour, puisque le tour précédent a changé la piste active.
       */
      await cdp.evaluer(`window.__attendre(${JSON.stringify(noms[0])}, 5000)`);
      const cible = (await cdp.evaluer(
        `(() => { const actifs = window.__libelles().filter((l) => /^[✓✔]/.test(l)).map(window.__normaliser);
                  return ${JSON.stringify(noms)}.find((n) => !actifs.includes(n)) ?? null; })()`,
      )) ?? noms[n];

      const presente = await cdp.evaluer(`window.__attendre(${JSON.stringify(cible)}, 5000)`);
      if (presente !== true) {
        /*
         * Un échec doit dire ce qu'il a VU, pas seulement ce qu'il cherchait.
         * « Introuvable » a fait soupçonner le lecteur pendant une heure ; la
         * liste des boutons présents aurait tranché en dix secondes.
         */
        const vus = await cdp.evaluer(
          `[...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter((t) => t !== '')`,
        );
        console.log(`  ${String(n).padStart(2)} (le menu s’ouvre mais « ${cible} » n’y est pas)`);
        console.log(`        boutons présents : ${JSON.stringify(vus)}`);
        echecs += 1;
        continue;
      }

      // Le chronomètre ne part qu ICI : l attente ci-dessus ne le fausse pas.
      const t0 = Date.now();
      const clique = await cdp.evaluer(`window.__clic(${JSON.stringify(cible)})`);
      if (clique !== true) {
        console.log(`  ${String(n).padStart(2)} ${(noms[n] ?? '?').slice(0, 18).padEnd(20)}  (entrée de menu introuvable)`);
        echecs += 1;
        continue;
      }

      // On attend un tampon qui recouvre ET qui a reçu du neuf.
      let etat = null;
      let delai = null;
      for (let essai = 0; essai < 240; essai += 1) {
        await new Promise((r) => setTimeout(r, 25));
        etat = await cdp.evaluer(ETAT);
        if (etat !== null && etat.couvre && etat.appends > avant.appends) {
          delai = Date.now() - t0;
          break;
        }
      }

      const bon = delai !== null;
      if (!bon) echecs += 1;
      console.log(
        `  ${String(n).padStart(2)} ${(cible ?? "?").slice(0, 18).padEnd(20)} ` +
          `${(delai === null ? 'jamais' : `${delai} ms`).padStart(8)}   ` +
          `${String(etat?.t ?? '?').padStart(8)}   ` +
          `${(etat?.couvre ? 'présent' : 'ABSENT').padEnd(12)}  ${bon ? '' : '← ÉCHEC'}`,
      );
      if (!bon) console.log(`        plages audio : ${JSON.stringify(etat?.plages)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log(`\n  ${Math.min(noms.length, 4) - 1 - echecs} changement(s) réussi(s) sur ${Math.min(noms.length, 4) - 1}.`);

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * L'INSTRUMENT SAIT-IL DIRE NON ? — contrôle à chaque exécution.
     *
     * Il vient de déclarer trois fois un échec là où la fonction marchait, et
     * cela a failli faire annuler un changement sain. La correction — attendre
     * que l'entrée existe au lieu de chercher après 300 ms — pourrait tout aussi
     * bien avoir rendu l'instrument incapable de refuser quoi que ce soit : une
     * attente bornée qui rendrait toujours vrai passerait inaperçue.
     *
     * On lui fait donc chercher une piste qui ne peut pas exister. S'il la
     * trouve, c'est lui qu'il faut corriger, pas le lecteur — et le reste de ses
     * verdicts ne vaut rien.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const FANTOME = 'Klingon 7.1 (piste inexistante)';
    await cdp.evaluer('window.__reveiller()');
    await cdp.evaluer('window.__clic("Réglages")');
    const trouveFantome = await cdp.evaluer(`window.__attendre(${JSON.stringify(FANTOME)}, 3000)`);

    console.log('');
    console.log(`  contrôle — recherche de « ${FANTOME} » : ${trouveFantome === true ? 'TROUVÉE' : 'refusée'}`);
    console.log(
      trouveFantome === true
        ? '  → L’INSTRUMENT NE SAIT PAS REFUSER. Ses verdicts ci-dessus ne valent rien.'
        : '  → Il sait refuser : ses verdicts ci-dessus ont une valeur.',
    );
  }
} finally {
  chrome.kill();
}
