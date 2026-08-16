/**
 * DEUX SAUTS RAPPROCHÉS — le seul cas où la 4K coûte quelque chose.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE CAS MÉRITE SON INSTRUMENT.
 *
 * Après un déplacement, la marge de tampon ne vaut pas grand-chose puis CROÎT —
 * environ 0,7 s par seconde de lecture en 4K, mesuré aux attentes de 10, 20 et
 * 35 s. En regardant normalement, le coussin se constitue et tout va bien.
 *
 * Le second saut rapproché tombe donc dans le creux : on repart d'une marge
 * quasi nulle, avant que l'encodeur ait pris de l'avance. `couv.mjs` ne peut pas
 * le voir — il attend dix secondes entre chaque saut, ce qui est précisément le
 * temps qu'il faut pour que le problème disparaisse.
 *
 * On mesure donc la REPRISE : le délai entre le second saut et le moment où
 * l'image repart vraiment. C'est ce que le spectateur ressent, et c'est le prix
 * exact du choix de la 4K.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * L'écart entre les deux sauts est la variable : à dix secondes on est revenu au
 * cas ordinaire, à deux secondes on est au pire.
 *
 * Usage : node sauts-rapproches.mjs [mediaFileId]
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';

/** Écarts entre les deux sauts, en secondes. */
const ECARTS = [2, 4, 6, 10];

/** Couples de positions : le second saut part loin du premier. */
const COUPLES = [
  [600, 1500],
  [1800, 900],
  [2400, 1200],
  [300, 2100],
];

/** Au-delà, on déclare que l'image n'est pas repartie. */
const PATIENCE_MS = 30_000;

const PIEGE = `(() => {
  window.__sb = [];
  const ajouter = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = ajouter.call(this, mime);
    sb.__mime = mime;
    window.__sb.push(sb);
    return sb;
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

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * LA COUVERTURE SE LIT SUR L'ÉLÉMENT, PAS SUR LES SourceBuffer.
 *
 * La première version interrogeait `window.__sb`, le registre rempli par le
 * piège posé sur `addSourceBuffer`. Ce piège rate par intermittence — constaté
 * trois fois aujourd'hui — et l'instrument annonçait alors « tampon vide » pour
 * les quatre essais, y compris à dix secondes d'écart où `couv.mjs` mesurait
 * +4,6 s au même moment. Un instrument qui confond « je n'ai pas vu » et « il
 * n'y a rien » fabrique exactement le genre de faux diagnostic que ce dossier
 * collectionne.
 *
 * `video.buffered` appartient à l'élément : il existe toujours, et c'est
 * l'INTERSECTION des tampons — donc précisément « le lecteur a-t-il de quoi
 * jouer ici ». Les SourceBuffer ne servent plus qu'au détail par flux, et leur
 * absence est signalée comme telle plutôt que prise pour un tampon vide.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const ETAT = `(() => {
  const v = window.__v;
  if (!v) return null;
  const t = v.currentTime;

  const restant = (ranges) => {
    try {
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges.start(i) <= t && ranges.end(i) >= t) return +(ranges.end(i) - t).toFixed(2);
      }
    } catch {}
    return null;
  };

  const parFlux = (motif) => {
    const sb = (window.__sb ?? []).find((s) => motif.test(s.__mime));
    return sb === undefined ? undefined : restant(sb.buffered);
  };

  return {
    t: +t.toFixed(3),
    readyState: v.readyState,
    element: restant(v.buffered),
    video: parFlux(/video/i),
    audio: parFlux(/audio/i),
    piegePose: (window.__sb ?? []).length > 0,
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
  await new Promise((r) => setTimeout(r, 10_000));

  console.log(`\n#${ID} — deux sauts rapprochés\n`);
  console.log('   écart   saut 1 → saut 2      reprise   marge après   marge avant');
  console.log('   ' + '─'.repeat(66));

  const resultats = [];

  for (let i = 0; i < ECARTS.length; i += 1) {
    const ecart = ECARTS[i];
    const [a, b] = COUPLES[i % COUPLES.length];

    // --- premier saut, puis on laisse passer EXACTEMENT l'écart voulu --------
    await cdp.evaluer(`window.__v.currentTime = ${a}`);
    await new Promise((r) => setTimeout(r, ecart * 1000));

    // --- second saut : c'est celui qu'on mesure -----------------------------
    const avant = await cdp.evaluer(ETAT);
    const t0 = Date.now();
    await cdp.evaluer(`window.__v.currentTime = ${b}`);

    /*
     * « Repartie » = la position AVANCE, et le lecteur a de quoi jouer. Se
     * contenter du tampon dirait « présent » alors que l'image est encore figée ;
     * se contenter de la position dirait « repartie » sur le simple saut.
     */
    let reprise = null;
    let etat = null;
    let repere = null;
    while (Date.now() - t0 < PATIENCE_MS) {
      await new Promise((r) => setTimeout(r, 50));
      etat = await cdp.evaluer(ETAT);
      if (etat === null) continue;
      if (repere === null && Math.abs(etat.t - b) < 3) repere = etat.t;
      if (repere !== null && etat.t > repere + 0.5 && etat.readyState >= 3 && etat.element !== null) {
        reprise = Date.now() - t0;
        break;
      }
    }

    resultats.push({ ecart, reprise });
    console.log(
      `   ${String(ecart).padStart(4)}s   ${String(a).padStart(5)} → ${String(b).padStart(5)}` +
        `   ${(reprise === null ? 'JAMAIS' : `${reprise} ms`).padStart(10)}` +
        `   ${(etat?.element == null ? 'absente' : `+${etat.element}s`).padStart(11)}` +
        `   ${(avant?.element == null ? 'vide' : `+${avant.element}s`).padStart(11)}` +
        `${etat?.piegePose === false ? '   (piège non posé — détail par flux indisponible)' : ''}`,
    );

    // On laisse la lecture se recaler avant l'essai suivant.
    await new Promise((r) => setTimeout(r, 8000));
  }

  // ---- lecture du résultat -------------------------------------------------
  const aboutis = resultats.filter((r) => r.reprise !== null);
  console.log('');
  console.log(`  ${aboutis.length}/${resultats.length} reprises abouties.`);

  if (aboutis.length > 0) {
    const delais = aboutis.map((r) => r.reprise);
    console.log(`  reprise : min ${Math.min(...delais)} ms · max ${Math.max(...delais)} ms`);

    const court = aboutis.filter((r) => r.ecart <= 4).map((r) => r.reprise);
    const long = aboutis.filter((r) => r.ecart >= 6).map((r) => r.reprise);
    if (court.length > 0 && long.length > 0) {
      const moy = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
      console.log(`  écart court (≤4 s) : ${moy(court)} ms   ·   écart long (≥6 s) : ${moy(long)} ms`);
      console.log('');
      console.log(
        moy(court) > moy(long) * 1.5
          ? '  → Le second saut rapproché COÛTE bien : la reprise y est nettement plus lente.'
          : '  → Pas d’écart franc : le second saut ne coûte pas plus que le premier.',
      );
    }
  }
} finally {
  chrome.kill();
}
