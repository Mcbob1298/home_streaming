/**
 * ÉCART AUDIO / VIDÉO, MESURÉ DANS LE NAVIGATEUR.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI PAS PAR ASSEMBLAGE DE FICHIERS.
 *
 * Concaténer `init.mp4` + des segments et lire les PTS avec ffprobe a produit
 * TROIS diagnostics faux sur ce projet. La liste d'édition de l'en-tête écrase
 * la valeur lue : le même segment donne 0,041 ou 6,000 selon l'en-tête, et
 * après un déplacement tous les segments annoncent zéro quelle que soit leur
 * position réelle.
 *
 * Le navigateur, lui, ne fait pas ça : hls.js empile des fragments dans deux
 * `SourceBuffer` distincts — un audio, un vidéo — et c'est le moteur média qui
 * décide où chaque fragment atterrit. La seule mesure qui dise la vérité est
 * donc celle des PLAGES TAMPONNÉES DE CHAQUE SourceBuffer.
 *
 * On piège `MediaSource.prototype.addSourceBuffer` pour retenir les deux
 * tampons avec leur type MIME, et `SourceBuffer.prototype.appendBuffer` pour
 * relever le `timestampOffset` que hls.js applique à chacun.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const CIBLES = (process.argv[3] ?? '600,1200,1800,2400').split(',').map(Number);

/** Posé AVANT toute lecture : les tampons n'existent pas encore. */
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
  const append = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    this.__appends += 1;
    this.__dernierOffset = this.timestampOffset;
    return append.call(this, data);
  };
  return true;
})()`;

/** Plages de chaque tampon, séparément. */
const ETAT = `(() => {
  const v = document.querySelector('video');
  const lire = (sb) => {
    const p = [];
    try { for (let i = 0; i < sb.buffered.length; i += 1) p.push([+sb.buffered.start(i).toFixed(3), +sb.buffered.end(i).toFixed(3)]); }
    catch { return null; }
    return { mime: sb.__mime, offset: sb.__dernierOffset ?? null, appends: sb.__appends, plages: p };
  };
  return {
    t: v === null ? null : +v.currentTime.toFixed(3),
    ready: v === null ? null : v.readyState,
    paused: v === null ? null : v.paused,
    tampons: (window.__sb ?? []).map(lire).filter(Boolean),
  };
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

/** L'écart entre le début du tampon audio et celui du tampon vidéo. */
function ecart(tampons) {
  const video = tampons.find((t) => /video/i.test(t.mime));
  const audio = tampons.find((t) => /audio/i.test(t.mime));
  if (video === undefined || audio === undefined) return null;
  if (video.plages.length === 0 || audio.plages.length === 0) return null;

  // On compare la plage qui contient la position de lecture, des deux côtés.
  return {
    video: video.plages,
    audio: audio.plages,
    debutMs: Math.round((audio.plages[0][0] - video.plages[0][0]) * 1000),
    finMs: Math.round((audio.plages.at(-1)[1] - video.plages.at(-1)[1]) * 1000),
    offsetAudio: audio.offset,
    offsetVideo: video.offset,
  };
}

const { chrome } = await ouvrirChrome();
try {
  await fetch(`${BASE}/api/progress`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaFileId: Number(ID), positionSeconds: 0, durationSeconds: 10690 }),
  }).catch(() => undefined);
  await fetch(`${BASE}/api/hls/${ID}/session`, { method: 'DELETE' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));

  const onglet = await nouvelOnglet(`${BASE}/`);
  const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);
  const reseau = [];
  cdp.sur((m) => {
    if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/hls/')) {
      reseau.push({ t: Date.now(), u: m.params.response.url.replace(BASE, ''), code: m.params.response.status });
    }
  });
  await cdp.envoyer('Network.enable');
  await cdp.envoyer('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));

  // Le piège AVANT la navigation : les tampons sont créés à l'attachement.
  console.log('piège posé :', await cdp.evaluer(PIEGE));

  await cdp.evaluer(LIRE.replace('CIBLE_ID', ID));
  await new Promise((r) => setTimeout(r, 12000));

  const initial = await cdp.evaluer(ETAT);
  console.log(`\n#${ID} — ${initial.tampons.length} SourceBuffer : ${initial.tampons.map((t) => t.mime).join('  |  ')}`);

  if (initial.tampons.length < 2) {
    console.log('  → audio et vidéo dans le MÊME tampon : aucun décalage possible par ce mécanisme.');
    console.log(`  plages : ${JSON.stringify(initial.tampons[0]?.plages)}`);
  } else {
    const e0 = ecart(initial.tampons);
    console.log(`\n  au démarrage (sans déplacement) :`);
    console.log(`    vidéo ${JSON.stringify(e0.video)}`);
    console.log(`    audio ${JSON.stringify(e0.audio)}`);
    console.log(`    écart début ${e0.debutMs} ms   fin ${e0.finMs} ms   (offsets hls.js : v=${e0.offsetVideo} a=${e0.offsetAudio})`);

    console.log(`\n  après chaque déplacement :`);
    console.log(`    n  cible   plage vidéo              plage audio              écart début   écart fin`);
    let n = 0;
    for (const cible of CIBLES) {
      n += 1;
      const marque = Date.now();
      reseau.length = 0;
      await cdp.evaluer(`window.__v.currentTime = ${cible}`);
      // On laisse le lecteur remplir ses tampons après le saut.
      await new Promise((r) => setTimeout(r, 9000));
      const etat = await cdp.evaluer(ETAT);
      const e = ecart(etat.tampons);
      if (e === null) { console.log(`    ${n}  ${cible}  (tampons illisibles)`); continue; }
      const fmt = (p) => {
        const c = p.find((x) => x[0] <= cible + 1 && x[1] >= cible) ?? p.at(-1);
        return `[${c[0].toFixed(2)}, ${c[1].toFixed(2)}]`;
      };
      const cv = e.video.find((x) => x[0] <= cible + 1 && x[1] >= cible) ?? e.video.at(-1);
      const ca = e.audio.find((x) => x[0] <= cible + 1 && x[1] >= cible) ?? e.audio.at(-1);
      console.log(
        `    ${n}  ${String(cible).padStart(5)}   ${fmt(e.video).padEnd(22)}   ${fmt(e.audio).padEnd(22)}   ` +
          `${String(Math.round((ca[0] - cv[0]) * 1000)).padStart(7)} ms   ${String(Math.round((ca[1] - cv[1]) * 1000)).padStart(6)} ms`,
      );
      const aud = reseau.filter((r) => r.u.includes(String.fromCharCode(47)+String.fromCharCode(115,101,103,45)) && r.u.split(String.fromCharCode(47)).some((p) => p.startsWith(String.fromCharCode(97,45))));
      const vid = reseau.filter((r) => r.u.includes(String.fromCharCode(47)+String.fromCharCode(115,101,103,45)) && !r.u.split(String.fromCharCode(47)).some((p) => p.startsWith(String.fromCharCode(97,45))));
      console.log(`         requêtes après le saut : ${vid.length} vidéo, ${aud.length} audio` +
        (aud.length > 0 ? ` — codes ${[...new Set(aud.map((r) => r.code))].join(',')}, ex ${aud[0].u}` : ' — AUCUNE'));
    }

    const fin = await cdp.evaluer(ETAT);
    console.log(`\n  position finale ${fin.t} s, readyState ${fin.ready}, en lecture : ${!fin.paused}`);
  }
} finally {
  chrome.kill();
}
