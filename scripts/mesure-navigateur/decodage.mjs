/**
 * CE QUE LE DÉCODEUR ENCAISSE, indépendamment de ce que la liaison transporte.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE MESURE EST SÉPARÉE DE TOUTES LES AUTRES.
 *
 * Le blocage d'Avatar en remux 4K a d'abord été imputé au transfert. C'était
 * faux : au moment où la lecture s'est figée, le tampon vidéo affichait +9,37 s
 * — il y avait de quoi lire. Ce qui a lâché est la RESTITUTION, et l'algèbre le
 * confirmait : la condition « transfert plus court que lecture » se réduit à
 * « débit du fichier < débit de la liaison », que la taille des segments
 * n'influence pas.
 *
 * Un seul indicateur répond à la question, et il est exposé par le navigateur :
 * `getVideoPlaybackQuality()`. `droppedVideoFrames / totalVideoFrames` dit la
 * part d'images que le décodeur n'a pas tenues. Avatar en perd 15 % à
 * 75,7 Mbps. On cherche le débit au-dessous duquel ce taux devient nul : c'est
 * la limite du décodeur, et c'est elle qui doit fixer le seuil de bascule vers
 * le réencodage.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Usage : node decodage.mjs <id[,id...]> [secondes]
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const IDS = (process.argv[2] ?? '365').split(',');
const DUREE = Number(process.argv[3] ?? 60) * 1000;

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

const QUALITE = `(() => {
  const v = window.__v;
  if (!v || typeof v.getVideoPlaybackQuality !== 'function') return null;
  const q = v.getVideoPlaybackQuality();
  return { t: +v.currentTime.toFixed(2), total: q.totalVideoFrames, perdues: q.droppedVideoFrames };
})()`;

const { chrome } = await ouvrirChrome();
try {
  console.log('\n  id    débit      lu       images   perdues   taux     verdict');
  for (const id of IDS) {
    await fetch(`${BASE}/api/progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaFileId: Number(id), positionSeconds: 0, durationSeconds: 3600 }),
    }).catch(() => undefined);
    await fetch(`${BASE}/api/hls/${id}/session`, { method: 'DELETE' }).catch(() => undefined);

    const onglet = await nouvelOnglet(`${BASE}/`);
    const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);
    await cdp.envoyer('Runtime.enable');
    await new Promise((r) => setTimeout(r, 2500));
    await cdp.evaluer(LIRE.replace('CIBLE_ID', id));

    // On laisse le démarrage passer : ses images perdues sont un coût d'amorçage,
    // pas une incapacité du décodeur.
    await new Promise((r) => setTimeout(r, 15000));
    const debut = await cdp.evaluer(QUALITE);
    await new Promise((r) => setTimeout(r, DUREE));
    const fin = await cdp.evaluer(QUALITE);

    if (debut === null || fin === null) { console.log(`  ${id}    (pas de lecteur)`); continue; }
    const total = fin.total - debut.total;
    const perdues = fin.perdues - debut.perdues;
    const taux = total > 0 ? (perdues / total) * 100 : 0;
    const lu = (fin.t - debut.t).toFixed(1);
    console.log(
      `  ${id.padEnd(5)} ${'?'.padStart(8)}  ${lu.padStart(6)}s  ${String(total).padStart(7)}  ` +
        `${String(perdues).padStart(7)}  ${taux.toFixed(1).padStart(5)} %  ${taux < 0.5 ? 'tient' : 'DÉCROCHE'}`,
    );
    await cdp.evaluer('window.__v && window.__v.pause()');
  }
} finally {
  chrome.kill();
}
