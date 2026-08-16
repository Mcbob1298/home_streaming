/**
 * LA FRONTIÈRE ENTRE DEUX RUNS — les images, une par une.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI `jonction.mjs` NE SUFFIT PAS ICI.
 *
 * Il échantillonne les plages tamponnées toutes les quelques centaines de
 * millisecondes. Une plage unique prouve qu'il n'y a pas de TROU de tampon, ce
 * qui est nécessaire mais pas suffisant : un recouvrement d'horodatages, une
 * image rejouée ou une image sautée à la frontière ne déchirent aucune plage.
 *
 * Depuis que la croisière démarre à la fin du prélude, la frontière n'est plus
 * interne à une exécution ffmpeg : elle sépare les segments du PRÉLUDE de ceux
 * d'un run démarré ailleurs. C'est le cas pour lequel le prélude a été conçu, et
 * que l'invariant `tfdt` couvre — mais il n'a jamais été mesuré depuis la
 * suppression d'`-output_ts_offset`, et un invariant ne se déduit pas, il se
 * constate.
 *
 * `requestVideoFrameCallback` donne le `mediaTime` de CHAQUE image réellement
 * présentée. C'est la mesure la plus fine que le navigateur expose, et la seule
 * qui puisse voir un recouvrement d'une image.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Usage : node frontiere.mjs [mediaFileId] [seconde de la frontière]
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const FRONTIERE = Number(process.argv[3] ?? 26);

const LIRE = `(() => {
  window.history.pushState({}, '', '/watch/CIBLE_ID');
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.__images = [];
  window.__ev = [];
  const p = () => {
    const v = document.querySelector('video');
    if (!v) { setTimeout(p, 15); return; }
    window.__v = v; v.muted = true;

    for (const nom of ['waiting', 'stalled', 'seeking', 'ratechange']) {
      v.addEventListener(nom, () => window.__ev.push([nom, +v.currentTime.toFixed(3)]));
    }

    /*
     * Chaque image présentée, avec son horodatage MÉDIA — pas l'heure du mur.
     * C'est ce qui permet de voir un saut ou un retour en arrière d'une seule
     * image, invisible dans les plages tamponnées.
     */
    if (typeof v.requestVideoFrameCallback === 'function') {
      const suivre = (_, meta) => {
        window.__images.push(+meta.mediaTime.toFixed(6));
        v.requestVideoFrameCallback(suivre);
      };
      v.requestVideoFrameCallback(suivre);
    }

    const q = v.play(); if (q && typeof q.catch === 'function') q.catch(() => {});
  };
  p(); return true;
})()`;

/** Position lue, et couverture de chaque flux À cette position. */
const ALIGNEMENT = `(() => {
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
  const sb = window.__sb ?? [];
  const parFlux = (motif) => {
    const b = sb.find((s) => motif.test(s.__mime));
    return b === undefined ? undefined : restant(b.buffered);
  };
  return { t: +t.toFixed(3), element: restant(v.buffered), video: parFlux(/video/i), audio: parFlux(/audio/i) };
})()`;

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

const { chrome } = await ouvrirChrome();
try {
  await fetch(`${BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaFileId: Number(ID), positionSeconds: 0, durationSeconds: 10690 }),
  }).catch(() => undefined);
  await fetch(`${BASE}/api/hls/${ID}/session`, { method: 'DELETE' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2000));

  const onglet = await nouvelOnglet(`${BASE}/`);
  const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);
  await cdp.envoyer('Runtime.enable');
  await new Promise((r) => setTimeout(r, 2500));
  await cdp.evaluer(PIEGE);
  await cdp.evaluer(LIRE.replace('CIBLE_ID', ID));

  console.log(`\n#${ID} — frontière annoncée à ${FRONTIERE} s\n`);

  // On suit l'alignement audio/vidéo pendant la traversée.
  const suivi = [];
  for (let i = 0; i < 18; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const a = await cdp.evaluer(ALIGNEMENT);
    if (a !== null) suivi.push(a);
  }

  const images = await cdp.evaluer('window.__images');
  const evenements = await cdp.evaluer('window.__ev');

  console.log('── ALIGNEMENT AUDIO / VIDÉO PENDANT LA TRAVERSÉE ──');
  console.log('    position   élément    vidéo     audio');
  for (const a of suivi) {
    const marque = Math.abs(a.t - FRONTIERE) < 2.5 ? '  ← frontière' : '';
    console.log(
      `   ${String(a.t).padStart(8)}  ${String(a.element ?? 'ABSENT').padStart(8)}  ` +
        `${String(a.video ?? '—').padStart(8)}  ${String(a.audio ?? '—').padStart(8)}${marque}`,
    );
  }

  // ---- continuité des horodatages de décodage -------------------------------
  console.log(`\n── LES IMAGES PRÉSENTÉES (${images.length} relevées) ──`);
  if (images.length < 10) {
    console.log('   requestVideoFrameCallback indisponible ou trop peu d’images.');
  } else {
    const autour = images.filter((t) => t > FRONTIERE - 4 && t < FRONTIERE + 4).sort((a, b) => a - b);
    let pireEcart = 0;
    let reculs = 0;
    let doublons = 0;

    for (let i = 1; i < autour.length; i += 1) {
      const delta = autour[i] - autour[i - 1];
      if (delta < 0) reculs += 1;
      else if (delta === 0) doublons += 1;
      else if (delta > pireEcart) pireEcart = delta;
    }

    const cadence = 1 / 23.976;
    console.log(`   images dans [${(FRONTIERE - 4).toFixed(0)} s, ${(FRONTIERE + 4).toFixed(0)} s] : ${autour.length}`);
    console.log(`   première ${autour[0]?.toFixed(3)}   dernière ${autour.at(-1)?.toFixed(3)}`);
    console.log(`   écart maximal entre deux images : ${(pireEcart * 1000).toFixed(1)} ms`);
    console.log(`   durée d’une image à 23,976 i/s  : ${(cadence * 1000).toFixed(1)} ms`);
    console.log(`   retours en arrière : ${reculs}    horodatages répétés : ${doublons}`);
    console.log('');

    /*
     * Un VIDE se voit comme un écart supérieur à une durée d'image ; un
     * RECOUVREMENT comme un recul ou un horodatage répété. Les deux sont
     * invisibles dans les plages tamponnées, qui resteraient d'un seul tenant.
     */
    if (reculs > 0 || doublons > 0) {
      console.log('   → RECOUVREMENT : des images se répètent ou reviennent en arrière.');
    } else if (pireEcart > cadence * 1.5) {
      console.log(`   → VIDE : ${(pireEcart * 1000).toFixed(1)} ms sans image, soit plus d’une image perdue.`);
    } else {
      console.log('   → CONTINU : ni vide ni recouvrement à la frontière.');
    }
  }

  console.log(`\n── ÉVÉNEMENTS DU LECTEUR : ${JSON.stringify(evenements)}`);
  console.log('');
} finally {
  chrome.kill();
}
