/**
 * OÙ PASSE LE TEMPS DU DÉMARRAGE — poste par poste.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI `demarrage.mjs` NE SUFFIT PAS.
 *
 * Il donne deux nombres : image et son. Quand ils dépassent la cible, ils ne
 * disent pas QUI attend. Pire, son repère « 1er segment » est
 * `Network.responseReceived`, qui se déclenche à l'arrivée des EN-TÊTES — pas à
 * la fin du corps. Sur un segment 4K de sept mégaoctets, l'écart entre les deux
 * est précisément ce qu'on cherche à mesurer.
 *
 * Ce script relève donc `Network.loadingFinished` — la fin du transfert — et la
 * taille réellement transportée. Le débit se déduit des deux, et c'est lui qui
 * décide si la 4K tient : un premier segment qu'on ne peut pas transporter en
 * moins d'une seconde interdit un démarrage sous la seconde, quel que soit le
 * serveur.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Usage : node demarrage-detail.mjs [mediaFileId] [essais]
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
    window.__v = v;
    v.muted = true;
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    for (const nom of ['loadedmetadata', 'loadeddata', 'canplay', 'playing']) {
      v.addEventListener(nom, () => {
        if (window.__m[nom] === undefined) window.__m[nom] = performance.now() - window.__t0;
      });
    }
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

/** Nom court d'une URL, pour que le tableau reste lisible. */
function etiquette(u) {
  if (u.includes('/playability')) return 'playability';
  if (u.endsWith('/index.m3u8')) return 'manifeste maître';
  if (u.endsWith('/video.m3u8')) return 'video.m3u8';
  if (/audio-\d+\.m3u8$/.test(u)) return `audio.m3u8`;
  if (/\/a-\d+\/init\.mp4$/.test(u)) return 'init audio';
  if (u.endsWith('/init.mp4')) return 'init vidéo';
  const a = /\/a-(\d+)\/seg-(\d+)\.m4s/.exec(u);
  if (a !== null) return `audio seg ${Number(a[2])}`;
  const v = /\/seg-(\d+)\.m4s/.exec(u);
  if (v !== null) return `vidéo seg ${Number(v[1])}`;
  return u.slice(0, 40);
}

const ko = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.round(n / 1024)} Ko`);

const totaux = [];

for (let essai = 1; essai <= ESSAIS; essai += 1) {
  await reset();
  const { chrome } = await ouvrirChrome();
  try {
    const onglet = await nouvelOnglet(`${BASE}/`);
    const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);

    /*
     * Trois événements par requête, corrélés par `requestId` :
     *   requestWillBeSent → départ
     *   responseReceived  → en-têtes (ce que mesurait l'instrument précédent)
     *   loadingFinished   → corps complet, avec la taille transportée
     */
    const req = new Map();
    cdp.sur((m) => {
      const p = m.params;
      if (m.method === 'Network.requestWillBeSent' && p.request.url.includes('/api/')) {
        req.set(p.requestId, { url: p.request.url.replace(BASE, ''), envoi: Date.now() });
      } else if (m.method === 'Network.responseReceived' && req.has(p.requestId)) {
        req.get(p.requestId).entetes = Date.now();
      } else if (m.method === 'Network.loadingFinished' && req.has(p.requestId)) {
        const e = req.get(p.requestId);
        e.fin = Date.now();
        e.octets = p.encodedDataLength;
      }
    });
    await cdp.envoyer('Network.enable');
    await cdp.envoyer('Runtime.enable');
    await new Promise((r) => setTimeout(r, 2500));

    req.clear();
    const t0 = Date.now();
    await cdp.evaluer(INSTRUMENT.replace('ID_CIBLE', ID));

    let m = {};
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      m = await cdp.evaluer(`window.__m`);
      if (m.loadeddata !== undefined && m.son !== undefined) break;
    }

    const image = m.loadeddata === undefined ? null : Math.round(m.loadeddata);
    const son = m.son === undefined ? null : Math.round(m.son);
    totaux.push({ image, son });

    console.log(`\n═══ essai ${essai} ═══   image ${image ?? '—'} ms · son ${son ?? '—'} ms`);
    console.log('   requête               départ   en-têtes      fin   transféré    débit');
    console.log('   ' + '─'.repeat(70));

    const lignes = [...req.values()]
      .filter((e) => e.fin !== undefined && e.envoi - t0 < (image ?? 6000) + 500)
      .sort((a, b) => a.envoi - b.envoi);

    for (const e of lignes) {
      const d = e.envoi - t0;
      const h = e.entetes === undefined ? null : e.entetes - t0;
      const f = e.fin - t0;
      const duree = (e.fin - (e.entetes ?? e.envoi)) / 1000;
      const debit = duree > 0.02 && e.octets > 65536 ? `${((e.octets * 8) / duree / 1e6).toFixed(0)} Mb/s` : '';
      console.log(
        `   ${etiquette(e.url).padEnd(20)} ${String(d).padStart(6)}   ${String(h ?? '—').padStart(6)}   ` +
          `${String(f).padStart(6)}   ${ko(e.octets).padStart(8)}   ${debit.padStart(8)}`,
      );
    }

    const evs = ['loadedmetadata', 'loadeddata', 'canplay', 'playing']
      .filter((n) => m[n] !== undefined)
      .map((n) => `${n} ${Math.round(m[n])} ms`);
    console.log(`   événements média : ${evs.join(' · ')}`);
  } finally {
    chrome.kill();
    await new Promise((r) => setTimeout(r, 1200));
  }
}

const med = (xs) => {
  const v = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return v.length === 0 ? '—' : `${v[Math.floor(v.length / 2)]} ms`;
};
console.log(`\n── médiane : image ${med(totaux.map((t) => t.image))}, son ${med(totaux.map((t) => t.son))}`);
