/**
 * LA VOIE DE REPLI REÇOIT-ELLE LE PRÉLUDE DE L'AUTRE VOIE ?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LA QUESTION QUI DÉCIDE SI LA PASSE DES 70 PEUT PARTIR.
 *
 * Un fichier HDR10 a désormais DEUX sorties possibles : HEVC 10 bits intact pour
 * un client qui décode, H.264 tone-mappé 1080p pour les autres. Le prélude, lui,
 * est rangé sous une clé qui ne porte que l'identifiant du fichier, sa taille et
 * sa date.
 *
 * Si un client sans HEVC recevait les segments du prélude HEVC 2160p, sa lecture
 * démarrerait sur des octets que son en-tête ne décrit pas — et la passe
 * figerait cet état sur soixante-dix fichiers d'un coup.
 *
 * On force donc l'en-tête à « 0 » dans un VRAI navigateur, et on regarde ce que
 * le lecteur reçoit réellement au début. Pas ce que le code prétend : c'est
 * l'instrument qui a vu tous les défauts précédents.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `Network.setExtraHTTPHeaders` écrase l'en-tête sur TOUTES les requêtes de la
 * page, y compris celles que hls.js pose par `xhrSetup` : on mesure donc bien un
 * client qui déclare ne pas décoder le HEVC, quoi que Chrome sache faire.
 *
 * Usage : node voie-repli.mjs [mediaFileId] [valeur d'en-tête]
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const VALEUR = process.argv[3] ?? '0';

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

const ETAT = `(() => {
  const v = window.__v;
  if (!v) return null;
  const plages = [];
  try {
    for (let i = 0; i < v.buffered.length; i += 1) {
      plages.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]);
    }
  } catch {}
  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  return {
    t: +v.currentTime.toFixed(2),
    dimensions: v.videoWidth + 'x' + v.videoHeight,
    readyState: v.readyState,
    erreur: v.error ? v.error.code : null,
    plages,
    images: q ? q.totalVideoFrames : null,
  };
})()`;

const { chrome } = await ouvrirChrome();
try {
  /*
   * La progression est remise à ZÉRO : sans cela le lecteur reprend à la
   * position mémorisée — 602 s sur Avatar — et le prélude n'est jamais
   * sollicité. C'est le début du fichier qu'on vient tester.
   */
  await fetch(`${BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaFileId: Number(ID), positionSeconds: 0, durationSeconds: 10690 }),
  }).catch(() => undefined);
  await fetch(`${BASE}/api/hls/${ID}/session`, { method: 'DELETE' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2000));

  const onglet = await nouvelOnglet(`${BASE}/`);
  const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);

  const requetes = [];
  cdp.sur((m) => {
    if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/hls/')) {
      requetes.push({
        url: m.params.response.url.replace(BASE, ''),
        code: m.params.response.status,
        taille: m.params.response.encodedDataLength,
      });
    }
  });

  await cdp.envoyer('Network.enable');
  await cdp.envoyer('Runtime.enable');

  // C'est ici qu'on ment sur la capacité, pour tous les appels de la page.
  await cdp.envoyer('Network.setExtraHTTPHeaders', { headers: { 'X-Client-Hevc': VALEUR } });
  await new Promise((r) => setTimeout(r, 2000));

  console.log(`\n#${ID} — en-tête forcé à « ${VALEUR} » sur toutes les requêtes\n`);

  await cdp.evaluer(LIRE.replace('CIBLE_ID', ID));
  await new Promise((r) => setTimeout(r, 25_000));

  const etat = await cdp.evaluer(ETAT);
  console.log('── CE QUE LE LECTEUR A REÇU ──');
  if (etat === null) {
    console.log('   (aucun élément vidéo)');
  } else {
    console.log(`   dimensions décodées : ${etat.dimensions}`);
    console.log(`   position            : ${etat.t} s   readyState ${etat.readyState}`);
    console.log(`   erreur média        : ${etat.erreur === null ? 'aucune' : etat.erreur}`);
    console.log(`   images décodées     : ${etat.images}`);
    console.log(`   plages tamponnées   : ${JSON.stringify(etat.plages)}`);
  }

  const segments = requetes.filter((r) => /seg-\d+\.m4s/.test(r.url) && !/a-\d+/.test(r.url));
  console.log(`\n── LES PREMIERS SEGMENTS VIDÉO SERVIS (${segments.length}) ──`);
  for (const s of segments.slice(0, 8)) {
    console.log(`   ${s.url.padEnd(34)} HTTP ${s.code}   ${(s.taille / 1048576).toFixed(2)} Mo`);
  }

  /*
   * Le verdict tient à trois choses ensemble : la définition décodée, l'absence
   * d'erreur, et une lecture qui AVANCE. Un flux dont l'en-tête ne décrit pas les
   * octets se manifeste par une position figée à zéro, pas par une erreur.
   */
  console.log('');
  if (etat === null || etat.dimensions === '0x0') {
    console.log('   → RIEN N’A ÉTÉ DÉCODÉ. Le lecteur n’a pas pu démarrer.');
  } else if (etat.erreur !== null) {
    console.log(`   → ERREUR MÉDIA ${etat.erreur}.`);
  } else if (etat.t < 1) {
    console.log('   → L’IMAGE NE DÉMARRE PAS : position figée malgré un tampon.');
  } else {
    console.log(`   → Lecture normale en ${etat.dimensions}, avancée jusqu’à ${etat.t} s.`);
  }
  console.log('');
} finally {
  chrome.kill();
}
