/**
 * COUVERTURE à la position lue — et non comparaison de débuts de plage.
 *
 * La version précédente comparait `audio.plages[0][0]` à `video.plages[0][0]`.
 * C'est faux : un audio qui commence à 1800 alors qu'on lit à 1800 ne laisse
 * aucun trou, et une vidéo qui a chargé un fragment de plus en arrière n'est pas
 * un décalage. Ce qui compte est UNE seule chose :
 *
 *     à l'instant où le lecteur est, l'audio est-il présent ?
 *
 * On relève donc, pour chaque flux, la plage qui contient `currentTime`, et la
 * marge dont on dispose de part et d'autre. Toutes les plages sont imprimées :
 * une sélection masquerait précisément ce qu'on cherche.
 */
import { Cdp, ouvrirChrome, nouvelOnglet, BASE } from './cdp.mjs';

const ID = process.argv[2] ?? '365';
const CIBLES = (process.argv[3] ?? '600,1800,900,2400,300,1500,2100,1200').split(',').map(Number);
/*
 * Attente après chaque saut, en millisecondes.
 *
 * Dix secondes suffisaient pour des segments de 3 Mo. En remux 4K ils pèsent
 * 78 Mo et le transfert seul en prend 4 à 5 — deux segments par fenêtre. Le
 * seuil dépend donc de la TAILLE des segments, pas du serveur : un instrument
 * trop court mesure sa propre impatience.
 */
const ATTENTE = Number(process.argv[4] ?? 10000);

const PIEGE = `(() => {
  window.__sb = [];
  const ajouter = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = ajouter.call(this, mime);
    sb.__mime = mime;
    window.__sb.push(sb);
    return sb;
  };
  return true;
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

/** Toutes les plages, et la couverture À la position lue. */
const ETAT = `(() => {
  const v = window.__v;
  if (!v) return null;
  const t = v.currentTime;
  const lire = (sb) => {
    const p = [];
    try { for (let i = 0; i < sb.buffered.length; i += 1) p.push([+sb.buffered.start(i).toFixed(2), +sb.buffered.end(i).toFixed(2)]); }
    catch { return null; }
    const contenant = p.find((x) => x[0] <= t && x[1] >= t) ?? null;
    return {
      mime: sb.__mime,
      plages: p,
      couvre: contenant !== null,
      // Marge devant : combien de secondes sont prêtes après la tête de lecture.
      devant: contenant === null ? 0 : +(contenant[1] - t).toFixed(2),
    };
  };
  return { t: +t.toFixed(2), ready: v.readyState, paused: v.paused, flux: (window.__sb ?? []).map(lire).filter(Boolean) };
})()`;

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
  await cdp.envoyer('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));
  await cdp.evaluer(PIEGE);
  await cdp.evaluer(LIRE.replace('CIBLE_ID', ID));
  await new Promise((r) => setTimeout(r, 12000));

  const depart = await cdp.evaluer(ETAT);
  console.log(`\n#${ID} — ${depart.flux.length} flux : ${depart.flux.map((f) => (/audio/i.test(f.mime) ? 'audio' : 'vidéo')).join(', ')}`);
  if (depart.flux.length === 0) {
    console.log('  aucun SourceBuffer : ce fichier est lu en FICHIER DIRECT, hors du chemin HLS.');
  } else {
    /*
     * Un seul flux — audio muxé dans la vidéo — est immunisé contre un DÉCALAGE
     * entre les deux, mais pas contre un segment mal placé : si l'horodatage
     * absolu était mal reconstruit, le tampon ne couvrirait pas la position
     * visée. On déroule donc les sauts dans tous les cas, en n'exigeant que la
     * présence des flux qui existent.
     */
    if (depart.flux.length === 1) {
      console.log('  audio muxé : un seul flux, on vérifie sa PRÉSENCE à chaque position.');
    }
    console.log(
      `  au départ  : t=${depart.t}  ` +
        depart.flux.map((f) => `${/audio/i.test(f.mime) ? 'audio' : 'vidéo'} ${f.couvre ? 'OK' : 'ABSENT'}`).join('  '),
    );
    console.log('\n   n  cible   sens      position   vidéo            audio            verdict');

    let precedente = depart.t;
    let n = 0;
    let echecs = 0;
    for (const cible of CIBLES) {
      n += 1;
      const sens = cible > precedente ? 'avant  ' : 'arrière';
      await cdp.evaluer(`window.__v.currentTime = ${cible}`);
      await new Promise((r) => setTimeout(r, ATTENTE));
      const e = await cdp.evaluer(ETAT);
      const video = e.flux.find((f) => /video/i.test(f.mime));
      const audio = e.flux.find((f) => /audio/i.test(f.mime));
      // On n'exige que les flux qui existent : un fichier à audio muxé n'en a qu'un.
      const bon = e.flux.length > 0 && e.flux.every((f) => f.couvre === true);
      if (!bon) echecs += 1;
      console.log(
        `  ${String(n).padStart(2)}  ${String(cible).padStart(5)}   ${sens}   ${String(e.t).padStart(8)}   ` +
          `${(video?.couvre ? `OK +${video.devant}s` : 'ABSENTE').padEnd(15)}  ` +
          `${(audio?.couvre ? `OK +${audio.devant}s` : 'ABSENT').padEnd(15)}  ${bon ? '' : '← ÉCHEC'}`,
      );
      if (!bon) {
        console.log(`        plages vidéo : ${JSON.stringify(video?.plages)}`);
        console.log(`        plages audio : ${JSON.stringify(audio?.plages)}`);
      }
      precedente = cible;
    }
    console.log(`\n  ${CIBLES.length - echecs}/${CIBLES.length} déplacements avec audio ET vidéo présents à la position lue.`);
  }
} finally {
  chrome.kill();
}
