import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * En développement, le front est servi par Vite sur le port 5173 et l'API par
 * Fastify. Le proxy ci-dessous fait croire au navigateur que tout vient de la
 * même adresse : le code du front appelle simplement « /api/... », sans se
 * soucier du port ni du CORS.
 *
 * « /images » doit y figurer aussi : ce sont les affiches téléchargées par
 * `npm run metadata`, servies par Fastify. Sans cette entrée, Vite répondrait
 * index.html à la place de l'image — une page HTML dans une balise <img>, donc
 * une affiche cassée, et sans erreur visible dans les journaux.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * VITE_API_TARGET DÉSIGNE LE SERVEUR VISÉ, ET SE LIT AVEC loadEnv.
 *
 * Ce fichier s'exécute AVANT que Vite ne charge les fichiers `.env` : un
 * `process.env.VITE_API_TARGET` y est donc toujours vide, même avec un
 * `web/.env.local` parfaitement écrit. Les fichiers `.env` alimentent
 * `import.meta.env` côté client, pas `process.env` ici.
 *
 * Le proxy restait donc sur 127.0.0.1:3000 quoi qu'on écrive, et l'interface
 * affichait les données d'un serveur local vide en croyant parler au NAS.
 * `loadEnv` existe précisément pour ce cas.
 *
 * Le répertoire passé à `loadEnv` est celui de CE FICHIER, pas `process.cwd()` :
 * la commande est lancée depuis la racine avec `--prefix web`, et une hypothèse
 * sur le répertoire courant ferait chercher le fichier au mauvais endroit.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Pour viser le NAS, créer `web/.env.local` — EN UTF-8 :
 *
 *     VITE_API_TARGET=http://192.168.1.15:3001
 *
 * 3001 est le conteneur de développement, 3000 celui de production. Sans cette
 * variable, on garde le comportement local — utile quand le serveur tourne
 * aussi sur le poste.
 */
const CONFIG_DIR = fileURLToPath(new URL('.', import.meta.url));

const DEFAULT_TARGET = 'http://127.0.0.1:3000';

export default defineConfig(({ command, mode }) => {
  // Le troisième argument vide charge TOUTES les variables, y compris celles
  // qui ne commencent pas par « VITE_ » : ce fichier n'est pas exposé au client.
  const env = loadEnv(mode, CONFIG_DIR, '');
  const target = env.VITE_API_TARGET ?? DEFAULT_TARGET;

  /*
   * Annoncé au démarrage, et c'est ce qui manquait le plus.
   *
   * Une cible fausse ne se voit nulle part : le proxy répond, l'interface
   * s'affiche, et les chiffres viennent simplement d'ailleurs. Une ligne au
   * lancement rend la question vérifiable en une seconde au lieu d'une heure.
   *
   * Au `build`, en revanche, le proxy ne sert à rien : l'annoncer laisserait
   * croire qu'il compte pour la version compilée.
   */
  if (command === 'serve') {
    console.log(
      `  API et images  →  ${target}${target === DEFAULT_TARGET ? '  (défaut : serveur local)' : ''}`,
    );
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        /*
         * `changeOrigin` doit être VRAI dès que la cible n'est plus la machine
         * locale : sans lui, l'en-tête Host annonce « localhost:5173 » à un
         * serveur qui n'est pas là, ce que Fastify n'a aucune raison d'accepter.
         */
        '/api': { target, changeOrigin: true },
        '/images': { target, changeOrigin: true },
      },
    },
  };
});
