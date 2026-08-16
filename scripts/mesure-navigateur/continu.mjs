/**
 * LECTURE LINÉAIRE, AUCUN DÉPLACEMENT — le cas jamais mesuré.
 *
 * Tous les tests précédents enchaînaient des sauts. Ils ne peuvent donc pas
 * distinguer un défaut de PRODUCTION (l'encodage lui-même dérive) d'un défaut de
 * RELANCE (chaque redémarrage de ffmpeg introduit l'écart). Ce script supprime
 * la seconde variable : on lance la lecture à zéro et on n'y touche plus.
 *
 * Ce qu'il relève, toutes les trente secondes :
 *   • la position lue, et si l'audio ET la vidéo la couvrent ;
 *   • l'écart entre le temps écoulé au mur et le temps de lecture — un lecteur
 *     qui décroche accumule du retard ici avant que ça ne s'entende ;
 *   • les images décodées et les images PERDUES : une perte croissante décale le
 *     rendu vidéo par rapport à l'audio sans qu'aucun horodatage ne bouge ;
 *   • tout événement `seeking` — pendant une lecture sans déplacement, il ne
 *     peut venir que de hls.js qui saute un trou de tampon, et c'est justement
 *     une relance déguisée.
 *
 * Usage : node continu.mjs [mediaFileId] [minutes]
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const MINUTES = Number(process.argv[3] ?? 11);
const PAS_MS = 30_000;

const PIEGE = `(() => {
  window.__sb = [];
  const ajouter = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = ajouter.call(this, mime);
    sb.__mime = mime;
    window.__sb.push(sb);
    return sb;
  };
  // Journal des événements qui trahissent une relance non demandée.
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
    for (const nom of ['seeking', 'waiting', 'stalled', 'ratechange']) {
      v.addEventListener(nom, () => window.__ev.push([nom, +v.currentTime.toFixed(3)]));
    }
    window.__t0 = performance.now();
    const q = v.play(); if (q && typeof q.catch === 'function') q.catch(() => {});
  };
  p(); return true;
})()`;

const ETAT = `(() => {
  const v = window.__v;
  if (!v) return null;
  const t = v.currentTime;
  const couvre = (sb) => {
    try {
      for (let i = 0; i < sb.buffered.length; i += 1) {
        if (sb.buffered.start(i) <= t && sb.buffered.end(i) >= t) {
          return { ok: true, devant: +(sb.buffered.end(i) - t).toFixed(2) };
        }
      }
    } catch { return { ok: false, devant: 0 }; }
    return { ok: false, devant: 0 };
  };
  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  const flux = (window.__sb ?? []).map((sb) => ({ audio: /audio/i.test(sb.__mime), ...couvre(sb) }));
  return {
    t: +t.toFixed(3),
    mur: +((performance.now() - (window.__t0 ?? performance.now())) / 1000).toFixed(3),
    paused: v.paused,
    ready: v.readyState,
    video: flux.find((f) => !f.audio) ?? null,
    audio: flux.find((f) => f.audio) ?? null,
    total: q ? q.totalVideoFrames : null,
    perdues: q ? q.droppedVideoFrames : null,
    ev: window.__ev.length,
  };
})()`;

const { chrome } = await ouvrirChrome();
try {
  // Repartir de zéro : ni reprise de position, ni session héritée.
  await fetch(`${BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaFileId: Number(ID), positionSeconds: 0, durationSeconds: 10690 }),
  }).catch(() => undefined);
  await fetch(`${BASE}/api/hls/${ID}/session`, { method: 'DELETE' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));

  const onglet = await nouvelOnglet(`${BASE}/`);
  const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);
  await cdp.envoyer('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));
  await cdp.evaluer(PIEGE);
  await cdp.evaluer(LIRE.replace('CIBLE_ID', ID));

  console.log(`\n#${ID} — lecture linéaire de ${MINUTES} min, AUCUN déplacement.\n`);
  console.log('   mur      lue      retard   vidéo      audio      images    perdues   év.');

  const pas = Math.round((MINUTES * 60_000) / PAS_MS);
  let dernier = null;
  for (let i = 0; i <= pas; i += 1) {
    await new Promise((r) => setTimeout(r, PAS_MS));
    const e = await cdp.evaluer(ETAT);
    if (e === null) { console.log('  (pas de lecteur)'); break; }
    dernier = e;
    // Le retard : ce que le mur a avancé, moins ce que la lecture a avancé.
    const retard = +(e.mur - e.t).toFixed(3);
    console.log(
      `  ${String(e.mur.toFixed(0)).padStart(5)}s  ${String(e.t.toFixed(1)).padStart(7)}s  ` +
        `${String(retard.toFixed(2)).padStart(8)}s  ` +
        `${(e.video?.ok ? `OK +${e.video.devant}` : 'ABSENTE').padEnd(10)} ` +
        `${(e.audio?.ok ? `OK +${e.audio.devant}` : 'ABSENT').padEnd(10)} ` +
        `${String(e.total ?? '-').padStart(8)}  ${String(e.perdues ?? '-').padStart(7)}  ${String(e.ev).padStart(4)}`,
    );
  }

  const evenements = await cdp.evaluer('JSON.stringify(window.__ev ?? [])');
  console.log(`\n  événements (seeking/waiting/stalled/ratechange) : ${evenements}`);
  if (dernier !== null) {
    console.log(`  images perdues au total : ${dernier.perdues} sur ${dernier.total}`);
  }
} finally {
  chrome.kill();
}
