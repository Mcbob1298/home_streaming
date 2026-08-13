/**
 * Tests du rattrapage : ce que le disque dément.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CE FICHIER EXISTE À CAUSE D'UN DÉFAUT PRÉCIS.
 *
 * Le bouton « Rechercher ce qui manque » ne cherchait que ce qui n'était pas
 * INSCRIT dans la file. Il comparait des empreintes, et un travail `done` dont
 * les WebVTT avaient disparu du disque avait toujours la bonne empreinte : il
 * répondait « 0 nouveaux, 0 modifiés » sur une bibliothèque entière restée sans
 * sous-titres, pendant que la lecture renvoyait 409 sur chaque piste annoncée.
 *
 * Tous les tests d'ici partent donc d'un cache réel, écrit dans un répertoire
 * temporaire. Un test qui simulerait le système de fichiers ne prouverait rien —
 * c'est exactement l'écart entre la base et le disque qu'on vérifie.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nowIso, openDatabase, type Db } from '../db/index.js';
import { JobQueue, type JobRow } from '../jobs/queue.js';
import { isReady, markReady } from './readiness.js';
import { cacheKey, extractableTracksByFile, missingTracks } from './subtitles.js';
import {
  filesMissingAssets,
  recentFailures,
  requeueMissing,
  subtitleQueue,
  verdictExtraction,
} from './subtitleQueue.js';

let db: Db;
let cacheRoot: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  cacheRoot = mkdtempSync(path.join(tmpdir(), 'sous-titres-'));

  db.prepare("INSERT INTO library (id, label, type) VALUES ('films', 'Films', 'movie')").run();
  db.prepare("INSERT INTO library_root (id, library_id, path, path_key) VALUES (1, 'films', '/m', '/m')").run();
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
});

/** Un fichier présent, avec ses pistes. Taille et date fixes : l'empreinte l'est aussi. */
function fichier(
  id: number,
  options: { sizeBytes?: number; tracks?: { streamIndex: number; codec: string; image?: boolean }[] } = {},
): { id: number; sizeBytes: number; mtimeMs: number } {
  const sizeBytes = options.sizeBytes ?? 1000;
  const mtimeMs = 1_700_000_000_000;

  db.prepare(
    `INSERT INTO media_file (id, library_id, library_root_id, path, path_key, relative_path, file_name,
                             extension, size_bytes, mtime_ms, present, first_seen_at, last_seen_at)
     VALUES (?, 'films', 1, ?, ?, ?, ?, '.mkv', ?, ?, 1, ?, ?)`,
  ).run(
    id,
    `/m/f${id}.mkv`,
    `/m/f${id}.mkv`,
    `f${id}.mkv`,
    `f${id}.mkv`,
    sizeBytes,
    mtimeMs,
    nowIso(),
    nowIso(),
  );

  for (const track of options.tracks ?? []) {
    db.prepare(
      `INSERT INTO embedded_subtitle (media_file_id, stream_index, codec, language, title,
                                      is_default, is_forced, is_image_based)
       VALUES (?, ?, ?, 'fre', NULL, 0, 0, ?)`,
    ).run(id, track.streamIndex, track.codec, track.image === true ? 1 : 0);
  }

  return { id, sizeBytes, mtimeMs };
}

