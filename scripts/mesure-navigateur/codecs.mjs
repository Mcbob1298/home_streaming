/**
 * CE QUE LE NAVIGATEUR ACCEPTE RÉELLEMENT DANS MediaSource.
 *
 * `canPlayType` a déjà menti une fois sur ce projet — il répond « maybe » pour
 * des choses qu'il ne lit pas. Ici on interroge `MediaSource.isTypeSupported`,
 * qui est la question que hls.js pose avant d'ouvrir un SourceBuffer : si elle
 * répond faux, aucun réglage serveur n'y changera rien.
 *
 * Les chaînes de codec HEVC se lisent ainsi :
 *   hvc1.1.6.L153.B0  → Main    8 bits, niveau 5.1
 *   hvc1.2.4.L153.B0  → Main 10 bits, niveau 5.1  ← le HDR passe par là
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const TYPES = [
  ['H.264 High (actuel)', 'video/mp4; codecs="avc1.640028"'],
  ['HEVC Main 8 bits', 'video/mp4; codecs="hvc1.1.6.L153.B0"'],
  ['HEVC Main 10 (HDR)', 'video/mp4; codecs="hvc1.2.4.L153.B0"'],
  ['HEVC Main 10, hev1', 'video/mp4; codecs="hev1.2.4.L153.B0"'],
  ['AAC-LC', 'audio/mp4; codecs="mp4a.40.2"'],
];

const SONDE = `(() => {
  const r = {};
  for (const [nom, type] of ${JSON.stringify(TYPES)}) {
    r[nom] = {
      mediaSource: MediaSource.isTypeSupported(type),
      // Pour mémoire seulement : c'est la réponse qui avait induit en erreur.
      canPlayType: document.createElement('video').canPlayType(type),
    };
  }
  return r;
})()`;

/** L'écran annonce-t-il une capacité HDR ? Décide si le passthrough a un sens. */
const ECRAN = `({
  hdr: window.matchMedia('(dynamic-range: high)').matches,
  profondeur: screen.colorDepth,
  gamut: ['srgb', 'p3', 'rec2020'].filter((g) => window.matchMedia('(color-gamut: ' + g + ')').matches),
})`;

const { chrome } = await ouvrirChrome();
try {
  const onglet = await nouvelOnglet(`${BASE}/`);
  const cdp = await Cdp.connect(onglet.webSocketDebuggerUrl);
  await cdp.envoyer('Runtime.enable');
  await new Promise((r) => setTimeout(r, 2500));

  const codecs = await cdp.evaluer(SONDE);
  console.log('\n  type                     MediaSource   canPlayType');
  for (const [nom, v] of Object.entries(codecs)) {
    console.log(`  ${nom.padEnd(24)} ${String(v.mediaSource).padEnd(13)} ${v.canPlayType || '(vide)'}`);
  }

  const ecran = await cdp.evaluer(ECRAN);
  console.log(`\n  écran : HDR ${ecran.hdr ? 'OUI' : 'non'} | ${ecran.profondeur} bits | gamut ${ecran.gamut.join(', ')}`);
} finally {
  chrome.kill();
}
