/**
 * Tests du verrou de drainage.
 *
 * Le comportement à garantir est double, et les deux moitiés se contredisent en
 * apparence : refuser un second drainage simultané, mais repartir INSTANTANÉMENT
 * après un redémarrage. C'est le PID du détenteur qui les concilie.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../db/index.js';
import {
  LOCK_STALE_MS,
  acquireDrainLock,
  processAlive,
  refreshDrainLock,
  releaseDrainLock,
} from './drainLock.js';

let db: Db;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('acquireDrainLock', () => {
  it('accorde le verrou quand personne ne le tient', () => {
    expect(acquireDrainLock(db, 'a', T0)).toEqual({ acquired: true, heldBy: null });
  });

  it('LE DÉFAUT : refuse un second drainage pendant qu’un premier travaille', () => {
    /*
     * Sans ce refus, « npm run subtitles » lancé pendant que le serveur tourne
     * appelait requeueStale() et arrachait au serveur son extraction en cours,
     * puis les deux ffmpeg se partageaient le disque.
     */
    acquireDrainLock(db, 'serveur', T0, process.pid);
    const cli = acquireDrainLock(db, 'cli', T0 + 5_000, process.pid);

    expect(cli.acquired).toBe(false);
    expect(cli.heldBy).toEqual({ pid: process.pid, sinceSeconds: 5 });
  });

  it('rend le verrou au même détenteur sans discuter', () => {
    acquireDrainLock(db, 'a', T0);
    expect(acquireDrainLock(db, 'a', T0 + 1000).acquired).toBe(true);
  });

  it('reprend IMMÉDIATEMENT le verrou d’un processus disparu', () => {
    /*
     * C'est ce qui fait repartir la passe treize secondes après un redémarrage
     * de conteneur : le détenteur d'avant n'existe plus, rien n'attend.
     */
    const mort = 0x7ffffffe; // PID hors de portée : personne ne tourne dessus
    acquireDrainLock(db, 'ancien', T0, mort);

    expect(acquireDrainLock(db, 'nouveau', T0 + 1000).acquired).toBe(true);
  });

  it('reprend un verrou périmé même si le PID existe encore', () => {
    // Filet du cas où un PID est réattribué à un autre programme.
    acquireDrainLock(db, 'fige', T0, process.pid);
    expect(acquireDrainLock(db, 'autre', T0 + LOCK_STALE_MS + 1).acquired).toBe(true);
  });

  it('ne se bloque pas sur une valeur illisible', () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('subtitles_drain_lock', 'pas du json')").run();
    expect(acquireDrainLock(db, 'a', T0).acquired).toBe(true);
  });
});

describe('refreshDrainLock', () => {
  it('repousse l’expiration du détenteur', () => {
    acquireDrainLock(db, 'a', T0, process.pid);
    expect(refreshDrainLock(db, 'a', T0 + LOCK_STALE_MS - 1)).toBe(true);

    // Rafraîchi : un tiers ne peut toujours pas le prendre.
    expect(acquireDrainLock(db, 'b', T0 + LOCK_STALE_MS + 1, process.pid).acquired).toBe(false);
  });

  it('rend false quand le verrou a été repris entre-temps', () => {
    // Le signal qui dit à la passe évincée de s'arrêter.
    acquireDrainLock(db, 'a', T0);
    acquireDrainLock(db, 'b', T0 + LOCK_STALE_MS + 1);
    expect(refreshDrainLock(db, 'a', T0 + LOCK_STALE_MS + 2)).toBe(false);
  });
});

describe('releaseDrainLock', () => {
  it('libère pour le suivant', () => {
    acquireDrainLock(db, 'a', T0, process.pid);
    releaseDrainLock(db, 'a');
    expect(acquireDrainLock(db, 'b', T0 + 1, process.pid).acquired).toBe(true);
  });

  it('ne libère pas le verrou de quelqu’un d’autre', () => {
    acquireDrainLock(db, 'a', T0, process.pid);
    releaseDrainLock(db, 'b');
    expect(acquireDrainLock(db, 'c', T0 + 1, process.pid).acquired).toBe(false);
  });
});

describe('processAlive', () => {
  it('reconnaît ce processus-ci', () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  it('reconnaît un processus disparu', () => {
    expect(processAlive(0x7ffffffe)).toBe(false);
  });

  it('traite EPERM comme vivant', () => {
    // Un processus d'un autre utilisateur EXISTE : le refus de signal ne veut
    // pas dire qu'il est mort, et le confondre libérerait le verrou à tort.
    const refus = () => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    };
    expect(processAlive(1234, refus)).toBe(true);
  });
});
