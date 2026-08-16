/**
 * LE DÉLAI DE CHANGEMENT DE PISTE DÉPEND-IL DE LA PHASE DANS LE SEGMENT ?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LA RÉSERVE QUI A MOTIVÉ CETTE MESURE.
 *
 * Trois positions avaient donné un délai remarquablement constant — 5,43 s. Une
 * constante est soit une loi, soit un artefact du plan d'expérience. Or les trois
 * positions choisies tombaient toutes vers le MILIEU d'un segment audio, et les
 * segments audio font huit secondes.
 *
 * Si le délai est dominé par « finir le segment courant puis charger le suivant
 * dans la nouvelle piste », alors il doit varier avec `t mod 8` : maximal juste
 * après une frontière, minimal juste avant. Trois points tous à la même phase ne
 * peuvent pas distinguer une constante d'une dent de scie — c'est exactement
 * l'erreur 6 du README, commise sur les segments vidéo.
 *
 * On échantillonne donc SIX phases réparties sur les huit secondes, et à des
 * endroits différents du film pour ne pas confondre phase et contenu.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * La phase est calculée sur le `currentTime` RÉEL relevé à l'instant du clic, et
 * non sur la position demandée : le lecteur a continué d'avancer pendant la
 * stabilisation, et prendre la consigne pour la mesure fausserait précisément
 * l'axe qu'on étudie.
 *
 * Usage : node piste-audio-phase.mjs [mediaFileId]
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const DUREE_SEGMENT_AUDIO = 8;

/*
 * Six endroits du film très éloignés les uns des autres : phase et contenu sont
 * deux variables, et les faire bouger ensemble ne les démêlerait pas.
 */
const POSITIONS = [600, 900, 1200, 1500, 1800, 2100];

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * LA PHASE EST ATTENDUE, PAS DEMANDÉE. C'EST LA CORRECTION D'UN PREMIER ESSAI.
 *
 * Viser la phase en décalant la CONSIGNE de saut ne marche pas : entre le saut
 * et le clic, le lecteur se stabilise puis continue d'avancer, et cette avance
 * a varié de 3,75 à 9,24 s d'un essai à l'autre. Les six phases visées — 0,0 à
 * 7,2 — sont arrivées groupées en 1,2-3,0 et 6,9-7,3, sans un seul point entre
 * 3 et 6,9. Un axe troué ne peut pas répondre à la question posée.
 *
 * On saute donc à un endroit rond, puis on ATTEND que `currentTime mod 8`
 * atteigne la phase voulue avant de cliquer. La lecture fournit elle-même toutes
 * les phases, huit secondes durant : il suffit de saisir la bonne.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const PHASES = [0.3, 1.6, 2.9, 4.2, 5.5, 6.8];
const TOLERANCE = 0.2;

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
  window.__clic = (texte) => {
    const boutons = [...document.querySelectorAll('button')];
    const cible = boutons.find((b) => (b.textContent ?? '').trim() === texte)
      ?? boutons.find((b) => (b.getAttribute('aria-label') ?? '') === texte);
    if (!cible) return false;
    cible.click();
    return true;
  };
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

