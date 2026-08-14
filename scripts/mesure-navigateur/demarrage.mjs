/**
 * Mesure du DÉMARRAGE d'une lecture, dans un vrai navigateur.
 *
 * Deux précautions sans lesquelles la mesure ne veut rien dire :
 *   • la progression est remise à zéro — Avatar porte une reprise à 13 min ;
 *   • la session est TUÉE avant chaque essai — sinon on mesure une session
 *     déjà chaude, dont les segments sont produits.
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const ESSAIS = Number(process.argv[3] ?? 3);

const INSTRUMENT = `(() => {
  window.__t0 = performance.now();
  window.__m = {};
  window.history.pushState({}, '', '/watch/ID_CIBLE');
  window.dispatchEvent(new PopStateEvent('popstate'));
  const poser = () => {
    const v = document.querySelector('video');
    if (!v) { setTimeout(poser, 20); return; }
    v.muted = true;
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    v.addEventListener('loadeddata', () => {
      if (window.__m.image === undefined) window.__m.image = performance.now() - window.__t0;
    });
    const avance = () => {
      if (v.currentTime > 0.15 && v.readyState >= 3) {
        if (window.__m.son === undefined) window.__m.son = performance.now() - window.__t0;
      } else setTimeout(avance, 30);
    };
    avance();
  };
  poser();
  return true;
})()`;

async function reset() {
  await fetch(`${BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaFileId: Number(ID), positionSeconds: 0, durationSeconds: 10690 }),
  }).catch(() => undefined);
  await fetch(`${BASE}/api/hls/${ID}/session`, { method: 'DELETE' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
}

const resultats = [];

for (let essai = 1; essai <= ESSAIS; essai += 1) {
  await reset();
  const { chrome } = await ouvrirChrome();
  try {
    const onglet = await nouvelOnglet(`${BASE}/`);
    const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);
    const evts = [];
    cdp.sur((m) => {
      if (m.method === 'Network.responseReceived') {
        const u = m.params.response.url.replace(BASE, '');
        if (u.includes('/api/hls/')) evts.push({ t: Date.now(), u });
      }
    });
    await cdp.envoyer('Network.enable');
    await cdp.envoyer('Runtime.enable');
    await new Promise((r) => setTimeout(r, 2500));

    const t0 = Date.now();
    await cdp.evaluer(INSTRUMENT.replace('ID_CIBLE', ID));

    let m = {};
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      m = await cdp.evaluer(`window.__m`);
      if (m.image !== undefined && m.son !== undefined) break;
    }

    const video = evts.find((e) => /\/seg-\d+\.m4s/.test(e.u) && !/\/a-\d+\//.test(e.u));
    const audio = evts.find((e) => /\/a-\d+\/seg-/.test(e.u));
    const etat = await cdp.evaluer(`(() => { const v=document.querySelector('video'); return { t:+v.currentTime.toFixed(2) }; })()`);

    const img = m.image === undefined ? null : Math.round(m.image);
    const son = m.son === undefined ? null : Math.round(m.son);
    resultats.push({ img, son });
    console.log(
      `  essai ${essai} :  image ${img === null ? '—' : img + ' ms'}` +
        `   son ${son === null ? '—' : son + ' ms'}` +
        `   | 1er seg vidéo +${video ? video.t - t0 : '—'} ms, audio +${audio ? audio.t - t0 : '—'} ms` +
        `   | position ${etat.t} s`,
    );
  } finally {
    chrome.kill();
    await new Promise((r) => setTimeout(r, 1200));
  }
}

const med = (xs) => {
  const v = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return v.length === 0 ? '—' : v[Math.floor(v.length / 2)] + ' ms';
};
console.log(`  ── médiane : image ${med(resultats.map((r) => r.img))}, son ${med(resultats.map((r) => r.son))}`);
