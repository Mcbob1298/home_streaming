/**
 * Pilote Chrome par CDP pour observer la lecture EN CONDITIONS RÉELLES.
 *
 * On ne regarde pas le code : on regarde les requêtes qui partent. Le serveur
 * ayant été innocenté (six rendus, six contenus distincts), la seule preuve qui
 * compte est de savoir quels segments le lecteur réclame après un changement de
 * piste.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9222;
const BASE = 'http://192.168.1.15:3000';

export async function ouvrirChrome() {
  const profil = mkdtempSync(path.join(tmpdir(), 'cdp-'));
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profil}`,
      ...(process.env.AVEC_FENETRE === '1' ? [] : ['--headless=new']),
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1280,720',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return { chrome, version: (await r.json())['Browser'] };
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome n’a pas ouvert son port de débogage');
}

export async function nouvelOnglet(url) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return r.json();
}

/** Client CDP minimal : un id qui s'incrémente, une promesse par message. */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.attente = new Map();
    this.ecouteurs = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined) {
        const p = this.attente.get(m.id);
        if (p !== undefined) {
          this.attente.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        }
      } else {
        for (const f of this.ecouteurs) f(m);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }

  envoyer(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((res, rej) => {
      this.attente.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  sur(f) {
    this.ecouteurs.push(f);
  }

  async evaluer(expression) {
    const r = await this.envoyer('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
    return r.result.value;
  }
}

export { BASE, PORT };