const ETAT = `(() => {
  const v = window.__v;
  if (!v) return null;
  const t = v.currentTime;
  const audio = (window.__sb ?? []).find((s) => /audio/i.test(s.__mime)) ?? null;
  let couvre = false;
  const plages = [];
  if (audio) {
    try {
      for (let i = 0; i < audio.buffered.length; i += 1) {
        const a = audio.buffered.start(i), b = audio.buffered.end(i);
        plages.push([+a.toFixed(2), +b.toFixed(2)]);
        if (a <= t && b >= t) couvre = true;
      }
    } catch {}
  }
  return { t: +t.toFixed(3), couvre, plages, appends: audio?.__appends ?? 0 };
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

  const master = await (await fetch(`${BASE}/api/hls/${ID}/index.m3u8`)).text();
  const noms = [...master.matchAll(/TYPE=AUDIO[^\n]*?NAME="([^"]+)"/g)].map((m) => m[1]);

  if (noms.length < 2) {
    console.log('Moins de deux pistes audio séparées : rien à mesurer.');
  } else {
    console.log(`\n#${ID} — pistes : ${noms.join(' | ')}`);
    console.log(`segment audio : ${DUREE_SEGMENT_AUDIO} s\n`);
    console.log('   position   phase visée    t réel   t mod 8    piste demandée         délai   audio');
    console.log('   ' + '─'.repeat(86));

    const mesures = [];

    for (let i = 0; i < POSITIONS.length; i += 1) {
      // On alterne les deux pistes : chaque essai est un VRAI changement.
      const nomCible = i % 2 === 0 ? noms[1] : noms[0];

      await cdp.evaluer(`window.__v.currentTime = ${POSITIONS[i]}`);
      // Stabilisation : le tampon doit avoir rattrapé la nouvelle position.
      await new Promise((r) => setTimeout(r, 9000));

      const avant = await cdp.evaluer(ETAT);
      if (avant === null) {
        console.log(`   ${POSITIONS[i].toFixed(1).padStart(8)}   (lecteur muet)`);
        continue;
      }

      /*
       * Le menu est ouvert AVANT l'attente de phase : le réveil et l'ouverture
       * coûtent 600 ms, qui décaleraient la phase qu'on vient de viser.
       */
      await cdp.evaluer('window.__reveiller()');
      await new Promise((r) => setTimeout(r, 300));
      await cdp.evaluer('window.__clic("Réglages")');
      await new Promise((r) => setTimeout(r, 300));

      // On attend que la lecture PASSE par la phase voulue. Au pire huit secondes.
      let auClic = null;
      for (let essai = 0; essai < 500; essai += 1) {
        auClic = await cdp.evaluer(ETAT);
        if (auClic === null) break;
        const ecart = Math.abs((auClic.t % DUREE_SEGMENT_AUDIO) - PHASES[i]);
        if (ecart <= TOLERANCE) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      if (auClic === null) continue;

      const t0 = Date.now();
      const clique = await cdp.evaluer(`window.__clic(${JSON.stringify(nomCible)})`);

      if (clique !== true) {
        console.log(`   ${POSITIONS[i].toFixed(1).padStart(8)}   (entrée « ${nomCible} » introuvable)`);
        continue;
      }

      let etat = null;
      let delai = null;
      for (let essai = 0; essai < 400; essai += 1) {
        await new Promise((r) => setTimeout(r, 25));
        etat = await cdp.evaluer(ETAT);
        if (etat !== null && etat.couvre && etat.appends > avant.appends) {
          delai = Date.now() - t0;
          break;
        }
      }

      const phase = auClic.t % DUREE_SEGMENT_AUDIO;
      mesures.push({ position: POSITIONS[i], t: auClic.t, phase, delai });

      console.log(
        `   ${POSITIONS[i].toFixed(1).padStart(8)}   ${PHASES[i].toFixed(1).padStart(10)}  ` +
          `${auClic.t.toFixed(2).padStart(8)}  ${phase.toFixed(2).padStart(7)}    ` +
          `${nomCible.slice(0, 18).padEnd(20)} ` +
          `${(delai === null ? 'jamais' : `${delai} ms`).padStart(8)}   ${etat?.couvre ? 'présent' : 'ABSENT'}`,
      );

      await new Promise((r) => setTimeout(r, 2500));
    }

    // ---- lecture du résultat -------------------------------------------------
    const bons = mesures.filter((m) => m.delai !== null);
    console.log('');
    if (bons.length < 2) {
      console.log('  Trop peu de mesures abouties pour conclure quoi que ce soit.');
    } else {
      const delais = bons.map((m) => m.delai);
      const min = Math.min(...delais);
      const max = Math.max(...delais);
      const moy = delais.reduce((a, b) => a + b, 0) / delais.length;
      const ecart = Math.sqrt(delais.reduce((a, b) => a + (b - moy) ** 2, 0) / delais.length);

      console.log(`  ${bons.length}/${POSITIONS.length} changements aboutis.`);
      console.log(`  délai : min ${min} ms · moyenne ${Math.round(moy)} ms · max ${max} ms · écart-type ${Math.round(ecart)} ms`);
      console.log(`  amplitude ${max - min} ms sur un segment de ${DUREE_SEGMENT_AUDIO * 1000} ms\n`);

      /*
       * Ce que le nuage doit trancher. Si le délai était « finir le segment
       * courant », il vaudrait à peu près (8 − phase) secondes : forte pente
       * NÉGATIVE contre la phase. Une droite plate dit l'inverse — le délai ne
       * doit rien à la position dans le segment, et la constante est une loi.
       */
      const mx = bons.reduce((a, m) => a + m.phase, 0) / bons.length;
      const my = moy;
      const cov = bons.reduce((a, m) => a + (m.phase - mx) * (m.delai - my), 0);
      const varx = bons.reduce((a, m) => a + (m.phase - mx) ** 2, 0);
      const vary = bons.reduce((a, m) => a + (m.delai - my) ** 2, 0);
      const pente = varx === 0 ? 0 : cov / varx;
      const r = varx === 0 || vary === 0 ? 0 : cov / Math.sqrt(varx * vary);

      console.log(`  régression délai ~ phase : pente ${pente.toFixed(0)} ms par seconde de phase, r = ${r.toFixed(2)}`);
      console.log(`  attendu si le délai était « finir le segment courant » : pente ≈ −1000 ms/s, r ≈ −1`);
      console.log('');
      if (Math.abs(r) < 0.5) {
        console.log('  → AUCUNE dépendance à la phase. La constante n’était pas un artefact.');
      } else if (pente < -300) {
        console.log('  → LE DÉLAI SUIT LA PHASE. La constante venait bien du plan d’expérience.');
      } else {
        console.log('  → Dépendance partielle : ni constante franche, ni dent de scie franche.');
      }
    }
  }
} finally {
  chrome.kill();
}
