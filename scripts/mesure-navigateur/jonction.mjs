/**
 * LA JONCTION : on regarde la lecture passer du prélude à la suite.
 *
 * La vidéo du prélude s'arrête à 26 s, l'audio à 24 s. On lit donc de 0 à 40 s
 * en échantillonnant toutes les 100 ms, et on cherche ce qui trahirait une
 * jonction ratée :
 *
 *   • un TROU dans les plages tamponnées — deux plages au lieu d'une signifient
 *     que le décodeur n'a pas pu raccorder les deux morceaux ;
 *   • un événement `waiting` ou `stalled` au passage ;
 *   • un ARRÊT de currentTime, ou un SAUT en arrière/avant ;
 *   • des images perdues ou corrompues au compteur du décodeur.
 *
 * Comparer des empreintes de segments ne dirait rien de tout cela : deux
 * segments parfaitement valides peuvent ne pas se raccorder.
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const JUSQUA = Number(process.argv[3] ?? 40);

const INSTRUMENT = `(() => {
  window.__ev = [];
  window.__t0 = performance.now();
  window.history.pushState({}, '', '/watch/ID_CIBLE');
  window.dispatchEvent(new PopStateEvent('popstate'));
  const poser = () => {
    const v = document.querySelector('video');
    if (!v) { setTimeout(poser, 15); return; }
    window.__v = v;
    v.muted = true;
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    for (const nom of ['waiting', 'stalled', 'seeking', 'seeked', 'error', 'ended', 'pause']) {
      v.addEventListener(nom, () => window.__ev.push({ nom, t: +v.currentTime.toFixed(3), ms: Math.round(performance.now() - window.__t0) }));
    }
  };
  poser();
  return true;
})()`;

const SONDE = `(() => {
  const v = window.__v;
  if (!v) return null;
  const plages = [];
  for (let i = 0; i < v.buffered.length; i += 1) {
    plages.push([+v.buffered.start(i).toFixed(3), +v.buffered.end(i).toFixed(3)]);
  }
  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  return {
    t: +v.currentTime.toFixed(3),
    ready: v.readyState,
    paused: v.paused,
    plages,
    total: q ? q.totalVideoFrames : null,
    perdues: q ? q.droppedVideoFrames : null,
    corrompues: q ? q.corruptedVideoFrames : null,
  };
})()`;

const { chrome } = await ouvrirChrome();
try {
  await fetch(`${BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaFileId: Number(ID), positionSeconds: 0, durationSeconds: 10690 }),
  }).catch(() => undefined);
  await fetch(`${BASE}/api/hls/${ID}/session`, { method: 'DELETE' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));

  const onglet = await nouvelOnglet(`${BASE}/`);
  const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);
  const reqs = [];
  cdp.sur((m) => {
    if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/hls/')) {
      reqs.push({ ms: Date.now(), u: m.params.response.url.replace(BASE, ''), code: m.params.response.status });
    }
  });
  await cdp.envoyer('Network.enable');
  await cdp.envoyer('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));

  const debut = Date.now();
  await cdp.evaluer(INSTRUMENT.replace('ID_CIBLE', ID));

  const echantillons = [];
  let precedent = null;
  while ((Date.now() - debut) / 1000 < JUSQUA + 12) {
    await new Promise((r) => setTimeout(r, 100));
    const s = await cdp.evaluer(SONDE);
    if (s === null) continue;
    s.ms = Date.now() - debut;
    echantillons.push(s);
    if (precedent !== null && s.t >= JUSQUA) break;
    precedent = s;
  }

  const evs = await cdp.evaluer(`window.__ev`);

  // --- analyse ------------------------------------------------------------
  console.log(`\n═══ ${echantillons.length} échantillons, jusqu'à ${echantillons.at(-1)?.t} s ═══\n`);

  console.log('── plages tamponnées autour de la jonction (20 s → 30 s de lecture)');
  for (const s of echantillons.filter((x) => x.t >= 19 && x.t <= 31)) {
    if (echantillons.indexOf(s) % 4 !== 0) continue;
    console.log(`   t=${String(s.t).padStart(7)}  ready=${s.ready}  plages ${JSON.stringify(s.plages)}`);
  }

  const trous = echantillons.filter((s) => s.plages.length > 1);
  console.log(`\n── échantillons avec PLUSIEURS plages (donc un trou) : ${trous.length}`);
  for (const s of trous.slice(0, 5)) console.log(`   t=${s.t}  ${JSON.stringify(s.plages)}`);

  console.log('\n── événements du lecteur');
  console.log(evs.length === 0 ? '   aucun' : JSON.stringify(evs));

  // Progression : un arrêt ou un saut se voit sur les écarts successifs.
  let arrets = 0;
  let sauts = 0;
  for (let i = 1; i < echantillons.length; i += 1) {
    const d = echantillons[i].t - echantillons[i - 1].t;
    const dms = (echantillons[i].ms - echantillons[i - 1].ms) / 1000;
    if (d <= 0.001 && dms > 0.05 && echantillons[i].t > 1) arrets += 1;
    if (d > dms * 3 + 0.5 || d < -0.05) sauts += 1;
  }
  console.log(`\n── progression : ${arrets} échantillon(s) sans avancée, ${sauts} saut(s)`);

  const fin = echantillons.at(-1);
  console.log(`── images : ${fin.total} totales, ${fin.perdues} perdues, ${fin.corrompues} corrompues`);

  const jonction = reqs.filter((r) => /seg-0000[6-9]|seg-0001[0-2]|a-\d+\/seg-0000[2-5]/.test(r.u));
  console.log('\n── requêtes autour de la jonction');
  for (const r of jonction.slice(0, 12)) console.log(`   +${r.ms - debut} ms  ${r.code}  ${r.u}`);
} finally {
  chrome.kill();
}
