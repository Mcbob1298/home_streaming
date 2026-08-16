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
  window.__clic = (texte) => {
    const boutons = [...document.querySelectorAll('button')];
    const cible = boutons.find((b) => (b.textContent ?? '').trim() === texte)
      ?? boutons.find((b) => (b.getAttribute('aria-label') ?? '') === texte);
    if (!cible) return false;
    cible.click();
    return true;
  };
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
      await cdp.evaluer('window.__reveiller()');
      await new Promise((r) => setTimeout(r, 300));
      await cdp.evaluer('window.__clic("Réglages")');
      await new Promise((r) => setTimeout(r, 300));

      const t0 = Date.now();
      const clique = await cdp.evaluer(`window.__clic(${JSON.stringify(noms[n])})`);
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
        `  ${String(n).padStart(2)} ${(noms[n] ?? "?").slice(0, 18).padEnd(20)} ` +
          `${(delai === null ? 'jamais' : `${delai} ms`).padStart(8)}   ` +
          `${String(etat?.t ?? '?').padStart(8)}   ` +
          `${(etat?.couvre ? 'présent' : 'ABSENT').padEnd(12)}  ${bon ? '' : '← ÉCHEC'}`,
      );
      if (!bon) console.log(`        plages audio : ${JSON.stringify(etat?.plages)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log(`\n  ${Math.min(noms.length, 4) - 1 - echecs} changement(s) réussi(s) sur ${Math.min(noms.length, 4) - 1}.`);
  }
} finally {
  chrome.kill();
}