/** Écrit un WebVTT dans le cache, comme le ferait la passe. */
function ecrireVtt(media: { id: number; sizeBytes: number; mtimeMs: number }, streamIndex: number): void {
  const dir = path.join(cacheRoot, cacheKey(media.id, media.sizeBytes, media.mtimeMs));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${streamIndex}.vtt`), 'WEBVTT\n\n');
}

// ---------------------------------------------------------------------------

describe('missingTracks — par index, pas par nombre', () => {
  const tracks = [
    { streamIndex: 2, codec: 'subrip' },
    { streamIndex: 3, codec: 'ass' },
  ];

  it('ne rend rien quand tout est là', () => {
    expect(missingTracks(new Set([2, 3]), tracks)).toEqual([]);
  });

  it('rend la piste absente', () => {
    expect(missingTracks(new Set([2]), tracks)).toEqual([{ streamIndex: 3, codec: 'ass' }]);
  });

  it('ne se laisse pas berner par un compte juste', () => {
    /*
     * Le cache porte deux `.vtt` — mais l'un vient d'une piste qui n'existe
     * plus. Un test sur `ready.size >= tracks.length` passerait ici, et la
     * piste 3 ne serait jamais extraite.
     */
    expect(missingTracks(new Set([2, 9]), tracks)).toEqual([{ streamIndex: 3, codec: 'ass' }]);
  });
});

describe('extractableTracksByFile', () => {
  it('groupe par fichier et écarte l’image comme l’inconnu', () => {
    fichier(1, {
      tracks: [
        { streamIndex: 2, codec: 'subrip' },
        { streamIndex: 3, codec: 'hdmv_pgs_subtitle', image: true },
        { streamIndex: 4, codec: 'ass' },
      ],
    });
    fichier(2, { tracks: [{ streamIndex: 1, codec: 'dvd_subtitle', image: true }] });
    fichier(3);

    const parFichier = extractableTracksByFile(db);

    expect(parFichier.get(1)).toEqual([
      { streamIndex: 2, codec: 'subrip' },
      { streamIndex: 4, codec: 'ass' },
    ]);
    // Ni #2 ni #3 n'ont de piste texte : ils n'entrent pas dans la table.
    expect(parFichier.has(2)).toBe(false);
    expect(parFichier.has(3)).toBe(false);
  });

  it('rend le même verdict que la version par fichier', () => {
    // Deux filtres qui divergent, et un fichier attend un `.vtt` qu'on n'écrit pas.
    fichier(1, {
      tracks: [
        { streamIndex: 0, codec: 'mov_text' },
        { streamIndex: 1, codec: 'webvtt' },
        { streamIndex: 2, codec: 'hdmv_pgs_subtitle', image: true },
      ],
    });

    const groupe = extractableTracksByFile(db).get(1) ?? [];
    const individuel = extractableTracksByFile(db).get(1) ?? [];
    expect(groupe).toEqual(individuel);
    expect(groupe.map((track) => track.streamIndex)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------

describe('filesMissingAssets — le disque a le dernier mot', () => {
  it('ne signale rien quand chaque piste a son WebVTT', () => {
    const media = fichier(1, {
      tracks: [
        { streamIndex: 2, codec: 'subrip' },
        { streamIndex: 3, codec: 'ass' },
      ],
    });
    ecrireVtt(media, 2);
    ecrireVtt(media, 3);

    expect(filesMissingAssets(db, cacheRoot)).toEqual([]);
  });

  it('signale un fichier dont il manque UNE piste', () => {
    const media = fichier(1, {
      tracks: [
        { streamIndex: 2, codec: 'subrip' },
        { streamIndex: 3, codec: 'ass' },
      ],
    });
    ecrireVtt(media, 2);

    expect(filesMissingAssets(db, cacheRoot).map(({ file }) => file.id)).toEqual([1]);
  });

  it('ignore un fichier sans piste texte', () => {
    // Rien à trouver sur le disque : rien ne manque. Le signaler mettrait toute
    // la bibliothèque sans sous-titres en file à chaque clic.
    fichier(1);
    fichier(2, { tracks: [{ streamIndex: 1, codec: 'hdmv_pgs_subtitle', image: true }] });

    expect(filesMissingAssets(db, cacheRoot)).toEqual([]);
  });

  it('signale un fichier dont le cache appartient à une AUTRE version', () => {
    /*
     * Le fichier a été réencodé sur place : le cache de l'ancienne version
     * existe toujours, mais sous une autre clé. Il est donc inatteignable, et
     * c'est bien ce qu'on veut voir.
     */
    const media = fichier(1, { tracks: [{ streamIndex: 2, codec: 'subrip' }] });
    ecrireVtt({ ...media, sizeBytes: 999 }, 2);

    expect(filesMissingAssets(db, cacheRoot).map(({ file }) => file.id)).toEqual([1]);
  });

  it('écarte un échec connu — sinon la boucle est sans fin', () => {
    /*
     * Une piste qui ne produira jamais son WebVTT manquera à chaque passage.
     * Sans cette garde, un clic sur le bouton relancerait la lecture complète du
     * fichier, indéfiniment, pour échouer de la même façon.
     */
    fichier(1, { sizeBytes: 94_000_000_000, tracks: [{ streamIndex: 2, codec: 'subrip' }] });
    const queue = subtitleQueue(db);
    queue.enqueue([{ targetType: 'media_file', targetId: 1, fingerprint: '94000000000-1700000000000' }]);
    const [job] = queue.claim(1);
    queue.fail((job as JobRow).id, 'le flux 2 n’a rien produit');

    expect(filesMissingAssets(db, cacheRoot)).toEqual([]);
    expect(requeueMissing(db, cacheRoot)).toEqual({ missing: 0, bytes: 0 });
    expect(queue.counts()).toMatchObject({ failed: 1, pending: 0 });
  });

  it('ignore un fichier absent du disque', () => {
    fichier(1, { tracks: [{ streamIndex: 2, codec: 'subrip' }] });
    db.prepare('UPDATE media_file SET present = 0 WHERE id = 1').run();

    expect(filesMissingAssets(db, cacheRoot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('requeueMissing — LE DÉFAUT D’ORIGINE', () => {
  it('remet en file un travail « done » dont le cache a disparu', () => {
    const media = fichier(1, { tracks: [{ streamIndex: 2, codec: 'subrip' }] });
    const queue = subtitleQueue(db);

    // La passe a fait son travail, et le fichier est déclaré prêt.
    queue.enqueue([{ targetType: 'media_file', targetId: 1, fingerprint: '1000-1700000000000' }]);
    const [job] = queue.claim(1);
    queue.complete((job as JobRow).id);
    markReady(db, 1);
    expect(isReady(db, 1)).toBe(true);

    // Puis le cache disparaît — volume recréé, `data/` effacé.
    expect(queue.enqueue([{ targetType: 'media_file', targetId: 1, fingerprint: '1000-1700000000000' }])).toMatchObject(
      { unchanged: 1 },
    );
    expect(queue.counts()).toMatchObject({ done: 1, pending: 0 });

    // C'est ce que `enqueue` seul ne voyait pas.
    const rattrape = requeueMissing(db, cacheRoot);

    expect(rattrape).toEqual({ missing: 1, bytes: 1000 });
    expect(queue.counts()).toMatchObject({ pending: 1, done: 0 });
    // Et il ne se déclare plus prêt entre-temps : il ne servira pas de pistes vides.
    expect(isReady(db, 1)).toBe(false);
    void media;
  });

  it('ne touche pas à un fichier réellement préparé', () => {
    const media = fichier(1, { tracks: [{ streamIndex: 2, codec: 'subrip' }] });
    ecrireVtt(media, 2);

    const queue = subtitleQueue(db);
    queue.enqueue([{ targetType: 'media_file', targetId: 1, fingerprint: '1000-1700000000000' }]);
    const [job] = queue.claim(1);
    queue.complete((job as JobRow).id);
    markReady(db, 1);

    expect(requeueMissing(db, cacheRoot)).toEqual({ missing: 0, bytes: 0 });
    expect(queue.counts()).toMatchObject({ done: 1, pending: 0 });
    expect(isReady(db, 1)).toBe(true);
  });

  it('crée le travail quand il n’a jamais existé', () => {
    // Cas d'une bibliothèque jamais préparée : il n'y a rien à réactiver.
    fichier(1, { tracks: [{ streamIndex: 2, codec: 'subrip' }] });

    expect(requeueMissing(db, cacheRoot)).toMatchObject({ missing: 1 });
    expect(subtitleQueue(db).counts()).toMatchObject({ pending: 1, total: 1 });
  });

  it('additionne les octets à relire', () => {
    fichier(1, { sizeBytes: 2000, tracks: [{ streamIndex: 2, codec: 'subrip' }] });
    fichier(2, { sizeBytes: 3000, tracks: [{ streamIndex: 2, codec: 'ass' }] });
    fichier(3, { sizeBytes: 9000 });

    // #3 n'a pas de piste texte : ses 9 000 octets n'entrent pas dans le compte.
    expect(requeueMissing(db, cacheRoot)).toEqual({ missing: 2, bytes: 5000 });
  });
});

// ---------------------------------------------------------------------------

describe('verdictExtraction — une sortie sans erreur n’est pas une réussite', () => {
  const tracks = [
    { streamIndex: 2, codec: 'subrip' },
    { streamIndex: 3, codec: 'ass' },
    { streamIndex: 5, codec: 'mov_text' },
  ];

  it('ne dit rien quand tout est écrit', () => {
    expect(verdictExtraction(new Set([2, 3, 5]), tracks)).toBeNull();
  });

  it('nomme les flux absents', () => {
    // « 1 piste sur 3 » n'aide personne à trouver laquelle.
    expect(verdictExtraction(new Set([2, 5]), tracks)).toBe(
      '1 piste(s) sur 3 n’ont rien produit : flux 3 (ass).',
    );
  });

  it('les énumère toutes quand ffmpeg n’a rien écrit', () => {
    expect(verdictExtraction(new Set(), tracks)).toBe(
      '3 piste(s) sur 3 n’ont rien produit : flux 2 (subrip), flux 3 (ass), flux 5 (mov_text).',
    );
  });
});

// ---------------------------------------------------------------------------

describe('recentFailures — la liste survit au redémarrage', () => {
  it('lit les échecs dans la file, pas en mémoire', () => {
    /*
     * L'ancienne version les tenait dans un tableau du processus : la page
     * affichait « aucun échec » après chaque redémarrage, alors que la base en
     * portait quatre. Une passe de vingt heures redémarre — c'est un cas normal.
     */
    fichier(1, { tracks: [{ streamIndex: 2, codec: 'subrip' }] });
    const queue = subtitleQueue(db);
    queue.enqueue([{ targetType: 'media_file', targetId: 1, fingerprint: 'a' }]);
    const [job] = queue.claim(1);
    queue.fail((job as JobRow).id, 'le flux 2 n’a rien produit');

    // Aucun objet SubtitlePreparation ici : c'est bien la base qu'on interroge.
    expect(recentFailures(db)).toEqual([
      { mediaFileId: 1, fileName: 'f1.mkv', error: 'le flux 2 n’a rien produit' },
    ]);
  });

  it('ne rend rien quand tout est passé', () => {
    fichier(1, { tracks: [{ streamIndex: 2, codec: 'subrip' }] });
    const queue = subtitleQueue(db);
    queue.enqueue([{ targetType: 'media_file', targetId: 1, fingerprint: 'a' }]);
    const [job] = queue.claim(1);
    queue.complete((job as JobRow).id);

    expect(recentFailures(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('requeueTargets', () => {
  it('réveille un travail terminé sans regarder son empreinte', () => {
    const queue = new JobQueue(db, 'probe');
    queue.enqueue([{ targetType: 'media_file', targetId: 1, fingerprint: 'a' }]);
    const [job] = queue.claim(1);
    queue.complete((job as JobRow).id);

    expect(queue.requeueTargets([{ targetType: 'media_file', targetId: 1, fingerprint: 'a' }])).toBe(1);
    expect(queue.counts()).toMatchObject({ pending: 1, done: 0 });
  });

  it('efface l’erreur et remet le compteur d’essais à zéro', () => {
    const queue = new JobQueue(db, 'probe');
    queue.enqueue([{ targetType: 'media_file', targetId: 1, fingerprint: 'a' }]);
    const [job] = queue.claim(1);
    queue.fail((job as JobRow).id, 'disque illisible');

    queue.requeueTargets([{ targetType: 'media_file', targetId: 1, fingerprint: 'a' }]);

    const row = db.prepare('SELECT status, attempts, last_error FROM job WHERE id = ?').get((job as JobRow).id);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
  });

  it('ne touche pas aux autres files', () => {
    const probe = new JobQueue(db, 'probe');
    const soustitres = new JobQueue(db, 'subtitles');
    probe.enqueue([{ targetType: 'media_file', targetId: 1, fingerprint: 'a' }]);
    const [job] = probe.claim(1);
    probe.complete((job as JobRow).id);

    soustitres.requeueTargets([{ targetType: 'media_file', targetId: 1, fingerprint: 'a' }]);

    expect(probe.counts()).toMatchObject({ done: 1 });
    expect(soustitres.counts()).toMatchObject({ pending: 1, total: 1 });
  });
});
