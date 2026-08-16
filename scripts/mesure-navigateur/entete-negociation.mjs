/**
 * L'EN-TÊTE DE CAPACITÉ PART-IL VRAIMENT, ET AVEC QUELLE VALEUR ?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POURQUOI OBSERVER LE NAVIGATEUR PLUTÔT QUE DE FAIRE CONFIANCE AU CODE.
 *
 * `xhrSetup` de hls.js est censé poser `X-Client-Hevc` sur chaque requête. Entre
 * « censé » et « le fait », il y a tout ce qui a déjà menti sur ce projet : un
 * réglage passé au mauvais endroit, une instance jamais construite, un mandataire
 * qui filtre. Un `curl` ne prouve rien de tout cela — il prouve ce que `curl`
 * envoie.
 *
 * On relève donc les en-têtes RÉELLEMENT émis par Chrome sur les requêtes de
 * lecture, la réponse de la sonde dans ce navigateur, et les dimensions que
 * l'élément vidéo finit par décoder. Les trois ensemble tracent la chaîne de
 * bout en bout : ce que le client sait, ce qu'il déclare, ce qu'il reçoit.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `requestWillBeSentExtraInfo` est relevé en plus de `requestWillBeSent` : le
 * premier porte les en-têtes tels qu'ils partent sur le réseau, le second ceux
 * que la page a demandés. Ils diffèrent quand quelque chose s'interpose.
 *
 * Usage : node entete-negociation.mjs [mediaFileId]
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';

const SONDE = `({
  hvc1: MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"'),
  hev1: MediaSource.isTypeSupported('video/mp4; codecs="hev1.2.4.L153.B0"'),
  avc1: MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"'),
})`;

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

const { chrome } = await ouvrirChrome();
try {
  const onglet = await nouvelOnglet(`${BASE}/`);
  const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);

  /** requestId → { url, demandes, reseau } */
  const vues = new Map();

  cdp.sur((m) => {
    const p = m.params;
    if (m.method === 'Network.requestWillBeSent' && p.request.url.includes('/api/')) {
      vues.set(p.requestId, { url: p.request.url.replace(BASE, ''), demandes: p.request.headers });
    } else if (m.method === 'Network.requestWillBeSentExtraInfo' && vues.has(p.requestId)) {
      vues.get(p.requestId).reseau = p.headers;
    }
  });

  await cdp.envoyer('Network.enable');
  await cdp.envoyer('Runtime.enable');
  await new Promise((r) => setTimeout(r, 2500));

  const sonde = await cdp.evaluer(SONDE);
  console.log('\n── CE QUE CE NAVIGATEUR SAIT DÉCODER (MediaSource.isTypeSupported) ──');
  console.log(`   hvc1.2.4.L153.B0 (HEVC Main 10) : ${sonde.hvc1}`);
  console.log(`   hev1.2.4.L153.B0 (même, autre étiquette) : ${sonde.hev1}`);
  console.log(`   avc1.640028 (H.264 High, témoin) : ${sonde.avc1}`);
  console.log(`   → la sonde doit donc déclarer : ${sonde.hvc1 || sonde.hev1 ? '1' : '0'}`);

  vues.clear();
  await cdp.evaluer(LIRE.replace('CIBLE_ID', ID));
  await new Promise((r) => setTimeout(r, 12_000));

  /** Cherche l'en-tête sans présumer de sa casse : HTTP ne la garantit pas. */
  const valeurDe = (headers) => {
    if (headers === undefined) return undefined;
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'x-client-hevc') return v;
    }
    return undefined;
  };

  const lignes = [...vues.values()].filter((v) => v.url.includes('/api/'));
  console.log(`\n── EN-TÊTES RÉELLEMENT ÉMIS (${lignes.length} requêtes vers /api/) ──`);
  console.log('   requête                              demandé   sur le réseau');
  console.log('   ' + '─'.repeat(64));

  let avec = 0;
  let sans = 0;
  for (const v of lignes.slice(0, 14)) {
    const d = valeurDe(v.demandes);
    const r = valeurDe(v.reseau);
    if (r !== undefined || d !== undefined) avec += 1;
    else sans += 1;
    console.log(
      `   ${v.url.slice(0, 36).padEnd(36)} ${String(d ?? '—').padStart(7)}   ${String(r ?? '—').padStart(12)}`,
    );
  }
  if (lignes.length > 14) console.log(`   … et ${lignes.length - 14} autres`);

  const total = lignes.filter((v) => valeurDe(v.reseau) !== undefined || valeurDe(v.demandes) !== undefined).length;
  console.log(`\n   ${total}/${lignes.length} requêtes /api/ portent l’en-tête.`);

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * L'ÉCHO DU SERVEUR : LA SEULE PREUVE QU'IL A *REÇU* ET *LU* L'EN-TÊTE.
   *
   * Voir Chrome ÉMETTRE l'en-tête ne prouve que la moitié du chemin ; un
   * mandataire pourrait le filtrer entre les deux. Le texte de playability, lui,
   * est calculé par `decidePlayback` à partir de `options.clientDecodesHevc` —
   * il ne peut mentionner le HEVC que si la valeur est arrivée ET a été lue.
   *
   * La requête part de la PAGE, donc avec l'en-tête que le client d'API pose,
   * dans la même session que la lecture.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const echo = await cdp.evaluer(
    `fetch('/api/stream/${ID}/playability').then((r) => r.json()).then((j) => j.reason)`,
  );
  console.log('\n── CE QUE LE SERVEUR RÉPOND, sur ce que le navigateur lui a envoyé ──');
  console.log(`   ${echo}`);

  const etat = await cdp.evaluer(
    `(() => { const v = window.__v; return v ? { l: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(2) } : null; })()`,
  );
  console.log(`\n── CE QUE L’ÉLÉMENT VIDÉO DÉCODE RÉELLEMENT ──`);
  console.log(`   ${etat === null ? '(pas de vidéo)' : `${etat.l}x${etat.h}, lecture à ${etat.t} s`}`);
  console.log('');
} finally {
  chrome.kill();
}
