/**
 * LA LECTURE SE FIGE — pourquoi, avec le détail de l'instant exact.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CE QUE `continu.mjs` A VU, ET CE QU'IL NE POUVAIT PAS TRANCHER.
 *
 * Sur Avatar en 4K, la lecture s'arrête net à 62,8 s et n'avance plus de tout le
 * reste des dix minutes — avec 57 s de vidéo DÉJÀ dans le tampon et neuf images
 * perdues en tout. Ce n'est donc ni le transfert, ni une chute progressive de
 * cadence : quelque chose cesse d'un coup.
 *
 * Trois explications tiennent debout, et elles se distinguent par des mesures
 * différentes :
 *
 *   1. LE NAVIGATEUR MET LA FENÊTRE EN VEILLE. Chrome suit l'occlusion sur
 *      Windows : une fenêtre entièrement recouverte peut voir son rendu
 *      suspendu. `document.visibilityState` et `document.hidden` le disent.
 *   2. LE DÉCODEUR ABANDONNE. `video.error`, et surtout des images décodées qui
 *      cessent d'augmenter alors que le tampon est plein.
 *   3. LE MOTEUR MÉDIA ATTEND quelque chose qu'il ne reçoit pas — `readyState`
 *      retombe, un `waiting` part.
 *
 * On relève donc les trois à la fois, toutes les deux secondes, et on imprime
 * l'état COMPLET de la première seconde où la position cesse d'avancer. Sans cet
 * instantané, on relit un tableau de nombres figés sans savoir ce qui les a
 * figés.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Usage : node blocage.mjs [mediaFileId] [secondes]
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const DUREE = Number(process.argv[3] ?? 180) * 1000;
const PAS_MS = 2000;

const PIEGE = `(() => {
  window.__sb = [];
  const ajouter = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = ajouter.call(this, mime);
    sb.__mime = mime;
    window.__sb.push(sb);
    return sb;
  };
  window.__ev = [];
  return true;
})()`;

const LIRE = `(() => {
  window.history.pushState({}, '', '/watch/CIBLE_ID');
  window.dispatchEvent(new PopStateEvent('popstate'));
  const p = () => {
    const v = document.querySelector('video');
    if (!v) { setTimeout(p, 15); return; }
    window.__v = v; v.muted = true;
    for (const nom of ['waiting', 'stalled', 'seeking', 'suspend', 'error', 'ended', 'pause', 'ratechange']) {
      v.addEventListener(nom, () => window.__ev.push([nom, +v.currentTime.toFixed(2)]));
    }
    document.addEventListener('visibilitychange', () =>
      window.__ev.push(['visibilité:' + document.visibilityState, +v.currentTime.toFixed(2)]));
    const q = v.play(); if (q && typeof q.catch === 'function') q.catch(() => {});
  };
  p(); return true;
})()`;

const ETAT = `(() => {
  const v = window.__v;
  if (!v) return null;
  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  const plages = (sb) => {
    const out = [];
    try { for (let i = 0; i < sb.buffered.length; i += 1) out.push([+sb.buffered.start(i).toFixed(2), +sb.buffered.end(i).toFixed(2)]); } catch {}
    return out;
  };
  const video = (window.__sb ?? []).find((s) => /video/i.test(s.__mime)) ?? null;
  const audio = (window.__sb ?? []).find((s) => /audio/i.test(s.__mime)) ?? null;
  const couvre = (sb) => {
    if (!sb) return null;
    const t = v.currentTime;
    return plages(sb).some(([a, b]) => a <= t && b >= t);
  };
  return {
    t: +v.currentTime.toFixed(3),
    readyState: v.readyState,
    networkState: v.networkState,
    paused: v.paused,
    ended: v.ended,
    rate: v.playbackRate,
    erreur: v.error ? { code: v.error.code, message: v.error.message } : null,
    dimensions: v.videoWidth + 'x' + v.videoHeight,
    total: q ? q.totalVideoFrames : null,
    perdues: q ? q.droppedVideoFrames : null,
    corrompues: q ? q.corruptedVideoFrames : null,
    visibilite: document.visibilityState,
    cachee: document.hidden,
    focus: document.hasFocus(),
    videoCouvre: couvre(video),
    audioCouvre: couvre(audio),
    videoPlages: video ? plages(video) : [],
    audioPlages: audio ? plages(audio) : [],
    evenements: window.__ev.slice(-6),
  };
})()`;

const { chrome } = await ouvrirChrome();
try {
  await fetch(`${BASE}/api/hls/${ID}/session`, { method: 'DELETE' }).catch(() => undefined);
  await fetch(`${BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaFileId: Number(ID), positionSeconds: 0, durationSeconds: 10690 }),
  }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));

  const onglet = await nouvelOnglet(`${BASE}/`);
  const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);
  await cdp.envoyer('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));
  await cdp.evaluer(PIEGE);
  await cdp.evaluer(LIRE.replace('CIBLE_ID', ID));

  console.log(`\n#${ID} — guet du blocage, ${DUREE / 1000} s\n`);
  console.log('    mur       lue    rs  images  perdues  vidéo↔  audio↔  vis.  dimensions');
  console.log('    ' + '─'.repeat(68));

  const debut = Date.now();
  let precedent = null;
  let fige = null;
  let figeDepuis = null;

  while (Date.now() - debut < DUREE) {
    await new Promise((r) => setTimeout(r, PAS_MS));
    const e = await cdp.evaluer(ETAT);
    if (e === null) continue;

    const mur = ((Date.now() - debut) / 1000).toFixed(0);

    // La position a-t-elle cessé d'avancer ?
    if (precedent !== null && Math.abs(e.t - precedent.t) < 0.02 && !e.paused) {
      if (figeDepuis === null) figeDepuis = Date.now();
      if (fige === null && Date.now() - figeDepuis > 4000) fige = { ...e, mur };
    } else {
      figeDepuis = null;
    }

    console.log(
      `   ${mur.padStart(4)}s  ${e.t.toFixed(2).padStart(8)}   ${e.readyState}  ` +
        `${String(e.total).padStart(6)}  ${String(e.perdues).padStart(7)}  ` +
        `${(e.videoCouvre ? 'oui' : 'NON').padStart(6)}  ${(e.audioCouvre ? 'oui' : 'NON').padStart(6)}  ` +
        `${e.visibilite.slice(0, 4).padStart(4)}  ${e.dimensions}`,
    );

    precedent = e;
  }

  console.log('');
  if (fige === null) {
    console.log('  Aucun blocage : la position a avancé tout du long.');
  } else {
    console.log('══════ ÉTAT AU MOMENT DU BLOCAGE ══════');
    console.log(`  mur                 : ${fige.mur} s`);
    console.log(`  position lue        : ${fige.t} s`);
    console.log(`  readyState          : ${fige.readyState}   (4 = a de quoi jouer jusqu’au bout)`);
    console.log(`  networkState        : ${fige.networkState}`);
    console.log(`  paused / ended      : ${fige.paused} / ${fige.ended}   vitesse ${fige.rate}`);
    console.log(`  erreur du média     : ${fige.erreur === null ? 'AUCUNE' : JSON.stringify(fige.erreur)}`);
    console.log(`  dimensions décodées : ${fige.dimensions}`);
    console.log(`  images  total       : ${fige.total}   perdues ${fige.perdues}   corrompues ${fige.corrompues}`);
    console.log(`  visibilité          : ${fige.visibilite}   cachée ${fige.cachee}   focus ${fige.focus}`);
    console.log(`  tampon vidéo        : ${JSON.stringify(fige.videoPlages)}  couvre ${fige.videoCouvre}`);
    console.log(`  tampon audio        : ${JSON.stringify(fige.audioPlages)}  couvre ${fige.audioCouvre}`);
    console.log(`  derniers événements : ${JSON.stringify(fige.evenements)}`);
    console.log('');

    // ---- lecture du résultat -------------------------------------------------
    if (fige.cachee === true || fige.visibilite !== 'visible') {
      console.log('  → LA FENÊTRE ÉTAIT MASQUÉE. Le blocage est un artefact de mesure,');
      console.log('    pas un défaut du flux. Refaire au premier plan.');
    } else if (fige.erreur !== null) {
      console.log('  → LE DÉCODEUR A RENDU UNE ERREUR. Le flux n’est pas décodable jusqu’au bout.');
    } else if (fige.videoCouvre === true && fige.readyState >= 3) {
      console.log('  → TAMPON PLEIN, ÉTAT PRÊT, ET POURTANT RIEN N’AVANCE.');
      console.log('    Le transfert est hors de cause : c’est la RESTITUTION qui a lâché.');
    } else if (fige.videoCouvre === false) {
      console.log('  → LE TAMPON NE COUVRE PLUS LA POSITION : là, c’est bien l’alimentation.');
    }
  }
} finally {
  chrome.kill();
}
